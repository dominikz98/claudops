import { describe, expect, it } from 'vitest';
import {
  checkEnvName,
  InvalidEgressHostError,
  InvalidEnvNameError,
  MANAGED_ENV_NAMES,
  MAX_EGRESS_HOSTS,
  mergeFirewallAllow,
  normaliseEgressHosts,
  ReservedEnvNameError,
  TooManyEgressHostsError,
} from '../src/projects/env.ts';

describe('checkEnvName', () => {
  it('accepts what a shell would', () => {
    for (const name of ['PATH', '_hidden', 'A1', 'DATABASE_URL']) {
      expect(() => {
        checkEnvName(name);
      }).not.toThrow();
    }
  });

  it('refuses what a shell would not', () => {
    for (const name of ['', '1BAD', 'A-B', 'A B', 'a.b', 'ä']) {
      expect(() => {
        checkEnvName(name);
      }).toThrow(InvalidEnvNameError);
    }
  });

  it('refuses every name claudops writes itself', () => {
    for (const name of MANAGED_ENV_NAMES) {
      expect(() => {
        checkEnvName(name);
      }).toThrow(ReservedEnvNameError);
    }
  });

  // The one name on that list nothing writes. It is there because Claude Code
  // prefers it over the OAuth token and bills per token
  // (knowledge/auth-token-handling.md).
  it('refuses ANTHROPIC_API_KEY although no code sets it', () => {
    expect(() => {
      checkEnvName('ANTHROPIC_API_KEY');
    }).toThrow(ReservedEnvNameError);
  });
});

describe('normaliseEgressHosts', () => {
  it('keeps a host, a CIDR and an address', () => {
    expect(normaliseEgressHosts(['api.example.com', '10.1.0.0/16', '192.168.1.7'])).toEqual([
      'api.example.com',
      '10.1.0.0/16',
      '192.168.1.7',
    ]);
  });

  it('trims, drops blanks and keeps the first of two identical entries', () => {
    expect(normaliseEgressHosts([' api.example.com ', '', '   ', 'api.example.com'])).toEqual([
      'api.example.com',
    ]);
  });

  it('keeps the order it was given -- it is a list somebody reads back', () => {
    expect(normaliseEgressHosts(['zulu.example.com', 'alpha.example.com'])).toEqual([
      'zulu.example.com',
      'alpha.example.com',
    ]);
  });

  it('refuses anything the firewall script would silently skip', () => {
    for (const host of [
      'https://api.example.com',
      'api.example.com/v1/things',
      '*.example.com',
      'api.example.com:443',
      'two words',
      '10.1.0.0/64',
      '-leading.example.com',
    ]) {
      expect(() => normaliseEgressHosts([host])).toThrow(InvalidEgressHostError);
    }
  });

  it('refuses more hosts than a project may list', () => {
    const many = Array.from({ length: MAX_EGRESS_HOSTS + 1 }, (_, i) => `h${String(i)}.example.com`);

    expect(() => normaliseEgressHosts(many)).toThrow(TooManyEgressHostsError);
  });
});

describe('mergeFirewallAllow', () => {
  it('puts the server-wide list first and the project after it', () => {
    expect(mergeFirewallAllow('api.nuget.org', ['api.example.com'])).toBe(
      'api.nuget.org,api.example.com',
    );
  });

  it('is either half on its own when the other has nothing', () => {
    expect(mergeFirewallAllow('api.nuget.org', [])).toBe('api.nuget.org');
    expect(mergeFirewallAllow(undefined, ['api.example.com'])).toBe('api.example.com');
  });

  // `undefined` rather than '': the caller leaves the variable out of the
  // container entirely, which is not the same as an empty whitelist.
  it('is undefined when neither side has anything to say', () => {
    expect(mergeFirewallAllow(undefined, [])).toBeUndefined();
    expect(mergeFirewallAllow('', [])).toBeUndefined();
  });
});
