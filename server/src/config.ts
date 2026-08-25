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
  /** Image instances are started from. #7 replaces this per project. */
  baseImage: string;
  /** `undefined` leaves the transport to dockerode, which then honours
   *  DOCKER_HOST. */
  dockerSocket: string | undefined;
  instanceEnv: InstanceEnvConfig;
}

export class ConfigError extends Error {}

const DEFAULT_PORT = 8080;

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
    dockerSocket,
    instanceEnv: {
      claudeOauthToken: optional(env, 'CLAUDE_CODE_OAUTH_TOKEN'),
      gitUserName: optional(env, 'CLAUDOPS_GIT_USER_NAME'),
      gitUserEmail: optional(env, 'CLAUDOPS_GIT_USER_EMAIL'),
    },
  };
}
