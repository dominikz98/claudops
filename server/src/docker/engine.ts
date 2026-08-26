import type { Duplex } from 'node:stream';

/**
 * The port between claudops and the Docker Engine.
 *
 * Everything the server needs from Docker goes through this interface, which is
 * what lets the tests run without a daemon: `test/fake-engine.ts` implements
 * the same contract. `dockerode-engine.ts` is the real one.
 */

/**
 * What one instance may use of the host. The NUC runs several of them next to
 * the server itself, so an unbounded container is one runaway build away from
 * taking the box down with it.
 */
export interface ContainerLimits {
  /** Fractional CPUs, exactly as `docker run --cpus` takes them. */
  cpus: number;
  memoryBytes: number;
}

export interface ContainerSpec {
  instanceId: string;
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  limits: ContainerLimits;
  /**
   * Linux capabilities added on top of Docker's default set. `NET_ADMIN` is
   * what lets the entrypoint install its own egress firewall: iptables needs it
   * in the effective set, and without it the container seals itself off and
   * refuses to start Claude. CAP_NET_RAW -- which the legacy iptables backend
   * opens a raw socket with -- is already in Docker's default set, so it is
   * deliberately not repeated here, and nothing may drop it.
   */
  capAdd: readonly string[];
}

/** A container as the Docker API reports it. */
export interface ContainerSummary {
  containerId: string;
  instanceId: string | undefined;
  /** Raw Docker state: created, running, exited, paused, restarting, dead. */
  state: string;
  status: string;
}

/** A volume as the Docker API reports it. `instanceId` is `undefined` for one
 *  that carries the label without a value -- a volume somebody labelled by
 *  hand. */
export interface VolumeSummary {
  name: string;
  instanceId: string | undefined;
}

/** Terminal geometry as the client reports it, in character cells. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface AttachTerminalOptions {
  /** Argv of the process the exec runs, e.g. `tmux attach -t main`. */
  command: string[];
  /** Set on the exec itself rather than by a resize afterwards, so the first
   *  redraw already arrives in the client's geometry instead of Docker's 80x24
   *  default and then reflowing. */
  size?: TerminalSize | undefined;
  /**
   * Bytes written on close to let the attached process end itself. Docker has
   * no API to kill an exec and does not close the TTY when the hijacked stream
   * goes away, so without this the process keeps running -- see
   * knowledge/docker-cannot-kill-an-exec.md.
   */
  closeInput?: Uint8Array | undefined;
}

/**
 * One attached TTY. The stream is a raw duplex -- with `Tty: true` Docker does
 * not multiplex, so bytes written are keystrokes and bytes read are screen
 * output, in both directions unframed.
 */
export interface TerminalSession {
  readonly stream: Duplex;
  /** Rejects when Docker refuses, which is what an exec that has already ended
   *  looks like. Callers log it and carry on. */
  resize(size: TerminalSize): Promise<void>;
  /** The exec's exit code once it has ended, `undefined` while it still runs
   *  or when Docker no longer knows the exec. */
  exitCode(): Promise<number | undefined>;
  /** Ends the session: `closeInput` first if there is one, then the stream.
   *  Idempotent. */
  close(): void;
}

/** What one `docker build` needs. No build-context contents here: the template
 *  in docker/project has no COPY, so the context is the Dockerfile and nothing
 *  else. */
export interface ImageBuildSpec {
  /** Tag the result gets, e.g. `claudops-project-<id>`. */
  tag: string;
  /** Directory handed to the daemon as the build context. */
  contextDir: string;
  /** Dockerfile inside `contextDir`. */
  dockerfile: string;
  buildArgs: Record<string, string>;
  labels: Record<string, string>;
}

export class ImageNotFoundError extends Error {
  constructor(readonly image: string) {
    super(`image '${image}' not found -- build it before starting instances`);
    this.name = 'ImageNotFoundError';
  }
}

/**
 * The build ran and the daemon refused it -- a missing base image, a failing
 * install step. `detail` is what Docker said, which is the only useful part of
 * a build that did not work.
 */
export class ImageBuildFailedError extends Error {
  constructor(
    readonly tag: string,
    readonly detail: string,
  ) {
    super(`building image '${tag}' failed: ${detail}`);
    this.name = 'ImageBuildFailedError';
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

export class ContainerNotRunningError extends Error {
  constructor(readonly containerId: string) {
    super(`container '${containerId}' is not running`);
    this.name = 'ContainerNotRunningError';
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
  /** Stops the container. Already stopped is not an error. Throws
   *  ContainerNotFoundError for one Docker no longer has. */
  stopContainer(containerId: string): Promise<void>;
  /** Starts a stopped container again. Already running is not an error. */
  startContainer(containerId: string): Promise<void>;
  /** Every container carrying the instance label, running or not. */
  listManagedContainers(): Promise<ContainerSummary[]>;
  /** Every volume carrying the instance label. What the startup reconcile
   *  needs to tell a leftover workspace from a foreign volume. */
  listManagedVolumes(): Promise<VolumeSummary[]>;
  /** Removes a volume by name. Missing is not an error, for the same reason
   *  removeContainer's is not. */
  removeVolume(name: string): Promise<void>;
  /** Attaches a TTY exec to a running container. Throws
   *  ContainerNotFoundError or ContainerNotRunningError. */
  attachTerminal(containerId: string, options: AttachTerminalOptions): Promise<TerminalSession>;
  /**
   * Builds an image and streams the daemon's output through `onLog` as it
   * arrives, so a caller can persist the log of a build that then fails.
   * Resolves when the image is tagged, throws ImageBuildFailedError otherwise.
   */
  buildImage(spec: ImageBuildSpec, onLog: (chunk: string) => void): Promise<void>;
  /** Removes an image by tag. Missing is not an error -- the same reasoning as
   *  removeContainer: cleanup has to stay idempotent. */
  removeImage(tag: string): Promise<void>;
}
