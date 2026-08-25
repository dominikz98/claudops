/**
 * Wires one WebSocket to one attached TTY.
 *
 * Both directions are byte-for-byte; the only thing this module interprets is a
 * control frame (see `protocol.ts`). Everything that makes the console survive a
 * reconnect lives in the container's tmux session, not here -- there is no
 * buffer and no replay in the server on purpose
 * (knowledge/terminal-streaming-via-tmux.md).
 */

import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { TerminalSession } from '../docker/engine.ts';
import { TerminalClose, closeReason, decodeClientFrame, errorFrame } from './protocol.ts';

/** A browser that vanishes without a close frame -- laptop lid, dropped Wi-Fi --
 *  would otherwise leave the exec and its tmux client attached forever. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

export interface BridgeOptions {
  heartbeatMs?: number;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

export function bridgeTerminal(
  socket: WebSocket,
  session: TerminalSession,
  log: FastifyBaseLogger,
  options: BridgeOptions = {},
): void {
  const { stream } = session;
  let ending = false;

  const isOpen = (): boolean => socket.readyState === socket.OPEN;

  /** Container -> browser. Paused until the frame is out, so a slow client
   *  cannot make the server buffer a whole TUI redraw storm. */
  stream.on('data', (chunk: Buffer) => {
    if (!isOpen()) return;
    stream.pause();
    socket.send(chunk, { binary: true }, (error) => {
      // Resume unconditionally. A failed frame is worth a log line but not a
      // paused stream: the next chunk finds the socket closed and stops there,
      // whereas never resuming wedges the console after the first frame.
      if (error) log.debug({ err: error }, 'terminal frame not delivered');
      stream.resume();
    });
  });

  /** Browser -> container. */
  socket.on('message', (data: RawData, isBinary: boolean) => {
    const frame = decodeClientFrame(toBytes(data), isBinary);

    switch (frame.kind) {
      case 'input':
        if (stream.writable) stream.write(frame.data);
        return;
      case 'resize':
        // Docker refuses a resize on an exec that has ended -- a lost race, not
        // something the client can fix, so it does not reach the socket.
        session.resize(frame.size).catch((error: unknown) => {
          log.debug({ err: error }, 'terminal resize rejected');
        });
        return;
      case 'invalid':
        // Not fatal: a client with a broken control frame can still type.
        if (isOpen()) socket.send(errorFrame('invalid_message', frame.message));
        return;
    }
  });

  const endSocket = (): void => {
    if (ending) return;
    ending = true;

    void session
      .exitCode()
      .then((code) => {
        if (!isOpen()) return;
        if (code === undefined || code === 0) {
          socket.close(TerminalClose.sessionEnded, closeReason('session ended'));
          return;
        }
        // A non-zero exit is worth telling apart from a detach: it is what
        // "there was no tmux session to attach to" looks like from here.
        socket.send(errorFrame('session_failed', `terminal process exited with ${code}`));
        socket.close(TerminalClose.conflict, closeReason(`session ended with exit ${code}`));
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'terminal teardown failed');
        if (isOpen()) socket.close(TerminalClose.internal, closeReason('teardown failed'));
      });
  };

  stream.on('end', endSocket);
  stream.on('close', endSocket);
  stream.on('error', (error: Error) => {
    log.debug({ err: error }, 'terminal stream error');
    endSocket();
  });

  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) {
      // No pong for a full interval: the peer is gone, not slow.
      log.debug('terminal client did not answer the ping -- terminating');
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  socket.on('pong', () => {
    alive = true;
  });

  socket.on('error', (error: Error) => {
    log.debug({ err: error }, 'terminal socket error');
  });

  socket.on('close', () => {
    clearInterval(heartbeat);
    // Ending the session is not optional housekeeping: an exec nobody asks to
    // leave keeps its tmux client attached and keeps sizing the pane for
    // everybody else.
    session.close();
  });
}
