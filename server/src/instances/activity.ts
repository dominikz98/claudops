/**
 * What Claude Code is doing inside an instance -- the third axis next to the
 * Docker state and the session readiness.
 *
 * The first two are read from Docker on every request. This one cannot be:
 * "Claude is waiting for an answer" is not visible from outside the container,
 * and no Docker object carries it. So the container reports it, through Claude
 * Code's own hooks, and this is where the reports are kept.
 *
 * In memory rather than in the database, deliberately. The whole value is about
 * a process that is running *now*; a row would survive both the process and the
 * server and start lying the moment either of them ends, which is exactly the
 * argument in knowledge/database-holds-identity-docker-holds-state.md. What a
 * restart loses is re-learned from the pane by `observePane` within one poll.
 *
 * Nothing here does I/O. The pane text arrives as a string, the clock arrives as
 * a function -- so the whole state machine is testable without a container.
 */

/**
 * - `none` -- no running container: nothing is happening and nothing can.
 * - `idle` -- the session is up and nobody has asked it for anything yet.
 * - `running` -- a turn is in flight.
 * - `needs_input` -- Claude asked something and is waiting for the answer.
 * - `done` -- the turn finished, or the session ended.
 *
 * `done` rather than back to `idle` after a turn: "I gave it a ticket and it
 * finished" is the one an operator scans the list for, and it is a different
 * fact from "this instance has never been given anything".
 *
 * Mirrored in web/src/api.ts.
 */
export type InstanceActivity = 'none' | 'idle' | 'running' | 'needs_input' | 'done';

/**
 * The four hooks docker/base/claude-settings.json registers. Sent by name
 * rather than pre-digested into an activity, so the mapping below is the only
 * place that decides what an event means -- and a test can drive it without a
 * container.
 */
export const HOOK_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Notification types that really mean "Claude is waiting for you".
 *
 * `Notification` fires for two quite different things, and treating them alike
 * is what would make this feature useless: Claude asking a question, and the
 * prompt simply having been idle for sixty seconds. The second one arrives for
 * every finished instance a minute after it finished -- it would turn `done`
 * into `needs_input` across the whole list, browser notification included.
 * `notification_type` is what tells them apart.
 */
const ASKING_NOTIFICATIONS: readonly string[] = ['permission_prompt', 'elicitation_dialog'];

/** The ones that are explicitly *not* a question. Listed rather than assumed,
 *  so an unknown type falls to the rule below instead of into this set. */
const QUIET_NOTIFICATIONS: readonly string[] = ['idle_prompt', 'auth_success', 'agent_completed'];

/**
 * What Claude Code prints while a turn is running. The pane fallback looks for
 * exactly this and nothing else: every other part of the TUI is layout that
 * changes between releases, while the interrupt hint is what a user is told to
 * press and has been stable across them.
 */
export const BUSY_MARKER = /esc to interrupt/i;

/** How long a `running` may stand without another hook before the pane is asked
 *  whether it is still true. A turn that is genuinely running keeps answering
 *  yes; one whose Claude was killed mid-turn is what this exists for. */
const STALE_MS = 30_000;

/** Floor between two pane probes of the same instance. Several browsers polling
 *  the list must not multiply into several execs per second. */
const PROBE_INTERVAL_MS = 5_000;

export interface ActivityReport {
  event: HookEvent;
  /** Only `Notification` carries one. */
  notificationType?: string | undefined;
}

interface TrackedActivity {
  activity: InstanceActivity;
  /** When it was last confirmed, so a stale `running` can be re-checked. */
  at: number;
}

/** Whether a string is one of the four events, for a value that came off the
 *  wire. The route's schema enforces the same list; this is the invariant. */
export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * The reported activity of every instance, and the rules that turn hook events
 * and pane text into one.
 */
export class ActivityTracker {
  private readonly states = new Map<string, TrackedActivity>();
  private readonly probes = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * One hook report.
   *
   * A `Notification` whose type is unknown -- a Claude Code release that adds
   * one -- counts as a question only while a turn is in flight. That is the
   * conservative half of the same argument as the type list: a notification
   * during a turn is Claude interrupting itself to ask, one after it is far
   * more likely to be the idle nag, and a false `needs_input` costs a browser
   * notification for something nobody has to answer.
   */
  record(instanceId: string, report: ActivityReport): void {
    const current = this.states.get(instanceId)?.activity;
    const next = nextActivity(current, report);
    if (next === undefined) return;

    this.states.set(instanceId, { activity: next, at: this.now() });
  }

  /**
   * What the tmux pane shows, for an instance whose hooks have said nothing --
   * a container from an image built before this existed, or a server that was
   * restarted while Claude was working.
   *
   * Deliberately narrow. It may start a `running`, and it may end one it
   * started; it must never overwrite a `needs_input`, because a Claude waiting
   * for an answer prints no spinner and the pane cannot tell that state from an
   * idle one. Guessing there would clear exactly the badge this ticket exists
   * for.
   */
  observePane(instanceId: string, pane: string): void {
    const current = this.states.get(instanceId)?.activity;
    const busy = BUSY_MARKER.test(pane);

    if (busy) {
      this.states.set(instanceId, { activity: 'running', at: this.now() });
      return;
    }
    if (current === 'running') {
      // A turn we saw start is over, and no Stop hook said so.
      this.states.set(instanceId, { activity: 'done', at: this.now() });
      return;
    }
    if (current === undefined) {
      this.states.set(instanceId, { activity: 'idle', at: this.now() });
    }
  }

  /** What to report for this instance, or `undefined` if nothing is known about
   *  it yet -- which the caller shows as `idle`. */
  activityOf(instanceId: string): InstanceActivity | undefined {
    return this.states.get(instanceId)?.activity;
  }

  /**
   * Whether to look at this instance's pane now, and the claim on doing so:
   * true is answered at most once per PROBE_INTERVAL_MS, so a caller can ask on
   * every request without producing an exec on every request.
   */
  beginProbe(instanceId: string): boolean {
    const now = this.now();
    const last = this.probes.get(instanceId);
    if (last !== undefined && now - last < PROBE_INTERVAL_MS) return false;

    const state = this.states.get(instanceId);
    // Nothing known, or a `running` that no hook has confirmed for a while.
    // Every other state is one Claude reported and then stopped talking about,
    // which is what a finished turn looks like -- there is nothing to re-check.
    const stale = state === undefined || (state.activity === 'running' && now - state.at > STALE_MS);
    if (!stale) return false;

    this.probes.set(instanceId, now);
    return true;
  }

  /** Drops everything about an instance. Called on delete, so a deleted id
   *  cannot keep a container's late report alive in this map. */
  forget(instanceId: string): void {
    this.states.delete(instanceId);
    this.probes.delete(instanceId);
  }
}

/** The state machine itself, as a function: `undefined` means "this report
 *  changes nothing", which is not the same as any of the five activities. */
function nextActivity(
  current: InstanceActivity | undefined,
  report: ActivityReport,
): InstanceActivity | undefined {
  switch (report.event) {
    case 'UserPromptSubmit':
      return 'running';
    case 'Stop':
    case 'SessionEnd':
      return 'done';
    case 'Notification':
      return notificationActivity(current, report.notificationType);
  }
}

function notificationActivity(
  current: InstanceActivity | undefined,
  type: string | undefined,
): InstanceActivity | undefined {
  if (type !== undefined && ASKING_NOTIFICATIONS.includes(type)) return 'needs_input';
  if (type !== undefined && QUIET_NOTIFICATIONS.includes(type)) return undefined;
  return current === 'running' ? 'needs_input' : undefined;
}
