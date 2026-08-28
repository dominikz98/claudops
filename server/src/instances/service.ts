import { DEFAULT_INSTANCE_LIMITS, type InstanceEnvConfig } from '../config.ts';
import type { InstanceRepository } from '../db/instances.ts';
import type {
  ContainerLimits,
  ContainerSpec,
  ContainerSummary,
  DockerEngine,
  TerminalSession,
  TerminalSize,
} from '../docker/engine.ts';
import { containerName, instanceLabels } from '../docker/labels.ts';
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

/**
 * Model aliases an instance may be started with.
 *
 * Aliases rather than model ids: an id goes stale with the next release, an
 * alias does not. The absence of a choice -- `null` -- is Claude Code's own
 * default and is deliberately not a member of this list, because "no flag" is
 * not a value that can be typed into a running session either.
 *
 * Mirrored in web/src/api.ts. The route schema validates against this list, and
 * so does the service: a value that is neither is a bug somewhere, and finding
 * it here beats finding it as a Claude Code startup warning inside a container.
 */
export const INSTANCE_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Effort levels, as Claude Code's `--effort` takes them. `max` is session-only
 * there, which costs nothing here: every container start passes the flag again.
 */
export const INSTANCE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What Claude Code is asked to run as. `null` on either means "whatever Claude
 *  Code picks itself" -- no flag at start, nothing typed into a session. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

/** A PATCH of the above: a field left out keeps what is stored, an explicit
 *  `null` is a reset to Claude Code's own default. */
export type ModelChoiceChanges = Partial<ModelChoice>;

/**
 * How long the container gets between the text of a slash command and the
 * Enter that submits it. The TUI reads its input in chunks, and an Enter in the
 * same read as the text it belongs to is swallowed -- the command then sits in
 * the prompt unsent, which looks exactly like a switch that did nothing.
 */
export const SEND_KEYS_PAUSE_MS = 400;

export interface CreateInstanceInput {
  name: string;
  /** Repository, branch and PAT all come from here -- an instance is created
   *  from a project, never configured by hand. */
  projectId: string;
  /** Both optional: an instance created without them runs whatever Claude Code
   *  defaults to, which is what every instance did before #16. */
  model?: string | null | undefined;
  effort?: string | null | undefined;
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
  /** What Claude Code was started as, and what it has been switched to since.
   *  Read from the database, unlike `status` -- a restarted container has no
   *  process left to ask. */
  model: string | null;
  effort: string | null;
  createdAt: string;
  /** Raw Docker state, or `missing`. Never read from the database. */
  status: string;
  /** Whether the console is attachable, as the container reports it. Read from
   *  Docker on every request, exactly like `status`. */
  session: SessionReadiness;
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
        : readiness === 'none'
          ? `instance '${id}' is not running`
          : `the session of instance '${id}' is still starting`,
    );
    this.name = 'SessionNotReadyError';
  }
}

/**
 * A command the server ran inside a container came back non-zero. Its own error
 * because "the exec could not start" and "the exec ran and refused" are
 * different problems: the first is a container that is gone, the second is
 * `tmux` saying it has no such pane.
 *
 * `output` is whatever the command printed. Nothing secret goes into one of
 * these commands -- a model alias and a tmux target -- so it is safe to repeat.
 */
export class ContainerCommandFailedError extends Error {
  constructor(
    command: readonly string[],
    readonly exitCode: number,
    readonly output: string,
  ) {
    const detail = output.trim();
    super(
      `'${command.join(' ')}' failed in the container with exit ${String(exitCode)}` +
        (detail === '' ? '' : `: ${detail}`),
    );
    this.name = 'ContainerCommandFailedError';
  }
}

/** A model or effort value that is in neither list. Its own error rather than a
 *  generic one so the route can answer 400 and name the field. */
export class UnknownChoiceError extends Error {
  constructor(
    readonly field: 'model' | 'effort',
    readonly value: string,
  ) {
    super(
      `'${value}' is not a known ${field} -- one of ${(field === 'model' ? INSTANCE_MODELS : INSTANCE_EFFORTS).join(', ')}`,
    );
    this.name = 'UnknownChoiceError';
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

/**
 * The value a PATCH leaves behind: what was asked for, what was stored, or a
 * refusal. Validated here as well as in the route schema -- the route is one
 * caller, this is the invariant.
 */
function resolveChoice(
  field: 'model' | 'effort',
  next: string | null | undefined,
  stored: string | null,
): string | null {
  if (next === undefined) return stored;
  if (next === null) return null;

  const allowed = field === 'model' ? INSTANCE_MODELS : INSTANCE_EFFORTS;
  if (!allowed.includes(next)) throw new UnknownChoiceError(field, next);
  return next;
}

/**
 * Writes the two files `docker/base/entrypoint.sh` prefers over its environment
 * on the next container start.
 *
 * An *empty* file rather than a removed one is what a reset writes: a missing
 * file falls back to the environment, and the environment still carries the
 * value the instance was created with -- Docker cannot change it afterwards.
 *
 * The values travel as arguments, not inside the script text, so nothing here
 * depends on what they contain.
 */
function overrideCommand(choice: ModelChoice): string[] {
  return [
    'sh',
    '-c',
    'mkdir -p ~/.claudops' +
      ' && printf %s "$1" > ~/.claudops/model' +
      ' && printf %s "$2" > ~/.claudops/effort',
    'sh',
    choice.model ?? '',
    choice.effort ?? '',
  ];
}

export interface InstanceServiceOptions {
  instanceEnv: InstanceEnvConfig;
  /** Where repository, branch, PAT and the image come from. */
  projects: ProjectService;
  tmuxSession?: string | undefined;
  /** What every instance container is capped at. Defaults to
   *  DEFAULT_INSTANCE_LIMITS, which is what the config falls back to as well. */
  limits?: ContainerLimits | undefined;
  generateId?: () => string;
  now?: () => Date;
  /** How long to wait between the text of a slash command and its Enter.
   *  A test sets it to 0; nothing else has a reason to change it. */
  sendKeysPauseMs?: number | undefined;
}

export class InstanceService {
  private readonly instanceEnv: InstanceEnvConfig;
  private readonly projects: ProjectService;
  private readonly tmuxSession: string;
  private readonly limits: ContainerLimits;
  private readonly generateId: () => string;
  private readonly now: () => Date;
  private readonly sendKeysPauseMs: number;

  constructor(
    private readonly repository: InstanceRepository,
    private readonly engine: DockerEngine,
    options: InstanceServiceOptions,
  ) {
    this.instanceEnv = options.instanceEnv;
    this.projects = options.projects;
    this.tmuxSession = options.tmuxSession ?? DEFAULT_TMUX_SESSION;
    this.limits = options.limits ?? DEFAULT_INSTANCE_LIMITS;
    this.generateId = options.generateId ?? shortId;
    this.now = options.now ?? (() => new Date());
    this.sendKeysPauseMs = options.sendKeysPauseMs ?? SEND_KEYS_PAUSE_MS;
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

    // Refused before the row is written, for the same reason the template is
    // read first: a typo in a model name must not leave a container behind.
    const choice: ModelChoice = {
      model: resolveChoice('model', input.model, null),
      effort: resolveChoice('effort', input.effort, null),
    };

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
      model: choice.model,
      effort: choice.effort,
      createdAt: this.now().toISOString(),
    });

    // The row comes first so a container can never exist without claudops
    // knowing about it -- an unreferenced container would be unfindable, while
    // a row without a container shows up as `missing` and is cleanable.
    let containerId: string;
    try {
      containerId = await this.engine.runContainer(this.specFor(id, template, choice));
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
   * Switches the model, the effort level, or both, on a running instance.
   *
   * A switch has to reach two places, and reaching only one of them is worse
   * than reaching neither: the session that is running right now, through the
   * slash commands a human would type, and the *next* container start, through
   * the override files the entrypoint reads. Docker cannot change a created
   * container's environment, so without the second half a `docker restart`
   * would quietly bring back the value the instance was created with while the
   * list kept showing the new one.
   *
   * The database comes last for the same reason: a row that claims something
   * the container was never told is the one failure mode with no way back.
   */
  async setModelEffort(id: string, changes: ModelChoiceChanges): Promise<InstanceView> {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);

    const model = resolveChoice('model', changes.model, record.model);
    const effort = resolveChoice('effort', changes.effort, record.effort);
    // Nothing to do, and nothing to refuse over either: a PATCH that changes
    // nothing must not fail on a container that happens to be stopped.
    if (model === record.model && effort === record.effort) return this.get(id);

    if (record.containerId === null) throw new ContainerMissingError(id);
    const containerId = record.containerId;

    // Asked before the first exec, exactly like openTerminal does: `tmux
    // send-keys` against a session that does not exist yet fails, and by then
    // the override files are already written.
    const readiness = sessionOf((await this.containerSummaries()).get(containerId));
    if (readiness !== 'ready') throw new SessionNotReadyError(id, readiness);

    await this.run(containerId, overrideCommand({ model, effort }));

    // `/model` before `/effort`: which levels a model offers depends on the
    // model, so the other order can have the level land on the old one.
    //
    // A reset to Claude Code's own default has no `/model` to type -- bare
    // `/model` opens a picker nobody is there to answer -- so it reaches the
    // running session not at all and the next start through the empty override
    // file. `/effort` does have `auto` for it. The UI offers a reset on neither,
    // which is why this asymmetry stays out of sight.
    if (model !== record.model && model !== null) {
      await this.sendLine(containerId, `/model ${model}`);
    }
    if (effort !== record.effort) {
      await this.sendLine(containerId, `/effort ${effort ?? 'auto'}`);
    }

    this.repository.setModelEffort(id, model, effort);
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
   * Types one line into the instance's tmux session and submits it, the way a
   * human at the console would.
   *
   * Two execs rather than one `sh -c`: the line reaches tmux as an argument, so
   * nothing about it has to survive a shell. `-l` keeps tmux from reading
   * `/model` as the name of a key.
   *
   * The target is the *first* pane of the first window, not the session: bare
   * `-t <session>` means "wherever the session happens to be focused", and a
   * second window somebody opened in the console would swallow the command.
   * Claude runs in the pane the entrypoint's `tmux new-session` created, which
   * is this one -- `docker/base/tmux.conf` leaves `base-index` at 0.
   */
  private async sendLine(containerId: string, line: string): Promise<void> {
    const target = ['-t', `${this.tmuxSession}:0.0`];
    await this.run(containerId, ['tmux', 'send-keys', ...target, '-l', '--', line]);
    if (this.sendKeysPauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendKeysPauseMs));
    }
    await this.run(containerId, ['tmux', 'send-keys', ...target, 'Enter']);
  }

  /**
   * One command in a container, with its exit code read rather than discarded.
   *
   * A `send-keys` that ran and failed -- a pane that is not there, a session
   * that ended between the readiness check and this -- would otherwise be
   * indistinguishable from one that worked, and the row would go on to record a
   * model nobody typed.
   */
  private async run(containerId: string, command: string[]): Promise<void> {
    const result = await this.engine.runCommand(containerId, command);
    if (result.exitCode !== 0) {
      throw new ContainerCommandFailedError(command, result.exitCode, result.output);
    }
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

  private specFor(id: string, template: ProjectTemplate, choice: ModelChoice): ContainerSpec {
    return {
      instanceId: id,
      name: containerName(id),
      image: template.image,
      env: this.envFor(template, choice),
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
  private envFor(template: ProjectTemplate, choice: ModelChoice): Record<string, string> {
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

    // Read by the entrypoint and turned into `--model` / `--effort`, not by
    // Claude Code itself: ANTHROPIC_MODEL and CLAUDE_CODE_EFFORT_LEVEL would be
    // the obvious variables, and both are wrong here. The effort one outranks
    // every other way of setting the level, so a later `/effort` in the console
    // would silently do nothing -- see
    // knowledge/the-effort-env-var-outranks-the-slash-command.md.
    set('CLAUDE_MODEL', choice.model ?? undefined);
    set('CLAUDE_EFFORT', choice.effort ?? undefined);

    return env;
  }
}
