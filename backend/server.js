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

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const corsOptions = allowedOrigins.length
    ? { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }
    : { origin: '*', methods: ['GET', 'POST'] };

const app = express();
app.use(cors(corsOptions));
app.use(express.static('../public'));

// ==================== SERVER SETUP ====================

let server;
const certPath = config.https?.cert;
const keyPath = config.https?.key;

if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
    console.log('🔒 HTTPS Server');
} else {
    server = http.createServer(app);
    console.log('⚠️  HTTP Server (SSL not found)');
}

const io = new Server(server, { cors: corsOptions });

// ==================== MANAGERS ====================

const workerManager = new WorkerManager();
let roomManager;

// ==================== HEALTH CHECK ENDPOINTS ====================

app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'VELOSTREAM', version: '2.0.0', uptime: Math.floor(process.uptime()) });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        workers: workerManager?.workers?.length || 0,
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// ==================== INPUT HELPERS ====================

/** Sanitize chat message: trim + limit length + basic safety */
function sanitizeChatMessage(msg) {
    if (typeof msg !== 'string') return '';
    return msg.trim().slice(0, 500);
}

// ==================== SOCKET HANDLERS ====================

io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || socket.handshake.address;

    console.log(`Client connected: ${socket.id} ip=${clientIp}`);

    // ==================== LOBBY EVENTS ====================

    socket.on('get-rooms', (callback) => {
        if (typeof callback !== 'function') return;
        callback(roomManager.getAllRooms());
    });

    socket.on('create-room', async ({ name, password, maxUsers }, callback) => {
        if (typeof callback !== 'function') return;

        const result = await roomManager.createRoom({
            name, password, adminSocketId: socket.id, maxUsers
        });

        if (result.error) { callback({ error: result.error }); return; }

        socket.join(result.roomId);
        callback({ success: true, roomId: result.roomId, isPublic: result.isPublic });

        io.emit('room-created', {
            id: result.roomId, name, is_locked: !!password,
            userCount: 1, max_users: maxUsers || 100
        });

        roomManager.startOrphanTimeout(result.roomId, (roomId) => {
            io.emit('room-deleted', { id: roomId });
        });
    });

    // Admin rejoin after page redirect
    socket.on('admin-rejoin', async ({ roomId, nickname }, callback) => {
        if (typeof callback !== 'function') return;

        const room = database.getRoom(roomId);
        if (!room) { callback({ error: 'Oda bulunamadı' }); return; }

        // Validate nickname
        const nickErr = RoomManager.validateNickname(nickname);
        if (nickErr) { callback({ error: nickErr }); return; }

        roomManager.cancelPendingClose(roomId);
        roomManager.cancelPendingAdminJoin(roomId);

        // Update admin socket
        roomManager.updateAdminSocket(roomId, socket.id, clientIp);

        // Set nickname
        roomManager.setNickname(socket.id, nickname.trim());

        const roomState = roomManager.rooms.get(roomId);
        if (roomState) roomState.adminJoined = true;

        socket.join(roomId);

        const userCount = roomManager.getRoomUserCount(roomId);

        callback({
            success: true,
            roomId,
            roomName: room.name,
            maxUsers: room.max_users,
            userCount,
            isStreaming: roomState?.isStreaming || false,
            viewerMicEnabled: roomState?.viewerMicEnabled ?? true,
            chatEnabled: roomState?.chatEnabled ?? true
        });

        // Broadcast updated user list
        io.to(roomId).emit('user-list', roomManager.getUserList(roomId));

        console.log(`👑 Admin rejoined room ${roomId} as "${nickname.trim()}"`);
    });

    // Join room (viewer)
    socket.on('join-room', async ({ roomId, password, nickname }, callback) => {
        if (typeof callback !== 'function') return;

        // Rate limit (password brute-force)
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
                const attemptResult = rateLimiter.recordFailedAttempt(clientIp, roomId);
                callback({
                    error: result.error, needPassword: true,
                    remainingAttempts: attemptResult.remainingAttempts,
                    blocked: attemptResult.blocked,
                    remainingTime: attemptResult.remainingTime
                });
            } else {
                callback(result);
            }
            return;
        }

        rateLimiter.resetAttempts(clientIp, roomId);
        socket.join(roomId);

        // Set nickname if provided (may be absent for lobby-only password check)
        if (nickname) {
            const nickErr = RoomManager.validateNickname(nickname);
            if (nickErr) {
                // Undo join and return error
                roomManager.leaveRoom(socket.id);
                socket.leave(roomId);
                callback({ error: nickErr });
                return;
            }
            const nickResult = roomManager.setNickname(socket.id, nickname.trim());
            if (nickResult.error) {
                roomManager.leaveRoom(socket.id);
                socket.leave(roomId);
                callback({ error: nickResult.error });
                return;
            }
        }

        callback(result);

        // Notify room
        socket.to(roomId).emit('user-joined', { userCount: roomManager.getRoomUserCount(roomId) });
        io.to(roomId).emit('user-list', roomManager.getUserList(roomId));
        io.emit('room-updated', { id: roomId, userCount: roomManager.getRoomUserCount(roomId) });
    });

    socket.on('leave-room', () => handleLeaveRoom(socket));

    // Close room (admin only)
    socket.on('close-room', () => {
        if (!roomManager.isAdmin(socket.id)) return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData) return;
        const roomId = socketData.roomId;
        io.to(roomId).emit('room-closed', { reason: 'Admin odayı kapattı' });
        roomManager.closeRoom(roomId);
        io.emit('room-deleted', { id: roomId });
    });

    // Update max users (admin only)
    socket.on('update-max-users', ({ maxUsers }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (socketData) {
            roomManager.updateMaxUsers(socketData.roomId, maxUsers);
            callback?.({ success: true });
        }
    });

    // ==================== MODERATION ====================

    // Kick user (admin only, viewer can re-join)
    socket.on('kick-user', ({ targetSocketId }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }

        const adminData = roomManager.getRoomFromSocket(socket.id);
        if (!adminData) { callback?.({ error: 'Oda bulunamadı' }); return; }

        const targetData = roomManager.socketRooms.get(targetSocketId);
        if (!targetData || targetData.roomId !== adminData.roomId) {
            callback?.({ error: 'Kullanıcı bu odada değil' }); return;
        }
        if (targetData.role === 'admin') { callback?.({ error: 'Admin kicklenemez' }); return; }

        const roomId = adminData.roomId;

        // Notify the kicked user
        io.to(targetSocketId).emit('you-were-kicked');

        // Clean up server state
        const result = roomManager.leaveRoom(targetSocketId);
        if (result?.closedProducerIds?.length) {
            result.closedProducerIds.forEach(pid =>
                io.to(roomId).emit('producer-closed', { remoteProducerId: pid }));
        }

        // Disconnect the socket
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) { targetSocket.leave(roomId); targetSocket.disconnect(true); }

        // Update room counts
        const newCount = roomManager.getRoomUserCount(roomId);
        io.to(roomId).emit('user-left', { userCount: newCount });
        io.to(roomId).emit('user-list', roomManager.getUserList(roomId));
        io.emit('room-updated', { id: roomId, userCount: newCount });

        callback?.({ success: true });
    });

    // Ban user (admin only, IP-based, cannot re-join this room while server running)
    socket.on('ban-user', ({ targetSocketId }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }

        const adminData = roomManager.getRoomFromSocket(socket.id);
        if (!adminData) { callback?.({ error: 'Oda bulunamadı' }); return; }

        const targetData = roomManager.socketRooms.get(targetSocketId);
        if (!targetData || targetData.roomId !== adminData.roomId) {
            callback?.({ error: 'Kullanıcı bu odada değil' }); return;
        }
        if (targetData.role === 'admin') { callback?.({ error: 'Admin banlanamaz' }); return; }

        const roomId = adminData.roomId;
        const targetIp = targetData.ip;

        // Apply ban
        roomManager.banIp(roomId, targetIp);

        // Notify and disconnect
        io.to(targetSocketId).emit('you-were-banned');

        const result = roomManager.leaveRoom(targetSocketId);
        if (result?.closedProducerIds?.length) {
            result.closedProducerIds.forEach(pid =>
                io.to(roomId).emit('producer-closed', { remoteProducerId: pid }));
        }

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) { targetSocket.leave(roomId); targetSocket.disconnect(true); }

        const newCount = roomManager.getRoomUserCount(roomId);
        io.to(roomId).emit('user-left', { userCount: newCount });
        io.to(roomId).emit('user-list', roomManager.getUserList(roomId));
        io.emit('room-updated', { id: roomId, userCount: newCount });

        callback?.({ success: true });
        console.log(`🚫 User ${targetSocketId} (IP: ${targetIp}) banned from room ${roomId}`);
    });

    // ==================== VIEWER MIC PERMISSION ====================

    // Toggle viewer mic permission (admin only)
    socket.on('toggle-viewer-mic', ({ enabled }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }

        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Oda bulunamadı' }); return; }

        const roomState = socketData.roomState;
        roomState.viewerMicEnabled = !!enabled;

        // Broadcast new state to all in room
        io.to(socketData.roomId).emit('viewer-mic-state', { enabled: !!enabled });

        // If disabling, forcibly close all viewer audio producers
        if (!enabled) {
            const closedIds = [];
            for (const [producerId, producer] of roomState.producers) {
                const ownerData = roomManager.socketRooms.get(producer.appData?.socketId);
                if (ownerData?.role === 'viewer' && producer.kind === 'audio') {
                    try { producer.close(); } catch (e) {}
                    roomState.producers.delete(producerId);
                    closedIds.push(producerId);
                    workerManager.decrementProducers(roomState.workerIndex);
                }
            }
            if (closedIds.length) {
                closedIds.forEach(pid =>
                    io.to(socketData.roomId).emit('producer-closed', { remoteProducerId: pid }));
            }
        }

        callback?.({ success: true });
        console.log(`🎙️ Viewer mic ${enabled ? 'enabled' : 'disabled'} in room ${socketData.roomId}`);
    });

    // ==================== CHAT ====================

    // Toggle chat (admin only)
    socket.on('toggle-chat', ({ enabled }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }

        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Oda bulunamadı' }); return; }

        socketData.roomState.chatEnabled = !!enabled;
        io.to(socketData.roomId).emit('chat-state', { enabled: !!enabled });

        callback?.({ success: true });
        console.log(`💬 Chat ${enabled ? 'enabled' : 'disabled'} in room ${socketData.roomId}`);
    });

    // Send chat message
    socket.on('chat-message', ({ message }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Odaya katılmadınız' }); return; }

        if (!socketData.roomState.chatEnabled) {
            callback?.({ error: 'Chat oda sahibi tarafından kapatıldı' }); return;
        }

        if (!roomManager.checkChatRateLimit(socket.id)) {
            callback?.({ error: 'Çok hızlı mesaj gönderiyorsunuz, biraz bekleyin' }); return;
        }

        const clean = sanitizeChatMessage(message);
        if (!clean) { callback?.({ error: 'Mesaj boş olamaz' }); return; }

        const nickname = socketData.nickname || 'Anonim';
        const role = socketData.role;

        io.to(socketData.roomId).emit('chat-message', {
            socketId: socket.id,
            nickname,
            role,
            message: clean,
            timestamp: Date.now()
        });

        callback?.({ success: true });
    });

    // ==================== VOICE ACTIVITY ====================

    socket.on('voice-activity', ({ speaking }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData) return;

        const roomId = roomManager.setSpeaking(socket.id, !!speaking);
        if (!roomId) return;

        // Broadcast to room (not back to sender)
        socket.to(roomId).emit('voice-activity', { socketId: socket.id, speaking: !!speaking });
    });

    // ==================== MEDIASOUP EVENTS ====================

    socket.on('getRouterRtpCapabilities', (callback) => {
        if (typeof callback !== 'function') return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback({ error: 'Odaya katılmadınız' }); return; }
        callback(socketData.roomState.router.rtpCapabilities);
    });

    socket.on('createWebRtcTransport', async ({ sender }, callback) => {
        if (typeof callback !== 'function') return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback({ params: { error: 'Odaya katılmadınız' } }); return; }

        // Viewers can create a send transport ONLY when viewerMicEnabled
        if (sender && socketData.role !== 'admin') {
            if (!socketData.roomState.viewerMicEnabled) {
                callback({ params: { error: 'Mikrofon özelliği şu an devre dışı' } }); return;
            }
        }

        try {
            const roomState = socketData.roomState;
            const transport = await roomState.router.createWebRtcTransport(config.mediasoup.webRtcTransport);

            try {
                if (sender && config.mediasoup.webRtcTransport.maxIncomingBitrate) {
                    await transport.setMaxIncomingBitrate(config.mediasoup.webRtcTransport.maxIncomingBitrate);
                }
                if (!sender && config.mediasoup.webRtcTransport.maxIncomingBitrate) {
                    await transport.setMaxOutgoingBitrate(config.mediasoup.webRtcTransport.maxIncomingBitrate);
                }
            } catch (e) {
                console.warn(`⚠️ Transport bitrate tuning skipped: ${e.message}`);
            }

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

    socket.on('transport-connect', async ({ transportId, dtlsParameters }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) return;
        const transport = findTransport(socketData.roomState, transportId);
        if (transport) await transport.connect({ dtlsParameters }).catch(e => console.warn('transport-connect error:', e));
    });

    socket.on('restartIce', async ({ transportId }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Not in room' }); return; }
        const transport = findTransport(socketData.roomState, transportId);
        if (!transport) { callback?.({ error: 'Transport not found' }); return; }
        try {
            const iceParameters = await transport.restartIce();
            callback?.({ iceParameters });
        } catch (error) {
            console.warn(`⚠️ ICE restart failed: ${error.message}`);
            callback?.({ error: error.message });
        }
    });

    // Produce (admin: any kind; viewer: audio only + viewerMicEnabled)
    socket.on('transport-produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
        if (typeof callback !== 'function') return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback({ error: 'Odaya katılmadınız' }); return; }

        // Permission check for viewers
        if (socketData.role !== 'admin') {
            if (kind !== 'audio') { callback({ error: 'İzleyiciler sadece ses yayınlayabilir' }); return; }
            if (!socketData.roomState.viewerMicEnabled) {
                callback({ error: 'Mikrofon özelliği şu an devre dışı' }); return;
            }
        }

        try {
            const transport = findTransport(socketData.roomState, transportId);
            if (!transport) { callback({ error: 'Transport bulunamadı' }); return; }

            const producer = await socketData.roomState.router.produce
                ? (await transport.produce({
                    kind,
                    rtpParameters,
                    appData: { ...appData, socketId: socket.id }, // Track owner
                    keyFrameRequestDelay: 500
                }))
                : null;

            if (!producer) { callback({ error: 'Producer oluşturulamadı' }); return; }

            socketData.roomState.producers.set(producer.id, producer);
            workerManager.incrementProducers(socketData.roomState.workerIndex);

            producer.on('score', (score) => {
                if (score[0]?.score < 5) console.warn(`⚠️ Low producer score: ${score[0]?.score}`);
            });

            if (kind === 'video') {
                roomManager.setStreamingStatus(socketData.roomId, true);
                socket.to(socketData.roomId).emit('stream-started');
            }

            callback({ id: producer.id });

            // Notify all others of new producer (works for admin screen + viewer mic)
            socket.to(socketData.roomId).emit('new-producer', producer.id);

        } catch (error) {
            console.error('Produce error:', error);
            callback({ error: error.message });
        }
    });

    socket.on('getProducers', (callback) => {
        if (typeof callback !== 'function') return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback([]); return; }
        const ids = Array.from(socketData.roomState.producers.keys());
        console.log(`📡 Sending ${ids.length} producers to ${socket.id}`);
        callback(ids);
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        if (typeof callback !== 'function') return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback({ params: { error: 'Odaya katılmadınız' } }); return; }

        try {
            const roomState = socketData.roomState;

            if (!roomState.router.canConsume({ producerId, rtpCapabilities })) {
                callback({ params: { error: 'Cannot consume' } }); return;
            }

            const transport = findTransport(roomState, transportId);
            if (!transport) { callback({ params: { error: 'Transport bulunamadı' } }); return; }

            const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });

            if (consumer.kind === 'audio') await consumer.setPriority(255).catch(() => {});
            else if (consumer.kind === 'video') await consumer.setPriority(200).catch(() => {});

            const maxSpatialLayer = Math.max(0, (consumer.rtpParameters.encodings?.length || 1) - 1);
            const maxTemporalLayer = getMaxTemporalLayer(consumer.rtpParameters.encodings);

            const consumerData = {
                consumer,
                socketId: socket.id,
                autoQuality: consumer.kind === 'video' ? {
                    enabled: true,
                    spatialLayer: maxSpatialLayer,
                    temporalLayer: maxTemporalLayer,
                    maxSpatialLayer,
                    maxTemporalLayer,
                    lastChange: 0
                } : null
            };

            roomState.consumers.set(consumer.id, consumerData);
            workerManager.incrementConsumers(roomState.workerIndex);

            if (consumer.kind === 'video') {
                try { await consumer.setPreferredLayers({ spatialLayer: maxSpatialLayer, temporalLayer: maxTemporalLayer }); }
                catch (e) { console.warn(`⚠️ Could not set initial layers: ${e.message}`); }

                consumer.on('score', (score) => autoAdjustConsumerLayers(consumerData, score));
            }

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

    socket.on('resume', async ({ consumerId }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) return;

        const consumerData = socketData.roomState.consumers.get(consumerId);
        if (consumerData?.consumer) {
            try {
                await consumerData.consumer.resume();
                if (consumerData.consumer.kind === 'video') {
                    try { await consumerData.consumer.requestKeyFrame(); } catch (e) {}
                }
            } catch (error) {
                console.warn(`⚠️ Could not resume consumer ${consumerId}: ${error.message}`);
                socketData.roomState.consumers.delete(consumerId);
            }
        }
    });

    socket.on('setPreferredLayers', async ({ consumerId, spatialLayer, temporalLayer }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Not in room' }); return; }

        const consumerData = socketData.roomState.consumers.get(consumerId);
        if (consumerData?.consumer) {
            try {
                if (consumerData.autoQuality) {
                    consumerData.autoQuality.enabled = false;
                    consumerData.autoQuality.spatialLayer = spatialLayer;
                    consumerData.autoQuality.temporalLayer = temporalLayer;
                }
                await consumerData.consumer.setPreferredLayers({ spatialLayer, temporalLayer });
                callback?.({ success: true });
            } catch (error) {
                callback?.({ error: error.message });
            }
        } else {
            callback?.({ error: 'Consumer not found' });
        }
    });

    socket.on('setAutoLayers', async ({ consumerId }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Not in room' }); return; }

        const consumerData = socketData.roomState.consumers.get(consumerId);
        if (consumerData?.consumer && consumerData.autoQuality) {
            try {
                consumerData.autoQuality.enabled = true;
                consumerData.autoQuality.lastChange = 0;
                await consumerData.consumer.setPreferredLayers({
                    spatialLayer: consumerData.autoQuality.maxSpatialLayer,
                    temporalLayer: consumerData.autoQuality.maxTemporalLayer
                });
                callback?.({ success: true });
            } catch (error) {
                callback?.({ error: error.message });
            }
        } else {
            callback?.({ error: 'Consumer not found' });
        }
    });

    socket.on('requestKeyFrame', async ({ consumerId }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) return;
        const consumerData = socketData.roomState.consumers.get(consumerId);
        if (consumerData?.consumer) {
            try { await consumerData.consumer.requestKeyFrame(); } catch (e) {}
        }
    });

    socket.on('producer-closing', ({ producerId }) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) return;

        const producer = socketData.roomState.producers.get(producerId);
        if (producer) {
            if (producer.kind === 'video') {
                roomManager.setStreamingStatus(socketData.roomId, false);
                socket.to(socketData.roomId).emit('stream-paused');
            }
            try { producer.close(); } catch (e) {}
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

function getMaxTemporalLayer(encodings = []) {
    let max = 0;
    for (const enc of encodings) {
        const match = (enc?.scalabilityMode || '').match(/L\dT(\d)/i);
        if (match) {
            const layers = parseInt(match[1], 10);
            if (Number.isFinite(layers) && layers > 0) max = Math.max(max, layers - 1);
        }
    }
    return max;
}

async function autoAdjustConsumerLayers(consumerData, score = []) {
    const autoQuality = consumerData?.autoQuality;
    if (!autoQuality?.enabled || !consumerData?.consumer) return;

    const now = Date.now();
    if (now - autoQuality.lastChange < 3000) return;

    const scores = Array.isArray(score) ? score.map(s => s?.score).filter(s => typeof s === 'number') : [];
    const overallScore = scores.length ? Math.min(...scores) : 10;

    let { spatialLayer, temporalLayer, maxSpatialLayer, maxTemporalLayer } = autoQuality;

    if (overallScore <= 4) temporalLayer = 0;
    else if (overallScore <= 6) temporalLayer = Math.min(1, maxTemporalLayer);
    else if (overallScore >= 8) temporalLayer = maxTemporalLayer;

    spatialLayer = maxSpatialLayer;

    if (spatialLayer === autoQuality.spatialLayer && temporalLayer === autoQuality.temporalLayer) return;

    try {
        await consumerData.consumer.setPreferredLayers({ spatialLayer, temporalLayer });
        autoQuality.spatialLayer = spatialLayer;
        autoQuality.temporalLayer = temporalLayer;
        autoQuality.lastChange = now;
    } catch (error) {
        console.warn(`⚠️ Auto layer adjust failed: ${error.message}`);
    }
}

function handleLeaveRoom(socket) {
    const result = roomManager.leaveRoom(socket.id);
    if (!result) return;

    // Emit producer-closed for any closed viewer producers
    if (result.closedProducerIds?.length) {
        result.closedProducerIds.forEach(pid =>
            io.to(result.roomId).emit('producer-closed', { remoteProducerId: pid }));
    }

    if (result.roomClosed) {
        io.to(result.roomId).emit('room-closed', { reason: 'Admin ayrıldı' });
        io.emit('room-deleted', { id: result.roomId });
    } else if (result.roomPending) {
        roomManager.startGracePeriod(result.roomId, (roomId) => {
            io.to(roomId).emit('room-closed', { reason: 'Admin ayrıldı' });
            io.emit('room-deleted', { id: roomId });
        });
    } else {
        const newCount = roomManager.getRoomUserCount(result.roomId);
        socket.to(result.roomId).emit('user-left', { userCount: newCount });
        io.to(result.roomId).emit('user-list', roomManager.getUserList(result.roomId));
        io.emit('room-updated', { id: result.roomId, userCount: newCount });
    }
}

function findTransport(roomState, transportId) {
    for (const [, transport] of roomState.transports) {
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
        console.log(`🚀 VELOSTREAM Server v2 running on port ${PORT}`);
        console.log(`📊 Workers: ${workerManager.workers.length}`);
    });
}

start().catch(console.error);
