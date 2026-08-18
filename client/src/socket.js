// Single shared Socket.IO connection for the whole app. Imported once as a
// module singleton so React StrictMode's double-render in dev doesn't create
// duplicate connections.
import { io } from 'socket.io-client';

export const socket = io({
  autoConnect: true,
});
