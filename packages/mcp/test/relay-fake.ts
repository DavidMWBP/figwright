import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

import {
  createRequest,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  SystemMethod,
  type Envelope,
} from '@figwright/shared';
import type { WebSocket, WebSocketServer } from 'ws';

import { Relay } from '../src/relay/relay.js';

/** In-memory sockets exercise the relay's real envelope and request paths without listening. */
export const fakeRelay = () => {
  const http = createServer();
  const relay = new Relay({ server: http, serverVersion: '1.0.0' });
  const connect = (id: string, fileName: string, pageName: string | null = null) => {
    const socket = new EventEmitter();
    const sent: Envelope[] = [];
    let requested: (env: Envelope) => void = () => {};
    const request = new Promise<Envelope>(resolve => {
      requested = resolve;
    });
    Object.assign(socket, {
      send: (bytes: Uint8Array) => {
        const env = decodeEnvelope(bytes);
        sent.push(env);
        if (env.kind === 'req' && env.method !== SystemMethod.Ping) requested(env);
      },
      ping: () => {},
      close: () => {},
      terminate: () => {},
    });
    (relay as unknown as { wss: WebSocketServer }).wss.emit('connection', socket);
    const receive = (env: Envelope) => socket.emit('message', encodeEnvelope(env));
    receive(
      createRequest({
        id: 'hello',
        sessionId: id,
        method: SystemMethod.Hello,
        params: { clientType: 'plugin', clientVersion: '1.0.0', protocolVersion: PROTOCOL_VERSION },
      }),
    );
    const session = relay.sessions.get(id)!;
    session.fileName = fileName;
    session.pageName = pageName;
    return { sent, receive, request, socket: socket as unknown as WebSocket };
  };
  return { relay, connect, http };
};
