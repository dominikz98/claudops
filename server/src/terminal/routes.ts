import type { FastifyBaseLogger, FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import type { WebSocket } from 'ws';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  DockerUnavailableError,
} from '../docker/engine.ts';
import {
  ContainerMissingError,
  InstanceNotFoundError,
  type InstanceService,
} from '../instances/service.ts';
import { bridgeTerminal, type BridgeOptions } from './bridge.ts';
import { TerminalClose, closeReason, errorFrame, parseSizeQuery } from './protocol.ts';

export interface TerminalRoutesOptions extends FastifyPluginOptions {
  service: InstanceService;
  /** Only the tests override this, to keep the heartbeat out of real time. */
  bridge?: BridgeOptions | undefined;
}

interface Refusal {
  code: number;
  reason: string;
  message: string;
}

/**
 * The upgrade has already succeeded by the time the handler runs, so a problem
 * is reported on the open socket rather than as an HTTP status: an error frame
 * for a human-readable cause, then a close code the UI can branch on.
 */
function refusalFor(error: unknown, log: FastifyBaseLogger): Refusal {
  if (error instanceof InstanceNotFoundError) {
    return { code: TerminalClose.notFound, reason: 'not_found', message: error.message };
  }
  if (error instanceof ContainerMissingError || error instanceof ContainerNotFoundError) {
    return { code: TerminalClose.conflict, reason: 'no_container', message: error.message };
  }
  if (error instanceof ContainerNotRunningError) {
    return { code: TerminalClose.conflict, reason: 'not_running', message: error.message };
  }
  if (error instanceof DockerUnavailableError) {
    return {
      code: TerminalClose.dockerUnavailable,
      reason: 'docker_unavailable',
      message: error.message,
    };
  }

  log.error({ err: error }, 'terminal attach failed');
  return { code: TerminalClose.internal, reason: 'internal_error', message: 'attach failed' };
}

export const terminalRoutes: FastifyPluginCallback<TerminalRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  app.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>(
    '/instances/:id/terminal',
    { websocket: true },
    async (socket: WebSocket, request) => {
      const { id } = request.params;
      const size = parseSizeQuery(request.query.cols, request.query.rows);

      // The upgrade is complete before the attach even starts, so the client
      // may already be typing while this awaits Docker -- and `ws` drops a
      // frame that arrives with no listener on it. Pausing holds those frames
      // in the socket until the bridge is wired.
      socket.pause();
      try {
        const session = await service.openTerminal(id, size);
        request.log.info({ instance: id, size }, 'terminal attached');
        bridgeTerminal(socket, session, request.log, options.bridge ?? {});
      } catch (error) {
        const refusal = refusalFor(error, request.log);
        if (socket.readyState === socket.OPEN) {
          socket.send(errorFrame(refusal.reason, refusal.message));
          socket.close(refusal.code, closeReason(refusal.reason));
        }
      } finally {
        socket.resume();
      }
    },
  );

  done();
};
