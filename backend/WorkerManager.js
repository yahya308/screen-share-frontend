/**
 * WorkerManager - Multi-core Mediasoup Worker Pool
 * Manages worker lifecycle and load balancing
 */

const mediasoup = require('mediasoup');
const os = require('os');
const config = require('./config');

class WorkerManager {
    constructor() {
        this.workers = [];
        this.workerStats = new Map(); // workerId -> { consumers, producers, routers }
    }

    async init() {
        const numCores = os.cpus().length;
        console.log(`🚀 Spawning ${numCores} Mediasoup workers...`);

        for (let i = 0; i < numCores; i++) {
            const worker = await this.createWorker(i);
            this.workers.push(worker);
            this.workerStats.set(worker.pid, {
                index: i,
                consumers: 0,
                producers: 0,
                routers: new Map() // roomId -> router
            });
        }

        console.log(`✅ ${numCores} workers ready`);
        return this.workers;
    }

    async createWorker(index) {
        const worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort
        });

        worker.on('died', (error) => {
            console.error(`❌ Worker ${index} died:`, error);
            // Restart worker
            setTimeout(async () => {
                const newWorker = await this.createWorker(index);
                this.workers[index] = newWorker;
                console.log(`🔄 Worker ${index} restarted`);
            }, 2000);
        });

        console.log(`  Worker ${index} started (PID: ${worker.pid})`);
        return worker;
    }

    /**
     * Get the least loaded worker based on consumer count
     */
    getLeastLoadedWorker() {
        let minLoad = Infinity;
        let selectedWorker = this.workers[0];
        let selectedIndex = 0;

        this.workerStats.forEach((stats, pid) => {
            const load = stats.consumers + stats.producers;
            if (load < minLoad) {
                minLoad = load;
                selectedWorker = this.workers[stats.index];
                selectedIndex = stats.index;
            }
        });

        console.log(`📊 Selected Worker ${selectedIndex} (load: ${minLoad})`);
        return { worker: selectedWorker, index: selectedIndex };
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
        const router = await worker.createRouter({
            mediaCodecs: config.mediasoup.router.mediaCodecs
        });

        const stats = this.workerStats.get(worker.pid);
        stats.routers.set(roomId, router);

        console.log(`🔧 Router created for room ${roomId} on Worker ${workerIndex}`);
        return router;
    }

    /**
     * Get router for a room
     */
    getRouter(workerIndex, roomId) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(worker.pid);
        return stats?.routers.get(roomId);
    }

    /**
     * Remove router when room closes
     */
    removeRouter(workerIndex, roomId) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(worker.pid);
        const router = stats?.routers.get(roomId);
        if (router) {
            router.close();
            stats.routers.delete(roomId);
            console.log(`🗑️ Router removed for room ${roomId}`);
        }
    }

    /**
     * Update consumer count for a worker
     */
    incrementConsumers(workerIndex) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(worker.pid);
        stats.consumers++;
    }

    decrementConsumers(workerIndex) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(worker.pid);
        if (stats.consumers > 0) stats.consumers--;
    }

    incrementProducers(workerIndex) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(worker.pid);
        stats.producers++;
    }

    decrementProducers(workerIndex) {
        const worker = this.workers[workerIndex];
        const stats = this.workerStats.get(worker.pid);
        if (stats.producers > 0) stats.producers--;
    }

    /**
     * Get worker stats for monitoring
     */
    getStats() {
        const stats = [];
        this.workerStats.forEach((data, pid) => {
            stats.push({
                index: data.index,
                pid,
                consumers: data.consumers,
                producers: data.producers,
                rooms: data.routers.size
            });
        });
        return stats;
    }
}

module.exports = WorkerManager;
