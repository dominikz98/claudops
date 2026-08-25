import Docker from 'dockerode';
import {
  ContainerNotFoundError,
  DockerUnavailableError,
  ImageNotFoundError,
  type ContainerSpec,
  type ContainerSummary,
  type DockerEngine,
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
