/**
 * Database - SQLite with prepared statements for security
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const log = require('./logger');

// Testler ':memory:' verebilsin diye dışarıdan geçersiz kılınabilir.
const DB_PATH = process.env.ROOMS_DB_PATH || path.join(__dirname, 'rooms.db');
const BCRYPT_ROUNDS = 10;

class RoomDatabase {
    constructor() {
        this.db = new Database(DB_PATH);
        this.init();
    }

    init() {
        // Create rooms table with prepared statement
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                password_hash TEXT,
                admin_socket_id TEXT,
                worker_index INTEGER NOT NULL,
                max_users INTEGER DEFAULT 100,
                is_streaming INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            )
        `);

        // Clean up stale rooms from previous server session
        // Rooms are memory-based, so any DB entries are orphaned after restart
        this.clearAllRooms();

        log.info('✅ Database initialized');
    }

    /**
     * Clear all rooms (used on server startup to clean stale data)
     */
    clearAllRooms() {
        const count = this.getRoomCount();
        if (count > 0) {
            log.info(`🧹 Cleaning ${count} stale room(s) from previous session...`);
            this.db.exec('DELETE FROM rooms');
        }
    }

    // ==================== ROOM CRUD ====================

    /**
     * Create a new room
     * @param {Object} room - Room data
     * @returns {boolean} Success
     */
    async createRoom({ id, name, password, adminSocketId, workerIndex, maxUsers }) {
        const stmt = this.db.prepare(`
            INSERT INTO rooms (id, name, password_hash, admin_socket_id, worker_index, max_users, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        // bcrypt.hashSync olay döngüsünü ~100 ms bloke ediyordu (bkz. verifyPassword)
        const passwordHash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;

        try {
            stmt.run(id, name, passwordHash, adminSocketId, workerIndex, maxUsers || 100, Date.now());
            return true;
        } catch (error) {
            log.error('Create room error:', error);
            return false;
        }
    }

    /**
     * Get room by ID
     */
    getRoom(roomId) {
        const stmt = this.db.prepare('SELECT * FROM rooms WHERE id = ?');
        return stmt.get(roomId);
    }

    /**
     * Get all rooms (for lobby)
     */
    getAllRooms() {
        const stmt = this.db.prepare(`
            SELECT id, name, password_hash IS NOT NULL as is_locked, max_users, is_streaming, created_at
            FROM rooms
            ORDER BY created_at DESC
        `);
        return stmt.all();
    }

    /**
     * Get room count
     */
    getRoomCount() {
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM rooms');
        return stmt.get().count;
    }

    /**
     * Delete a room
     */
    deleteRoom(roomId) {
        const stmt = this.db.prepare('DELETE FROM rooms WHERE id = ?');
        stmt.run(roomId);
    }

    /**
     * Delete room by admin socket ID (when admin disconnects)
     */
    deleteRoomByAdmin(adminSocketId) {
        const stmt = this.db.prepare('SELECT id FROM rooms WHERE admin_socket_id = ?');
        const room = stmt.get(adminSocketId);

        if (room) {
            this.deleteRoom(room.id);
            return room.id;
        }
        return null;
    }

    /**
     * Update streaming status
     */
    setStreamingStatus(roomId, isStreaming) {
        const stmt = this.db.prepare('UPDATE rooms SET is_streaming = ? WHERE id = ?');
        stmt.run(isStreaming ? 1 : 0, roomId);
    }

    /**
     * Update max users
     */
    setMaxUsers(roomId, maxUsers) {
        const stmt = this.db.prepare('UPDATE rooms SET max_users = ? WHERE id = ?');
        stmt.run(maxUsers, roomId);
    }

    /**
     * Update admin socket ID
     */
    updateAdminSocket(roomId, socketId) {
        const stmt = this.db.prepare('UPDATE rooms SET admin_socket_id = ? WHERE id = ?');
        stmt.run(socketId, roomId);
    }

    // ==================== PASSWORD ====================

    /**
     * Verify room password
     *
     * ASENKRON: bcrypt 10 tur tipik bir vCPU'da 60-100 ms sürer ve senkron
     * sürümü boyunca Node'un TEK olay döngüsü tamamen bloke olur. Saniyede
     * 10 parola denemesi, sadece o odayı değil TÜM odaların sinyalleşmesini
     * (transport kurma, consume, sohbet, kullanıcı listesi) dondururdu.
     *
     * @returns {Promise<boolean>} Password correct
     */
    async verifyPassword(roomId, password) {
        const room = this.getRoom(roomId);
        if (!room) return false;
        if (!room.password_hash) return true; // Public room

        return bcrypt.compare(password, room.password_hash);
    }

    /**
     * Check if room is public (no password)
     */
    isPublicRoom(roomId) {
        const room = this.getRoom(roomId);
        return room && !room.password_hash;
    }

    // ==================== CLEANUP ====================

    /**
     * Close database connection
     */
    close() {
        if (!this.db.open) return;
        this.db.close();
    }
}

module.exports = new RoomDatabase();
