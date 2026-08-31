/**
 * Lobi yayınının gerçekten daraldığını doğrular: oda içindeki istemciler
 * (ve abone olmayan herkes) artık her katılım/ayrılışta mesaj almamalı.
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

/** Bağlanmış bir istemci döndürür; test sonunda topluca kapatılır. */
function connect() {
    return new Promise((resolve, reject) => {
        const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
        openSockets.add(socket);
        const timer = setTimeout(() => reject(new Error('istemci 15 sn içinde bağlanamadı')), 15000);
        socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    });
}

/** Callback'li bir olayı promise'e çevirir. */
function emit(socket, event, payload) {
    return new Promise((resolve, reject) => {
        // Ack'siz kalan bir çağrı testi SESSİZCE askıda bırakmasın: yetkilendirme
        // testinin başarısızlığı okunabilir olmalı, gizemli bir zaman aşımı değil.
        const timer = setTimeout(
            () => reject(new Error(`'${event}' olayı 10 sn içinde yanıtlanmadı`)),
            10000
        );
        const done = (result) => { clearTimeout(timer); resolve(result); };
        // Dikkat: payload undefined ise onu göndermeyin — socket.io son fonksiyon
        // argümanını ack sayar ve undefined sunucuda callback parametresine düşer.
        if (payload === undefined) socket.emit(event, done);
        else socket.emit(event, payload, done);
    });
}

/** Gelen olayları biriktirir; "gelmemeli" iddialarını da mümkün kılar. */
function record(socket, event) {
    const received = [];
    socket.on(event, (payload) => received.push(payload));
    return received;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('lobby-subscribe ilk oda listesini de döndürür', async () => {
    const admin = await connect();
    await emit(admin, 'create-room', { name: 'Listede Görünsün' });

    const lobby = await connect();
    const rooms = await emit(lobby, 'lobby-subscribe');

    assert.ok(Array.isArray(rooms));
    assert.ok(rooms.some(r => r.name === 'Listede Görünsün'));
});

test('room-created yalnızca lobi abonelerine gider', async () => {
    const lobby = await connect();
    await emit(lobby, 'lobby-subscribe');
    const lobbyEvents = record(lobby, 'room-created');

    const outsider = await connect();
    const outsiderEvents = record(outsider, 'room-created');

    const admin = await connect();
    await emit(admin, 'create-room', { name: 'Yeni Oda' });
    await wait(150);

    assert.equal(lobbyEvents.length, 1, 'abone bildirim almalı');
    assert.equal(outsiderEvents.length, 0, 'abone olmayan bildirim almamalı');
});

test('kullanıcı sayısı güncellemeleri toplulaştırılıp yalnızca lobiye gider', async () => {
    const admin = await connect();
    const { roomId } = await emit(admin, 'create-room', { name: 'Sayaç Odası', maxUsers: 50 });

    const lobby = await connect();
    await emit(lobby, 'lobby-subscribe');
    const batches = record(lobby, 'rooms-updated');

    const inRoom = await connect();
    const inRoomEvents = record(inRoom, 'rooms-updated');
    await emit(inRoom, 'join-room', { roomId, nickname: 'izleyici1' });

    // Aynı pencerede birden çok katılım tek mesajda birleşmeli
    const others = [];
    for (let i = 2; i <= 4; i++) {
        const viewer = await connect();
        await emit(viewer, 'join-room', { roomId, nickname: `izleyici${i}` });
        others.push(viewer);
    }

    await wait(1400);

    assert.ok(batches.length >= 1, 'lobi en az bir toplu güncelleme almalı');
    assert.ok(batches.length <= 3, `4 katılım için ${batches.length} mesaj: toplulaştırma çalışmıyor`);

    const last = batches[batches.length - 1].find(u => u.id === roomId);
    assert.equal(last.userCount, 5, 'admin + 4 izleyici');

    assert.equal(inRoomEvents.length, 0, 'oda içindeki istemci lobi trafiği almamalı');
});

test('lobby-unsubscribe sonrası bildirim durur', async () => {
    const lobby = await connect();
    await emit(lobby, 'lobby-subscribe');
    lobby.emit('lobby-unsubscribe');
    await wait(100);

    const events = record(lobby, 'room-created');

    const admin = await connect();
    await emit(admin, 'create-room', { name: 'Abonelik Sonrası' });
    await wait(150);

    assert.equal(events.length, 0);
});
