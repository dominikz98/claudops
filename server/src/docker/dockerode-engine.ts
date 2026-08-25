import type { Duplex } from 'node:stream';
import Docker from 'dockerode';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  DockerUnavailableError,
  ImageBuildFailedError,
  ImageNotFoundError,
  type AttachTerminalOptions,
  type ContainerSpec,
  type ContainerSummary,
  type DockerEngine,
  type ImageBuildSpec,
  type TerminalSession,
  type TerminalSize,
  type VolumeSummary,
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

/** Docker answers 304 for a stop of a stopped container and a start of a
 *  running one. Both are the state the caller asked for. */
function isAlreadyInThatState(error: unknown): boolean {
  return statusCode(error) === 304;
}

/** What `docker stop` waits before it reaches for SIGKILL. The entrypoint shuts
 *  its tmux session down on SIGTERM, so this is a backstop rather than the
 *  normal path -- a stop that really takes ten seconds is a bug in the image. */
const STOP_TIMEOUT_SECONDS = 10;

/** One CPU, in the unit the Docker API takes. `--cpus 2` is 2e9 NanoCpus. */
const NANO_CPUS_PER_CPU = 1_000_000_000;

/** Docker takes the console size as [height, width], the client speaks
 *  cols/rows -- swapping these two is a silent one-character-off bug. */
function consoleSize(size: TerminalSize): [number, number] {
  return [size.rows, size.cols];
}

/** One line of the build response body. Everything is optional -- the daemon
 *  mixes progress, output and failure into the same stream. */
interface BuildEvent {
  stream?: unknown;
  status?: unknown;
  error?: unknown;
  errorDetail?: { message?: unknown };
}

/** The error text of a build event, or `undefined` for an ordinary line. */
function buildFailure(event: BuildEvent): string | undefined {
  if (typeof event.errorDetail?.message === 'string') return event.errorDetail.message;
  if (typeof event.error === 'string') return event.error;
  return undefined;
}

/**
 * Reads a build response to its end, handing every line of output to `onLog`,
 * and returns the failure the daemon reported -- or `undefined` when the build
 * got through.
 *
 * A failed build still answers HTTP 200: the reason arrives as a JSON line
 * inside the body, so a caller that only awaits the request sees every build
 * succeed (knowledge/docker-build-errors-arrive-in-the-stream.md).
 */
async function drainBuildLog(
  stream: NodeJS.ReadableStream,
  onLog: (chunk: string) => void,
): Promise<string | undefined> {
  let failure: string | undefined;

  const handle = (line: string): void => {
    if (line === '') return;

    let event: BuildEvent;
    try {
      event = JSON.parse(line) as BuildEvent;
    } catch {
      // Not every line is JSON once a proxy sits in between -- keep it anyway,
      // it is still the most informative thing available.
      onLog(`${line}\n`);
      return;
    }

    if (typeof event.stream === 'string') onLog(event.stream);
    else if (typeof event.status === 'string') onLog(`${event.status}\n`);

    const detail = buildFailure(event);
    if (detail !== undefined) {
      // The first failure is the cause; anything after it is fallout.
      failure ??= detail;
      onLog(`${detail}\n`);
    }
  };

  // The body is newline-delimited JSON, and a line can straddle two chunks.
  let pending = '';
  for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) handle(line.trim());
  }
  handle(pending.trim());

  return failure;
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

  async stopContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop({ t: STOP_TIMEOUT_SECONDS });
    } catch (error) {
      // Already stopped is the outcome the caller wanted.
      if (isAlreadyInThatState(error)) return;
      throw this.translate(error);
    }
  }

  async startContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).start();
    } catch (error) {
      if (isAlreadyInThatState(error)) return;
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

  async listManagedVolumes(): Promise<VolumeSummary[]> {
    let response: { Volumes: Docker.VolumeInspectInfo[] };
    try {
      response = await this.docker.listVolumes({ filters: managedFilter });
    } catch (error) {
      throw this.translate(error);
    }

    // The daemon answers `"Volumes": null` when nothing matches, which the
    // dockerode types do not admit to.
    return (response.Volumes ?? []).map((volume) => ({
      name: volume.Name,
      instanceId: instanceIdFromLabels(volume.Labels),
    }));
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
    } catch (error) {
      // Gone already is the outcome we wanted. A 409 is not: it means a
      // container still has the volume mounted, and the caller wants to hear
      // about that rather than believe it was removed.
      if (isNotFound(error)) return;
      throw this.translate(error);
    }
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

  async buildImage(spec: ImageBuildSpec, onLog: (chunk: string) => void): Promise<void> {
    let stream: NodeJS.ReadableStream;
    try {
      // dockerode tars the context itself -- it ships tar-fs, so this needs no
      // dependency of ours and no temporary archive.
      stream = await this.docker.buildImage(
        { context: spec.contextDir, src: [spec.dockerfile] },
        {
          t: spec.tag,
          dockerfile: spec.dockerfile,
          buildargs: spec.buildArgs,
          labels: spec.labels,
          // Intermediate containers go away; the layer cache stays, which is
          // what makes an unchanged rebuild seconds rather than minutes.
          rm: true,
          // Without this the daemon would try to pull claudops-base from a
          // registry, where it has never existed.
          pull: false,
        },
      );
    } catch (error) {
      throw this.translate(error);
    }

    const failure = await drainBuildLog(stream, onLog);
    if (failure !== undefined) throw new ImageBuildFailedError(spec.tag, failure);
  }

  async removeImage(tag: string): Promise<void> {
    try {
      await this.docker.getImage(tag).remove({ force: true });
    } catch (error) {
      // Gone already is the outcome we wanted.
      if (isGone(error)) return;
      throw this.translate(error);
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
          AutoRemove: false,
          // What `docker run --cpus` sets. A ceiling on CPU time per period,
          // not a pinning: the instance may use every core, just not more than
          // this much of them in total.
          NanoCpus: Math.round(spec.limits.cpus * NANO_CPUS_PER_CPU),
          Memory: spec.limits.memoryBytes,
          // The same value as Memory is what turns swap off for this container.
          // Left unset, Docker allows twice the limit in swap, and a container
          // over its memory would page the whole NUC to a standstill instead of
          // being killed.
          MemorySwap: spec.limits.memoryBytes,
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
