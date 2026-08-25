import { Duplex } from 'node:stream';
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
} from '../src/docker/engine.ts';
import { instanceIdFromLabels } from '../src/docker/labels.ts';

/**
 * The container side of a fake TTY: what the bridge writes shows up in
 * `input`, what a test pushes with `output` travels to the client.
 */
export class FakeTerminalStream extends Duplex {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  override _read(): void {
    // Output is pushed by the test, never pulled.
  }

  /** Everything the client has typed so far. */
  get input(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  output(text: string): void {
    this.push(Buffer.from(text, 'utf8'));
  }
}

export class FakeTerminalSession implements TerminalSession {
  readonly stream = new FakeTerminalStream();
  /** Resizes the client asked for, in order. The geometry handed to the attach
   *  itself stays in `options.size` -- the real engine sets that one at exec
   *  create time, not through a resize. */
  readonly resizes: TerminalSize[] = [];
  /** What `exitCode()` reports; `undefined` means "still running". */
  exit: number | undefined;
  closed = false;

  constructor(
    readonly containerId: string,
    readonly options: AttachTerminalOptions,
  ) {}

  resize(size: TerminalSize): Promise<void> {
    this.resizes.push(size);
    return Promise.resolve();
  }

  exitCode(): Promise<number | undefined> {
    return Promise.resolve(this.exit);
  }

  close(): void {
    this.closed = true;
    this.stream.destroy();
  }

  /** The process behind the TTY ended -- tmux detached, the shell exited. */
  end(exitCode = 0): void {
    this.exit = exitCode;
    this.stream.push(null);
  }
}

interface FakeContainer {
  containerId: string;
  spec: ContainerSpec;
  state: string;
}

/**
 * In-memory stand-in for the Docker Engine. Same contract as DockerodeEngine,
 * which is why the service and route tests need no daemon.
 */
export class FakeDockerEngine implements DockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly knownImages = new Set<string>(['claudops-base']);

  /** Set to make every call behave as if the daemon were down. */
  unavailable = false;
  /** Set to make the next runContainer fail after the row already exists. */
  failNextRun: Error | undefined;
  /** Set to make the next attachTerminal fail with exactly this error. */
  failNextAttach: Error | undefined;
  /** Widens the window between the upgrade and the attach, where a client that
   *  sends immediately would lose its frames. */
  attachDelayMs = 0;
  readonly terminals: FakeTerminalSession[] = [];

  private sequence = 0;

  async ping(): Promise<void> {
    this.guard();
    return Promise.resolve();
  }

  async runContainer(spec: ContainerSpec): Promise<string> {
    this.guard();

    if (this.failNextRun !== undefined) {
      const error = this.failNextRun;
      this.failNextRun = undefined;
      throw error;
    }
    if (!this.knownImages.has(spec.image)) throw new ImageNotFoundError(spec.image);

    this.sequence += 1;
    const containerId = `container-${this.sequence}`;
    this.containers.set(containerId, { containerId, spec, state: 'running' });
    return Promise.resolve(containerId);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.guard();
    // Missing is not an error -- delete stays idempotent.
    this.containers.delete(containerId);
    return Promise.resolve();
  }

  async listManagedContainers(): Promise<ContainerSummary[]> {
    this.guard();
    return Promise.resolve(
      [...this.containers.values()]
        .filter((container) => instanceIdFromLabels(container.spec.labels) !== undefined)
        .map((container) => ({
          containerId: container.containerId,
          instanceId: instanceIdFromLabels(container.spec.labels),
          state: container.state,
          status: `Up (${container.state})`,
        })),
    );
  }

  async attachTerminal(
    containerId: string,
    options: AttachTerminalOptions,
  ): Promise<TerminalSession> {
    this.guard();

    if (this.attachDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.attachDelayMs));
    }

    if (this.failNextAttach !== undefined) {
      const error = this.failNextAttach;
      this.failNextAttach = undefined;
      throw error;
    }

    const container = this.containers.get(containerId);
    if (container === undefined) throw new ContainerNotFoundError(containerId);
    if (container.state !== 'running') throw new ContainerNotRunningError(containerId);

    const session = new FakeTerminalSession(containerId, options);
    this.terminals.push(session);
    return Promise.resolve(session);
  }

  /** Test helpers -------------------------------------------------------- */

  /** The session of the connection that attached last. */
  lastTerminal(): FakeTerminalSession {
    const session = this.terminals.at(-1);
    if (session === undefined) throw new Error('no terminal was attached');
    return session;
  }

  specFor(instanceId: string): ContainerSpec | undefined {
    return [...this.containers.values()].find((c) => c.spec.instanceId === instanceId)?.spec;
  }

  setState(containerId: string, state: string): void {
    const container = this.containers.get(containerId);
    if (container !== undefined) container.state = state;
  }

  /** A container on the same host that claudops does not own. */
  addUnmanagedContainer(containerId: string): void {
    this.containers.set(containerId, {
      containerId,
      spec: {
        instanceId: '',
        name: containerId,
        image: 'someone-else',
        env: {},
        labels: {},
      },
      state: 'running',
    });
  }

  /** Simulate a container that vanished behind the server's back. */
  forget(containerId: string): void {
    this.containers.delete(containerId);
  }

  private guard(): void {
    if (this.unavailable) throw new DockerUnavailableError(new Error('connect ECONNREFUSED'));
  }
}
