import { Duplex } from 'node:stream';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  DockerUnavailableError,
  ImageNotFoundError,
  type AttachTerminalOptions,
  type CommandResult,
  type ContainerHealth,
  type ContainerSpec,
  type ContainerSummary,
  type DockerEngine,
  type ImageBuildSpec,
  type TerminalSession,
  type TerminalSize,
  type VolumeSummary,
} from '../src/docker/engine.ts';
import { instanceIdFromLabels, instanceLabels } from '../src/docker/labels.ts';

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
  /** What the container's healthcheck would report. `healthy` by default so a
   *  test that is not about readiness gets a container it can attach to;
   *  `setHealth` plays the other three answers, `undefined` among them -- that
   *  is an image without a HEALTHCHECK. */
  health: ContainerHealth | undefined;
}

interface PutArchive {
  containerId: string;
  targetDir: string;
  archive: Uint8Array;
}

interface RunCommand {
  containerId: string;
  command: string[];
}

interface FakeVolume {
  name: string;
  labels: Record<string, string>;
}

/**
 * In-memory stand-in for the Docker Engine. Same contract as DockerodeEngine,
 * which is why the service and route tests need no daemon.
 */
export class FakeDockerEngine implements DockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  /** Nothing creates one today -- `runContainer` mounts no volume, exactly like
   *  the real engine. A test puts one here to play the leftover a hand-run
   *  container or a `docker rm` without `-v` leaves behind. */
  readonly volumes = new Map<string, FakeVolume>();
  readonly knownImages = new Set<string>(['claudops-base']);

  /** Set to make every call behave as if the daemon were down. */
  unavailable = false;
  /** Set to make the next runContainer fail after the row already exists. */
  failNextRun: Error | undefined;
  /** Set to make the next attachTerminal fail with exactly this error. */
  failNextAttach: Error | undefined;
  /** Set to make the next buildImage fail with exactly this error. */
  failNextBuild: Error | undefined;
  /** Volumes whose removal refuses -- what a volume another container still has
   *  mounted looks like. */
  readonly failVolumeRemoval = new Set<string>();
  /** Every build that was asked for, in order -- the tags, args and labels a
   *  test asserts on. */
  readonly builds: ImageBuildSpec[] = [];
  /** Tags handed to removeImage. */
  readonly removedImages: string[] = [];
  /** What a build "prints". Enough to tell a stored log from an empty one. */
  buildOutput = ['Step 1/1 : FROM claudops-base\n', 'Successfully tagged\n'];
  /** Keeps a build running long enough to observe the `building` state, which a
   *  real dotnet or Playwright build occupies for minutes. */
  buildDelayMs = 0;
  /** Widens the window between the upgrade and the attach, where a client that
   *  sends immediately would lose its frames. */
  attachDelayMs = 0;
  readonly terminals: FakeTerminalSession[] = [];
  /** Every archive that was put into a container, in order. */
  readonly archives: PutArchive[] = [];
  /** Every one-shot command, in order -- the mkdir, the du and the
   *  `tmux send-keys` an upload runs. */
  readonly commands: RunCommand[] = [];
  /** What the fake `find -printf '%s'` reports: bytes already lying in the
   *  uploads directory. */
  uploadUsage = 0;
  /** Set to make the next runCommand fail with exactly this error. */
  failNextCommand: Error | undefined;
  /** What runCommand answers. Replaced by a test that needs another answer;
   *  the default plays a container whose uploads directory holds
   *  `uploadUsage` bytes. */
  commandResult: (command: string[]) => CommandResult = (command) =>
    command.join(' ').includes('-printf')
      ? { exitCode: 0, output: this.uploadUsage === 0 ? '' : `${String(this.uploadUsage)}
` }
      : { exitCode: 0, output: '' };

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
    this.containers.set(containerId, { containerId, spec, state: 'running', health: 'healthy' });
    return Promise.resolve(containerId);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.guard();
    // Missing is not an error -- delete stays idempotent.
    this.containers.delete(containerId);
    return Promise.resolve();
  }

  async stopContainer(containerId: string): Promise<void> {
    this.guard();
    const container = this.containers.get(containerId);
    if (container === undefined) throw new ContainerNotFoundError(containerId);
    // Already stopped is not an error, exactly like Docker's 304.
    container.state = 'exited';
    return Promise.resolve();
  }

  async startContainer(containerId: string): Promise<void> {
    this.guard();
    const container = this.containers.get(containerId);
    if (container === undefined) throw new ContainerNotFoundError(containerId);
    container.state = 'running';
    return Promise.resolve();
  }

  async listManagedVolumes(): Promise<VolumeSummary[]> {
    this.guard();
    return Promise.resolve(
      [...this.volumes.values()]
        .filter((volume) => instanceIdFromLabels(volume.labels) !== undefined)
        .map((volume) => ({ name: volume.name, instanceId: instanceIdFromLabels(volume.labels) })),
    );
  }

  async removeVolume(name: string): Promise<void> {
    this.guard();
    if (this.failVolumeRemoval.has(name)) {
      throw new Error(`volume is in use - ${name}`);
    }
    this.volumes.delete(name);
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
          // Only a running container reports one, exactly like the real engine.
          health: container.state === 'running' ? container.health : undefined,
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

  async putArchive(containerId: string, targetDir: string, archive: Uint8Array): Promise<void> {
    this.guard();
    this.requireRunning(containerId);
    this.archives.push({ containerId, targetDir, archive: Uint8Array.from(archive) });
    return Promise.resolve();
  }

  async runCommand(containerId: string, command: string[]): Promise<CommandResult> {
    this.guard();
    this.requireRunning(containerId);

    if (this.failNextCommand !== undefined) {
      const error = this.failNextCommand;
      this.failNextCommand = undefined;
      throw error;
    }

    this.commands.push({ containerId, command });
    return Promise.resolve(this.commandResult(command));
  }

  async buildImage(spec: ImageBuildSpec, onLog: (chunk: string) => void): Promise<void> {
    this.guard();
    this.builds.push(spec);

    // Output before the failure, like the real one: a build that breaks halfway
    // still has a log worth keeping.
    for (const chunk of this.buildOutput) onLog(chunk);

    if (this.buildDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.buildDelayMs));
    }

    if (this.failNextBuild !== undefined) {
      const error = this.failNextBuild;
      this.failNextBuild = undefined;
      throw error;
    }

    // What makes the next runContainer find it.
    this.knownImages.add(spec.tag);
    return Promise.resolve();
  }

  async removeImage(tag: string): Promise<void> {
    this.guard();
    this.removedImages.push(tag);
    this.knownImages.delete(tag);
    return Promise.resolve();
  }

  /** Test helpers -------------------------------------------------------- */

  /** The archive that was put last, as text -- every upload in these tests is
   *  a small one, and its bytes start at offset 512 behind the tar header. */
  lastArchive(): PutArchive {
    const archive = this.archives.at(-1);
    if (archive === undefined) throw new Error('no archive was put');
    return archive;
  }

  /** The commands whose argv starts with `tmux`. What an upload announces. */
  tmuxCommands(): string[][] {
    return this.commands.filter((entry) => entry.command[0] === 'tmux').map((e) => e.command);
  }

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

  /** What the container's healthcheck says. `undefined` plays an image that
   *  carries none. */
  setHealth(containerId: string, health: ContainerHealth | undefined): void {
    const container = this.containers.get(containerId);
    if (container !== undefined) container.health = health;
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
        limits: { cpus: 1, memoryBytes: 1024 * 1024 * 1024 },
        capAdd: [],
      },
      state: 'running',
      health: 'healthy',
    });
  }

  /** A container carrying the claudops label that no instance points at -- what
   *  a create that died between the two steps, or a server that was killed,
   *  leaves on the host. */
  addOrphanContainer(containerId: string, instanceId: string): void {
    this.containers.set(containerId, {
      containerId,
      spec: {
        instanceId,
        name: `claudops-${instanceId}`,
        image: 'claudops-project-gone',
        env: {},
        labels: instanceLabels(instanceId),
        limits: { cpus: 1, memoryBytes: 1024 * 1024 * 1024 },
        capAdd: [],
      },
      state: 'running',
      health: 'healthy',
    });
  }

  /** A labelled volume, with or without an instance behind it. */
  addVolume(name: string, instanceId?: string): void {
    this.volumes.set(name, {
      name,
      labels: instanceId === undefined ? {} : instanceLabels(instanceId),
    });
  }

  /** Simulate a container that vanished behind the server's back. */
  forget(containerId: string): void {
    this.containers.delete(containerId);
  }

  /** Both new calls need a container that is up, exactly like the real
   *  daemon: 404 for one it does not have, 409 for one that is not running. */
  private requireRunning(containerId: string): void {
    const container = this.containers.get(containerId);
    if (container === undefined) throw new ContainerNotFoundError(containerId);
    if (container.state !== 'running') throw new ContainerNotRunningError(containerId);
  }

  private guard(): void {
    if (this.unavailable) throw new DockerUnavailableError(new Error('connect ECONNREFUSED'));
  }
}
