import { io } from 'socket.io-client';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.DEV ? 'http://localhost:3001' : undefined);

export const socket = io(SERVER_URL, {
  transports: ['websocket', 'polling']
});

export function connectSocket() {
  if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

export function disconnectSocket() {
  socket.disconnect();
}

export function onSocketEvent(event, handler) {
  socket.on(event, handler);
  return () => socket.off(event, handler);
}

export function emitSocket(event, payload, callback) {
  socket.emit(event, payload, callback);
}

