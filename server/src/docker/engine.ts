/**
 * The port between claudops and the Docker Engine.
 *
 * Everything the server needs from Docker goes through this interface, which is
 * what lets the tests run without a daemon: `test/fake-engine.ts` implements
 * the same contract. `dockerode-engine.ts` is the real one.
 */

export interface ContainerSpec {
  instanceId: string;
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
}

/** A container as the Docker API reports it. */
export interface ContainerSummary {
  containerId: string;
  instanceId: string | undefined;
  /** Raw Docker state: created, running, exited, paused, restarting, dead. */
  state: string;
  status: string;
}

export class ImageNotFoundError extends Error {
  constructor(readonly image: string) {
    super(`image '${image}' not found -- build it before starting instances`);
    this.name = 'ImageNotFoundError';
  }
}

export class DockerUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Docker Engine is unreachable: ${describe(cause)}`);
    this.name = 'DockerUnavailableError';
    this.cause = cause;
  }
}

export class ContainerNotFoundError extends Error {
  constructor(readonly containerId: string) {
    super(`container '${containerId}' does not exist`);
    this.name = 'ContainerNotFoundError';
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface DockerEngine {
  /** Throws DockerUnavailableError if the daemon does not answer. */
  ping(): Promise<void>;
  /** Creates and starts the container, returns its id. */
  runContainer(spec: ContainerSpec): Promise<string>;
  /** Removes the container including its anonymous volumes. Missing is not an
   *  error -- delete has to stay idempotent. */
  removeContainer(containerId: string): Promise<void>;
  /** Every container carrying the instance label, running or not. */
  listManagedContainers(): Promise<ContainerSummary[]>;
}
