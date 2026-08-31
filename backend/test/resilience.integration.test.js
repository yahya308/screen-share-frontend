/**
 * Kurtarma yollarının gerçekten çalıştığını doğrular: worker ölümü ve
 * düzgün kapanma. Bu iki senaryo sunucuyu kalıcı olarak bozduğu için
 * kendi dosyasında ve sıralı çalışır.
 */

process.env.ROOMS_DB_PATH = ':memory:';
process.env.MEDIASOUP_WORKERS = '1';
process.env.MAX_ROOMS_PER_IP = '100';
process.env.CREATE_ROOM_MAX = '500';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const server = require('../server');

let baseUrl;
const openSockets = new Set();

test.before(async () => {
    const { port } = await server.start({ port: 0 });
    baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
    for (const socket of openSockets) socket.disconnect();
    await server.stop();
});

function connect() {
    return new Promise((resolve, reject) => {
        const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
        openSockets.add(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}

function emit(socket, event, payload) {
    return new Promise((resolve) => {
        // Dikkat: payload undefined ise onu göndermeyin — socket.io son
        // fonksiyon argümanını ack sayar ve undefined sunucuda callback
        // parametresine düşerek ack'i sessizce yutar.
        if (payload === undefined) socket.emit(event, resolve);
        else socket.emit(event, payload, resolve);
    });
}

function once(socket, event, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        socket.once(event, (payload) => { clearTimeout(timer); resolve(payload || {}); });
    });
}

test('worker ölünce odadakiler bilgilendirilir ve oda temizlenir', async () => {
    const admin = await connect();
    const { roomId, adminToken } = await emit(admin, 'create-room', { name: 'Kurtarma Odası' });
    await emit(admin, 'admin-rejoin', { roomId, nickname: 'sahip', adminToken });

    const viewer = await connect();
    await emit(viewer, 'join-room', { roomId, nickname: 'izleyici' });

    const lobby = await connect();
    await emit(lobby, 'lobby-subscribe');

    const roomClosed = once(viewer, 'room-closed');
    const roomDeleted = once(lobby, 'room-deleted');

    // Gerçek bir worker çökmesini taklit et
    server.workerManager.handleWorkerDeath(0, new Error('simüle edilmiş çökme'));

    const closed = await roomClosed;
    const deleted = await roomDeleted;

    assert.ok(closed, 'izleyici sessizce bırakılmamalı, room-closed almalı');
    assert.match(closed.reason, /yeniden başlat/i);
    assert.equal(deleted.id, roomId, 'lobiden de düşmeli');
    assert.equal(server.getRoomManager().rooms.has(roomId), false, 'oda durumu temizlenmeli');
});

test('düzgün kapanmada istemciler önceden uyarılır', async () => {
    const client = await connect();
    const warning = once(client, 'server-restarting');

    await server.stop({ notifyClients: true, drainMs: 100 });

    const payload = await warning;
    assert.ok(payload, 'kapanmadan önce server-restarting gelmeliydi');
    assert.match(payload.reason, /güncelleniyor/i);
});

test('stop() tekrar çağrılabilir (idempotent)', async () => {
    await assert.doesNotReject(() => server.stop());
});
