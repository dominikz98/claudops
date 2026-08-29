import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { InstanceRepository } from '../src/db/instances.ts';
import { migrate } from '../src/db/migrations.ts';
import { ActivityTracker } from '../src/instances/activity.ts';
import { buildStatusApp } from '../src/status/app.ts';
import { createStatusTokens } from '../src/status/tokens.ts';

/**
 * The container's hook script against the real listener.
 *
 * There are two halves to "an instance says what it is doing", and they are
 * written in two languages: a bash script inside the image and a Fastify route
 * out here. Everything else in this suite tests one of them; the shape of what
 * travels between them -- `hook_event_name` becoming `event`,
 * `notification_type` becoming `notificationType` -- is tested by nothing at
 * all unless something runs the script against the route.
 *
 * The smoke tests do it inside a real container, which is where it counts. This
 * does it on every `pnpm test`, which is where a rename gets caught the day it
 * happens rather than at the next release.
 *
 * Skipped where the tools are not there. The script needs bash, curl and jq --
 * all three are in claudops-base by definition, none of them is guaranteed on a
 * Windows dev host (knowledge/windows-dev-host-linux-target.md).
 */

const run = promisify(execFile);
const SCRIPT = new URL('../../docker/base/claudops-status', import.meta.url).pathname;

async function toolsAvailable(): Promise<boolean> {
  try {
    await run('bash', ['-c', 'command -v curl && command -v jq']);
    return true;
  } catch {
    return false;
  }
}

const available = await toolsAvailable();

describe.skipIf(!available)('the hook script against the status listener', () => {
  const activity = new ActivityTracker();
  const tokens = createStatusTokens('a-shared-secret-long-enough');
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    const db = new Database(':memory:');
    migrate(db);
    const instances = new InstanceRepository(db);
    instances.insert({
      id: 'id-1',
      name: 'demo',
      image: 'claudops-project-demo',
      projectId: null,
      repoUrl: null,
      repoBranch: null,
      model: null,
      effort: null,
      createdAt: '2026-08-25T08:00:00.000Z',
    });

    app = buildStatusApp({ instances, activity, tokens, logLevel: 'silent' });
    // Port 0: the runner picks a free one, so two suites in parallel -- or a
    // dev host with something on 8081 -- cannot collide.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${String(address.port)}/instances/id-1/status`;
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * One hook firing. Asynchronous rather than execFileSync for a reason worth
   * writing down: the listener under test runs on this process's event loop,
   * and a synchronous child would block it until curl has given up -- the
   * report would never be answered and the test would fail on code that works.
   */
  const fire = async (hook: string, env: Record<string, string> = {}): Promise<string> => {
    const child = run('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDOPS_STATUS_TOKEN: tokens.issue('id-1'),
        CLAUDOPS_STATUS_URL: url,
        ...env,
      },
    });
    child.child.stdin?.end(hook);
    return (await child).stdout;
  };

  /** No CLAUDOPS_STATUS_URL and no token: what the script does in an image
   *  nobody handed a status endpoint to. */
  const fireBare = async (hook: string, env: Record<string, string> = {}): Promise<string> => {
    const child = run('bash', [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env } });
    child.child.stdin?.end(hook);
    return (await child).stdout;
  };

  /**
   * A UserPromptSubmit hook's stdout is added to the conversation as context.
   * Anything this script prints would arrive as text Claude reads and acts on,
   * which is why the very first thing it does is close stdout.
   */
  it('prints absolutely nothing', async () => {
    expect(await fire('{"hook_event_name":"UserPromptSubmit","user_input":"hi"}')).toBe('');
  });

  it('drives the whole cycle the way Claude Code would', async () => {
    await fire('{"session_id":"s","hook_event_name":"UserPromptSubmit","user_input":"do it"}');
    expect(activity.activityOf('id-1')).toBe('running');

    await fire('{"session_id":"s","hook_event_name":"Notification","notification_type":"elicitation_dialog"}');
    expect(activity.activityOf('id-1')).toBe('needs_input');

    await fire('{"session_id":"s","hook_event_name":"UserPromptSubmit","user_input":"yes"}');
    expect(activity.activityOf('id-1')).toBe('running');

    await fire('{"session_id":"s","hook_event_name":"Stop","last_assistant_message":"done"}');
    expect(activity.activityOf('id-1')).toBe('done');

    // The nag that fires sixty seconds after a turn ends, on an instance that
    // is finished and needs nobody.
    await fire('{"session_id":"s","hook_event_name":"Notification","notification_type":"idle_prompt"}');
    expect(activity.activityOf('id-1')).toBe('done');

    await fire('{"session_id":"s","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}');
    expect(activity.activityOf('id-1')).toBe('done');
  });

  /** Three ways for this to go wrong in a container, and none of them may
   *  reach the session: a hook that exits non-zero on UserPromptSubmit erases
   *  what the user typed. */
  it('stays silent and successful when it cannot report', async () => {
    expect(await fireBare('{"hook_event_name":"Stop"}')).toBe('');
    expect(await fire('not json at all')).toBe('');
    expect(
      await fire('{"hook_event_name":"Stop"}', {
        CLAUDOPS_STATUS_URL: 'http://127.0.0.1:1/instances/id-1/status',
      }),
    ).toBe('');
  });

  /** Nothing listens on the gateway here, so this proves the script works out
   *  an address and exits 0 -- the smoke tests prove the report arrives. */
  it('works out its own URL when it is given only a port and an id', async () => {
    expect(
      await fireBare('{"hook_event_name":"Stop"}', {
        CLAUDOPS_STATUS_TOKEN: tokens.issue('id-1'),
        CLAUDOPS_STATUS_PORT: '8081',
        CLAUDOPS_INSTANCE_ID: 'id-1',
      }),
    ).toBe('');
  });
});
