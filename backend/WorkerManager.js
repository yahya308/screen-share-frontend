/**
 * WorkerManager - Multi-core Mediasoup Worker Pool
 * Manages worker lifecycle and load balancing
 *
 * İstatistikler worker INDEX'i ile anahtarlanır. Daha önce anahtar
 * `worker.pid` idi ve kayıt yalnızca init() içinde oluşturuluyordu: bir worker
 * öldüğünde yenisi farklı bir PID ile açılıyor, istatistik kaydı hiç
 * oluşturulmuyor, eskisi de silinmiyordu. Yeniden başlatmadan sonraki ilk
 * createRouter/incrementConsumers çağrısı tanımsız üzerinde çalışıp istisna
 * fırlatıyordu. PID değişken bir kimlik, indeks ise sabit.
 */

const mediasoup = require('mediasoup');
const os = require('os');
const config = require('./config');
const log = require('./logger');

const RESTART_DELAY_MS = 2000;

class WorkerManager {
    constructor() {
        this.workers = [];
        this.workerStats = new Map(); // index -> { pid, consumers, producers, routers }
        /** @type {null | (info: { index:number, roomIds:string[] }) => void} */
        this.onWorkerDied = null;
        this.closing = false;
    }

    /** Kaç worker açılacak: açık ayar > kullanılabilir paralellik > çekirdek sayısı. */
    static resolveWorkerCount(env = process.env) {
        const configured = parseInt(env.MEDIASOUP_WORKERS, 10);
        if (Number.isFinite(configured) && configured > 0) return configured;
        // os.cpus().length konteynerde HOST çekirdeklerini döndürür, cgroup
        // kotasını değil: 2 vCPU'luk bir konteyner 16 worker açabiliyordu.
        if (typeof os.availableParallelism === 'function') return os.availableParallelism();
        return os.cpus().length;
    }

    async init() {
        const workerCount = WorkerManager.resolveWorkerCount();
        log.info(`🚀 Spawning ${workerCount} Mediasoup workers...`);

        for (let i = 0; i < workerCount; i++) {
            this.workers[i] = await this.createWorker(i);
        }

        log.info(`✅ ${workerCount} workers ready`);
        return this.workers;
    }

    async createWorker(index) {
        const worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort
        });

        // İstatistik kaydı worker ile BİRLİKTE oluşur; yeniden başlatmada da geçerli.
        this.workerStats.set(index, {
            index,
            pid: worker.pid,
            consumers: 0,
            producers: 0,
            routers: new Map() // roomId -> router
        });

        worker.on('died', (error) => this.handleWorkerDeath(index, error));

        log.info(`  Worker ${index} started (PID: ${worker.pid})`);
        return worker;
    }

    /**
     * Bir worker öldüğünde: üstündeki odaları KAYBEDİLMİŞ olarak bildir, sonra
     * yerine yenisini aç. Sessiz kayıp çökmeden kötüdür — istemciler bağlı
     * görünüp medya hiç gelmez.
     */
    handleWorkerDeath(index, error) {
        if (this.closing) return;

        const stats = this.workerStats.get(index);
        const roomIds = stats ? [...stats.routers.keys()] : [];
        log.error(`❌ Worker ${index} died (${roomIds.length} oda etkilendi):`, error && error.message);

        this.workerStats.delete(index);
        this.workers[index] = null;

        if (typeof this.onWorkerDied === 'function') {
            try { this.onWorkerDied({ index, roomIds }); }
            catch (e) { log.error('onWorkerDied hatası:', e); }
        }

        setTimeout(async () => {
            if (this.closing) return;
            try {
                this.workers[index] = await this.createWorker(index);
                log.info(`🔄 Worker ${index} restarted`);
            } catch (e) {
                log.error(`Worker ${index} yeniden başlatılamadı:`, e);
            }
        }, RESTART_DELAY_MS).unref();
    }

    /**
     * Get the least loaded worker based on consumer count
     */
    getLeastLoadedWorker() {
        let minLoad = Infinity;
        let selectedIndex = -1;

        for (const [index, stats] of this.workerStats) {
            if (!this.workers[index]) continue; // yeniden başlatma bekleyen slot
            const load = stats.consumers + stats.producers;
            if (load < minLoad) {
                minLoad = load;
                selectedIndex = index;
            }
        }

        if (selectedIndex === -1) {
            throw new Error('Kullanılabilir mediasoup worker yok');
        }

        log.debug(`📊 Selected Worker ${selectedIndex} (load: ${minLoad})`);
        return { worker: this.workers[selectedIndex], index: selectedIndex };
    }

    /**
     * Get a specific worker by index
     */
    getWorker(index) {
        return this.workers[index];
    }

    /**
     * Create router on specific worker
     */
    async createRouter(workerIndex, roomId) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(workerIndex);
        if (!worker || !stats) {
            throw new Error(`Worker ${workerIndex} kullanılabilir değil`);
        }

        const router = await worker.createRouter({
            mediaCodecs: config.mediasoup.router.mediaCodecs
        });

        stats.routers.set(roomId, router);

        log.debug(`🔧 Router created for room ${roomId} on Worker ${workerIndex}`);
        return router;
    }

    /**
     * Get router for a room
     */
    getRouter(workerIndex, roomId) {
        return this.workerStats.get(workerIndex)?.routers.get(roomId);
    }

    /**
     * Remove router when room closes
     */
    removeRouter(workerIndex, roomId) {
        const stats = this.workerStats.get(workerIndex);
        const router = stats?.routers.get(roomId);
        if (router) {
            try { router.close(); } catch (e) { /* zaten kapalı */ }
            stats.routers.delete(roomId);
            log.debug(`🗑️ Router removed for room ${roomId}`);
        }
    }

    // ==================== SAYAÇLAR ====================
    // Hepsi kayıt yoksa sessizce geçer: kapanış ve worker ölümü sırasında geç
    // gelen temizlik çağrıları süreci düşürmemeli.

    incrementConsumers(workerIndex) {
        const stats = this.workerStats.get(workerIndex);
        if (stats) stats.consumers++;
    }

    decrementConsumers(workerIndex) {
        const stats = this.workerStats.get(workerIndex);
        if (stats && stats.consumers > 0) stats.consumers--;
    }

    incrementProducers(workerIndex) {
        const stats = this.workerStats.get(workerIndex);
        if (stats) stats.producers++;
    }

    decrementProducers(workerIndex) {
        const stats = this.workerStats.get(workerIndex);
        if (stats && stats.producers > 0) stats.producers--;
    }

    /** Tüm worker'ları kapat (düzgün kapanma ve testler). */
    async closeAll() {
        this.closing = true;
        for (const worker of this.workers) {
            if (!worker) continue;
            try { worker.close(); } catch (e) { /* zaten kapalı */ }
        }
        this.workers = [];
        this.workerStats.clear();
    }

    /**
     * Get worker stats for monitoring
     */
    getStats() {
        const stats = [];
        this.workerStats.forEach((data) => {
            stats.push({
                index: data.index,
                pid: data.pid,
                consumers: data.consumers,
                producers: data.producers,
                rooms: data.routers.size
            });
        });
        return stats.sort((a, b) => a.index - b.index);
    }
}

module.exports = WorkerManager;
