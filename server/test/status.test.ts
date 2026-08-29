import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { InstanceRepository } from '../src/db/instances.ts';
import { migrate } from '../src/db/migrations.ts';
import { ActivityTracker } from '../src/instances/activity.ts';
import { buildStatusApp } from '../src/status/app.ts';
import { createStatusTokens, type StatusTokens } from '../src/status/tokens.ts';

const SECRET = 'a-shared-secret-long-enough';

describe('status tokens', () => {
  const tokens = createStatusTokens(SECRET);

  it('is stable for an instance, so a container survives a server restart', () => {
    expect(createStatusTokens(SECRET).issue('id-1')).toBe(tokens.issue('id-1'));
  });

  it('is different per instance, and does not verify against another one', () => {
    expect(tokens.issue('id-1')).not.toBe(tokens.issue('id-2'));
    expect(tokens.verify('id-2', tokens.issue('id-1'))).toBe(false);
  });

  it('refuses anything that is not the token', () => {
    for (const bad of ['', 'nonsense', tokens.issue('id-1').slice(0, -2), '!!!!']) {
      expect(tokens.verify('id-1', bad)).toBe(false);
    }
  });

  it('does not verify a token from another secret', () => {
    const other = createStatusTokens('a-completely-different-secret');

    expect(tokens.verify('id-1', other.issue('id-1'))).toBe(false);
  });

  /** Without a login secret every process gets its own key, and says so by
   *  refusing the tokens the previous one handed out. */
  it('forgets across processes when there is no secret to derive from', () => {
    expect(createStatusTokens(undefined).verify('id-1', createStatusTokens(undefined).issue('id-1'))).toBe(
      false,
    );
  });
});

describe('POST /instances/:id/status', () => {
  let app: FastifyInstance;
  let activity: ActivityTracker;
  let tokens: StatusTokens;

  beforeEach(() => {
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
      createdAt: new Date().toISOString(),
    });

    activity = new ActivityTracker();
    tokens = createStatusTokens(SECRET);
    app = buildStatusApp({ instances, activity, tokens, logLevel: 'silent' });
  });

  /** `null` is "send no Authorization header at all" -- an explicit
   *  `undefined` would fall back to the default and quietly send a good one. */
  const report = (id: string, body: Record<string, unknown>, token: string | null = tokens.issue(id)) =>
    app.inject({
      method: 'POST',
      url: `/instances/${id}/status`,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: body,
    });

  it('records a report and answers with no body at all', async () => {
    const response = await report('id-1', { event: 'UserPromptSubmit' });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(activity.activityOf('id-1')).toBe('running');
  });

  it('carries the notification type through to the tracker', async () => {
    await report('id-1', { event: 'UserPromptSubmit' });
    await report('id-1', { event: 'Notification', notificationType: 'idle_prompt' });
    expect(activity.activityOf('id-1')).toBe('running');

    await report('id-1', { event: 'Notification', notificationType: 'permission_prompt' });
    expect(activity.activityOf('id-1')).toBe('needs_input');
  });

  it('takes a notification type it has never heard of', async () => {
    const response = await report('id-1', {
      event: 'Notification',
      notificationType: 'invented_in_a_later_release',
    });

    expect(response.statusCode).toBe(204);
  });

  it('refuses a report with no token', async () => {
    const response = await report('id-1', { event: 'Stop' }, null);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
    expect(activity.activityOf('id-1')).toBeUndefined();
  });

  /** The point of the token: one instance may not speak for another. */
  it("refuses another instance's token", async () => {
    const response = await report('id-1', { event: 'Stop' }, tokens.issue('id-2'));

    expect(response.statusCode).toBe(401);
    expect(activity.activityOf('id-1')).toBeUndefined();
  });

  it('takes the scheme in any case, and nothing else as a credential', async () => {
    const token = tokens.issue('id-1');

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances/id-1/status',
          headers: { authorization: `bearer ${token}` },
          payload: { event: 'Stop' },
        })
      ).statusCode,
    ).toBe(204);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances/id-1/status',
          headers: { authorization: token },
          payload: { event: 'Stop' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('answers 404 for an instance the server does not have', async () => {
    const response = await report('id-gone', { event: 'Stop' });

    expect(response.statusCode).toBe(404);
    expect(activity.activityOf('id-gone')).toBeUndefined();
  });

  it('refuses an event that is not one of the four', async () => {
    const response = await report('id-1', { event: 'PreToolUse' });

    expect(response.statusCode).toBe(400);
    expect(activity.activityOf('id-1')).toBeUndefined();
  });

  it('refuses a body with a field nobody reads', async () => {
    const response = await report('id-1', { event: 'Stop', prompt: 'the whole conversation' });

    expect(response.statusCode).toBe(400);
  });

  /** Everything the browser talks to is on the other port. This one carries a
   *  single route, which is what makes opening it in the container's firewall
   *  a different proposition from opening the API's. */
  it('serves nothing else at all', async () => {
    for (const url of ['/instances', '/health', '/login', '/']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});
