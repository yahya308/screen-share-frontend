/**
 * Uçtan uca yetkilendirme testi.
 *
 * Bu dosyanın tek amacı G-1'in geri gelmesini kalıcı olarak engellemek:
 * gerçek bir Socket.io sunucusu ve gerçek istemcilerle, token'sız bir
 * istemcinin hiçbir koşulda yönetici olamadığını doğrular.
 */

process.env.ROOMS_DB_PATH = ':memory:';
process.env.MEDIASOUP_WORKERS = '1';
// Bu dosya tek IP'den (127.0.0.1) çok sayıda oda açar; DoS limitleri burada
// ölçülmüyor (bkz. roomManager/eventLimiter testleri) ve yolu tıkamamalı.
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
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}

/** Callback'li bir olayı promise'e çevirir. */
function emit(socket, event, payload) {
    return new Promise((resolve) => {
        if (payload === undefined) socket.emit(event, resolve);
        else socket.emit(event, payload, resolve);
    });
}

async function createRoom(socket, overrides = {}) {
    return emit(socket, 'create-room', { name: 'Entegrasyon Odası', maxUsers: 10, ...overrides });
}

// ==================== TOKEN DAĞITIMI ====================

test('create-room kurucuya adminToken döner', async () => {
    const admin = await connect();
    const result = await createRoom(admin);

    assert.equal(result.success, true);
    assert.match(result.adminToken, /^[0-9a-f]{64}$/);
});

test('oda listesi adminToken içermez', async () => {
    const admin = await connect();
    const { adminToken } = await createRoom(admin);

    const spy = await connect();
    const rooms = await emit(spy, 'get-rooms');

    assert.ok(Array.isArray(rooms));
    assert.equal(JSON.stringify(rooms).includes(adminToken), false);
});

// ==================== YETKİSİZ ERİŞİM ====================

test('token olmadan admin-rejoin reddedilir', async () => {
    const admin = await connect();
    const { roomId } = await createRoom(admin);

    const attacker = await connect();
    const result = await emit(attacker, 'admin-rejoin', { roomId, nickname: 'saldirgan' });

    assert.equal(result.forbidden, true);
    assert.ok(result.error);
});

test('yanlış token ile admin-rejoin reddedilir', async () => {
    const admin = await connect();
    const { roomId } = await createRoom(admin);

    const attacker = await connect();
    const result = await emit(attacker, 'admin-rejoin', {
        roomId, nickname: 'saldirgan', adminToken: 'f'.repeat(64)
    });

    assert.equal(result.forbidden, true);
});

test('reddedilen admin-rejoin hiçbir yetki bırakmaz', async () => {
    const admin = await connect();
    const { roomId, adminToken } = await createRoom(admin);

    // Gerçek yönetici odaya yerleşsin
    const realAdmin = await connect();
    await emit(realAdmin, 'admin-rejoin', { roomId, nickname: 'sahip', adminToken });

    // Kurban izleyici
    const victim = await connect();
    await emit(victim, 'join-room', { roomId, nickname: 'kurban' });

    // Saldırgan token'sız yönetici olmayı dener, sonra moderasyon dener
    const attacker = await connect();
    await emit(attacker, 'admin-rejoin', { roomId, nickname: 'saldirgan' });
    await emit(attacker, 'join-room', { roomId, nickname: 'saldirgan' });

    const kick = await emit(attacker, 'kick-user', { targetSocketId: victim.id });
    const ban = await emit(attacker, 'ban-user', { targetSocketId: victim.id });
    const chatOff = await emit(attacker, 'toggle-chat', { enabled: false });
    const micOff = await emit(attacker, 'toggle-viewer-mic', { enabled: false });
    const maxUsers = await emit(attacker, 'update-max-users', { maxUsers: 2 });

    for (const [name, result] of Object.entries({ kick, ban, chatOff, micOff, maxUsers })) {
        assert.match(result.error || '', /Yetkiniz yok/, `${name} yetkisiz geçmemeliydi`);
    }
    assert.equal(victim.connected, true, 'kurban hâlâ bağlı olmalı');
});

test('parola koruması admin yolundan atlatılamaz', async () => {
    const admin = await connect();
    const { roomId } = await createRoom(admin, { password: 'cokgizli' });

    const attacker = await connect();

    // 1) Yönetici kılığında girmeyi dene
    const asAdmin = await emit(attacker, 'admin-rejoin', { roomId, nickname: 'saldirgan' });
    assert.equal(asAdmin.forbidden, true);

    // 2) Parolasız izleyici olarak girmeyi dene
    const noPassword = await emit(attacker, 'join-room', { roomId, nickname: 'saldirgan' });
    assert.equal(noPassword.needPassword, true);

    // 3) Yanlış parola
    const wrongPassword = await emit(attacker, 'join-room', { roomId, password: 'yanlis', nickname: 'saldirgan' });
    assert.equal(wrongPassword.needPassword, true);
});

test('odaya katılmayan soket medya olaylarını kullanamaz', async () => {
    const stranger = await connect();

    const caps = await emit(stranger, 'getRouterRtpCapabilities');
    assert.ok(caps.error, 'oda dışından RTP yetenekleri alınamamalı');

    const transport = await emit(stranger, 'createWebRtcTransport', { sender: true });
    assert.ok(transport.params.error, 'oda dışından transport açılamamalı');
});

// ==================== MEŞRU AKIŞ ====================

test('doğru token ile admin-rejoin çalışır ve moderasyon açılır', async () => {
    const creator = await connect();
    const { roomId, adminToken } = await createRoom(creator, { name: 'Meşru Oda' });

    // Ön yüzdeki gerçek akış: lobi soketi kapanır, oda sayfası yeni soketle döner
    creator.disconnect();
    openSockets.delete(creator);

    const admin = await connect();
    const rejoin = await emit(admin, 'admin-rejoin', { roomId, nickname: 'sahip', adminToken });

    assert.equal(rejoin.success, true);
    assert.equal(rejoin.roomName, 'Meşru Oda');

    const victim = await connect();
    await emit(victim, 'join-room', { roomId, nickname: 'izleyici' });

    const kick = await emit(admin, 'kick-user', { targetSocketId: victim.id });
    assert.equal(kick.success, true);
});

test('geçersiz takma ad token doğruyken bile reddedilir', async () => {
    const creator = await connect();
    const { roomId, adminToken } = await createRoom(creator);

    const admin = await connect();
    const result = await emit(admin, 'admin-rejoin', { roomId, nickname: 'ab', adminToken });

    assert.ok(result.error);
    assert.notEqual(result.success, true);
});

test('olmayan oda için admin-rejoin reddedilir', async () => {
    const socket = await connect();
    const result = await emit(socket, 'admin-rejoin', {
        roomId: 'yok-boyle-bir-oda', nickname: 'birisi', adminToken: 'a'.repeat(64)
    });
    assert.ok(result.error);
});
