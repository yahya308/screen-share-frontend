/**
 * RoomManager - Manages rooms, workers, and PipeTransports
 */

const { v4: uuidv4 } = require('uuid');
const database = require('./database');

const MAX_ROOMS = 50;
const PIPE_THRESHOLD = 100;
const ADMIN_GRACE_PERIOD = 5000;

const ROOM_NAME_MIN = 3;
const ROOM_NAME_MAX = 50;
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;
const MAX_USERS_MIN = 2;
const MAX_USERS_MAX = 1000;

const NICKNAME_MIN = 3;
const NICKNAME_MAX = 30;

// Rate limit: max 10 messages per 5 seconds per socket
const CHAT_RATE_WINDOW_MS = 5000;
const CHAT_RATE_MAX = 10;

/**
 * Validate nickname string
 * @returns {string|null} Error message or null if valid
 */
function validateNickname(nickname) {
    if (!nickname || typeof nickname !== 'string') return 'Nickname gerekli';
    const t = nickname.trim();
    if (t.length < NICKNAME_MIN) return `Nickname en az ${NICKNAME_MIN} karakter olmalı`;
    if (t.length > NICKNAME_MAX) return `Nickname en fazla ${NICKNAME_MAX} karakter olmalı`;
    if (/\s/.test(t)) return 'Nickname boşluk içeremez';
    if (/^[0-9]+$/.test(t)) return 'Nickname yalnızca rakamlardan oluşamaz';
    if (!/^[a-zA-Z0-9\u00c0-\u024f_-]+$/.test(t)) return 'Nickname sadece harf, rakam, _ ve - içerebilir';
    return null;
}

class RoomManager {
    constructor(workerManager) {
        this.workerManager = workerManager;

        // roomId -> { workerIndex, router, producers, consumers, transports, ... }
        this.rooms = new Map();

        // socketId -> { roomId, role, nickname, ip }
        this.socketRooms = new Map();

        // roomId -> timeout (admin disconnect grace period)
        this.pendingClose = new Map();

        // roomId -> timeout (orphan room cleanup)
        this.pendingAdminJoin = new Map();

        // roomId -> Set<ip>  (RAM-based ban list)
        this.bannedIps = new Map();

        // roomId -> Map<socketId, { nickname, speaking }>
        this.roomUsers = new Map();

        // socketId -> { count, resetAt }
        this.chatRateLimits = new Map();
    }

    // ==================== NICKNAME ====================

    /** Public validator so server.js can use it */
    static validateNickname(nickname) {
        return validateNickname(nickname);
    }

    /**
     * Set or update nickname for a socket already in a room.
     * Checks uniqueness within the room.
     * @returns {{ success:true } | { error:string }}
     */
    setNickname(socketId, nickname) {
        const socketData = this.socketRooms.get(socketId);
        if (!socketData) return { error: 'Odaya kayıtlı değilsiniz' };

        const err = validateNickname(nickname);
        if (err) return { error: err };

        const clean = nickname.trim();
        const { roomId } = socketData;

        if (!this.roomUsers.has(roomId)) this.roomUsers.set(roomId, new Map());
        const userMap = this.roomUsers.get(roomId);

        // Uniqueness check (case-insensitive)
        for (const [sid, data] of userMap) {
            if (sid !== socketId && data.nickname.toLowerCase() === clean.toLowerCase()) {
                return { error: 'Bu nickname bu odada zaten kullanılıyor' };
            }
        }

        if (userMap.has(socketId)) {
            userMap.get(socketId).nickname = clean;
        } else {
            userMap.set(socketId, { nickname: clean, speaking: false });
        }
        socketData.nickname = clean;
        return { success: true };
    }

    // ==================== USER LIST ====================

    /**
     * Build the public user list for a room.
     * Admin always first, then viewers alphabetically.
     */
    getUserList(roomId) {
        const userMap = this.roomUsers.get(roomId) || new Map();
        const list = [];

        for (const [socketId, data] of this.socketRooms) {
            if (data.roomId !== roomId) continue;
            const ud = userMap.get(socketId) || {};
            list.push({
                socketId,
                nickname: ud.nickname || data.nickname || 'Anonim',
                role: data.role,
                speaking: ud.speaking || false
            });
        }

        list.sort((a, b) => {
            if (a.role === 'admin') return -1;
            if (b.role === 'admin') return 1;
            return a.nickname.localeCompare(b.nickname, 'tr');
        });

        return list;
    }

    /**
     * Update speaking state and return roomId for broadcast
     */
    setSpeaking(socketId, speaking) {
        const socketData = this.socketRooms.get(socketId);
        if (!socketData) return null;
        const userMap = this.roomUsers.get(socketData.roomId);
        if (userMap?.has(socketId)) {
            userMap.get(socketId).speaking = !!speaking;
        }
        return socketData.roomId;
    }

    // ==================== BAN ====================

    isBanned(roomId, ip) {
        return this.bannedIps.get(roomId)?.has(ip) || false;
    }

    banIp(roomId, ip) {
        if (!this.bannedIps.has(roomId)) this.bannedIps.set(roomId, new Set());
        this.bannedIps.get(roomId).add(ip);
    }

    // ==================== CHAT RATE LIMIT ====================

    checkChatRateLimit(socketId) {
        const now = Date.now();
        const rec = this.chatRateLimits.get(socketId) || { count: 0, resetAt: now + CHAT_RATE_WINDOW_MS };

        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + CHAT_RATE_WINDOW_MS;
        }

        if (rec.count >= CHAT_RATE_MAX) {
            this.chatRateLimits.set(socketId, rec);
            return false;
        }

        rec.count++;
        this.chatRateLimits.set(socketId, rec);
        return true;
    }

    // ==================== ROOM CRUD ====================

    async createRoom({ name, password, adminSocketId, maxUsers }) {
        const roomName = (name || '').trim();
        if (roomName.length < ROOM_NAME_MIN || roomName.length > ROOM_NAME_MAX) {
            return { error: `Oda adı ${ROOM_NAME_MIN}-${ROOM_NAME_MAX} karakter olmalı` };
        }

        const requestedMaxUsers = Number.isFinite(Number(maxUsers)) ? Number(maxUsers) : 100;
        if (requestedMaxUsers < MAX_USERS_MIN || requestedMaxUsers > MAX_USERS_MAX) {
            return { error: `Maksimum kullanıcı ${MAX_USERS_MIN}-${MAX_USERS_MAX} arasında olmalı` };
        }

        const passwordValue = (password || '').trim();
        if (passwordValue && (passwordValue.length < PASSWORD_MIN || passwordValue.length > PASSWORD_MAX)) {
            return { error: `Şifre ${PASSWORD_MIN}-${PASSWORD_MAX} karakter olmalı` };
        }

        if (database.getRoomCount() >= MAX_ROOMS) {
            return { error: 'Sunucu oda limitine ulaştı (50)' };
        }

        const roomId = uuidv4();
        const { index: workerIndex } = this.workerManager.getLeastLoadedWorker();
        const router = await this.workerManager.createRouter(workerIndex, roomId);

        const success = database.createRoom({
            id: roomId,
            name: roomName,
            password: passwordValue || null,
            adminSocketId,
            workerIndex,
            maxUsers: requestedMaxUsers || 100
        });

        if (!success) {
            router.close();
            return { error: 'Oda oluşturulamadı' };
        }

        this.rooms.set(roomId, {
            workerIndex,
            router,
            producers: new Map(),
            consumers: new Map(),
            transports: new Map(),
            pipeTransports: new Map(),
            pipeProducers: new Map(),
            isStreaming: false,
            adminJoined: false,
            viewerMicEnabled: true,   // Can viewers use mic?
            chatEnabled: true          // Is chat open?
        });

        this.socketRooms.set(adminSocketId, { roomId, role: 'admin', nickname: '', ip: '' });
        this.roomUsers.set(roomId, new Map());

        console.log(`🏠 Room created: ${name} (${roomId}) on Worker ${workerIndex}`);
        return { roomId, workerIndex, isPublic: !password };
    }

    startOrphanTimeout(roomId, callback) {
        const t = setTimeout(() => {
            const roomState = this.rooms.get(roomId);
            if (roomState && !roomState.adminJoined) {
                console.log(`⏰ Orphan room cleanup: ${roomId}`);
                this.closeRoom(roomId);
                this.pendingAdminJoin.delete(roomId);
                if (callback) callback(roomId);
            }
        }, 30000);
        this.pendingAdminJoin.set(roomId, t);
    }

    async joinRoom(roomId, socketId, password, clientIp) {
        if (!roomId || typeof roomId !== 'string' || roomId.length > 100) {
            return { error: 'Geçersiz oda kimliği' };
        }

        const room = database.getRoom(roomId);
        if (!room) return { error: 'Oda bulunamadı' };

        // Ban check
        if (this.isBanned(roomId, clientIp)) {
            return { error: 'Bu odadan banlandınız', banned: true };
        }

        // Password check
        const passwordValue = (password || '').trim();
        if (room.password_hash && passwordValue) {
            if (!database.verifyPassword(roomId, passwordValue)) {
                return { error: 'Yanlış şifre', needPassword: true };
            }
        } else if (room.password_hash && !passwordValue) {
            return { error: 'Şifre gerekli', needPassword: true };
        }

        const roomState = this.rooms.get(roomId);
        if (!roomState) return { error: 'Oda aktif değil' };

        const currentUsers = this.getRoomUserCount(roomId);
        if (currentUsers >= room.max_users) return { error: 'Oda dolu' };

        this.socketRooms.set(socketId, { roomId, role: 'viewer', nickname: '', ip: clientIp });

        if (!this.roomUsers.has(roomId)) this.roomUsers.set(roomId, new Map());

        const newUserCount = this.getRoomUserCount(roomId);
        console.log(`👤 User ${socketId} joined room ${roomId} (total: ${newUserCount})`);

        return {
            success: true,
            roomId,
            roomName: room.name,
            isStreaming: roomState.isStreaming,
            viewerMicEnabled: roomState.viewerMicEnabled,
            chatEnabled: roomState.chatEnabled,
            workerIndex: room.worker_index,
            maxUsers: room.max_users,
            userCount: newUserCount
        };
    }

    leaveRoom(socketId) {
        const socketData = this.socketRooms.get(socketId);
        if (!socketData) return null;

        const { roomId, role } = socketData;
        this.socketRooms.delete(socketId);

        // Remove from user map
        const userMap = this.roomUsers.get(roomId);
        if (userMap) userMap.delete(socketId);

        const roomState = this.rooms.get(roomId);
        const closedProducerIds = [];

        if (roomState) {
            // Close consumers owned by this socket
            for (const [consumerId, consumerData] of roomState.consumers) {
                if (consumerData.socketId === socketId) {
                    try { consumerData.consumer.close(); } catch (e) { /* already closed */ }
                    roomState.consumers.delete(consumerId);
                    this.workerManager.decrementConsumers(roomState.workerIndex);
                }
            }

            // Close viewer's audio producers (if viewer had mic open)
            if (role !== 'admin') {
                for (const [producerId, producer] of roomState.producers) {
                    if (producer.appData?.socketId === socketId) {
                        try { producer.close(); } catch (e) { /* already closed */ }
                        roomState.producers.delete(producerId);
                        closedProducerIds.push(producerId);
                        this.workerManager.decrementProducers(roomState.workerIndex);
                    }
                }
            }

            // Close transports
            for (const [key, transport] of roomState.transports) {
                if (key.startsWith(socketId)) {
                    try { transport.close(); } catch (e) { /* already closed */ }
                    roomState.transports.delete(key);
                }
            }
        }

        if (role === 'admin') {
            console.log(`⏳ Admin disconnected from room ${roomId}, waiting for reconnect...`);
            return { roomPending: true, roomId, closedProducerIds };
        }

        console.log(`👋 User ${socketId} left room ${roomId}`);
        return { roomId, closedProducerIds };
    }

    startGracePeriod(roomId, callback) {
        const t = setTimeout(() => {
            console.log(`⏰ Grace period expired for room ${roomId}, closing...`);
            this.pendingClose.delete(roomId);
            this.closeRoom(roomId);
            if (callback) callback(roomId);
        }, ADMIN_GRACE_PERIOD);
        this.pendingClose.set(roomId, t);
    }

    cancelPendingClose(roomId) {
        const t = this.pendingClose.get(roomId);
        if (t) {
            clearTimeout(t);
            this.pendingClose.delete(roomId);
            console.log(`✅ Admin reconnected, cancelled pending close for room ${roomId}`);
            return true;
        }
        return false;
    }

    cancelPendingAdminJoin(roomId) {
        const t = this.pendingAdminJoin.get(roomId);
        if (t) {
            clearTimeout(t);
            this.pendingAdminJoin.delete(roomId);
            console.log(`✅ Cancelled orphan timeout for room ${roomId}`);
            return true;
        }
        return false;
    }

    closeRoom(roomId) {
        const roomState = this.rooms.get(roomId);
        if (!roomState) return;

        roomState.consumers.forEach(cd => { try { cd.consumer?.close(); } catch (e) {} });
        roomState.producers.forEach(p => { try { p.close(); } catch (e) {} });
        roomState.transports.forEach(t => { try { t.close(); } catch (e) {} });
        roomState.pipeTransports.forEach(pipe => {
            try { pipe.local?.close(); } catch (e) {}
            try { pipe.remote?.close(); } catch (e) {}
        });

        this.workerManager.removeRouter(roomState.workerIndex, roomId);
        database.deleteRoom(roomId);

        this.rooms.delete(roomId);
        this.roomUsers.delete(roomId);
        this.bannedIps.delete(roomId);

        for (const [socketId, data] of this.socketRooms) {
            if (data.roomId === roomId) this.socketRooms.delete(socketId);
        }

        this.pendingAdminJoin.delete(roomId);
        this.pendingClose.delete(roomId);

        console.log(`🗑️ Room ${roomId} closed`);
    }

    // ==================== TRANSPORT ====================

    async getTransportInfo(roomId, socketId, isSender) {
        const roomState = this.rooms.get(roomId);
        if (!roomState) return { error: 'Oda bulunamadı' };

        const socketData = this.socketRooms.get(socketId);
        if (!socketData || socketData.roomId !== roomId) return { error: 'Odaya kayıtlı değilsiniz' };

        let targetRouter = roomState.router;
        let targetWorkerIndex = roomState.workerIndex;

        if (!isSender && this.getRoomUserCount(roomId) >= PIPE_THRESHOLD) {
            const { index } = this.workerManager.getLeastLoadedWorker();
            if (index !== roomState.workerIndex) {
                targetWorkerIndex = index;
                targetRouter = await this.ensurePipeTransport(roomId, targetWorkerIndex);
            }
        }

        return { router: targetRouter, workerIndex: targetWorkerIndex };
    }

    async ensurePipeTransport(roomId, targetWorkerIndex) {
        const roomState = this.rooms.get(roomId);

        if (roomState.pipeTransports.has(targetWorkerIndex)) {
            return this.workerManager.getRouter(targetWorkerIndex, roomId);
        }

        const targetRouter = await this.workerManager.createRouter(targetWorkerIndex, roomId);
        const { pipeTransport: localPipe, pipeConsumer } = await roomState.router.pipeToRouter({ router: targetRouter });

        roomState.pipeTransports.set(targetWorkerIndex, { local: localPipe, consumer: pipeConsumer });
        console.log(`🔗 PipeTransport: Worker ${roomState.workerIndex} → Worker ${targetWorkerIndex}`);

        return targetRouter;
    }

    // ==================== STREAMING ====================

    setStreamingStatus(roomId, isStreaming) {
        const roomState = this.rooms.get(roomId);
        if (roomState) {
            roomState.isStreaming = isStreaming;
            database.setStreamingStatus(roomId, isStreaming);
        }
    }

    // ==================== HELPERS ====================

    getRoom(roomId) { return this.rooms.get(roomId); }

    getRoomFromSocket(socketId) {
        const socketData = this.socketRooms.get(socketId);
        if (!socketData) return null;
        return { ...socketData, roomState: this.rooms.get(socketData.roomId) };
    }

    getRoomUserCount(roomId) {
        let count = 0;
        for (const [, data] of this.socketRooms) {
            if (data.roomId === roomId) count++;
        }
        return count;
    }

    isAdmin(socketId) {
        return this.socketRooms.get(socketId)?.role === 'admin';
    }

    getAllRooms() {
        return database.getAllRooms().map(room => ({
            ...room,
            userCount: this.getRoomUserCount(room.id)
        }));
    }

    updateMaxUsers(roomId, maxUsers) {
        database.setMaxUsers(roomId, maxUsers);
    }

    /** Update admin socket after rejoin */
    updateAdminSocket(roomId, socketId, ip) {
        database.updateAdminSocket(roomId, socketId);
        this.socketRooms.set(socketId, { roomId, role: 'admin', nickname: '', ip: ip || '' });
    }
}

module.exports = RoomManager;
