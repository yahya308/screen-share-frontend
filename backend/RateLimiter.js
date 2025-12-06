/**
 * RateLimiter - Brute force protection for password attempts
 * 5 failed attempts = 3 minute block
 */

class RateLimiter {
    constructor() {
        // Map: "ip:roomId" -> { attempts: number, blockedUntil: timestamp }
        this.attempts = new Map();
        this.MAX_ATTEMPTS = 5;
        this.BLOCK_DURATION = 3 * 60 * 1000; // 3 minutes

        // Cleanup expired entries every 5 minutes
        setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }

    /**
     * Generate key from IP and room ID
     */
    getKey(ip, roomId) {
        return `${ip}:${roomId}`;
    }

    /**
     * Check if IP is blocked for a specific room
     * @returns {Object} { blocked: boolean, remainingTime: number (seconds) }
     */
    isBlocked(ip, roomId) {
        const key = this.getKey(ip, roomId);
        const record = this.attempts.get(key);

        if (!record) {
            return { blocked: false, remainingTime: 0 };
        }

        if (record.blockedUntil && Date.now() < record.blockedUntil) {
            const remainingMs = record.blockedUntil - Date.now();
            return {
                blocked: true,
                remainingTime: Math.ceil(remainingMs / 1000)
            };
        }

        // Block expired, reset
        if (record.blockedUntil && Date.now() >= record.blockedUntil) {
            this.attempts.delete(key);
            return { blocked: false, remainingTime: 0 };
        }

        return { blocked: false, remainingTime: 0 };
    }

    /**
     * Record a failed attempt
     * @returns {Object} { blocked: boolean, remainingAttempts: number, remainingTime: number }
     */
    recordFailedAttempt(ip, roomId) {
        const key = this.getKey(ip, roomId);
        let record = this.attempts.get(key);

        if (!record) {
            record = { attempts: 0, blockedUntil: null };
            this.attempts.set(key, record);
        }

        record.attempts++;

        if (record.attempts >= this.MAX_ATTEMPTS) {
            record.blockedUntil = Date.now() + this.BLOCK_DURATION;
            console.log(`🚫 IP ${ip} blocked for room ${roomId} for 3 minutes`);
            return {
                blocked: true,
                remainingAttempts: 0,
                remainingTime: Math.ceil(this.BLOCK_DURATION / 1000)
            };
        }

        return {
            blocked: false,
            remainingAttempts: this.MAX_ATTEMPTS - record.attempts,
            remainingTime: 0
        };
    }

    /**
     * Reset attempts after successful login
     */
    resetAttempts(ip, roomId) {
        const key = this.getKey(ip, roomId);
        this.attempts.delete(key);
    }

    /**
     * Cleanup expired records
     */
    cleanup() {
        const now = Date.now();
        for (const [key, record] of this.attempts.entries()) {
            if (record.blockedUntil && now >= record.blockedUntil) {
                this.attempts.delete(key);
            }
        }
    }

    /**
     * Get stats for monitoring
     */
    getStats() {
        return {
            trackedEntries: this.attempts.size,
            blockedCount: Array.from(this.attempts.values())
                .filter(r => r.blockedUntil && Date.now() < r.blockedUntil).length
        };
    }
}

module.exports = new RateLimiter();
