/**
 * VELOSTREAM Server - Room-based streaming with multi-core support
 */

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const config = require('./config');
const WorkerManager = require('./WorkerManager');
const RoomManager = require('./RoomManager');
const database = require('./database');
const rateLimiter = require('./RateLimiter');
const EventLimiter = require('./EventLimiter');
const { getClientIp } = require('./clientIp');
const { FRONTEND_SECURITY_HEADERS } = require('./securityHeaders');
const metrics = require('./metrics');
const svc = require('./svcLayers');
const log = require('./logger');

// IP başına oda oluşturma hızı ve soket başına lobi sorgusu hızı.
const CREATE_ROOM_MAX = parseInt(process.env.CREATE_ROOM_MAX, 10) > 0
    ? parseInt(process.env.CREATE_ROOM_MAX, 10) : 5;
const createRoomLimiter = new EventLimiter(CREATE_ROOM_MAX, 10 * 60 * 1000);
const listRoomsLimiter = new EventLimiter(30, 60 * 1000);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

// Üretimde izin listesi boşsa açılışta dur. Eskiden sessizce origin:'*'a
// düşülüyordu: yanlış yazılmış tek bir ortam değişkeni, sinyalleşme sunucusunu
// herhangi bir web sitesinin gömebileceği hale getiriyordu.
if (process.env.NODE_ENV === 'production' && !allowedOrigins.length) {
    log.error('❌ ALLOWED_ORIGINS tanımsız. Üretimde CORS açık bırakılamaz.');
    log.error('   Örnek: ALLOWED_ORIGINS=https://velostream.com.tr,https://www.velostream.com.tr');
    process.exit(1);
}

const corsOptions = allowedOrigins.length
    ? { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }
    : { origin: '*', methods: ['GET', 'POST'] };

const app = express();
// Nginx ters vekilinin arkasındayız: tek hop güvenilir.
app.set('trust proxy', 1);
app.use(cors(corsOptions));

// Yerel geliştirmede ön yüzü aynı origin'den sunmak kullanışlı. Yol artık
// çalışma dizinine değil dosyanın konumuna göreli; üretim imajında bu dizin
// bulunmadığı için sessizce atlanır (ön yüz Vercel'de).
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
    // Üretimdeki başlıkların BİREBİR aynısı. Daha önce buradan CSP'siz
    // sunuluyordu: satır içi bir script yerelde ve duman testinde sorunsuz
    // çalışıyor, Vercel'de sessizce engelleniyordu. Ön yüzü iki farklı
    // güvenlik politikasıyla test etmek, üretimde ne kırıldığını görmemek
    // demek — o yüzden aynı politikayı burada da uyguluyoruz.
    app.use((req, res, next) => {
        for (const [key, value] of Object.entries(FRONTEND_SECURITY_HEADERS)) {
            res.setHeader(key, value);
        }
        next();
    });
    app.use(express.static(publicDir));
}

// ==================== SERVER SETUP ====================

let server;
const certPath = config.https?.cert;
const keyPath = config.https?.key;

if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
    log.info('🔒 HTTPS Server');
} else {
    server = http.createServer(app);
    log.info('⚠️  HTTP Server (SSL not found)');
}

const io = new Server(server, { cors: corsOptions });

// ==================== MANAGERS ====================

const workerManager = new WorkerManager();
let roomManager;

// Kapanış sırasında oda durumu güncellemeye çalışmayalım: sunucu zaten gidiyor.
let shuttingDown = false;

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

/**
 * Yerel geliştirme için /api/config yedeği.
 *
 * Üretimde bu uç nokta Vercel'de serverless olarak yayınlanıyor; sunucuyu
 * doğrudan çalıştırdığınızda ise 404 dönüyordu ve tarayıcı konsolunu
 * kirletiyordu. Boş signalingUrl, istemcinin aynı origin'e bağlanması demek.
 */
app.get('/api/config', (req, res) => {
    res.status(200).json({ signalingUrl: process.env.SIGNALING_URL || '' });
});

// ==================== LOBİ YAYINI ====================

// Oda listesini izleyen istemciler ayrı bir Socket.io odasında toplanır.
// Eskiden her katılım/ayrılışta io.emit ile BAĞLI HER SOKETE gidiliyordu ve
// lobi istemcileri bunu alınca tam bir get-rooms turu yapıyordu: N kullanıcılık
// bir odaya giriş dalgası O(N²) mesaj üretiyordu.
const LOBBY_ROOM = 'lobby';
const ROOM_UPDATE_INTERVAL_MS = 1000;

const pendingRoomUpdates = new Set();
let roomUpdateTimer = null;

/** Kullanıcı sayısı değişimlerini saniyede bir toplu gönder. */
function queueRoomUpdate(roomId) {
    if (!roomId) return;
    pendingRoomUpdates.add(roomId);
    if (roomUpdateTimer) return;

    roomUpdateTimer = setTimeout(flushRoomUpdates, ROOM_UPDATE_INTERVAL_MS);
    if (typeof roomUpdateTimer.unref === 'function') roomUpdateTimer.unref();
}

function flushRoomUpdates() {
    roomUpdateTimer = null;
    if (!pendingRoomUpdates.size) return;

    const updates = [];
    for (const roomId of pendingRoomUpdates) {
        if (roomManager?.rooms.has(roomId)) {
            updates.push({ id: roomId, userCount: roomManager.getRoomUserCount(roomId) });
        }
    }
    pendingRoomUpdates.clear();

    if (updates.length) io.to(LOBBY_ROOM).emit('rooms-updated', updates);
}

/**
 * Prometheus metrikleri. METRICS_TOKEN tanımlıysa token zorunlu; değilse
 * yalnızca özel ağdan (loopback/RFC1918) erişilebilir — nginx bu yolu dışarı
 * açmıyor, ama sunucu doğrudan da çalıştırılabildiği için varsayılan kapalı.
 */
app.get('/metrics', (req, res) => {
    const ip = getClientIp({ headers: req.headers, address: req.socket.remoteAddress });
    if (!metrics.isAuthorized(req, { ip })) {
        res.status(404).end();
        return;
    }

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(metrics.render({ workerManager, roomManager, io }));
});

// ==================== INPUT HELPERS ====================

/** Sanitize chat message: trim + limit length + basic safety */
function sanitizeChatMessage(msg) {
    if (typeof msg !== 'string') return '';
    return msg.trim().slice(0, 500);
}

// ==================== SOCKET HANDLERS ====================

io.on('connection', (socket) => {
    // X-Real-IP → XFF'in SON ögesi → soket adresi. İstemcinin gönderdiği
    // X-Forwarded-For'un ilk ögesi asla güvenilmez (bkz. clientIp.js).
    const clientIp = getClientIp(socket.handshake);

    log.debug(`Client connected: ${socket.id} ip=${clientIp}`);

    // ==================== LOBBY EVENTS ====================

    // Lobi sayfası buraya abone olur; oda içi istemciler olmaz.
    socket.on('lobby-subscribe', (callback) => {
        socket.join(LOBBY_ROOM);
        if (typeof callback === 'function') callback(roomManager.getAllRooms());
    });

    socket.on('lobby-unsubscribe', () => socket.leave(LOBBY_ROOM));

    socket.on('get-rooms', (callback) => {
        if (typeof callback !== 'function') return;
        if (!listRoomsLimiter.consume(socket.id).allowed) { callback([]); return; }
        callback(roomManager.getAllRooms());
    });

    socket.on('create-room', async ({ name, password, maxUsers }, callback) => {
        if (typeof callback !== 'function') return;

        const quota = createRoomLimiter.consume(clientIp || socket.id);
        if (!quota.allowed) {
            callback({ error: `Çok sık oda açıyorsunuz. ${quota.retryAfter} saniye sonra tekrar deneyin.` });
            return;
        }

        const result = await roomManager.createRoom({
            name, password, adminSocketId: socket.id, maxUsers, creatorIp: clientIp
        });

        if (result.error) { callback({ error: result.error }); return; }

        socket.join(result.roomId);
        // adminToken SADECE burada, odayı kuran istemciye döner. Başka hiçbir
        // olay bu değeri yaymaz; oda listesinde de yer almaz.
        callback({
            success: true,
            roomId: result.roomId,
            isPublic: result.isPublic,
            adminToken: result.adminToken
        });

        io.to(LOBBY_ROOM).emit('room-created', {
            id: result.roomId, name, is_locked: !!password,
            userCount: 1, max_users: maxUsers || 100
        });

        roomManager.startOrphanTimeout(result.roomId, (roomId) => {
            io.to(LOBBY_ROOM).emit('room-deleted', { id: roomId });
        });
    });

    // Admin rejoin after page redirect
    socket.on('admin-rejoin', async ({ roomId, nickname, adminToken }, callback) => {
        if (typeof callback !== 'function') return;

        const room = database.getRoom(roomId);
        if (!room) { callback({ error: 'Oda bulunamadı' }); return; }

        // ⚠️ Yetki kontrolü her şeyden önce gelir: token doğrulanmadan hiçbir
        // durum değiştirilmez (bekleyen kapanış iptali dahil), aksi halde
        // token'sız bir istek odanın yaşam döngüsünü etkileyebilirdi.
        if (!roomManager.verifyAdminToken(roomId, adminToken)) {
            log.warn(`⛔ Yetkisiz admin-rejoin denemesi: room=${roomId} socket=${socket.id} ip=${clientIp}`);
            callback({ error: 'Bu oda için yönetici yetkiniz yok', forbidden: true });
            return;
        }

        // Validate nickname
        const nickErr = RoomManager.validateNickname(nickname);
        if (nickErr) { callback({ error: nickErr }); return; }

        // Token doğru ama başka bir sekmede/cihazda hâlâ bağlı bir yönetici
        // varsa devri tamamla: eski soket yönetici rolünü bırakır. Token'ı
        // bilen kişi her zaman odasına dönebilmeli.
        const previousAdminSocketId = roomManager.getConnectedAdminSocketId(roomId);
        if (previousAdminSocketId && previousAdminSocketId !== socket.id) {
            roomManager.leaveRoom(previousAdminSocketId);
            const previousSocket = io.sockets.sockets.get(previousAdminSocketId);
            if (previousSocket) {
                previousSocket.emit('admin-superseded');
                previousSocket.leave(roomId);
            }
            log.info(`🔁 Admin devri: ${previousAdminSocketId} → ${socket.id} (room ${roomId})`);
        }

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
            chatEnabled: roomState?.chatEnabled ?? true,
            contentType: roomState?.contentType || 'detail'
        });

        // Broadcast updated user list
        io.to(roomId).emit('user-list', roomManager.getUserList(roomId));

        log.info(`👑 Admin rejoined room ${roomId} as "${nickname.trim()}"`);
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
        queueRoomUpdate(roomId);
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
        io.to(LOBBY_ROOM).emit('room-deleted', { id: roomId });
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
        queueRoomUpdate(roomId);

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
        queueRoomUpdate(roomId);

        callback?.({ success: true });
        log.info(`🚫 User ${targetSocketId} (IP: ${targetIp}) banned from room ${roomId}`);
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
                    try { producer.close(); } catch (e) { /* yoksay */ }
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
        log.info(`🎙️ Viewer mic ${enabled ? 'enabled' : 'disabled'} in room ${socketData.roomId}`);
    });

    // ==================== CHAT ====================

    // Toggle chat (admin only)
    // Yayıncı içerik türünü değiştirdi. İzleyicilerin oynatma tamponu buna göre
    // ayarlanıyor: 'motion' (film/oyun) → büyük tampon, akıcılık öncelikli;
    // 'detail' (sunum/metin) → küçük tampon, gecikme öncelikli.
    socket.on('set-content-type', ({ contentType }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }

        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Oda bulunamadı' }); return; }

        const value = contentType === 'motion' ? 'motion' : 'detail';
        socketData.roomState.contentType = value;
        io.to(socketData.roomId).emit('content-type', { contentType: value });

        callback?.({ success: true });
        log.debug(`🎞️ İçerik türü '${value}' (room ${socketData.roomId})`);
    });

    socket.on('toggle-chat', ({ enabled }, callback) => {
        if (!roomManager.isAdmin(socket.id)) { callback?.({ error: 'Yetkiniz yok' }); return; }

        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Oda bulunamadı' }); return; }

        socketData.roomState.chatEnabled = !!enabled;
        io.to(socketData.roomId).emit('chat-state', { enabled: !!enabled });

        callback?.({ success: true });
        log.info(`💬 Chat ${enabled ? 'enabled' : 'disabled'} in room ${socketData.roomId}`);
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
            const transportKey = `${socket.id}-${sender ? 'send' : 'recv'}-${transport.id}`;

            try {
                if (sender && config.mediasoup.webRtcTransport.maxIncomingBitrate) {
                    await transport.setMaxIncomingBitrate(config.mediasoup.webRtcTransport.maxIncomingBitrate);
                }
                if (!sender && config.mediasoup.webRtcTransport.maxIncomingBitrate) {
                    await transport.setMaxOutgoingBitrate(config.mediasoup.webRtcTransport.maxIncomingBitrate);
                }
            } catch (e) {
                log.warn(`⚠️ Transport bitrate tuning skipped: ${e.message}`);
            }

            roomState.transports.set(transportKey, transport);
            roomState.transportsById.set(transport.id, transport);

            transport.on('close', () => {
                if (roomState.transports.get(transportKey) === transport) {
                    roomState.transports.delete(transportKey);
                }
                if (roomState.transportsById.get(transport.id) === transport) {
                    roomState.transportsById.delete(transport.id);
                }

                if (sender) {
                    const { closedProducerIds, hadVideo } = closeProducersOwnedBySocket(roomState, socket.id, workerManager, transport.id);
                    if (hadVideo) {
                        roomManager.setStreamingStatus(socketData.roomId, false);
                        socket.to(socketData.roomId).emit('stream-paused');
                    }
                    closedProducerIds.forEach(pid =>
                        socket.to(socketData.roomId).emit('producer-closed', { remoteProducerId: pid }));
                } else {
                    closeConsumersOwnedBySocket(roomState, socket.id, workerManager);
                }
            });

            callback({
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters
                }
            });
        } catch (error) {
            log.error('Transport create error:', error);
            callback({ params: { error: error.message } });
        }
    });

    socket.on('transport-connect', async ({ transportId, dtlsParameters }, callback) => {
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback?.({ error: 'Odaya katÄ±lmadÄ±nÄ±z' }); return; }
        const transport = findTransport(socketData.roomState, transportId);
        if (!transport) { callback?.({ error: 'Transport bulunamadÄ±' }); return; }
        try {
            await transport.connect({ dtlsParameters });
            callback?.({ success: true });
        } catch (e) {
            log.warn('transport-connect error:', e);
            callback?.({ error: e.message });
        }
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
            log.warn(`⚠️ ICE restart failed: ${error.message}`);
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

            const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: { ...appData, socketId: socket.id, transportId: transport.id }, // Track owner
                keyFrameRequestDelay: 500
            });

            if (!producer) { callback({ error: 'Producer oluşturulamadı' }); return; }

            socketData.roomState.producers.set(producer.id, producer);
            workerManager.incrementProducers(socketData.roomState.workerIndex);

            producer.on('score', (score) => {
                if (score[0]?.score < 5) log.warn(`⚠️ Low producer score: ${score[0]?.score}`);
            });

            if (kind === 'video') {
                roomManager.setStreamingStatus(socketData.roomId, true);
                socket.to(socketData.roomId).emit('stream-started');
            }

            callback({ id: producer.id });

            // Notify all others of new producer (works for admin screen + viewer mic)
            // kind + source bilgisini de gönderelim ki client (audio/video) ayırabilsin
            socket.to(socketData.roomId).emit('new-producer', {
                id: producer.id,
                kind,
                source: appData?.source || null
            });

        } catch (error) {
            log.error('Produce error:', error);
            callback({ error: error.message });
        }
    });

    socket.on('getProducers', (callback) => {
        if (typeof callback !== 'function') return;
        const socketData = roomManager.getRoomFromSocket(socket.id);
        if (!socketData?.roomState) { callback([]); return; }

        const ids = [];
        for (const [id, producer] of socketData.roomState.producers) {
            if (producer.appData?.socketId !== socket.id && !producer.closed) {
                ids.push(id);
            }
        }

        log.debug(`📡 Sending ${ids.length} producers to ${socket.id}`);
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

            // enableRtx: mediasoup bunu vermezsen video için true, SES İÇİN FALSE
            // varsayıyor ve consumer'ın Opus codec'inden düz 'nack' geri
            // bildirimini siliyor (ortc.getConsumerRtpParameters). Sonuç: yayıncı
            // NACK'i açsa bile SFU→izleyici yönünde kayıp ses paketi hiç yeniden
            // istenmiyordu.
            //
            // Video davranışı DEĞİŞMEZ: mediasoup video için zaten true
            // varsayıyordu, burada yalnızca açıkça yazıyoruz. Ses için de RTX
            // akışı açılmaz (mediasoup RTX codec'ini yalnızca video için üretir);
            // tek etkisi NACK'in korunması.
            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
                enableRtx: true
            });

            if (consumer.kind === 'audio') await consumer.setPriority(255).catch(() => {});
            else if (consumer.kind === 'video') await consumer.setPriority(200).catch(() => {});

            const encodings = consumer.rtpParameters.encodings;
            const maxSpatialLayer = svc.getMaxSpatialLayer(encodings);
            const maxTemporalLayer = svc.getMaxTemporalLayer(encodings);

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
                catch (e) { log.warn(`⚠️ Could not set initial layers: ${e.message}`); }

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
            log.error('Consume error:', error);
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
                    try { await consumerData.consumer.requestKeyFrame(); } catch (e) { /* yoksay */ }
                }
            } catch (error) {
                log.warn(`⚠️ Could not resume consumer ${consumerId}: ${error.message}`);
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
            try { await consumerData.consumer.requestKeyFrame(); } catch (e) { /* yoksay */ }
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
            try { producer.close(); } catch (e) { /* yoksay */ }
            socketData.roomState.producers.delete(producerId);
            workerManager.decrementProducers(socketData.roomState.workerIndex);
            socket.to(socketData.roomId).emit('producer-closed', { remoteProducerId: producerId });
        }
    });

    // ==================== DISCONNECT ====================

    socket.on('disconnect', () => {
        if (shuttingDown) return;
        log.debug(`Client disconnected: ${socket.id}`);
        handleLeaveRoom(socket);
    });
});

// ==================== HELPERS ====================

async function autoAdjustConsumerLayers(consumerData, score = []) {
    const autoQuality = consumerData?.autoQuality;
    if (!autoQuality?.enabled || !consumerData?.consumer) return;

    const now = Date.now();
    if (now - autoQuality.lastChange < 3000) return;

    const { spatialLayer, temporalLayer } = svc.pickLayers(svc.overallScore(score), autoQuality);

    if (spatialLayer === autoQuality.spatialLayer && temporalLayer === autoQuality.temporalLayer) return;

    try {
        await consumerData.consumer.setPreferredLayers({ spatialLayer, temporalLayer });
        autoQuality.spatialLayer = spatialLayer;
        autoQuality.temporalLayer = temporalLayer;
        autoQuality.lastChange = now;
    } catch (error) {
        log.warn(`⚠️ Auto layer adjust failed: ${error.message}`);
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
        io.to(LOBBY_ROOM).emit('room-deleted', { id: result.roomId });
    } else if (result.roomPending) {
        roomManager.startGracePeriod(result.roomId, (roomId) => {
            io.to(roomId).emit('room-closed', { reason: 'Admin ayrıldı' });
            io.to(LOBBY_ROOM).emit('room-deleted', { id: roomId });
        });
    } else {
        const newCount = roomManager.getRoomUserCount(result.roomId);
        socket.to(result.roomId).emit('user-left', { userCount: newCount });
        io.to(result.roomId).emit('user-list', roomManager.getUserList(result.roomId));
        queueRoomUpdate(result.roomId);
    }
}

function findTransport(roomState, transportId) {
    return roomState.transportsById.get(transportId) || null;
}

function closeProducersOwnedBySocket(roomState, socketId, workerManagerRef, transportId = null) {
    const closedProducerIds = [];
    let hadVideo = false;

    for (const [producerId, producer] of [...roomState.producers]) {
        if (producer.appData?.socketId !== socketId) continue;
        if (transportId && producer.appData?.transportId !== transportId) continue;
        hadVideo = hadVideo || producer.kind === 'video';
        try { producer.close(); } catch (e) { /* yoksay */ }
        if (roomState.producers.delete(producerId)) {
            workerManagerRef.decrementProducers(roomState.workerIndex);
        }
        closedProducerIds.push(producerId);
    }

    return { closedProducerIds, hadVideo };
}

function closeConsumersOwnedBySocket(roomState, socketId, workerManagerRef) {
    const closedConsumerIds = [];

    for (const [consumerId, consumerData] of [...roomState.consumers]) {
        if (consumerData.socketId !== socketId) continue;
        try { consumerData.consumer.close(); } catch (e) { /* yoksay */ }
        if (roomState.consumers.delete(consumerId)) {
            workerManagerRef.decrementConsumers(roomState.workerIndex);
        }
        closedConsumerIds.push(consumerId);
    }

    return closedConsumerIds;
}

// ==================== STARTUP ====================

/**
 * Sunucuyu başlat.
 * @param {{ port?: number }} options port 0 verilirse işletim sistemi boş bir port seçer (testler).
 */
async function start({ port } = {}) {
    await workerManager.init();
    roomManager = new RoomManager(workerManager);

    // Ölen bir worker'ın odalarını AÇIKÇA tahliye et. Eskiden bu odaların
    // router'ları sessizce kayboluyordu: istemciler bağlı görünüyor ama medya
    // hiç gelmiyordu. Sessiz kayıp, hata mesajından kötü bir deneyimdir.
    workerManager.onWorkerDied = ({ index, roomIds }) => {
        for (const roomId of roomIds) {
            io.to(roomId).emit('room-closed', { reason: 'Sunucu kaynağı yeniden başlatıldı, odayı yeniden açın' });
            roomManager.closeRoom(roomId);
            io.to(LOBBY_ROOM).emit('room-deleted', { id: roomId });
        }
        if (roomIds.length) {
            log.warn(`⚠️ Worker ${index} öldü, ${roomIds.length} oda tahliye edildi`);
        }
    };

    const requestedPort = port !== undefined ? port : (config.port || 3000);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    const boundPort = server.address().port;
    log.info(`🚀 VELOSTREAM Server v2 running on port ${boundPort}`);
    log.info(`📊 Workers: ${workerManager.workers.length}`);

    return { server, io, port: boundPort };
}

/**
 * Kaynakları DOĞRU SIRAYLA kapat. Sıra önemli: soketler kapanmadan
 * veritabanını kapatırsak, geç gelen 'disconnect' işleyicileri kapalı bir
 * bağlantıya yazmaya çalışır.
 */
async function stop({ notifyClients = false, drainMs = 500 } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;

    // 0) İstemcilere haber ver ki "bağlantı koptu" yerine ne olduğunu görsünler
    if (notifyClients) {
        io.emit('server-restarting', { reason: 'Sunucu güncelleniyor, birazdan yeniden bağlanılacak' });
        await new Promise((resolve) => setTimeout(resolve, drainMs));
    }

    // 1) İstemcileri düşür ve yeni bağlantıları reddet
    io.disconnectSockets(true);
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));

    // 2) Kuyruktaki disconnect işleyicileri boşalsın, bekleyen zamanlayıcılar iptal olsun
    await new Promise((resolve) => setImmediate(resolve));
    if (roomUpdateTimer) { clearTimeout(roomUpdateTimer); roomUpdateTimer = null; }
    pendingRoomUpdates.clear();
    if (roomManager) roomManager.cancelAllTimers();

    // 3) Medya ve veri katmanı
    await workerManager.closeAll();
    database.close();
}

/**
 * Düzgün kapanma. SIGTERM/SIGINT dinleyicisi yoktu: her `docker compose up -d
 * --build` ya da PM2 yeniden başlatması canlı odaları hiçbir uyarı vermeden
 * koparıyor, kullanıcılar boş bir lobiye düşüp nedenini anlamıyordu.
 */
function installSignalHandlers() {
    const shutdown = async (signal) => {
        log.info(`\n${signal} alındı, düzgün kapanılıyor...`);
        const timer = setTimeout(() => {
            log.error('Kapanma zaman aşımına uğradı, zorla çıkılıyor');
            process.exit(1);
        }, 10000);
        timer.unref();

        try {
            await stop({ notifyClients: true });
            log.info('✅ Kapandı');
            process.exit(0);
        } catch (error) {
            log.error('Kapanma hatası:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// Doğrudan çalıştırıldığında başlat; require edildiğinde (testler) başlatma.
if (require.main === module) {
    installSignalHandlers();
    start().catch((error) => {
        log.error('Başlatma hatası:', error);
        process.exit(1);
    });
}

module.exports = {
    app, server, io, start, stop, workerManager,
    getRoomManager: () => roomManager,
    limiters: { createRoom: createRoomLimiter, listRooms: listRoomsLimiter }
};
