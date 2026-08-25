import type { Duplex } from 'node:stream';
import Docker from 'dockerode';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  DockerUnavailableError,
  ImageNotFoundError,
  type AttachTerminalOptions,
  type ContainerSpec,
  type ContainerSummary,
  type DockerEngine,
  type TerminalSession,
  type TerminalSize,
} from './engine.ts';
import { instanceIdFromLabels, managedFilter } from './labels.ts';

interface DockerError {
  statusCode?: number;
  message?: string;
}

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null
    ? (error as DockerError).statusCode
    : undefined;
}

/** Docker answers 404 both for a missing image and a missing container; the
 *  call site knows which one it asked for. */
function isNotFound(error: unknown): boolean {
  return statusCode(error) === 404;
}

/** Container already gone, or a remove already in progress. */
function isGone(error: unknown): boolean {
  const code = statusCode(error);
  return code === 404 || code === 409;
}

/** Docker takes the console size as [height, width], the client speaks
 *  cols/rows -- swapping these two is a silent one-character-off bug. */
function consoleSize(size: TerminalSize): [number, number] {
  return [size.rows, size.cols];
}

/** How long the attached process gets to exit on its own after `closeInput`
 *  before the stream is pulled out from under it. */
const CLOSE_GRACE_MS = 500;

class DockerodeTerminalSession implements TerminalSession {
  private closing = false;

  constructor(
    readonly stream: Duplex,
    private readonly exec: Docker.Exec,
    private readonly closeInput: Uint8Array | undefined,
  ) {}

  async resize(size: TerminalSize): Promise<void> {
    await this.exec.resize({ h: size.rows, w: size.cols });
  }

  async exitCode(): Promise<number | undefined> {
    try {
      const info = await this.exec.inspect();
      return info.Running ? undefined : (info.ExitCode ?? undefined);
    } catch {
      // Docker forgets an exec once its container is gone.
      return undefined;
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;

    // Destroying the stream does not end the exec -- Docker keeps the TTY open
    // and `tmux attach` runs on. The process has to be asked to leave.
    if (this.closeInput === undefined || !this.stream.writable) {
      this.stream.destroy();
      return;
    }

    this.stream.write(this.closeInput);
    const backstop = setTimeout(() => this.stream.destroy(), CLOSE_GRACE_MS);
    backstop.unref();
    this.stream.once('close', () => {
      clearTimeout(backstop);
    });
  }
}

export class DockerodeEngine implements DockerEngine {
  private readonly docker: Docker;

  constructor(socketPath?: string) {
    // Without options dockerode falls back to DOCKER_HOST, which is what the
    // config leaves it to when that variable is set.
    this.docker = socketPath === undefined ? new Docker() : new Docker({ socketPath });
  }

  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (error) {
      throw new DockerUnavailableError(error);
    }
  }

  async runContainer(spec: ContainerSpec): Promise<string> {
    const container = await this.create(spec);

    try {
      await container.start();
    } catch (error) {
      // A container that exists but never started would be invisible to the
      // caller and left behind on the host.
      await this.removeContainer(container.id);
      throw this.translate(error, spec.image);
    }

    return container.id;
  }

  async removeContainer(containerId: string): Promise<void> {
    try {
      // `v: true` takes the anonymous volumes with it -- otherwise a deleted
      // instance leaves its workspace behind.
      await this.docker.getContainer(containerId).remove({ force: true, v: true });
    } catch (error) {
      if (isGone(error)) return;
      throw this.translate(error);
    }
  }

  async listManagedContainers(): Promise<ContainerSummary[]> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.docker.listContainers({ all: true, filters: managedFilter });
    } catch (error) {
      throw this.translate(error);
    }

    return containers.map((info) => ({
      containerId: info.Id,
      instanceId: instanceIdFromLabels(info.Labels),
      state: info.State,
      status: info.Status,
    }));
  }

  async attachTerminal(
    containerId: string,
    options: AttachTerminalOptions,
  ): Promise<TerminalSession> {
    const container = this.docker.getContainer(containerId);

    try {
      const exec = await container.exec({
        Cmd: options.command,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        // Geometry at create time rather than a resize after start, so the
        // first redraw already arrives in the client's size instead of
        // Docker's 80x24 default and then reflowing.
        ...(options.size === undefined ? {} : { ConsoleSize: consoleSize(options.size) }),
      });

      // `hijack` turns the HTTP request into the raw duplex; `stdin: true`
      // keeps the write half open. With Tty the stream is not multiplexed.
      const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

      return new DockerodeTerminalSession(stream, exec, options.closeInput);
    } catch (error) {
      throw this.translateAttach(error, containerId);
    }
  }

  private async create(spec: ContainerSpec): Promise<Docker.Container> {
    try {
      return await this.docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Labels: spec.labels,
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        // No TTY here on purpose: the entrypoint starts tmux detached and the
        // terminal bridge (#4) attaches later with its own exec TTY.
        Tty: false,
        OpenStdin: false,
        HostConfig: {
          // Resource limits and a restart policy belong to #8.
          AutoRemove: false,
        },
      });
    } catch (error) {
      if (isNotFound(error)) throw new ImageNotFoundError(spec.image);
      throw this.translate(error, spec.image);
    }
  }

  /** Docker answers 404 for a container it does not have and 409 for one that
   *  is not running -- both are ordinary states here, not failures. */
  private translateAttach(error: unknown, containerId: string): Error {
    const code = statusCode(error);
    if (code === 404) return new ContainerNotFoundError(containerId);
    if (code === 409) return new ContainerNotRunningError(containerId);
    if (code === undefined) return new DockerUnavailableError(error);
    return error instanceof Error ? error : new Error(String(error));
  }

  private translate(error: unknown, image?: string): Error {
    if (image !== undefined && isNotFound(error)) return new ImageNotFoundError(image);
    if (isNotFound(error)) {
      const message = (error as DockerError).message ?? '';
      return new ContainerNotFoundError(message);
    }
    // A refused socket is not a request error -- the daemon is simply not there.
    if (statusCode(error) === undefined) return new DockerUnavailableError(error);
    return error instanceof Error ? error : new Error(String(error));
  }
}
