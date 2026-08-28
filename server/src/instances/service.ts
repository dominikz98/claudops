import {
  DEFAULT_INSTANCE_LIMITS,
  DEFAULT_UPLOAD_LIMITS,
  type InstanceEnvConfig,
  type UploadLimits,
} from '../config.ts';
import type { InstanceRepository } from '../db/instances.ts';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  type ContainerLimits,
  type ContainerSpec,
  type ContainerSummary,
  type DockerEngine,
  type TerminalSession,
  type TerminalSize,
} from '../docker/engine.ts';
import { containerName, instanceLabels } from '../docker/labels.ts';
import { singleFileArchive } from '../docker/tar.ts';
import { shortId } from '../ids.ts';
import {
  ProjectImageNotReadyError,
  type ProjectService,
  type ProjectTemplate,
} from '../projects/service.ts';

/** A container claudops knows about but Docker no longer has. The startup
 *  reconcile forgets the container id of such a row, so this is what the
 *  instance keeps reporting until somebody deletes it. */
export const MISSING_STATUS = 'missing';

/** The tmux session `docker/base/entrypoint.sh` starts. Overridable because a
 *  project image may bring its own TMUX_SESSION. */
export const DEFAULT_TMUX_SESSION = 'main';

/**
 * `C-b d` -- tmux's default detach binding, which `docker/base/tmux.conf`
 * leaves alone. Sent when the browser disconnects: Docker has no way to kill an
 * exec, and a `tmux attach` that is never asked to leave keeps running with a
 * dangling TTY and keeps sizing the pane
 * (knowledge/docker-cannot-kill-an-exec.md).
 */
export const TMUX_DETACH = Uint8Array.from([0x02, 0x64]);

/**
 * What every instance container gets on top of Docker's default capabilities.
 *
 * Deliberately not configurable: the entrypoint always installs its egress
 * firewall, and without NET_ADMIN that fails, seals the container off and
 * withholds Claude -- so an instance created without this would never be
 * useful, and a switch for it would only be a way to turn the isolation off by
 * accident. Turning the firewall off is FIREWALL_MODE inside the container,
 * which is the operator's decision, not the server's.
 */
export const INSTANCE_CAPABILITIES: readonly string[] = ['NET_ADMIN'];

/**
 * Where an attachment lands. A sibling of the clone, never a directory inside
 * it: the workspace holds `<repo>/` next to this, so an upload cannot turn up
 * in the repository's `git status` and cannot be committed by accident -- which
 * is a property of the path rather than of a `.gitignore` somebody maintains.
 */
export const UPLOAD_DIR = '/workspace/.claudops/uploads';

/** Tar keeps 100 bytes for a name, and a path that has to stay readable in a
 *  console has rather less patience than that. */
const MAX_UPLOAD_NAME = 80;

/** The longest extension worth preserving when a name has to be shortened.
 *  Past this it is not a suffix any more, it is the rest of the name. */
const MAX_EXTENSION = 10;

/**
 * Whether the instance's console can be attached to -- a second axis next to
 * the Docker state, because "the container runs" and "the tmux session is up"
 * are minutes apart: the entrypoint installs a firewall and clones a repository
 * before it starts anything.
 *
 * Who answers this is the point. It comes from the container's own healthcheck
 * (`tmux has-session` in `docker/base/Dockerfile`), not from a timer the server
 * runs against the container's start time.
 *
 * - `none` -- nothing to attach to: no container, or one that is not running.
 * - `starting` -- the container runs, the session is not up yet.
 * - `ready` -- attachable.
 * - `failed` -- the healthcheck gave up: the entrypoint never reached tmux.
 */
export type SessionReadiness = 'none' | 'starting' | 'ready' | 'failed';

export interface CreateInstanceInput {
  name: string;
  /** Repository, branch and PAT all come from here -- an instance is created
   *  from a project, never configured by hand. */
  projectId: string;
}

/** What the API returns. Deliberately without any token field. */
export interface InstanceView {
  id: string;
  name: string;
  image: string;
  containerId: string | null;
  projectId: string | null;
  repoUrl: string | null;
  repoBranch: string | null;
  createdAt: string;
  /** Raw Docker state, or `missing`. Never read from the database. */
  status: string;
  /** Whether the console is attachable, as the container reports it. Read from
   *  Docker on every request, exactly like `status`. */
  session: SessionReadiness;
}

/** Bytes as a person reads them, for a message that has to say what was too
 *  big. Binary units, like every other size in this server. */
function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;

  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'B'}`;
}

/**
 * The name an upload gets inside the container.
 *
 * Everything a browser sends is treated as hostile: only the last path segment
 * survives, anything outside `[A-Za-z0-9._-]` becomes an underscore, and
 * leading dots go -- which is what turns `..` into nothing and refuses it, and
 * also keeps an attachment from hiding itself from an `ls`.
 *
 * The name never reaches a shell. It goes into a tar header and into the argv
 * of `tmux send-keys`, so this is defence in depth rather than the only thing
 * standing between a filename and the container.
 */
export function uploadFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (cleaned === '') throw new InvalidUploadNameError(raw);
  if (cleaned.length <= MAX_UPLOAD_NAME) return cleaned;

  // Shortened from the front, not the back: the extension is what tells Claude
  // it was handed a PNG.
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= MAX_EXTENSION ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_UPLOAD_NAME - extension.length) + extension;
}

/** One file on its way into an instance. */
export interface UploadInput {
  /** As the browser sent it. Sanitised by `uploadFileName`, never used raw. */
  name: string;
  content: Uint8Array;
}

/** What an upload became inside the container. */
export interface UploadView {
  /** The sanitised name, which may differ from the one that was sent. */
  name: string;
  /** The absolute path in the container -- what Claude is told. */
  path: string;
  size: number;
  /**
   * Whether the path was written into the tmux session. `false` for an
   * instance whose session is not up yet: the file is there either way, and
   * refusing the upload over it would be the wrong trade.
   */
  announced: boolean;
}

export class InvalidUploadNameError extends Error {
  constructor(readonly sent: string) {
    super(`'${sent}' is not a usable file name`);
    this.name = 'InvalidUploadNameError';
  }
}

/** One of the two ceilings was hit. `scope` says which, because the way out
 *  differs: a smaller file, or a cleanup inside the instance. */
export class UploadTooLargeError extends Error {
  constructor(
    readonly scope: 'file' | 'instance',
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      scope === 'file'
        ? `the file is ${describeBytes(actualBytes)}, the limit per file is ${describeBytes(limitBytes)}`
        : `the instance would then hold ${describeBytes(actualBytes)} of uploads, the limit is ${describeBytes(limitBytes)}`,
    );
    this.name = 'UploadTooLargeError';
  }
}

export class InstanceNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`instance '${id}' does not exist`);
    this.name = 'InstanceNotFoundError';
  }
}

/** The row exists but no container is attached to it -- the `missing` status.
 *  Nothing to attach a terminal to, nothing to stop or start; the instance can
 *  only be deleted. */
export class ContainerMissingError extends Error {
  constructor(readonly id: string) {
    super(`instance '${id}' has no container`);
    this.name = 'ContainerMissingError';
  }
}

/**
 * The container runs but its session is not attachable. Thrown *before* the
 * exec rather than after it: `tmux attach` against a session that does not
 * exist yet exits non-zero, and by then the socket is open and the only thing
 * left to say is `session_failed`.
 */
export class SessionNotReadyError extends Error {
  constructor(
    readonly id: string,
    readonly readiness: SessionReadiness,
  ) {
    super(
      readiness === 'failed'
        ? `the session of instance '${id}' never came up -- see 'docker logs'`
        : `the session of instance '${id}' is still starting`,
    );
    this.name = 'SessionNotReadyError';
  }
}

/** One resource the reconcile wanted to remove and could not. Collected rather
 *  than thrown: a volume somebody else is holding must not stop the pass from
 *  cleaning up everything else. */
export interface ReconcileFailure {
  resource: string;
  message: string;
}

/** What a startup reconcile did, for the log line that reports it. */
export interface ReconcileReport {
  /** Containers that carried the label but belonged to no instance. */
  removedContainers: string[];
  /** Volumes of instances that no longer exist. */
  removedVolumes: string[];
  /** Instances whose container is gone and who now say so. */
  endedInstances: string[];
  failures: ReconcileFailure[];
}

/**
 * Docker's view of one container, read as "can a console attach to it".
 *
 * A container whose image carries no healthcheck reports nothing, and that is
 * deliberately read as `ready`: an instance started from an image built before
 * the healthcheck existed would otherwise have its console disabled forever,
 * with no way back short of rebuilding the project and recreating the instance.
 * Everything built from `docker/base` since #25 does answer.
 */
function sessionOf(summary: ContainerSummary | undefined): SessionReadiness {
  if (summary === undefined || summary.state !== 'running') return 'none';

  switch (summary.health) {
    case 'starting':
      return 'starting';
    case 'unhealthy':
      return 'failed';
    default:
      return 'ready';
  }
}

export interface InstanceServiceOptions {
  instanceEnv: InstanceEnvConfig;
  /** Where repository, branch, PAT and the image come from. */
  projects: ProjectService;
  tmuxSession?: string | undefined;
  /** What every instance container is capped at. Defaults to
   *  DEFAULT_INSTANCE_LIMITS, which is what the config falls back to as well. */
  limits?: ContainerLimits | undefined;
  /** What may be uploaded into an instance. Defaults to
   *  DEFAULT_UPLOAD_LIMITS, which is what the config falls back to as well. */
  uploads?: UploadLimits | undefined;
  generateId?: () => string;
  now?: () => Date;
}

export class InstanceService {
  private readonly instanceEnv: InstanceEnvConfig;
  private readonly projects: ProjectService;
  private readonly tmuxSession: string;
  private readonly limits: ContainerLimits;
  private readonly uploads: UploadLimits;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly repository: InstanceRepository,
    private readonly engine: DockerEngine,
    options: InstanceServiceOptions,
  ) {
    this.instanceEnv = options.instanceEnv;
    this.projects = options.projects;
    this.tmuxSession = options.tmuxSession ?? DEFAULT_TMUX_SESSION;
    this.limits = options.limits ?? DEFAULT_INSTANCE_LIMITS;
    this.uploads = options.uploads ?? DEFAULT_UPLOAD_LIMITS;
    this.generateId = options.generateId ?? shortId;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateInstanceInput): Promise<InstanceView> {
    // Read before anything is written: an unknown project, or one whose PAT no
    // longer decrypts, has to fail without leaving a row or a container behind.
    const template = this.projects.template(input.projectId);

    // The environment is prebuilt, so there is nothing to fall back to: a
    // project whose image is still building or failed cannot start an instance
    // (knowledge/project-images-not-devcontainer-features.md).
    if (template.imageStatus !== 'ready') {
      throw new ProjectImageNotReadyError(template.id, template.imageStatus);
    }

    const id = this.generateId();
    const record = this.repository.insert({
      id,
      name: input.name,
      // Snapshotted like the repository: which image this instance was started
      // from stays readable after the project is rebuilt.
      image: template.image,
      projectId: template.id,
      // A snapshot, not a reference: what the container was told to clone stays
      // readable on the instance even after the project moves on.
      repoUrl: template.repoUrl,
      repoBranch: template.repoBranch,
      createdAt: this.now().toISOString(),
    });

    // The row comes first so a container can never exist without claudops
    // knowing about it -- an unreferenced container would be unfindable, while
    // a row without a container shows up as `missing` and is cleanable.
    let containerId: string;
    try {
      containerId = await this.engine.runContainer(this.specFor(id, template));
    } catch (error) {
      this.repository.delete(id);
      throw error;
    }

    try {
      this.repository.attachContainer(id, containerId);
    } catch (error) {
      await this.engine.removeContainer(containerId);
      this.repository.delete(id);
      throw error;
    }

    // `starting`, without asking Docker: the container was started microseconds
    // ago, so no healthcheck has run yet and the answer is known. Saying
    // anything else here would hand the caller a console it cannot attach to.
    return { ...record, containerId, status: 'running', session: 'starting' };
  }

  async list(): Promise<InstanceView[]> {
    const containers = await this.containerSummaries();
    return this.repository.list().map((record) => this.view(record, containers));
  }

  async get(id: string): Promise<InstanceView> {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);

    return this.view(record, await this.containerSummaries());
  }

  async delete(id: string): Promise<void> {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);

    // Container first: if the removal fails the row survives and the instance
    // can be deleted again. The other order would orphan the container.
    if (record.containerId !== null) {
      await this.engine.removeContainer(record.containerId);
    }

    // The container took its anonymous volumes with it. This is the second
    // half: a volume that carries the instance label without hanging off that
    // container -- one left behind by a `docker rm` without `-v`, or by a
    // container that was already gone -- would otherwise outlive the instance
    // with nothing left to name it.
    for (const volume of await this.volumesOf(id)) {
      await this.engine.removeVolume(volume);
    }

    this.repository.delete(id);
  }

  /**
   * Stops the container without touching the instance. The workspace, the tmux
   * session and its scrollback are in the container's filesystem and come back
   * with `start` -- what is lost is whatever was only in memory, so Claude is
   * started again by the entrypoint rather than resumed.
   */
  async stop(id: string): Promise<InstanceView> {
    await this.engine.stopContainer(this.containerOf(id));
    return this.get(id);
  }

  async start(id: string): Promise<InstanceView> {
    await this.engine.startContainer(this.containerOf(id));
    return this.get(id);
  }

  /**
   * Brings Docker and the database back into agreement, once, at startup.
   *
   * Three kinds of leftover exist, all of them from something that died between
   * two steps -- a killed server, a `docker rm` by hand, a create that failed
   * after the container was up:
   *
   * - a labelled container no instance points at: removed, with its volumes
   * - a labelled volume whose instance no longer exists: removed
   * - an instance whose container Docker does not have: told so, by forgetting
   *   the container id -- the row stays, because it is somebody's instance and
   *   deleting rows behind their back is not cleanup
   *
   * Nothing here runs periodically. Docker is asked for the state on every
   * request anyway, so a reconcile in between would only race with the user.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      removedContainers: [],
      removedVolumes: [],
      endedInstances: [],
      failures: [],
    };

    const records = this.repository.list();
    const knownInstances = new Set(records.map((record) => record.id));
    // Keyed by container id: a container whose label names an instance that
    // points at a *different* container is an orphan too -- a create that was
    // rolled back and run again leaves exactly that.
    const claimed = new Map<string, string>();
    for (const record of records) {
      if (record.containerId !== null) claimed.set(record.containerId, record.id);
    }

    const live = new Set<string>();
    for (const container of await this.engine.listManagedContainers()) {
      const owner = claimed.get(container.containerId);
      if (owner !== undefined && owner === container.instanceId) {
        live.add(container.containerId);
        continue;
      }

      await this.attempt(report, `container ${container.containerId}`, async () => {
        await this.engine.removeContainer(container.containerId);
        report.removedContainers.push(container.containerId);
      });
    }

    for (const record of records) {
      if (record.containerId === null || live.has(record.containerId)) continue;
      if (this.repository.detachContainer(record.id)) report.endedInstances.push(record.id);
    }

    for (const volume of await this.engine.listManagedVolumes()) {
      if (volume.instanceId !== undefined && knownInstances.has(volume.instanceId)) continue;

      await this.attempt(report, `volume ${volume.name}`, async () => {
        await this.engine.removeVolume(volume.name);
        report.removedVolumes.push(volume.name);
      });
    }

    return report;
  }

  /**
   * Attaches to the instance's tmux session. Every connection gets its own exec
   * and its own tmux client; the session itself outlives all of them, which is
   * what makes a reconnect find its scrollback and its running Claude again.
   */
  async openTerminal(id: string, size?: TerminalSize): Promise<TerminalSession> {
    const containerId = this.containerOf(id);

    // Asked before the exec, not diagnosed after it. `none` is deliberately not
    // refused here: a container that is not running has its own error from the
    // attach, and "not running" says more than "not ready".
    const readiness = sessionOf((await this.containerSummaries()).get(containerId));
    if (readiness === 'starting' || readiness === 'failed') {
      throw new SessionNotReadyError(id, readiness);
    }

    return this.engine.attachTerminal(containerId, {
      // `attach`, not `new -A`: the session belongs to the entrypoint, and
      // creating one here would produce a console nobody is watching over.
      //
      // `-u` says the client takes UTF-8. claudops-base sets LANG for the same
      // reason, but a project image (#7) might not, and without it tmux writes
      // an underscore for every multi-byte character
      // (knowledge/tmux-needs-a-utf8-client.md).
      command: ['tmux', '-u', 'attach', '-t', this.tmuxSession],
      size,
      closeInput: TMUX_DETACH,
    });
  }

  /**
   * Puts one file into the instance's uploads directory and writes its path
   * into the tmux session, so it is in Claude's prompt without anybody typing
   * it out.
   *
   * The path is inserted, not submitted: `send-keys -l` types the characters
   * and stops there. An Enter as well would send whatever the user had
   * half-written in the prompt along with it.
   */
  async upload(id: string, input: UploadInput): Promise<UploadView> {
    // Name and size first: both are answerable without Docker, and a request
    // that cannot succeed should not cost a round trip to the daemon.
    const name = uploadFileName(input.name);
    const size = input.content.length;
    if (size > this.uploads.maxFileBytes) {
      throw new UploadTooLargeError('file', this.uploads.maxFileBytes, size);
    }

    const containerId = this.containerOf(id);
    const summary = (await this.containerSummaries()).get(containerId);
    if (summary === undefined) throw new ContainerNotFoundError(containerId);
    if (summary.state !== 'running') throw new ContainerNotRunningError(containerId);

    const used = await this.usedUploadBytes(containerId);
    if (used + size > this.uploads.maxInstanceBytes) {
      throw new UploadTooLargeError('instance', this.uploads.maxInstanceBytes, used + size);
    }

    // The archive carries the name; the target is the directory its entry is
    // extracted into, which the reading above has just made sure exists.
    await this.engine.putArchive(containerId, UPLOAD_DIR, singleFileArchive(name, input.content));

    const path = `${UPLOAD_DIR}/${name}`;
    const announced =
      sessionOf(summary) === 'ready' ? await this.announce(containerId, path) : false;

    return { name, path, size, announced };
  }

  /**
   * What the uploads directory holds, in bytes, creating it on the way.
   *
   * `find -printf` rather than `du`: du counts the directory entry itself, so
   * an empty uploads directory would already report four kilobytes against the
   * quota. The summing happens here rather than in an `awk` the image is not
   * guaranteed to carry.
   */
  private async usedUploadBytes(containerId: string): Promise<number> {
    const result = await this.engine.runCommand(containerId, [
      'sh',
      '-c',
      `mkdir -p ${UPLOAD_DIR} && find ${UPLOAD_DIR} -type f -printf '%s\\n'`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`the uploads directory is not usable: ${result.output.trim()}`);
    }

    return result.output
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((bytes) => Number.isFinite(bytes))
      .reduce((total, bytes) => total + bytes, 0);
  }

  /** Types the path into the pane. A tmux that refuses is not a failed upload:
   *  the file is in the container, and the answer says the path was not
   *  written. */
  private async announce(containerId: string, path: string): Promise<boolean> {
    const result = await this.engine.runCommand(containerId, [
      'tmux',
      'send-keys',
      '-t',
      this.tmuxSession,
      // Literally, and with a trailing space so the next word the user types
      // does not run into the path.
      '-l',
      `${path} `,
    ]);
    return result.exitCode === 0;
  }

  /** The container of an instance that has to have one. Everything that talks
   *  to a running container goes through here, so "no such instance" and "no
   *  container" are one decision rather than four. */
  private containerOf(id: string): string {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);
    if (record.containerId === null) throw new ContainerMissingError(id);
    return record.containerId;
  }

  private async volumesOf(instanceId: string): Promise<string[]> {
    const volumes = await this.engine.listManagedVolumes();
    return volumes
      .filter((volume) => volume.instanceId === instanceId)
      .map((volume) => volume.name);
  }

  /** Runs one removal and records a failure rather than aborting the pass:
   *  a volume somebody else is holding must not keep the rest of the leftovers
   *  on the disk. */
  private async attempt(
    report: ReconcileReport,
    resource: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      report.failures.push({
        resource,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async containerSummaries(): Promise<Map<string, ContainerSummary>> {
    const containers = await this.engine.listManagedContainers();
    return new Map(containers.map((container) => [container.containerId, container]));
  }

  /** The database row plus the two things only Docker knows. Both are joined in
   *  one place so `list` and `get` cannot drift apart. */
  private view(
    record: Omit<InstanceView, 'status' | 'session'>,
    containers: Map<string, ContainerSummary>,
  ): InstanceView {
    const summary = record.containerId === null ? undefined : containers.get(record.containerId);
    return {
      ...record,
      status: summary?.state ?? MISSING_STATUS,
      session: sessionOf(summary),
    };
  }

  private specFor(id: string, template: ProjectTemplate): ContainerSpec {
    return {
      instanceId: id,
      name: containerName(id),
      image: template.image,
      env: this.envFor(template),
      labels: instanceLabels(id),
      limits: this.limits,
      capAdd: INSTANCE_CAPABILITIES,
    };
  }

  /** Exactly the variables docker/base/README.md documents. An
   *  ANTHROPIC_API_KEY is never among them -- it would override the
   *  subscription (knowledge/auth-token-handling.md). The PAT is handed over as
   *  GIT_TOKEN and read by the credential helper, so it never reaches
   *  .git/config or the console
   *  (knowledge/git-token-via-credential-helper.md). */
  private envFor(template: ProjectTemplate): Record<string, string> {
    const env: Record<string, string> = {};
    const set = (key: string, value: string | undefined): void => {
      if (value !== undefined && value !== '') env[key] = value;
    };

    set('REPO_URL', template.repoUrl);
    set('REPO_BRANCH', template.repoBranch ?? undefined);
    set('GIT_TOKEN', template.gitToken);
    set('GIT_USER_NAME', this.instanceEnv.gitUserName);
    set('GIT_USER_EMAIL', this.instanceEnv.gitUserEmail);
    set('CLAUDE_CODE_OAUTH_TOKEN', this.instanceEnv.claudeOauthToken);
    set('FIREWALL_ALLOW', this.instanceEnv.firewallAllow);

    return env;
  }
}
