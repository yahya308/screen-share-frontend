const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration for Vercel compatibility
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e8, // 100MB buffer for large SDP messages
  allowEIO3: true,
  path: '/socket.io/'
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'broadcaster.html'));
});

app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    connections: io.engine.clientsCount,
    uptime: process.uptime(),
  });
});

// Store active connections for better management
const activeConnections = new Map();
let broadcasterCount = 0;
let viewerCount = 0;

// Socket.IO connection handling with enhanced error management
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id} (Total: ${io.engine.clientsCount})`);

  // Store connection info
  activeConnections.set(socket.id, {
    id: socket.id,
    type: null,
    connectedAt: new Date(),
    lastActivity: new Date(),
  });

  // Handle broadcaster joining
  socket.on('broadcaster', () => {
    try {
      console.log(`Broadcaster joined: ${socket.id}`);

      const connection = activeConnections.get(socket.id);
      if (connection) {
        connection.type = 'broadcaster';
        connection.lastActivity = new Date();
      }

      broadcasterCount++;

      // Notify all other clients about new broadcaster
      socket.broadcast.emit('broadcaster');

      // Send connection stats to broadcaster
      socket.emit('connection-stats', {
        totalConnections: io.engine.clientsCount,
        broadcasterCount,
        viewerCount,
      });

      console.log(`Broadcaster count: ${broadcasterCount}`);
    } catch (error) {
      console.error('Error handling broadcaster join:', error);
      socket.emit('error', 'Broadcaster join failed');
    }
  });

  // Handle viewer joining
  socket.on('viewer', () => {
    try {
      console.log(`Viewer joined: ${socket.id}`);

      const connection = activeConnections.get(socket.id);
      if (connection) {
        connection.type = 'viewer';
        connection.lastActivity = new Date();
      }

      viewerCount++;

      // Notify all other clients about new viewer
      socket.broadcast.emit('viewer');

      // Send connection stats to viewer
      socket.emit('connection-stats', {
        totalConnections: io.engine.clientsCount,
        broadcasterCount,
        viewerCount,
      });

      console.log(`Viewer count: ${viewerCount}`);
    } catch (error) {
      console.error('Error handling viewer join:', error);
      socket.emit('error', 'Viewer join failed');
    }
  });

  // Handle WebRTC offer with validation
  socket.on('offer', (offer) => {
    try {
      if (!offer || !offer.sdp) {
        console.error('Invalid offer received from:', socket.id);
        socket.emit('error', 'Invalid offer format');
        return;
      }

      console.log(`Offer received from ${socket.id}, SDP length: ${offer.sdp.length}`);

      // Validate SDP format
      if (offer.sdp.includes('v=0') && offer.sdp.includes('m=video')) {
        socket.broadcast.emit('offer', offer);
        console.log('Offer forwarded successfully');

        // Update activity
        const connection = activeConnections.get(socket.id);
        if (connection) {
          connection.lastActivity = new Date();
        }
      } else {
        console.error('Invalid SDP format in offer from:', socket.id);
        socket.emit('error', 'Invalid SDP format');
      }
    } catch (error) {
      console.error('Error handling offer:', error);
      socket.emit('error', 'Offer processing failed');
    }
  });

  // Handle WebRTC answer with validation
  socket.on('answer', (answer) => {
    try {
      if (!answer || !answer.sdp) {
        console.error('Invalid answer received from:', socket.id);
        socket.emit('error', 'Invalid answer format');
        return;
      }

      console.log(`Answer received from ${socket.id}, SDP length: ${answer.sdp.length}`);

      // Validate SDP format
      if (answer.sdp.includes('v=0') && answer.sdp.includes('m=video')) {
        socket.broadcast.emit('answer', answer);
        console.log('Answer forwarded successfully');

        // Update activity
        const connection = activeConnections.get(socket.id);
        if (connection) {
          connection.lastActivity = new Date();
        }
      } else {
        console.error('Invalid SDP format in answer from:', socket.id);
        socket.emit('error', 'Invalid SDP format');
      }
    } catch (error) {
      console.error('Error handling answer:', error);
      socket.emit('error', 'Answer processing failed');
    }
  });

  // Handle ICE candidates with validation
  socket.on('ice-candidate', (candidate) => {
    try {
      if (!candidate || !candidate.candidate) {
        console.error('Invalid ICE candidate received from:', socket.id);
        return;
      }

      console.log(`ICE candidate from ${socket.id}: ${candidate.candidate.substring(0, 50)}...`);

      socket.broadcast.emit('ice-candidate', candidate);

      // Update activity
      const connection = activeConnections.get(socket.id);
      if (connection) {
        connection.lastActivity = new Date();
      }
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  });

  // Handle custom events for debugging
  socket.on('debug', (data) => {
    console.log(`Debug from ${socket.id}:`, data);
  });

  // Handle disconnect with cleanup
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);

    // Don't immediately clean up, wait a bit to see if it's a temporary disconnection
    setTimeout(() => {
      const connection = activeConnections.get(socket.id);
      if (connection) {
        // Only clean up if it's been more than 10 seconds
        const timeSinceLastActivity = Date.now() - connection.lastActivity;
        if (timeSinceLastActivity > 10000) { // 10 seconds
          console.log(`Cleaning up connection after timeout: ${socket.id}`);

          if (connection.type === 'broadcaster') {
            broadcasterCount = Math.max(0, broadcasterCount - 1);
            console.log(`Broadcaster count: ${broadcasterCount}`);
          } else if (connection.type === 'viewer') {
            viewerCount = Math.max(0, viewerCount - 1);
            console.log(`Viewer count: ${viewerCount}`);
          }

          activeConnections.delete(socket.id);

          // Notify other clients about disconnection
          socket.broadcast.emit('user-disconnected', {
            userId: socket.id,
            reason: reason,
          });
        } else {
          console.log(`Connection ${socket.id} may reconnect, keeping active`);
          // Update last activity to prevent premature cleanup
          connection.lastActivity = Date.now();
        }
      }

      console.log(`Total connections: ${io.engine.clientsCount}`);
    }, 5000); // Wait 5 seconds before cleanup
  });

  // Handle reconnection
  socket.on('reconnect', () => {
    console.log(`User reconnected: ${socket.id}`);

    // Check if this is a reconnection of an existing user
    const existingConnection = activeConnections.get(socket.id);
    if (existingConnection) {
      console.log(`Reconnection detected for ${socket.id}`);
      existingConnection.lastActivity = Date.now();

      // Notify other clients about reconnection
      socket.broadcast.emit('user-reconnected', {
        userId: socket.id,
        type: existingConnection.type,
      });
    }
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });

  // Handle ping for connection health
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });

    // Update activity
    const connection = activeConnections.get(socket.id);
    if (connection) {
      connection.lastActivity = new Date();
    }
  });
});

// Periodic cleanup of stale connections with better logic
setInterval(() => {
  const now = new Date();
  const timeout = 30 * 1000; // 30 seconds (increased from 5 minutes)

  for (const [id, connection] of activeConnections.entries()) {
    const timeSinceLastActivity = now - connection.lastActivity;

    if (timeSinceLastActivity > timeout) {
      console.log(`Cleaning up stale connection: ${id} (inactive for ${Math.round(timeSinceLastActivity / 1000)}s)`);

      // Only force disconnect if it's been inactive for a very long time
      if (timeSinceLastActivity > 60000) { // 1 minute
        const socket = io.sockets.sockets.get(id);
        if (socket) {
          console.log(`Force disconnecting stale socket: ${id}`);
          socket.disconnect(true);
        }
      }

      activeConnections.delete(id);

      // Update counts
      if (connection.type === 'broadcaster') {
        broadcasterCount = Math.max(0, broadcasterCount - 1);
      } else if (connection.type === 'viewer') {
        viewerCount = Math.max(0, viewerCount - 1);
      }
    }
  }

  // Log connection stats
  console.log(`Connection stats - Total: ${io.engine.clientsCount}, Active: ${activeConnections.size}, Broadcasters: ${broadcasterCount}, Viewers: ${viewerCount}`);
}, 30000); // Check every 30 seconds (increased from 1 minute

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📺 Broadcaster: http://localhost:${PORT}/`);
  console.log(`👁️ Viewer: http://localhost:${PORT}/watch`);
  console.log(`🧪 Test: http://localhost:${PORT}/test`);
  console.log(`💚 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Socket.IO transport: ${io.engine.opts.transports.join(', ')}`);
});
