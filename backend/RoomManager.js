/**
 * RoomManager - Manages rooms, workers, and PipeTransports
 */

const { v4: uuidv4 } = require('uuid');
const database = require('./database');

const MAX_ROOMS = 50;
const PIPE_THRESHOLD = 100; // Users per worker before PipeTransport

const ADMIN_GRACE_PERIOD = 5000; // 5 seconds for admin to reconnect

class RoomManager {
    constructor(workerManager) {
        this.workerManager = workerManager;
        // roomId -> { workerIndex, router, producers, consumers, pipeTransports, userCount }
        this.rooms = new Map();
        // socketId -> { roomId, role }
        this.socketRooms = new Map();
        // roomId -> timeout (for admin disconnect grace period)
        this.pendingClose = new Map();
    }

    // ==================== ROOM CRUD ====================

    /**
     * Create a new room
     */
    async createRoom({ name, password, adminSocketId, maxUsers }) {
        // Check room limit
        if (database.getRoomCount() >= MAX_ROOMS) {
            return { error: 'Sunucu oda limitine ulaştı (50)' };
        }

        const roomId = uuidv4();
        const { worker, index: workerIndex } = this.workerManager.getLeastLoadedWorker();

        // Create router on selected worker
        const router = await this.workerManager.createRouter(workerIndex, roomId);

        // Save to database
        const success = database.createRoom({
            id: roomId,
            name,
            password,
            adminSocketId,
            workerIndex,
            maxUsers: maxUsers || 100
        });

        if (!success) {
            router.close();
            return { error: 'Oda oluşturulamadı' };
        }

        // Initialize room state
        this.rooms.set(roomId, {
            workerIndex,
            router,
            producers: new Map(),
            consumers: new Map(),
            transports: new Map(),
            pipeTransports: new Map(), // targetWorkerIndex -> { local, remote }
            pipeProducers: new Map(),  // workerIndex -> producer
            isStreaming: false
        });

        // Track admin socket
        this.socketRooms.set(adminSocketId, { roomId, role: 'admin' });

        console.log(`🏠 Room created: ${name} (${roomId}) on Worker ${workerIndex}`);

        return {
            roomId,
            workerIndex,
            isPublic: !password
        };
    }

    /**
     * Join a room
     */
    async joinRoom(roomId, socketId, password, clientIp) {
        const room = database.getRoom(roomId);
        if (!room) {
            return { error: 'Oda bulunamadı' };
        }

        // Check password if required
        if (room.password_hash && password) {
            if (!database.verifyPassword(roomId, password)) {
                return { error: 'Yanlış şifre', needPassword: true };
            }
        } else if (room.password_hash && !password) {
            return { error: 'Şifre gerekli', needPassword: true };
        }

        // Check user limit
        const roomState = this.rooms.get(roomId);
        if (!roomState) {
            return { error: 'Oda aktif değil' };
        }

        const currentUsers = this.getRoomUserCount(roomId);
        if (currentUsers >= room.max_users) {
            return { error: 'Oda dolu' };
        }

        // Track socket
        this.socketRooms.set(socketId, { roomId, role: 'viewer' });

        const newUserCount = this.getRoomUserCount(roomId);
        console.log(`👤 User ${socketId} joined room ${roomId} (total: ${newUserCount})`);

        return {
            success: true,
            roomId,
            roomName: room.name,
            isStreaming: roomState.isStreaming,
            workerIndex: room.worker_index,
            maxUsers: room.max_users,
            userCount: newUserCount
        };
    }

    /**
     * Leave a room
     */
    leaveRoom(socketId) {
        const socketData = this.socketRooms.get(socketId);
        if (!socketData) return null;

        const { roomId, role } = socketData;
        this.socketRooms.delete(socketId);

        // Clean up transports and consumers for this socket
        const roomState = this.rooms.get(roomId);
        if (roomState) {
            // Close all consumers belonging to this socket
            for (const [consumerId, consumerData] of roomState.consumers) {
                if (consumerData.socketId === socketId) {
                    consumerData.consumer.close();
                    roomState.consumers.delete(consumerId);
                    this.workerManager.decrementConsumers(roomState.workerIndex);
                }
            }

            // Close transports
            for (const [key, transport] of roomState.transports) {
                if (key.startsWith(socketId)) {
                    transport.close();
                    roomState.transports.delete(key);
                }
            }
        }

        // If admin left, start grace period (don't close immediately)
        if (role === 'admin') {
            console.log(`⏳ Admin disconnected from room ${roomId}, waiting ${ADMIN_GRACE_PERIOD / 1000}s for reconnect...`);

            // Set pending close timeout
            const timeout = setTimeout(() => {
                console.log(`⏰ Grace period expired for room ${roomId}, closing...`);
                this.pendingClose.delete(roomId);
                this.closeRoom(roomId);
            }, ADMIN_GRACE_PERIOD);

            this.pendingClose.set(roomId, timeout);

            return { roomPending: true, roomId };
        }

        console.log(`👋 User ${socketId} left room ${roomId}`);
        return { roomId };
    }

    /**
     * Cancel pending close (admin reconnected)
     */
    cancelPendingClose(roomId) {
        const timeout = this.pendingClose.get(roomId);
        if (timeout) {
            clearTimeout(timeout);
            this.pendingClose.delete(roomId);
            console.log(`✅ Admin reconnected, cancelled pending close for room ${roomId}`);
            return true;
        }
        return false;
    }

    /**
     * Close a room
     */
    closeRoom(roomId) {
        const roomState = this.rooms.get(roomId);
        if (!roomState) return;

        // Close all consumers
        roomState.consumers.forEach(consumer => consumer.close());

        // Close all producers
        roomState.producers.forEach(producer => producer.close());

        // Close all transports
        roomState.transports.forEach(transport => transport.close());

        // Close pipe transports
        roomState.pipeTransports.forEach(pipe => {
            pipe.local?.close();
            pipe.remote?.close();
        });

        // Close router
        this.workerManager.removeRouter(roomState.workerIndex, roomId);

        // Remove from database
        database.deleteRoom(roomId);

        // Remove room state
        this.rooms.delete(roomId);

        // Remove all socket mappings for this room
        for (const [socketId, data] of this.socketRooms) {
            if (data.roomId === roomId) {
                this.socketRooms.delete(socketId);
            }
        }

        console.log(`🗑️ Room ${roomId} closed`);
    }

    // ==================== TRANSPORT ====================

    /**
     * Get or create transport for a user
     */
    async getTransportInfo(roomId, socketId, isSender) {
        const roomState = this.rooms.get(roomId);
        if (!roomState) return { error: 'Oda bulunamadı' };

        const socketData = this.socketRooms.get(socketId);
        if (!socketData || socketData.roomId !== roomId) {
            return { error: 'Odaya kayıtlı değilsiniz' };
        }

        // Check if we need PipeTransport (user count > threshold)
        let targetRouter = roomState.router;
        let targetWorkerIndex = roomState.workerIndex;

        if (!isSender && this.getRoomUserCount(roomId) >= PIPE_THRESHOLD) {
            // Get least loaded worker for this viewer
            const { worker, index } = this.workerManager.getLeastLoadedWorker();
            if (index !== roomState.workerIndex) {
                targetWorkerIndex = index;
                targetRouter = await this.ensurePipeTransport(roomId, targetWorkerIndex);
            }
        }

        return {
            router: targetRouter,
            workerIndex: targetWorkerIndex
        };
    }

    /**
     * Ensure PipeTransport exists between source and target workers
     */
    async ensurePipeTransport(roomId, targetWorkerIndex) {
        const roomState = this.rooms.get(roomId);

        // Check if pipe already exists
        if (roomState.pipeTransports.has(targetWorkerIndex)) {
            const targetRouter = this.workerManager.getRouter(targetWorkerIndex, roomId);
            return targetRouter;
        }

        // Create router on target worker
        const targetRouter = await this.workerManager.createRouter(targetWorkerIndex, roomId);

        // Create pipe transport
        const { pipeTransport: localPipe, pipeConsumer } = await roomState.router.pipeToRouter({
            router: targetRouter
        });

        roomState.pipeTransports.set(targetWorkerIndex, {
            local: localPipe,
            consumer: pipeConsumer
        });

        console.log(`🔗 PipeTransport created: Worker ${roomState.workerIndex} → Worker ${targetWorkerIndex}`);

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

    getRoom(roomId) {
        return this.rooms.get(roomId);
    }

    getRoomFromSocket(socketId) {
        const socketData = this.socketRooms.get(socketId);
        if (!socketData) return null;
        return {
            ...socketData,
            roomState: this.rooms.get(socketData.roomId)
        };
    }

    getRoomUserCount(roomId) {
        let count = 0;
        for (const [, data] of this.socketRooms) {
            if (data.roomId === roomId) count++;
        }
        return count;
    }

    isAdmin(socketId) {
        const socketData = this.socketRooms.get(socketId);
        return socketData?.role === 'admin';
    }

    getAllRooms() {
        const dbRooms = database.getAllRooms();
        return dbRooms.map(room => ({
            ...room,
            userCount: this.getRoomUserCount(room.id)
        }));
    }

    updateMaxUsers(roomId, maxUsers) {
        database.setMaxUsers(roomId, maxUsers);
    }
}

module.exports = RoomManager;
