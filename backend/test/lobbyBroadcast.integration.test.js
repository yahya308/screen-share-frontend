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

test('lobiden checkOnly join-room hayalet Anonim üretmez ve 2 kişilik odayı tıkamaz', async () => {
    const creator = await connect();
    const { roomId, adminToken } = await emit(creator, 'create-room', {
        name: 'İki Kişilik Oda', password: 'sifre', maxUsers: 2
    });
    creator.disconnect();
    openSockets.delete(creator);

    const admin = await connect();
    await emit(admin, 'admin-rejoin', { roomId, nickname: 'sahip', adminToken });
    const userLists = record(admin, 'user-list');
    const userJoined = record(admin, 'user-joined');

    // Lobi soketi hâlâ bağlıyken oda sayfası yeni soketle katılır (maxUsers = 2)
    const lobbySocket = await connect();
    const check = await emit(lobbySocket, 'join-room', { roomId, password: 'sifre', checkOnly: true });
    assert.equal(check.success, true);

    await wait(100);
    assert.equal(userJoined.length, 0, 'lobi kontrolü user-joined yaymamalı');
    assert.equal(userLists.some(list => list.some(u => u.nickname === 'Anonim')), false, 'Anonim görünmemeli');

    const viewerSocket = await connect();
    const joined = await emit(viewerSocket, 'join-room', { roomId, password: 'sifre', nickname: 'izleyici' });
    assert.equal(joined.success, true, 'lobi soketi açıkken bile gerçek izleyici girebilmeli');
});

test('update-max-users doğrulama yapar ve yeni limiti lobiye bildirir', async () => {
    const creator = await connect();
    const { roomId, adminToken } = await emit(creator, 'create-room', { name: 'Limit Güncelleme', maxUsers: 10 });
    creator.disconnect();
    openSockets.delete(creator);

    const admin = await connect();
    await emit(admin, 'admin-rejoin', { roomId, nickname: 'sahip', adminToken });

    const lobby = await connect();
    await emit(lobby, 'lobby-subscribe');
    const updates = record(lobby, 'rooms-updated');

    const bad = await emit(admin, 'update-max-users', { maxUsers: null });
    assert.match(bad.error || '', /2-1000/);

    const ok = await emit(admin, 'update-max-users', { maxUsers: 42 });
    assert.equal(ok.success, true);

    await wait(1200);
    const update = updates.flat().find(u => u.id === roomId);
    assert.ok(update, 'lobi limit değişimini almalı');
    assert.equal(update.max_users, 42);
});

test('bozuk (null/ilkel) soket yükleri sunucuyu çökertmez', async () => {
    const client = await connect();
    for (const bad of [null, 123, 'metin', []]) {
        const c1 = await emit(client, 'create-room', bad);
        assert.ok(c1.error);
        const c2 = await emit(client, 'join-room', bad);
        assert.ok(c2.error);
        const c3 = await emit(client, 'admin-rejoin', bad);
        assert.ok(c3.error);
        const c4 = await emit(client, 'createWebRtcTransport', bad);
        assert.ok(c4.params.error);
        const c5 = await emit(client, 'consume', bad);
        assert.ok(c5.params.error);
        const c6 = await emit(client, 'update-max-users', bad);
        assert.ok(c6.error);
    }
    client.emit('voice-activity', null);
    client.emit('producer-closing', null);
    client.emit('requestKeyFrame', null);
    await wait(50);
    assert.equal(client.connected, true, 'sunucu ayakta ve soket bağlı kalmalı');
});
