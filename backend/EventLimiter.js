/**
 * EventLimiter - Soket olayları için kayan pencereli genel hız sınırı.
 *
 * Daha önce yalnızca sohbet mesajları ve parola denemeleri sınırlıydı;
 * 'create-room' ve 'get-rooms' serbestti. 50 odalık sunucu kotası (MAX_ROOMS)
 * tek bir döngüyle doldurulabiliyor, sonraki tüm gerçek kullanıcılar
 * "Sunucu oda limitine ulaştı" hatası alıyordu.
 */

class EventLimiter {
    /**
     * @param {number} max Pencere başına izin verilen çağrı sayısı
     * @param {number} windowMs Pencere uzunluğu (ms)
     */
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.hits = new Map(); // key -> number[] (zaman damgaları)

        this.cleanupTimer = setInterval(() => this.cleanup(), windowMs);
        if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
    }

    /**
     * Bir kullanım hakkı tüket.
     * @returns {{ allowed: boolean, retryAfter: number }} retryAfter saniye
     */
    consume(key, now = Date.now()) {
        const cutoff = now - this.windowMs;
        const timestamps = (this.hits.get(key) || []).filter(t => t > cutoff);

        if (timestamps.length >= this.max) {
            this.hits.set(key, timestamps);
            const retryAfter = Math.ceil((timestamps[0] + this.windowMs - now) / 1000);
            return { allowed: false, retryAfter: Math.max(1, retryAfter) };
        }

        timestamps.push(now);
        this.hits.set(key, timestamps);
        return { allowed: true, retryAfter: 0 };
    }

    reset(key) {
        this.hits.delete(key);
    }

    cleanup(now = Date.now()) {
        const cutoff = now - this.windowMs;
        for (const [key, timestamps] of this.hits) {
            const kept = timestamps.filter(t => t > cutoff);
            if (kept.length) this.hits.set(key, kept);
            else this.hits.delete(key);
        }
    }

    get size() {
        return this.hits.size;
    }
}

module.exports = EventLimiter;
