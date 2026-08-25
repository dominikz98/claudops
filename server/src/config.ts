import { resolve } from 'node:path';
import type { ContainerLimits } from './docker/engine.ts';
import { defaultProjectContext } from './projects/images.ts';
import { createCipher, parseSecretKey, type SecretCipher } from './secrets/cipher.ts';

/**
 * Server configuration, read from the environment exactly once at startup.
 *
 * Secrets live here and in the container environment only -- never in the
 * database, the log or an API response (see knowledge/auth-token-handling.md).
 */

export interface InstanceEnvConfig {
  /** From `claude setup-token`. Never an ANTHROPIC_API_KEY -- that one would
   *  override the subscription and bill per token. */
  claudeOauthToken: string | undefined;
  gitUserName: string | undefined;
  gitUserEmail: string | undefined;
}

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
  databaseFile: string;
  /** What a project image is built `FROM`. Instances themselves start from
   *  their project's image, never from this one. */
  baseImage: string;
  /** Directory holding the project template Dockerfile. */
  projectContext: string;
  /** Channel dotnet-install.sh gets for the dotnet building block. */
  dotnetChannel: string;
  /** Directory the built web UI is served from. */
  webRoot: string;
  /** The tmux session the terminal bridge attaches to. Matches TMUX_SESSION in
   *  claudops-base; only a project image with its own entrypoint needs another. */
  tmuxSession: string;
  /** `undefined` leaves the transport to dockerode, which then honours
   *  DOCKER_HOST. */
  dockerSocket: string | undefined;
  /**
   * Encrypts and decrypts the PAT a project keeps. A cipher rather than the key
   * itself: `JSON.stringify` of a Buffer prints every one of its bytes, and a
   * config object ends up in a log line sooner or later. Without
   * CLAUDOPS_SECRET_KEY this is the variant that refuses rather than the one
   * that encrypts (server/src/secrets/cipher.ts).
   */
  cipher: SecretCipher;
  instanceEnv: InstanceEnvConfig;
  /** CPU and memory ceiling every instance container is created with. */
  instanceLimits: ContainerLimits;
}

export class ConfigError extends Error {}

const DEFAULT_PORT = 8080;

/**
 * Two cores and four gigabytes: enough for a `pnpm install` plus a test run,
 * and small enough that the NUC still answers while three instances do it at
 * once. A box with more to spare raises them.
 */
export const DEFAULT_INSTANCE_LIMITS: ContainerLimits = {
  cpus: 2,
  memoryBytes: 4 * 1024 * 1024 * 1024,
};

/** Docker refuses a memory limit below this, and the message it gives back is
 *  less clear than the one here. */
const MIN_MEMORY_BYTES = 6 * 1024 * 1024;

/** Current LTS. A project that needs another one is a `CLAUDOPS_DOTNET_CHANNEL`
 *  away, so this is a default rather than a decision. */
const DEFAULT_DOTNET_CHANNEL = '10.0';

/**
 * Where `@claudops/web` puts its build. Resolved from this module's own
 * location rather than from the working directory, because the server is
 * started from the repository root by hand and from `server/` by the smoke
 * tests -- and it is two levels down either way, as `server/src` in development
 * and as `server/dist` after a build.
 */
export function defaultWebRoot(here: string = import.meta.dirname): string {
  return resolve(here, '../../web/dist');
}

/** Docker Desktop on the Windows dev host listens on a named pipe, the NUC on
 *  a unix socket. */
export function defaultDockerSocket(platform: string = process.platform): string {
  return platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

function port(env: NodeJS.ProcessEnv): number {
  const raw = optional(env, 'CLAUDOPS_PORT');
  if (raw === undefined) return DEFAULT_PORT;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(`CLAUDOPS_PORT must be a port number, got '${raw}'`);
  }
  return parsed;
}

/**
 * `docker run --memory` notation: a plain byte count, or a number with a `b`,
 * `k`, `m` or `g` suffix. Written the way an operator would write it on the
 * command line, because that is where the number comes from.
 */
export function parseMemory(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?$/i.exec(raw.trim());
  if (match === null) return undefined;

  const factors: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  const value = Number(match[1]) * (factors[match[2]?.toLowerCase() ?? 'b'] ?? 1);
  // Docker takes whole bytes, and `1.5g` is a legitimate way to say one.
  return Math.floor(value);
}

function instanceLimits(env: NodeJS.ProcessEnv): ContainerLimits {
  const rawCpus = optional(env, 'CLAUDOPS_INSTANCE_CPUS');
  const cpus = rawCpus === undefined ? DEFAULT_INSTANCE_LIMITS.cpus : Number(rawCpus);
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new ConfigError(`CLAUDOPS_INSTANCE_CPUS must be a positive number, got '${rawCpus ?? ''}'`);
  }

  const rawMemory = optional(env, 'CLAUDOPS_INSTANCE_MEMORY');
  const memoryBytes =
    rawMemory === undefined ? DEFAULT_INSTANCE_LIMITS.memoryBytes : parseMemory(rawMemory);
  if (memoryBytes === undefined || memoryBytes < MIN_MEMORY_BYTES) {
    throw new ConfigError(
      `CLAUDOPS_INSTANCE_MEMORY must be a byte count with an optional b/k/m/g suffix, at least 6m, got '${rawMemory ?? ''}'`,
    );
  }

  return { cpus, memoryBytes };
}

/**
 * A missing key is not a configuration error: the server starts, projects work,
 * only a PAT cannot be stored -- and the request that tries says so. A key that
 * is present but unusable is an error, because the alternative is discovering it
 * when somebody saves a token.
 */
function cipher(env: NodeJS.ProcessEnv): SecretCipher {
  const raw = optional(env, 'CLAUDOPS_SECRET_KEY');
  if (raw === undefined) return createCipher(undefined);

  const key = parseSecretKey(raw);
  if (key === undefined) {
    throw new ConfigError('CLAUDOPS_SECRET_KEY must be 32 bytes, base64 or hex encoded');
  }
  return createCipher(key);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // DOCKER_HOST wins over the platform default: dockerode reads it itself, so
  // we hand it no socket path at all in that case.
  const dockerSocket =
    optional(env, 'DOCKER_SOCKET') ??
    (optional(env, 'DOCKER_HOST') !== undefined ? undefined : defaultDockerSocket());

  return {
    host: optional(env, 'CLAUDOPS_HOST') ?? '0.0.0.0',
    port: port(env),
    logLevel: optional(env, 'CLAUDOPS_LOG_LEVEL') ?? 'info',
    databaseFile: optional(env, 'CLAUDOPS_DB') ?? 'data/claudops.db',
    baseImage: optional(env, 'CLAUDOPS_BASE_IMAGE') ?? 'claudops-base',
    projectContext: optional(env, 'CLAUDOPS_PROJECT_CONTEXT') ?? defaultProjectContext(),
    dotnetChannel: optional(env, 'CLAUDOPS_DOTNET_CHANNEL') ?? DEFAULT_DOTNET_CHANNEL,
    webRoot: optional(env, 'CLAUDOPS_WEB_ROOT') ?? defaultWebRoot(),
    tmuxSession: optional(env, 'CLAUDOPS_TMUX_SESSION') ?? 'main',
    dockerSocket,
    cipher: cipher(env),
    instanceLimits: instanceLimits(env),
    instanceEnv: {
      claudeOauthToken: optional(env, 'CLAUDE_CODE_OAUTH_TOKEN'),
      gitUserName: optional(env, 'CLAUDOPS_GIT_USER_NAME'),
      gitUserEmail: optional(env, 'CLAUDOPS_GIT_USER_EMAIL'),
    },
  };
}
