import { describe, expect, it } from 'vitest';
import { parseEnv, parseHosts } from '../src/views/projects.ts';

describe('parseEnv', () => {
  it('reads one NAME=value per line', () => {
    expect(parseEnv('A=one\nB=two')).toEqual({ A: 'one', B: 'two' });
  });

  it('splits on the first = only, so a value may contain one', () => {
    expect(parseEnv('DATABASE_URL=postgres://u:p@h/db?x=1')).toEqual({
      DATABASE_URL: 'postgres://u:p@h/db?x=1',
    });
  });

  it('skips blank lines and comments, and trims what is left', () => {
    expect(parseEnv('\n # a note\n  A = one  \n\n')).toEqual({ A: 'one' });
  });

  it('keeps an empty value, which is a variable that exists and says nothing', () => {
    expect(parseEnv('A=')).toEqual({ A: '' });
  });

  // Refused rather than dropped: a line that was meant to be a variable and
  // silently is not would show up as a container missing half its environment.
  it('refuses a line that is not a NAME=value', () => {
    expect(() => parseEnv('A=one\njust-a-word')).toThrow(/not a NAME=value/);
    expect(() => parseEnv('=novalue')).toThrow(/not a NAME=value/);
  });
});

describe('parseHosts', () => {
  it('splits on commas, spaces and newlines alike', () => {
    expect(parseHosts('a.example.com, b.example.com\nc.example.com d.example.com')).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com',
      'd.example.com',
    ]);
  });

  it('is empty for a field nobody filled in', () => {
    expect(parseHosts('   \n ')).toEqual([]);
  });
});
