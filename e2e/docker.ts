/**
 * The container side of the assertions.
 *
 * The browser can only ever show what it was sent, so every claim about the
 * console is checked twice: once in the page and once against tmux inside the
 * container. `docker` is called directly rather than through a library --
 * these are four commands, and the CLI is what a reader would run by hand.
 */

import { execFileSync } from 'node:child_process';

export function docker(...args: string[]): string {
  // Windows line endings would otherwise end up inside every compared string.
  return execFileSync('docker', args, { encoding: 'utf8' }).replaceAll('\r', '');
}

/** `false` rather than a throw for the commands whose failure is an answer. */
function ask(...args: string[]): boolean {
  try {
    docker(...args);
    return true;
  } catch {
    return false;
  }
}

export function containersFor(instanceId: string): string[] {
  return docker(
    'ps',
    '-a',
    '--filter',
    `label=claudops.instance=${instanceId}`,
    '--format',
    '{{.ID}}',
  )
    .split('\n')
    .filter((line) => line !== '');
}

export function hasSession(containerId: string, session: string): boolean {
  return ask('exec', containerId, 'tmux', 'has-session', '-t', session);
}

/**
 * A second window running a plain login shell. Window 0 runs Claude, whose
 * output depends on a token and on the day; every assertion below wants a
 * shell that answers the same way every time. tmux makes the new window the
 * active one, so this is also what an attaching browser will see.
 */
export function openProbeWindow(containerId: string, session: string): void {
  docker('exec', containerId, 'tmux', 'new-window', '-t', session, '-n', 'probe', 'exec bash -l');
}

export function capturePane(containerId: string, target: string): string {
  return docker('exec', containerId, 'tmux', 'capture-pane', '-p', '-S', '-', '-t', target);
}

export function paneSize(containerId: string, target: string): string {
  return docker(
    'exec',
    containerId,
    'tmux',
    'display',
    '-p',
    '-t',
    target,
    '#{pane_width}x#{pane_height}',
  ).trim();
}

/** One line per attached console. A leftover line is a client nobody is
 *  watching -- and tmux sizes the window to the smallest of them. */
export function listClients(containerId: string, session: string): string[] {
  return docker('exec', containerId, 'tmux', 'list-clients', '-t', session)
    .split('\n')
    .filter((line) => line !== '');
}

export function removeContainers(instanceId: string): void {
  for (const id of containersFor(instanceId)) ask('rm', '-f', id);
}

/** Every environment variable of a container, as `KEY=value` lines. What the
 *  server handed the container is only visible from out here. */
export function containerEnv(containerId: string): string[] {
  return docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', containerId)
    .split('\n')
    .filter((line) => line !== '');
}
