import { beforeEach, describe, expect, it } from 'vitest';
import type { Instance, InstanceActivity } from '../src/api.ts';
import { createNotifier, type Notifier, type NotifierPorts, type NotifyState } from '../src/notify.ts';

/** Only the three fields the notifier reads. */
function instance(id: string, activity: InstanceActivity, name = id): Instance {
  return {
    id,
    name,
    image: 'claudops-project-demo',
    containerId: 'container-1',
    projectId: 'project-1',
    repoUrl: null,
    repoBranch: null,
    model: null,
    effort: null,
    createdAt: '2026-08-25T08:00:00.000Z',
    status: 'running',
    session: 'ready',
    activity,
  };
}

describe('needs-input notifications', () => {
  let shown: { title: string; body: string; tag: string }[];
  let pending: number[];
  let permission: NotifyState;
  let notifier: Notifier;

  beforeEach(() => {
    shown = [];
    pending = [];
    permission = 'granted';

    const ports: NotifierPorts = {
      permission: () => permission,
      request: () => Promise.resolve('granted'),
      show: (title, body, tag) => shown.push({ title, body, tag }),
      setPending: (count) => pending.push(count),
    };
    notifier = createNotifier(ports);
  });

  /**
   * A reload is not news. Without this every open tab would announce every
   * waiting instance again on every refresh -- and the list view mounts this
   * fresh each time somebody navigates back to it.
   */
  it('says nothing about what was already waiting when it started watching', () => {
    notifier.update([instance('id-1', 'needs_input')]);

    expect(shown).toEqual([]);
    // Counted from the first update, though: the tab title is a state, not an
    // event.
    expect(pending).toEqual([1]);
  });

  it('fires when an instance starts waiting', () => {
    notifier.update([instance('id-1', 'running', 'ticket-17')]);

    notifier.update([instance('id-1', 'needs_input', 'ticket-17')]);

    expect(shown).toEqual([
      { title: 'ticket-17 needs input', body: 'Claude is waiting for an answer.', tag: 'id-1' },
    ]);
  });

  it('fires once, not on every poll while it keeps waiting', () => {
    notifier.update([instance('id-1', 'running')]);
    notifier.update([instance('id-1', 'needs_input')]);
    notifier.update([instance('id-1', 'needs_input')]);
    notifier.update([instance('id-1', 'needs_input')]);

    expect(shown).toHaveLength(1);
  });

  it('fires again when the same instance asks a second question', () => {
    notifier.update([instance('id-1', 'running')]);
    notifier.update([instance('id-1', 'needs_input')]);
    notifier.update([instance('id-1', 'running')]);
    notifier.update([instance('id-1', 'needs_input')]);

    expect(shown).toHaveLength(2);
  });

  it('fires for each instance that switched, and only for those', () => {
    notifier.update([
      instance('id-1', 'running'),
      instance('id-2', 'running'),
      instance('id-3', 'needs_input'),
    ]);

    notifier.update([
      instance('id-1', 'needs_input'),
      instance('id-2', 'done'),
      instance('id-3', 'needs_input'),
    ]);

    expect(shown.map((entry) => entry.tag)).toEqual(['id-1']);
  });

  it('counts what is waiting, up and down', () => {
    notifier.update([instance('id-1', 'running'), instance('id-2', 'running')]);
    notifier.update([instance('id-1', 'needs_input'), instance('id-2', 'needs_input')]);
    notifier.update([instance('id-1', 'needs_input'), instance('id-2', 'running')]);
    notifier.update([instance('id-1', 'done'), instance('id-2', 'running')]);

    expect(pending).toEqual([0, 2, 1, 0]);
  });

  it('forgets an instance that is gone from the list', () => {
    notifier.update([instance('id-1', 'needs_input')]);
    notifier.update([]);
    expect(pending.at(-1)).toBe(0);

    // Back as a *new* instance rather than as one that never stopped waiting:
    // a deleted id that comes round again has no history to compare against.
    notifier.update([instance('id-1', 'needs_input')]);

    expect(shown).toHaveLength(1);
  });

  it('passes the permission state straight through', async () => {
    permission = 'unsupported';
    expect(notifier.state()).toBe('unsupported');

    expect(await notifier.enable()).toBe('granted');
  });
});
