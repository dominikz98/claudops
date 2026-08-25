import { describe, expect, it } from 'vitest';
import { ConfigError, defaultDockerSocket, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('falls back to defaults on an empty environment', () => {
    const config = loadConfig({});

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.baseImage).toBe('claudops-base');
    expect(config.databaseFile).toBe('data/claudops.db');
  });

  it('reads host, port, database and image from the environment', () => {
    const config = loadConfig({
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

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ CLAUDOPS_HOST: '' }).host).toBe('0.0.0.0');
  });

  it('rejects a port that is not a port', () => {
    expect(() => loadConfig({ CLAUDOPS_PORT: 'http' })).toThrow(ConfigError);
    expect(() => loadConfig({ CLAUDOPS_PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ CLAUDOPS_PORT: '70000' })).toThrow(ConfigError);
  });

  it('picks up the instance environment without ever inventing an API key', () => {
    const config = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDOPS_GIT_USER_NAME: 'claudops',
      CLAUDOPS_GIT_USER_EMAIL: 'claudops@example.invalid',
      ANTHROPIC_API_KEY: 'must-be-ignored',
    });

    expect(config.instanceEnv).toEqual({
      claudeOauthToken: 'oauth-token',
      gitUserName: 'claudops',
      gitUserEmail: 'claudops@example.invalid',
    });
    expect(JSON.stringify(config)).not.toContain('must-be-ignored');
  });

  describe('docker transport', () => {
    it('uses the platform default socket', () => {
      expect(defaultDockerSocket('linux')).toBe('/var/run/docker.sock');
      expect(defaultDockerSocket('win32')).toBe('//./pipe/docker_engine');
      expect(loadConfig({}).dockerSocket).toBe(defaultDockerSocket());
    });

    it('leaves the transport to dockerode when DOCKER_HOST is set', () => {
      expect(loadConfig({ DOCKER_HOST: 'tcp://nuc:2375' }).dockerSocket).toBeUndefined();
    });

    it('lets an explicit DOCKER_SOCKET win over DOCKER_HOST', () => {
      const config = loadConfig({ DOCKER_HOST: 'tcp://nuc:2375', DOCKER_SOCKET: '/tmp/d.sock' });
      expect(config.dockerSocket).toBe('/tmp/d.sock');
    });
  });
});
