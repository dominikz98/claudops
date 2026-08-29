/**
 * What a project adds to its instances beyond the fixed set: named environment
 * variables and hosts for the container's egress firewall.
 *
 * Its own module because both halves are needed on both sides of the wire --
 * the project service validates them, the instance service turns them into a
 * container environment -- and instances/service.ts already imports
 * projects/service.ts, so the shared pieces cannot live there without a cycle.
 */

/**
 * The variables claudops writes itself in `InstanceService.envFor`. A project
 * may not carry one of them: the container environment is assembled with the
 * fixed set last, so a project variable of the same name would be dropped
 * silently -- and a refusal that says which name is managed is better than a
 * value that quietly never arrives.
 *
 * `ANTHROPIC_API_KEY` is on the list although nothing writes it: it is the one
 * name that would do damage rather than nothing, because Claude Code prefers it
 * over the OAuth token and bills per token
 * (knowledge/auth-token-handling.md).
 */
export const MANAGED_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_EFFORT',
  'CLAUDE_MODEL',
  'CLAUDOPS_INSTANCE_ID',
  'CLAUDOPS_STATUS_PORT',
  'CLAUDOPS_STATUS_TOKEN',
  'FIREWALL_ALLOW',
  'GIT_TOKEN',
  'GIT_USER_EMAIL',
  'GIT_USER_NAME',
  'REPO_BRANCH',
  'REPO_URL',
];

/**
 * What a shell would accept as a name, which is also what `docker inspect`
 * shows and what `${VAR}` in a `.mcp.json` looks up. Enforced here as well as in
 * the route schema, so a caller that goes around the schema gets the same
 * answer.
 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A host or a CIDR, as `docker/base/init-firewall.sh` reads them: a word with a
 * slash or four dotted numbers is added to the ipset as it stands, anything else
 * is resolved before the default-deny policy takes effect. Nothing else can be
 * expressed -- a wildcard cannot go into an ipset at all, and a URL would be
 * skipped by the script without a word about it.
 */
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(\/(3[0-2]|[12]?[0-9]))?$/;

/** Longer than a DNS name may be, so the limit is never the thing in the way of
 *  a legitimate host. */
const MAX_HOST_LENGTH = 253;

/** Enough for a project that talks to a handful of services; small enough that
 *  the list stays something a human reads before saving it. */
export const MAX_EGRESS_HOSTS = 50;

export class ReservedEnvNameError extends Error {
  constructor(readonly variable: string) {
    super(
      `'${variable}' is set by claudops itself and cannot be a project variable -- see docker/base/README.md`,
    );
    this.name = 'ReservedEnvNameError';
  }
}

export class InvalidEnvNameError extends Error {
  constructor(readonly variable: string) {
    super(`'${variable}' is not a valid environment variable name`);
    this.name = 'InvalidEnvNameError';
  }
}

export class InvalidEgressHostError extends Error {
  constructor(readonly host: string) {
    super(
      `'${host}' is not a host or a CIDR -- the container's firewall would skip it without a word`,
    );
    this.name = 'InvalidEgressHostError';
  }
}

export class TooManyEgressHostsError extends Error {
  constructor(readonly count: number) {
    super(
      `${String(count)} egress hosts is more than the ${String(MAX_EGRESS_HOSTS)} a project may list`,
    );
    this.name = 'TooManyEgressHostsError';
  }
}

/** Throws for a name a project may not use. Called for every name a request
 *  carries, `null` values included: removing a managed name is as meaningless
 *  as setting one. */
export function checkEnvName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new InvalidEnvNameError(name);
  if (MANAGED_ENV_NAMES.includes(name)) throw new ReservedEnvNameError(name);
}

/**
 * Trims, drops what is empty, refuses what the firewall could not use and keeps
 * the first of any duplicates. The order is the operator's -- it is a list they
 * read back, and sorting it would make a saved form look edited.
 */
export function normaliseEgressHosts(hosts: readonly string[]): string[] {
  const seen: string[] = [];

  for (const raw of hosts) {
    const host = raw.trim();
    if (host === '') continue;
    if (host.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(host)) {
      throw new InvalidEgressHostError(host);
    }
    if (!seen.includes(host)) seen.push(host);
  }

  if (seen.length > MAX_EGRESS_HOSTS) throw new TooManyEgressHostsError(seen.length);
  return seen;
}

/**
 * What the container gets as `FIREWALL_ALLOW`: the server-wide
 * `CLAUDOPS_FIREWALL_ALLOW` and the project's hosts, in that order.
 *
 * Both, not either: the server-wide list is the operator's floor for every
 * instance on the box, and a project adding to it must not be able to take
 * something away from it. `undefined` when neither has anything to say, so the
 * variable is left out of the container rather than set to an empty string.
 */
export function mergeFirewallAllow(
  serverWide: string | undefined,
  projectHosts: readonly string[],
): string | undefined {
  const entries = [
    ...(serverWide === undefined ? [] : [serverWide]),
    ...projectHosts,
  ].filter((entry) => entry !== '');

  return entries.length === 0 ? undefined : entries.join(',');
}
