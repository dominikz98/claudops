import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityTracker } from '../src/instances/activity.ts';

/**
 * The rules that turn hook events and pane text into one word. Every one of
 * them is a decision this ticket had to take, so every one of them is here
 * rather than only in the route test that happens to exercise it.
 */
describe('ActivityTracker', () => {
  let now: number;
  let tracker: ActivityTracker;

  beforeEach(() => {
    now = 1_000_000;
    tracker = new ActivityTracker(() => now);
  });

  describe('hook events', () => {
    it('knows nothing about an instance that has not reported', () => {
      expect(tracker.activityOf('id-1')).toBeUndefined();
    });

    it('reads a submitted prompt as a turn in flight', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });

      expect(tracker.activityOf('id-1')).toBe('running');
    });

    it('reads the end of a turn and the end of a session as done', () => {
      tracker.record('id-1', { event: 'Stop' });
      expect(tracker.activityOf('id-1')).toBe('done');

      tracker.record('id-2', { event: 'SessionEnd' });
      expect(tracker.activityOf('id-2')).toBe('done');
    });

    it('keeps instances apart', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });
      tracker.record('id-2', { event: 'Stop' });

      expect(tracker.activityOf('id-1')).toBe('running');
      expect(tracker.activityOf('id-2')).toBe('done');
    });

    it('walks the whole cycle: asked, answered, finished', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });
      tracker.record('id-1', { event: 'Notification', notificationType: 'elicitation_dialog' });
      expect(tracker.activityOf('id-1')).toBe('needs_input');

      // Answering is a prompt like any other -- which is what puts the instance
      // back on `running` without anything else having to notice.
      tracker.record('id-1', { event: 'UserPromptSubmit' });
      expect(tracker.activityOf('id-1')).toBe('running');

      tracker.record('id-1', { event: 'Stop' });
      expect(tracker.activityOf('id-1')).toBe('done');
    });
  });

  describe('notifications', () => {
    it('reads a permission prompt and a dialog as a question', () => {
      for (const type of ['permission_prompt', 'elicitation_dialog']) {
        tracker.record(type, { event: 'Notification', notificationType: type });
        expect(tracker.activityOf(type)).toBe('needs_input');
      }
    });

    /**
     * The one that decides whether this feature is usable at all: Notification
     * also fires after sixty idle seconds, which is a state every finished
     * instance reaches. Reading that as a question would turn the whole list
     * into "needs input" a minute after it went quiet -- with a browser
     * notification each.
     */
    it('leaves a finished instance alone when the idle nag fires', () => {
      tracker.record('id-1', { event: 'Stop' });

      tracker.record('id-1', { event: 'Notification', notificationType: 'idle_prompt' });

      expect(tracker.activityOf('id-1')).toBe('done');
    });

    it('leaves an untouched instance alone for the quiet types', () => {
      for (const type of ['idle_prompt', 'auth_success', 'agent_completed']) {
        tracker.record('id-1', { event: 'Notification', notificationType: type });
      }

      expect(tracker.activityOf('id-1')).toBeUndefined();
    });

    it('reads an unknown type as a question only during a turn', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });
      tracker.record('id-1', { event: 'Notification', notificationType: 'something_new' });
      expect(tracker.activityOf('id-1')).toBe('needs_input');

      tracker.record('id-2', { event: 'Stop' });
      tracker.record('id-2', { event: 'Notification', notificationType: 'something_new' });
      expect(tracker.activityOf('id-2')).toBe('done');
    });

    it('treats a notification with no type at all the same way', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });
      tracker.record('id-1', { event: 'Notification' });

      expect(tracker.activityOf('id-1')).toBe('needs_input');
    });
  });

  describe('the pane fallback', () => {
    const BUSY = '✳ Frobnicating… (esc to interrupt · ctrl+t to hide todos)';
    const PROMPT = '╭──────────╮\n│ >        │\n╰──────────╯';

    it('reads the interrupt hint as a turn in flight', () => {
      tracker.observePane('id-1', BUSY);

      expect(tracker.activityOf('id-1')).toBe('running');
    });

    it('reads a quiet pane on an unknown instance as idle', () => {
      tracker.observePane('id-1', PROMPT);

      expect(tracker.activityOf('id-1')).toBe('idle');
    });

    it('ends a turn whose Stop hook never arrived', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });

      tracker.observePane('id-1', PROMPT);

      expect(tracker.activityOf('id-1')).toBe('done');
    });

    /**
     * A Claude waiting for an answer prints no spinner, so the pane cannot tell
     * that state from an idle one. Guessing here would clear exactly the badge
     * the ticket is about -- and it would clear it three seconds after it
     * appeared.
     */
    it('never overwrites a question', () => {
      tracker.record('id-1', { event: 'Notification', notificationType: 'permission_prompt' });

      tracker.observePane('id-1', PROMPT);

      expect(tracker.activityOf('id-1')).toBe('needs_input');
    });

    it('leaves a finished instance finished', () => {
      tracker.record('id-1', { event: 'Stop' });

      tracker.observePane('id-1', PROMPT);

      expect(tracker.activityOf('id-1')).toBe('done');
    });
  });

  describe('when to probe at all', () => {
    it('probes an instance nothing is known about, once', () => {
      expect(tracker.beginProbe('id-1')).toBe(true);
      expect(tracker.beginProbe('id-1')).toBe(false);
    });

    it('does not probe an instance that just reported', () => {
      tracker.record('id-1', { event: 'Stop' });

      expect(tracker.beginProbe('id-1')).toBe(false);
    });

    it('re-checks a running that no hook has confirmed for a while', () => {
      tracker.record('id-1', { event: 'UserPromptSubmit' });
      expect(tracker.beginProbe('id-1')).toBe(false);

      now += 31_000;

      expect(tracker.beginProbe('id-1')).toBe(true);
      // ... and then not again on the next poll three seconds later.
      now += 3_000;
      expect(tracker.beginProbe('id-1')).toBe(false);
    });

    it('does not re-check a finished instance however long it stands', () => {
      tracker.record('id-1', { event: 'Stop' });
      now += 3_600_000;

      expect(tracker.beginProbe('id-1')).toBe(false);
    });
  });

  it('forgets an instance completely', () => {
    tracker.record('id-1', { event: 'UserPromptSubmit' });
    tracker.beginProbe('id-1');

    tracker.forget('id-1');

    expect(tracker.activityOf('id-1')).toBeUndefined();
    expect(tracker.beginProbe('id-1')).toBe(true);
  });
});
