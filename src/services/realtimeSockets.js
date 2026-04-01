const socketIo = require('socket.io');

let io;

function initializeSockets(server) {
  io = socketIo(server, {
    cors: {
      origin: "*", // Allows any frontend origin during local dev
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log(`🟢 New Socket Connection: ${socket.id}`);

    // Frontend attaches its Firebase UID to this socket connection
    socket.on('authenticate', (uid) => {
      socket.join(uid); // Group sockets by User UID
      console.log(`👤 Socket ${socket.id} authenticated into room UID: ${uid}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔴 Socket Disconnected: ${socket.id}`);
    });
  });

  console.log('✅ Real-Time WebSockets initialized.');
  return io;
}

/**
 * Broadcast an event to a specific user's connected clients
 * This perfectly replaces Firebase's 'onSnapshot' realtime behavior.
 */
function broadcastToUser(uid, eventName, data) {
  if (io) {
    io.to(uid).emit(eventName, data);
  }
}

/**
 * Broadcast an event to ALL connected clients (e.g., config changes)
 */
function broadcastGlobal(eventName, data) {
  if (io) {
    io.emit(eventName, data);
  }
}

module.exports = {
  initializeSockets,
  broadcastToUser,
  broadcastGlobal
};
