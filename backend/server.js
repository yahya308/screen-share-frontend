/**
 * VELOSTREAM Server - Room-based streaming with multi-core support
 */

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');

const config = require('./config');
const WorkerManager = require('./WorkerManager');
const RoomManager = require('./RoomManager');
const database = require('./database');
const rateLimiter = require('./RateLimiter');

const app = express();
app.use(cors());
app.use(express.static('../public'));

// ==================== SERVER SETUP ====================

let server;

// Check for SSL certificates
const certPath = config.https?.cert;
const keyPath = config.https?.key;

if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    server = https.createServer({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath)
    }, app);
    console.log('🔒 HTTPS Server');
} else {
    server = http.createServer(app);
    console.log('⚠️ HTTP Server (SSL not found)');
}

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// ==================== MANAGERS ====================

const workerManager = new WorkerManager();
let roomManager;

// ==================== SOCKET HANDLERS ====================

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    console.log(`Client connected: ${socket.id}`);

    // ==================== LOBBY EVENTS ====================

    // Get all rooms
    socket.on('get-rooms', (callback) => {
        const rooms = roomManager.getAllRooms();
        callback(rooms);
    });

    // Create room
    socket.on('create-room', async ({ name, password, maxUsers }, callback) => {
        const result = await roomManager.createRoom({
            name,
            password,
            adminSocketId: socket.id,
            maxUsers
        });

        if (result.error) {
            callback({ error: result.error });
            return;
        }

        socket.join(result.roomId);
        callback({
            success: true,
            roomId: result.roomId,
            isPublic: result.isPublic
        });

        // Notify lobby of new room
        io.emit('room-created', {
            id: result.roomId,
            name,
            is_locked: !!password,
            userCount: 1,
            max_users: maxUsers || 100
        });
    });

    // Admin rejoin (after page redirect)
    socket.on('admin-rejoin', async ({ roomId }, callback) => {
        const room = database.getRoom(roomId);
        if (!room) {
            callback({ error: 'Oda bulunamadı' });
            return;
        }

        // Cancel any pending room close
        roomManager.cancelPendingClose(roomId);

        // Update admin socket ID
        database.updateAdminSocket(roomId, socket.id);
        roomManager.socketRooms.set(socket.id, { roomId, role: 'admin' });

        socket.join(roomId);

        const roomState = roomManager.rooms.get(roomId);

        callback({
            success: true,
            roomId,
            roomName: room.name,
            maxUsers: room.max_users,
            isStreaming: roomState?.isStreaming || false
        });

        console.log(`👑 Admin rejoined room ${roomId} with new socket ${socket.id}`);
    });

    // Join room
    socket.on('join-room', async ({ roomId, password }, callback) => {
        // Check rate limit
        const blockStatus = rateLimiter.isBlocked(clientIp, roomId);
        if (blockStatus.blocked) {
            callback({
                error: `Çok fazla yanlış deneme. ${blockStatus.remainingTime} saniye bekleyin.`,
                blocked: true,
                remainingTime: blockStatus.remainingTime
            });
            return;
        }

        const result = await roomManager.joinRoom(roomId, socket.id, password, clientIp);

        if (result.error) {
            if (result.needPassword && password) {
                // Wrong password, record failed attempt
                const attemptResult = rateLimiter.recordFailedAttempt(clientIp, roomId);
                callback({
                    error: result.error,
                    needPassword: true,
                    remainingAttempts: attemptResult.remainingAttempts,
                    blocked: attemptResult.blocked,
                    remainingTime: attemptResult.remainingTime
                });
            } else {
                callback(result);
            }
            return;
        }

        // Success - reset rate limiter
        rateLimiter.resetAttempts(clientIp, roomId);

        socket.join(roomId);
        callback(result);

        // Notify room of new user
        socket.to(roomId).emit('user-joined', {
            userCount: roomManager.getRoomUserCount(roomId)
        });

        // Update lobby
        io.emit('room-updated', {
            id: roomId,
            userCount: roomManager.getRoomUserCount(roomId)
        });
    });

    // Leave room
    socket.on('leave-room', () => {
        handleLeaveRoom(socket);
    });

    // Close room (admin only)
    socket.on('close-room', () => {
        if (roomManager.isAdmin(socket.id)) {
            const socketData = roomManager.getRoomFromSocket(socket.id);
            if (socketData) {
                const roomId = socketData.roomId;

                // Notify all users in room
                io.to(roomId).emit('room-closed', { reason: 'Admin odayı kapattı' });

                roomManager.closeRoom(roomId);

                // Update lobby
                io.emit('room-deleted', { id: roomId });
            }
        }
    });

    // Update max users (admin only)
    socket.on('update-max-users', ({ maxUsers }, callback) => {
        if (!roomManager.isAdmin(socket.id)) {
            callback({ error: 'Yetkiniz yok' });
            return;
        }

        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (socketData) {
            roomManager.updateMaxUsers(socketData.roomId, maxUsers);
            callback({ success: true });
        }
    });

    // ==================== MEDIASOUP EVENTS ====================

    // Get router capabilities
    socket.on('getRouterRtpCapabilities', (callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) {
            callback({ error: 'Odaya katılmadınız' });
            return;
        }
        callback(socketData.roomState.router.rtpCapabilities);
    });

    // Create transport
    socket.on('createWebRtcTransport', async ({ sender }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) {
            callback({ params: { error: 'Odaya katılmadınız' } });
            return;
        }

        // Only admin can be sender
        if (sender && socketData.role !== 'admin') {
            callback({ params: { error: 'Yayın yapma yetkiniz yok' } });
            return;
        }

        try {
            const roomState = socketData.roomState;
            const transport = await roomState.router.createWebRtcTransport(
                config.mediasoup.webRtcTransport
            );

            roomState.transports.set(socket.id + (sender ? '-send' : '-recv'), transport);

            callback({
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters
                }
            });
        } catch (error) {
            console.error('Transport create error:', error);
            callback({ params: { error: error.message } });
        }
    });

    // Connect transport
    socket.on('transport-connect', async ({ transportId, dtlsParameters }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) return;

        const transport = findTransport(socketData.roomState, transportId);
        if (transport) {
            await transport.connect({ dtlsParameters });
        }
    });

    // Produce (admin only)
    socket.on('transport-produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) {
            callback({ error: 'Odaya katılmadınız' });
            return;
        }

        if (socketData.role !== 'admin') {
            callback({ error: 'Yayın yapma yetkiniz yok' });
            return;
        }

        try {
            const transport = findTransport(socketData.roomState, transportId);
            if (!transport) {
                callback({ error: 'Transport bulunamadı' });
                return;
            }

            const producer = await transport.produce({ kind, rtpParameters, appData });
            socketData.roomState.producers.set(producer.id, producer);

            workerManager.incrementProducers(socketData.roomState.workerIndex);

            // Set streaming status
            if (kind === 'video') {
                roomManager.setStreamingStatus(socketData.roomId, true);
                socket.to(socketData.roomId).emit('stream-started');
            }

            callback({ id: producer.id });

            // Notify viewers of new producer
            socket.to(socketData.roomId).emit('new-producer', producer.id);
        } catch (error) {
            console.error('Produce error:', error);
            callback({ error: error.message });
        }
    });

    // Consume
    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) {
            callback({ params: { error: 'Odaya katılmadınız' } });
            return;
        }

        try {
            const roomState = socketData.roomState;

            if (!roomState.router.canConsume({ producerId, rtpCapabilities })) {
                callback({ params: { error: 'Cannot consume' } });
                return;
            }

            const transport = findTransport(roomState, transportId);
            if (!transport) {
                callback({ params: { error: 'Transport bulunamadı' } });
                return;
            }

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: true
            });

            roomState.consumers.set(socket.id, consumer);
            workerManager.incrementConsumers(roomState.workerIndex);

            callback({
                params: {
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters
                }
            });
        } catch (error) {
            console.error('Consume error:', error);
            callback({ params: { error: error.message } });
        }
    });

    // Resume consumer
    socket.on('resume', async () => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) return;

        const consumer = socketData.roomState.consumers.get(socket.id);
        if (consumer) {
            await consumer.resume();
        }
    });

    // Get producers
    socket.on('getProducers', (callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) {
            callback([]);
            return;
        }
        callback(Array.from(socketData.roomState.producers.keys()));
    });

    // Producer closing (pause/stop stream)
    socket.on('producer-closing', ({ producerId }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData || !socketData.roomState) return;

        const producer = socketData.roomState.producers.get(producerId);
        if (producer) {
            if (producer.kind === 'video') {
                roomManager.setStreamingStatus(socketData.roomId, false);
                socket.to(socketData.roomId).emit('stream-paused');
            }

            producer.close();
            socketData.roomState.producers.delete(producerId);
            workerManager.decrementProducers(socketData.roomState.workerIndex);

            socket.to(socketData.roomId).emit('producer-closed', { remoteProducerId: producerId });
        }
    });

    // ==================== DISCONNECT ====================

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        handleLeaveRoom(socket);
    });
});

// ==================== HELPERS ====================

function handleLeaveRoom(socket) {
    const result = roomManager.leaveRoom(socket.id);
    if (!result) return;

    if (result.roomClosed) {
        io.to(result.roomId).emit('room-closed', { reason: 'Admin ayrıldı' });
        io.emit('room-deleted', { id: result.roomId });
    } else {
        socket.to(result.roomId).emit('user-left', {
            userCount: roomManager.getRoomUserCount(result.roomId)
        });
        io.emit('room-updated', {
            id: result.roomId,
            userCount: roomManager.getRoomUserCount(result.roomId)
        });
    }
}

function findTransport(roomState, transportId) {
    for (const [key, transport] of roomState.transports) {
        if (transport.id === transportId) return transport;
    }
    return null;
}

// ==================== STARTUP ====================

async function start() {
    await workerManager.init();
    roomManager = new RoomManager(workerManager);

    const PORT = config.port || 3000;
    server.listen(PORT, () => {
        console.log(`🚀 VELOSTREAM Server running on port ${PORT}`);
        console.log(`📊 Workers: ${workerManager.workers.length}`);
    });
}

start().catch(console.error);
