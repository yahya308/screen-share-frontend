const test = require('node:test');
const assert = require('node:assert/strict');

const WorkerManager = require('../WorkerManager');

test('resolveWorkerCount açık ayarı önceler', () => {
    assert.equal(WorkerManager.resolveWorkerCount({ MEDIASOUP_WORKERS: '3' }), 3);
});

test('resolveWorkerCount geçersiz ayarı yok sayar', () => {
    for (const value of ['0', '-2', 'abc', '']) {
        const count = WorkerManager.resolveWorkerCount({ MEDIASOUP_WORKERS: value });
        assert.ok(count > 0, `geçersiz "${value}" için pozitif sayıya düşmeli`);
    }
});

test('sayaçlar kayıt yokken çökmez', () => {
    // Kapanış ve worker ölümü sırasında geç gelen temizlik çağrıları buraya düşer.
    const wm = new WorkerManager();
    assert.doesNotThrow(() => {
        wm.incrementConsumers(0);
        wm.decrementConsumers(0);
        wm.incrementProducers(7);
        wm.decrementProducers(7);
        wm.removeRouter(3, 'yok');
        wm.getRouter(3, 'yok');
    });
});

test('sayaçlar sıfırın altına inmez', () => {
    const wm = new WorkerManager();
    wm.workerStats.set(0, { index: 0, pid: 1, consumers: 0, producers: 0, routers: new Map() });

    wm.decrementConsumers(0);
    wm.decrementProducers(0);

    const [stats] = wm.getStats();
    assert.equal(stats.consumers, 0);
    assert.equal(stats.producers, 0);
});

test('kullanılabilir worker yoksa açık hata verir', () => {
    const wm = new WorkerManager();
    assert.throws(() => wm.getLeastLoadedWorker(), /worker yok/i);
});

test('getLeastLoadedWorker yeniden başlatma bekleyen slotu atlar', () => {
    const wm = new WorkerManager();
    wm.workers = [null, { pid: 22 }];
    wm.workerStats.set(0, { index: 0, pid: 11, consumers: 0, producers: 0, routers: new Map() });
    wm.workerStats.set(1, { index: 1, pid: 22, consumers: 5, producers: 5, routers: new Map() });

    const { index } = wm.getLeastLoadedWorker();
    assert.equal(index, 1, 'yükü daha yüksek olsa da tek ayakta olan worker seçilmeli');
});

test('worker ölümü etkilenen odaları bildirir ve kaydı temizler', () => {
    const wm = new WorkerManager();
    wm.workers = [{ pid: 11 }];
    wm.workerStats.set(0, {
        index: 0, pid: 11, consumers: 3, producers: 1,
        routers: new Map([['oda-a', {}], ['oda-b', {}]])
    });

    let reported = null;
    wm.onWorkerDied = (info) => { reported = info; };

    wm.handleWorkerDeath(0, new Error('test'));

    assert.deepEqual(reported, { index: 0, roomIds: ['oda-a', 'oda-b'] });
    assert.equal(wm.workerStats.has(0), false, 'ölü worker istatistiği silinmeli');
    assert.equal(wm.workers[0], null);
});

test('kapanış sırasında ölüm bildirimi tetiklenmez', () => {
    const wm = new WorkerManager();
    wm.workerStats.set(0, { index: 0, pid: 11, consumers: 0, producers: 0, routers: new Map() });
    let called = false;
    wm.onWorkerDied = () => { called = true; };

    wm.closing = true;
    wm.handleWorkerDeath(0, new Error('kapanış'));

    assert.equal(called, false);
});

test('getStats indekse göre sıralı döner', () => {
    const wm = new WorkerManager();
    wm.workerStats.set(2, { index: 2, pid: 3, consumers: 1, producers: 0, routers: new Map() });
    wm.workerStats.set(0, { index: 0, pid: 1, consumers: 0, producers: 0, routers: new Map() });

    assert.deepEqual(wm.getStats().map(s => s.index), [0, 2]);
});
