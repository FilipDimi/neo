/**
 * The event stream. A client names the last event it has seen and proves it holds the token;
 * it gets every event after that one, then each new event as it is committed. The web app is a
 * projection of this stream.
 */
import type { FastifyInstance } from 'fastify';
import { onEvents, readEvents } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import type { EventRow } from '../shared/events.ts';
import { EVENTS_PATH, sameToken } from './security.ts';

const FIRST_MESSAGE_MS = 3000;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_RESYNC = 4409;

export function eventStream(app: FastifyInstance, options: { db: Db; token: string; replayCap: number }): void {
  app.get(EVENTS_PATH, { websocket: true }, (socket) => {
    let stopListening = () => {};
    const impatient = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED), FIRST_MESSAGE_MS);
    socket.on('close', () => {
      clearTimeout(impatient);
      stopListening();
    });
    socket.once('message', (data) => {
      clearTimeout(impatient);
      let first: { token?: unknown; since?: unknown; taskId?: unknown };
      try {
        first = JSON.parse(String(data)) as typeof first;
      } catch {
        return socket.close(CLOSE_UNAUTHORIZED);
      }
      if (typeof first.token !== 'string' || !sameToken(first.token, options.token)) return socket.close(CLOSE_UNAUTHORIZED);
      const since = typeof first.since === 'number' ? first.since : 0;
      const taskId = typeof first.taskId === 'string' ? first.taskId : undefined;
      const send = (row: EventRow) => socket.send(JSON.stringify(row));

      // Too far behind to replay: the client takes a new snapshot instead.
      const missed = readEvents(options.db, since, options.replayCap + 1, taskId);
      if (missed.length > options.replayCap) {
        socket.send(JSON.stringify({ resync: true }));
        return socket.close(CLOSE_RESYNC);
      }
      // Replay and subscribe in one synchronous step, so no event can fall between them.
      missed.forEach(send);
      stopListening = onEvents(options.db, (rows) => rows.filter((row) => taskId === undefined || row.taskId === taskId).forEach(send));
    });
  });
}
