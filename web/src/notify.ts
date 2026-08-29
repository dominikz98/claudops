/**
 * The browser notification an instance gets when it starts waiting for an
 * answer.
 *
 * The whole point of the status badge is not having to watch the list, and a
 * badge you have to look at to see is only half of that. This is the other
 * half: the list polls anyway, so every poll is also the moment to notice that
 * an instance has just switched into `needs_input`.
 *
 * Everything that touches the browser is in `browserNotifications()`; the rule
 * for *when* to fire is in `createNotifier`, which is why that half can be
 * tested without a DOM (web/vitest.config.ts runs in node on purpose).
 *
 * The title fallback is not a nicety. The Notifications API needs a secure
 * context, and claudops on a NUC is reached over plain http on a LAN address --
 * so in Chrome `Notification` is simply not there, and a tab title that counts
 * the waiting instances is all there is
 * (knowledge/notifications-need-a-secure-context.md).
 */

import type { Instance, InstanceActivity } from './api.ts';

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

/** Everything browser-shaped, so the rule above it can be driven by a test. */
export interface NotifierPorts {
  permission(): NotifyState;
  /** Resolves with the answer. Only meaningful from inside a user gesture --
   *  browsers refuse a permission prompt that nobody asked for. */
  request(): Promise<NotifyState>;
  show(title: string, body: string, tag: string): void;
  /** How many instances are waiting, for whoever paints that -- the tab title
   *  in the browser. */
  setPending(count: number): void;
}

export interface Notifier {
  /** One poll's worth of instances. Fires for each one that has just started
   *  waiting. */
  update(instances: Instance[]): void;
  /** Asks for permission. Call from a click. */
  enable(): Promise<NotifyState>;
  state(): NotifyState;
}

const WAITING: InstanceActivity = 'needs_input';

export function createNotifier(ports: NotifierPorts): Notifier {
  /** What each instance was doing at the previous poll. */
  const previous = new Map<string, InstanceActivity>();
  /** The first update seeds the map without firing. Reloading the page is not
   *  news, and without this every open tab would announce the whole list again
   *  on every refresh. */
  let seeded = false;

  return {
    update(instances: Instance[]): void {
      const fresh = new Map<string, InstanceActivity>();
      let pending = 0;

      for (const instance of instances) {
        fresh.set(instance.id, instance.activity);
        if (instance.activity !== WAITING) continue;

        pending += 1;
        // Only the switch, not the state: an instance that is still waiting at
        // the next poll has already been announced.
        if (seeded && previous.get(instance.id) !== WAITING) {
          ports.show(
            `${instance.name} needs input`,
            'Claude is waiting for an answer.',
            // Tagged by instance, so a second notification for the same one
            // replaces the first rather than stacking.
            instance.id,
          );
        }
      }

      previous.clear();
      for (const [id, activity] of fresh) previous.set(id, activity);
      seeded = true;
      ports.setPending(pending);
    },

    enable(): Promise<NotifyState> {
      return ports.request();
    },

    state(): NotifyState {
      return ports.permission();
    },
  };
}

/**
 * The real browser. `Notification` is missing entirely outside a secure
 * context, which is the normal case here -- so every method has to survive its
 * absence rather than assume the API is there.
 */
export function browserNotifications(baseTitle = document.title): NotifierPorts {
  const api = (): typeof Notification | undefined =>
    typeof Notification === 'undefined' ? undefined : Notification;

  return {
    permission(): NotifyState {
      const notification = api();
      return notification === undefined ? 'unsupported' : notification.permission;
    },

    async request(): Promise<NotifyState> {
      const notification = api();
      if (notification === undefined) return 'unsupported';
      return await notification.requestPermission();
    },

    show(title: string, body: string, tag: string): void {
      const notification = api();
      if (notification === undefined || notification.permission !== 'granted') return;

      // Clicking it should bring the list back up rather than do nothing; the
      // browser decides whether it may, and a refusal is not worth handling.
      const shown = new notification(title, { body, tag });
      shown.onclick = () => {
        window.focus();
      };
    },

    /** The tab title, which is the only channel that always works: it needs no
     *  permission, no secure context, and it is visible from another tab. */
    setPending(count: number): void {
      document.title = count === 0 ? baseTitle : `(${String(count)}) ${baseTitle}`;
    },
  };
}
