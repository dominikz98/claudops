import { resolve } from 'node:path';
import { createSessionAuth, type SessionAuth } from './auth/session.ts';
import type { ContainerLimits } from './docker/engine.ts';
import { defaultProjectContext } from './projects/images.ts';
import { createCipher, parseSecretKey, type SecretCipher } from './secrets/cipher.ts';
import { createStatusTokens, type StatusTokens } from './status/tokens.ts';

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
  /**
   * Extra hosts and CIDRs the container's egress firewall lets through, on top
   * of its built-in list. Handed over as FIREWALL_ALLOW, which the container
   * reads from PID 1's environment -- so it cannot be widened from inside
   * (knowledge/container-env-reaches-a-sudo-script-through-proc-1.md).
   */
  firewallAllow: string | undefined;
}

/**
 * What an instance may be handed through `POST /instances/:id/files`. Two
 * numbers because they answer two different worries: one request that fills the
 * NUC's disk, and a hundred small ones that do the same over an afternoon.
 */
export interface UploadLimits {
  /** Per request. Also the route's `bodyLimit`, so anything larger is refused
   *  before it is read into memory. */
  maxFileBytes: number;
  /** Everything in one instance's uploads directory, together. */
  maxInstanceBytes: number;
}

/**
 * The ceiling on one `GET /instances/:id/files/content`. Its own number rather
 * than the upload limit: the two travel in opposite directions and are limited
 * for different reasons -- an upload is bounded to keep the NUC's disk, a read
 * to keep the server's memory, because a read is buffered before it is sent.
 */
export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;

export interface ServerConfig {
  host: string;
  port: number;
  /**
   * Address and port of the second listener, the one instance containers report
   * their status to. Its own port because a container's egress firewall filters
   * by address and port and not by path: on the API's port the hole would carry
   * `POST /login` and every other endpoint with it
   * (knowledge/the-status-port-is-the-one-hole-in-the-egress-firewall.md).
   */
  statusHost: string;
  statusPort: number;
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
  /**
   * The shared secret behind the UI, ready to verify session cookies with.
   * Never the secret itself, for the same reason `cipher` is not the key.
   */
  auth: SessionAuth;
  /** Proves a status report came from the instance it claims. Derived from the
   *  same shared secret as `auth`, so nothing new is stored. */
  statusTokens: StatusTokens;
  /** `Secure` on the session cookie. Only with TLS in front -- a browser
   *  silently discards a Secure cookie that arrived over plain http, and the
   *  login would appear to do nothing. */
  secureCookie: boolean;
  instanceEnv: InstanceEnvConfig;
  /** CPU and memory ceiling every instance container is created with. */
  instanceLimits: ContainerLimits;
  /** What may be uploaded into an instance. */
  uploadLimits: UploadLimits;
  /** The largest file `GET /instances/:id/files/content` will hand back. */
  maxReadBytes: number;
}

export class ConfigError extends Error {}

const DEFAULT_PORT = 8080;

/** The status listener, next to the API's port. Mirrored as the default of
 *  CLAUDOPS_STATUS_PORT in docker/base/Dockerfile: the container has to dial
 *  the same number the server listens on. */
const DEFAULT_STATUS_PORT = 8081;

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

/**
 * A screenshot is a couple of megabytes, a log or a heap dump more; twenty-five
 * of them is generous for one attachment and still small enough that a mistyped
 * upload cannot occupy the box. The total is what keeps a session of pasting
 * from filling the instance's layer.
 */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxInstanceBytes: 200 * 1024 * 1024,
};

/** Below this a size limit is a mistake rather than a policy -- a kilobyte
 *  does not hold a screenshot. */
const MIN_UPLOAD_BYTES = 1024;

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

function port(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(`${key} must be a port number, got '${raw}'`);
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

function byteLimit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = optional(env, key);
  const bytes = raw === undefined ? fallback : parseMemory(raw);
  if (bytes === undefined || bytes < MIN_UPLOAD_BYTES) {
    throw new ConfigError(
      `${key} must be a byte count with an optional b/k/m/g suffix, at least 1k, got '${raw ?? ''}'`,
    );
  }
  return bytes;
}

function uploadLimits(env: NodeJS.ProcessEnv): UploadLimits {
  const maxFileBytes = byteLimit(
    env,
    'CLAUDOPS_UPLOAD_MAX_FILE',
    DEFAULT_UPLOAD_LIMITS.maxFileBytes,
  );
  const maxInstanceBytes = byteLimit(
    env,
    'CLAUDOPS_UPLOAD_MAX_TOTAL',
    DEFAULT_UPLOAD_LIMITS.maxInstanceBytes,
  );

  // A total below the per-file limit is a configuration that refuses every
  // upload the other number allows, which is never what anybody meant.
  if (maxInstanceBytes < maxFileBytes) {
    throw new ConfigError(
      'CLAUDOPS_UPLOAD_MAX_TOTAL must not be smaller than CLAUDOPS_UPLOAD_MAX_FILE',
    );
  }

  return { maxFileBytes, maxInstanceBytes };
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

/**
 * Long enough that the brake on /login is not the only thing between a LAN and
 * an instance console. Short enough to type once a day.
 */
const MIN_LOGIN_SECRET = 16;

/**
 * The shared secret behind the UI. Unlike CLAUDOPS_SECRET_KEY, a missing value
 * is an error here: the whole point of the login is that the endpoints are
 * unusable without it, and a server that silently runs open because somebody
 * forgot an environment variable does not have that property. Refusing at
 * startup is also the only failure a human sees immediately.
 */
function loginSecret(env: NodeJS.ProcessEnv): string {
  const raw = optional(env, 'CLAUDOPS_LOGIN_SECRET');
  if (raw === undefined) {
    throw new ConfigError(
      'CLAUDOPS_LOGIN_SECRET is required -- the UI and the terminal WebSocket are unusable without a login',
    );
  }
  if (raw.length < MIN_LOGIN_SECRET) {
    throw new ConfigError(
      `CLAUDOPS_LOGIN_SECRET must be at least ${String(MIN_LOGIN_SECRET)} characters`,
    );
  }
  return raw;
}

/** Hosts and CIDRs only. Validated here rather than in the container, because
 *  the firewall script skips a word it cannot parse and the operator would
 *  never learn the entry did nothing. */
const FIREWALL_ALLOW_PATTERN = /^[A-Za-z0-9._\-/, \t]+$/;

function firewallAllow(env: NodeJS.ProcessEnv): string | undefined {
  const raw = optional(env, 'CLAUDOPS_FIREWALL_ALLOW');
  if (raw === undefined) return undefined;
  if (!FIREWALL_ALLOW_PATTERN.test(raw)) {
    throw new ConfigError(
      `CLAUDOPS_FIREWALL_ALLOW must be a comma- or space-separated list of hosts and CIDRs, got '${raw}'`,
    );
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // DOCKER_HOST wins over the platform default: dockerode reads it itself, so
  // we hand it no socket path at all in that case.
  const dockerSocket =
    optional(env, 'DOCKER_SOCKET') ??
    (optional(env, 'DOCKER_HOST') !== undefined ? undefined : defaultDockerSocket());

  // Read once and used twice: the session cookie and the status token are both
  // derived from it, each with its own HKDF info.
  const secret = loginSecret(env);

  const apiPort = port(env, 'CLAUDOPS_PORT', DEFAULT_PORT);
  const statusPort = port(env, 'CLAUDOPS_STATUS_PORT', DEFAULT_STATUS_PORT);
  // Caught here rather than as an EADDRINUSE stack trace from the second
  // listen, and the two must not be one port for a reason beyond binding: the
  // container's firewall opens the status port, so sharing it with the API
  // would hand every instance the login endpoint.
  if (apiPort === statusPort) {
    throw new ConfigError(
      'CLAUDOPS_STATUS_PORT must differ from CLAUDOPS_PORT -- the status port is reachable from inside every instance, the API port deliberately is not',
    );
  }

  return {
    host: optional(env, 'CLAUDOPS_HOST') ?? '0.0.0.0',
    port: apiPort,
    statusHost: optional(env, 'CLAUDOPS_STATUS_HOST') ?? '0.0.0.0',
    statusPort,
    logLevel: optional(env, 'CLAUDOPS_LOG_LEVEL') ?? 'info',
    databaseFile: optional(env, 'CLAUDOPS_DB') ?? 'data/claudops.db',
    baseImage: optional(env, 'CLAUDOPS_BASE_IMAGE') ?? 'claudops-base',
    projectContext: optional(env, 'CLAUDOPS_PROJECT_CONTEXT') ?? defaultProjectContext(),
    dotnetChannel: optional(env, 'CLAUDOPS_DOTNET_CHANNEL') ?? DEFAULT_DOTNET_CHANNEL,
    webRoot: optional(env, 'CLAUDOPS_WEB_ROOT') ?? defaultWebRoot(),
    tmuxSession: optional(env, 'CLAUDOPS_TMUX_SESSION') ?? 'main',
    dockerSocket,
    cipher: cipher(env),
    auth: createSessionAuth(secret),
    statusTokens: createStatusTokens(secret),
    secureCookie: optional(env, 'CLAUDOPS_SESSION_SECURE') === '1',
    instanceLimits: instanceLimits(env),
    uploadLimits: uploadLimits(env),
    maxReadBytes: byteLimit(env, 'CLAUDOPS_FILE_MAX_READ', DEFAULT_MAX_READ_BYTES),
    instanceEnv: {
      claudeOauthToken: optional(env, 'CLAUDE_CODE_OAUTH_TOKEN'),
      gitUserName: optional(env, 'CLAUDOPS_GIT_USER_NAME'),
      gitUserEmail: optional(env, 'CLAUDOPS_GIT_USER_EMAIL'),
      firewallAllow: firewallAllow(env),
    },
  };
}
