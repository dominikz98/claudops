import { randomBytes } from 'node:crypto';
import type { InstanceEnvConfig } from '../config.ts';
import type { InstanceRepository } from '../db/instances.ts';
import type {
  ContainerSpec,
  DockerEngine,
  TerminalSession,
  TerminalSize,
} from '../docker/engine.ts';
import { containerName, instanceLabels } from '../docker/labels.ts';

/** A container claudops knows about but Docker no longer has. #8 reconciles
 *  these away at startup; until then they stay visible instead of silently
 *  looking healthy. */
export const MISSING_STATUS = 'missing';

/** The tmux session `docker/base/entrypoint.sh` starts. Overridable because a
 *  project image (#7) may bring its own TMUX_SESSION. */
export const DEFAULT_TMUX_SESSION = 'main';

/**
 * `C-b d` -- tmux's default detach binding, which `docker/base/tmux.conf`
 * leaves alone. Sent when the browser disconnects: Docker has no way to kill an
 * exec, and a `tmux attach` that is never asked to leave keeps running with a
 * dangling TTY and keeps sizing the pane
 * (knowledge/docker-cannot-kill-an-exec.md).
 */
export const TMUX_DETACH = Uint8Array.from([0x02, 0x64]);

export interface CreateInstanceInput {
  name: string;
  repoUrl?: string | undefined;
  repoBranch?: string | undefined;
  /** PAT for a private repo. Goes straight into the container environment and
   *  is never stored or logged (knowledge/git-token-via-credential-helper.md). */
  gitToken?: string | undefined;
}

/** What the API returns. Deliberately without any token field. */
export interface InstanceView {
  id: string;
  name: string;
  image: string;
  containerId: string | null;
  repoUrl: string | null;
  repoBranch: string | null;
  createdAt: string;
  /** Raw Docker state, or `missing`. Never read from the database. */
  status: string;
}

export class InstanceNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`instance '${id}' does not exist`);
    this.name = 'InstanceNotFoundError';
  }
}

/** The row exists but no container is attached to it -- the `missing` status.
 *  There is nothing to attach a terminal to until #8 reconciles it away. */
export class ContainerMissingError extends Error {
  constructor(readonly id: string) {
    super(`instance '${id}' has no container`);
    this.name = 'ContainerMissingError';
  }
}

export interface InstanceServiceOptions {
  baseImage: string;
  instanceEnv: InstanceEnvConfig;
  tmuxSession?: string | undefined;
  generateId?: () => string;
  now?: () => Date;
}

/** Short, URL-safe and still unique enough for a handful of containers. */
function shortId(): string {
  return randomBytes(6).toString('hex');
}

export class InstanceService {
  private readonly baseImage: string;
  private readonly instanceEnv: InstanceEnvConfig;
  private readonly tmuxSession: string;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly repository: InstanceRepository,
    private readonly engine: DockerEngine,
    options: InstanceServiceOptions,
  ) {
    this.baseImage = options.baseImage;
    this.instanceEnv = options.instanceEnv;
    this.tmuxSession = options.tmuxSession ?? DEFAULT_TMUX_SESSION;
    this.generateId = options.generateId ?? shortId;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateInstanceInput): Promise<InstanceView> {
    const id = this.generateId();
    const record = this.repository.insert({
      id,
      name: input.name,
      image: this.baseImage,
      repoUrl: input.repoUrl ?? null,
      repoBranch: input.repoBranch ?? null,
      createdAt: this.now().toISOString(),
    });

    // The row comes first so a container can never exist without claudops
    // knowing about it -- an unreferenced container would be unfindable, while
    // a row without a container shows up as `missing` and is cleanable.
    let containerId: string;
    try {
      containerId = await this.engine.runContainer(this.specFor(id, input));
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

    return { ...record, containerId, status: 'running' };
  }

  async list(): Promise<InstanceView[]> {
    const states = await this.containerStates();
    return this.repository.list().map((record) => ({
      ...record,
      status: this.statusOf(record.containerId, states),
    }));
  }

  async get(id: string): Promise<InstanceView> {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);

    const states = await this.containerStates();
    return { ...record, status: this.statusOf(record.containerId, states) };
  }

  async delete(id: string): Promise<void> {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);

    // Container first: if the removal fails the row survives and the instance
    // can be deleted again. The other order would orphan the container.
    if (record.containerId !== null) {
      await this.engine.removeContainer(record.containerId);
    }
    this.repository.delete(id);
  }

  /**
   * Attaches to the instance's tmux session. Every connection gets its own exec
   * and its own tmux client; the session itself outlives all of them, which is
   * what makes a reconnect find its scrollback and its running Claude again.
   */
  async openTerminal(id: string, size?: TerminalSize): Promise<TerminalSession> {
    const record = this.repository.get(id);
    if (record === undefined) throw new InstanceNotFoundError(id);
    if (record.containerId === null) throw new ContainerMissingError(id);

    return this.engine.attachTerminal(record.containerId, {
      // `attach`, not `new -A`: the session belongs to the entrypoint, and
      // creating one here would produce a console nobody is watching over.
      command: ['tmux', 'attach', '-t', this.tmuxSession],
      size,
      closeInput: TMUX_DETACH,
    });
  }

  private async containerStates(): Promise<Map<string, string>> {
    const containers = await this.engine.listManagedContainers();
    return new Map(containers.map((container) => [container.containerId, container.state]));
  }

  private statusOf(containerId: string | null, states: Map<string, string>): string {
    if (containerId === null) return MISSING_STATUS;
    return states.get(containerId) ?? MISSING_STATUS;
  }

  private specFor(id: string, input: CreateInstanceInput): ContainerSpec {
    return {
      instanceId: id,
      name: containerName(id),
      image: this.baseImage,
      env: this.envFor(input),
      labels: instanceLabels(id),
    };
  }

  /** Exactly the variables docker/base/README.md documents. An
   *  ANTHROPIC_API_KEY is never among them -- it would override the
   *  subscription (knowledge/auth-token-handling.md). */
  private envFor(input: CreateInstanceInput): Record<string, string> {
    const env: Record<string, string> = {};
    const set = (key: string, value: string | undefined): void => {
      if (value !== undefined && value !== '') env[key] = value;
    };

    set('REPO_URL', input.repoUrl);
    set('REPO_BRANCH', input.repoBranch);
    set('GIT_TOKEN', input.gitToken);
    set('GIT_USER_NAME', this.instanceEnv.gitUserName);
    set('GIT_USER_EMAIL', this.instanceEnv.gitUserEmail);
    set('CLAUDE_CODE_OAUTH_TOKEN', this.instanceEnv.claudeOauthToken);

    return env;
  }
}
