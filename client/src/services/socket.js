import { io } from 'socket.io-client';

// In dev with Vite proxy, io() connects to window.location.host; 
// support VITE_SERVER_URL fallback for production.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined;
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

