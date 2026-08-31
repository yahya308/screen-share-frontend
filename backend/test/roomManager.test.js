process.env.ROOMS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const RoomManager = require('../RoomManager');
const database = require('../database');

/** Mediasoup'a hiç dokunmadan RoomManager'ı sürebilmek için sahte worker havuzu. */
function createStubWorkerManager() {
    const calls = { producers: 0, consumers: 0, removedRouters: [] };
    return {
        calls,
        getLeastLoadedWorker: () => ({ index: 0, worker: { pid: 1 } }),
        createRouter: async () => ({ closed: false, close() { this.closed = true; }, rtpCapabilities: {} }),
        removeRouter: (index, roomId) => calls.removedRouters.push(roomId),
        incrementProducers: () => { calls.producers++; },
        decrementProducers: () => { calls.producers--; },
        incrementConsumers: () => { calls.consumers++; },
        decrementConsumers: () => { calls.consumers--; }
    };
}

function freshManager() {
    database.clearAllRooms();
    return new RoomManager(createStubWorkerManager());
}

const ADMIN = 'socket-admin';

// ==================== ADMIN TOKEN ====================

test('createRoom yalnızca kurucuya bir adminToken döner', async () => {
    const rm = freshManager();
    const room = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN, maxUsers: 10 });

    assert.ok(room.roomId, 'oda kimliği üretilmeli');
    assert.match(room.adminToken, /^[0-9a-f]{64}$/);
});

test('verifyAdminToken yalnızca doğru token için geçer', async () => {
    const rm = freshManager();
    const { roomId, adminToken } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });

    assert.equal(rm.verifyAdminToken(roomId, adminToken), true);
    assert.equal(rm.verifyAdminToken(roomId, 'f'.repeat(64)), false);
    assert.equal(rm.verifyAdminToken(roomId, ''), false);
    assert.equal(rm.verifyAdminToken(roomId, undefined), false);
    assert.equal(rm.verifyAdminToken('olmayan-oda', adminToken), false);
});

test('adminToken oda listesine sızmaz', async () => {
    const rm = freshManager();
    const { adminToken } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });

    const serialized = JSON.stringify(rm.getAllRooms());
    assert.equal(serialized.includes(adminToken), false, 'token lobide görünmemeli');
    assert.equal(serialized.includes('password_hash'), false, 'parola özeti de sızmamalı');
});

test('her odanın token\'ı bağımsızdır', async () => {
    const rm = freshManager();
    const a = await rm.createRoom({ name: 'Oda A', adminSocketId: 'a' });
    const b = await rm.createRoom({ name: 'Oda B', adminSocketId: 'b' });

    assert.notEqual(a.adminToken, b.adminToken);
    assert.equal(rm.verifyAdminToken(a.roomId, b.adminToken), false);
});

test('getConnectedAdminSocketId bağlı yöneticiyi bulur', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });

    assert.equal(rm.getConnectedAdminSocketId(roomId), ADMIN);
    rm.leaveRoom(ADMIN);
    assert.equal(rm.getConnectedAdminSocketId(roomId), null);
});

// ==================== DOĞRULAMA ====================

test('oda adı sınırları uygulanır', async () => {
    const rm = freshManager();
    assert.match((await rm.createRoom({ name: 'ab', adminSocketId: ADMIN })).error, /3-50/);
    assert.match((await rm.createRoom({ name: 'x'.repeat(51), adminSocketId: ADMIN })).error, /3-50/);
});

test('maksimum kullanıcı sınırları uygulanır', async () => {
    const rm = freshManager();
    assert.match((await rm.createRoom({ name: 'Oda', adminSocketId: ADMIN, maxUsers: 1 })).error, /2-1000/);
    assert.match((await rm.createRoom({ name: 'Oda', adminSocketId: ADMIN, maxUsers: 1001 })).error, /2-1000/);
});

test('validateNickname kuralları', () => {
    assert.equal(RoomManager.validateNickname('yahya'), null);
    assert.equal(RoomManager.validateNickname('kullanıcı_1'), null);
    assert.ok(RoomManager.validateNickname('ab'));
    assert.ok(RoomManager.validateNickname('x'.repeat(31)));
    assert.ok(RoomManager.validateNickname('iki kelime'), 'boşluk reddedilmeli');
    assert.ok(RoomManager.validateNickname('12345'), 'yalnız rakam reddedilmeli');
    assert.ok(RoomManager.validateNickname('<script>'), 'işaretleme reddedilmeli');
    assert.ok(RoomManager.validateNickname(''));
    assert.ok(RoomManager.validateNickname(null));
});

test('takma ad oda içinde benzersizdir (büyük/küçük harf duyarsız)', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });
    rm.setNickname(ADMIN, 'Yahya');

    await rm.joinRoom(roomId, 'viewer-1', null, '1.1.1.1');
    const result = rm.setNickname('viewer-1', 'yahya');

    assert.match(result.error, /zaten kullanılıyor/);
});

// ==================== KATILIM ====================

test('parolalı odaya parolasız girilemez', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Gizli Oda', password: 'sifre123', adminSocketId: ADMIN });

    const noPassword = await rm.joinRoom(roomId, 'v1', null, '1.1.1.1');
    assert.equal(noPassword.needPassword, true);

    const wrongPassword = await rm.joinRoom(roomId, 'v1', 'yanlis', '1.1.1.1');
    assert.equal(wrongPassword.needPassword, true);

    const correct = await rm.joinRoom(roomId, 'v1', 'sifre123', '1.1.1.1');
    assert.equal(correct.success, true);
});

test('dolu odaya girilemez', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Küçük Oda', adminSocketId: ADMIN, maxUsers: 2 });

    assert.equal((await rm.joinRoom(roomId, 'v1', null, '1.1.1.1')).success, true);
    assert.match((await rm.joinRoom(roomId, 'v2', null, '2.2.2.2')).error, /dolu/);
});

test('banlanan IP geri giremez', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });

    await rm.joinRoom(roomId, 'v1', null, '9.9.9.9');
    rm.banIp(roomId, '9.9.9.9');
    rm.leaveRoom('v1');

    const result = await rm.joinRoom(roomId, 'v2', null, '9.9.9.9');
    assert.equal(result.banned, true);
});

test('yönetici ayrılınca oda hemen kapanmaz, beklemeye alınır', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });

    const result = rm.leaveRoom(ADMIN);
    assert.equal(result.roomPending, true);
    assert.equal(result.roomId, roomId);
    assert.ok(rm.rooms.has(roomId), 'oda hâlâ ayakta olmalı');
});

test('kullanıcı sayısı katılım ve ayrılışla tutarlı', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN, maxUsers: 50 });
    assert.equal(rm.getRoomUserCount(roomId), 1);

    await rm.joinRoom(roomId, 'v1', null, '1.1.1.1');
    await rm.joinRoom(roomId, 'v2', null, '2.2.2.2');
    assert.equal(rm.getRoomUserCount(roomId), 3);

    rm.leaveRoom('v1');
    assert.equal(rm.getRoomUserCount(roomId), 2);
});

test('closeRoom tüm izleri temizler', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Test Odası', adminSocketId: ADMIN });
    await rm.joinRoom(roomId, 'v1', null, '1.1.1.1');
    rm.banIp(roomId, '5.5.5.5');

    rm.closeRoom(roomId);

    assert.equal(rm.rooms.has(roomId), false);
    assert.equal(rm.roomUsers.has(roomId), false);
    assert.equal(rm.bannedIps.has(roomId), false);
    assert.equal(rm.socketRooms.has('v1'), false);
    assert.equal(database.getRoom(roomId), undefined);
});

test('sohbet hız sınırı 5 saniyede 10 mesajda durur', () => {
    const rm = freshManager();
    for (let i = 0; i < 10; i++) {
        assert.equal(rm.checkChatRateLimit('s1'), true, `${i + 1}. mesaj geçmeliydi`);
    }
    assert.equal(rm.checkChatRateLimit('s1'), false, '11. mesaj engellenmeli');
    assert.equal(rm.checkChatRateLimit('s2'), true, 'başka soket etkilenmemeli');
});

// ==================== IP BAŞINA ODA LİMİTİ ====================

test('aynı IP sınırsız oda açamaz', async () => {
    const rm = freshManager();
    const ip = '198.51.100.4';

    for (let i = 0; i < 3; i++) {
        const room = await rm.createRoom({ name: `Oda ${i}`, adminSocketId: `a${i}`, creatorIp: ip });
        assert.ok(room.roomId, `${i}. oda açılmalıydı`);
    }

    const blocked = await rm.createRoom({ name: 'Dördüncü', adminSocketId: 'a4', creatorIp: ip });
    assert.match(blocked.error, /en fazla 3 oda/);
});

test('oda limiti IP başına ayrışır', async () => {
    const rm = freshManager();
    for (let i = 0; i < 3; i++) {
        await rm.createRoom({ name: `Oda ${i}`, adminSocketId: `a${i}`, creatorIp: '1.1.1.1' });
    }

    const other = await rm.createRoom({ name: 'Başka IP', adminSocketId: 'b1', creatorIp: '2.2.2.2' });
    assert.ok(other.roomId, 'farklı IP etkilenmemeli');
});

test('oda kapanınca IP kotası geri gelir', async () => {
    const rm = freshManager();
    const ip = '198.51.100.5';
    const ids = [];
    for (let i = 0; i < 3; i++) {
        const room = await rm.createRoom({ name: `Oda ${i}`, adminSocketId: `a${i}`, creatorIp: ip });
        ids.push(room.roomId);
    }
    assert.equal(rm.countRoomsByIp(ip), 3);

    rm.closeRoom(ids[0]);

    const again = await rm.createRoom({ name: 'Yeniden', adminSocketId: 'a9', creatorIp: ip });
    assert.ok(again.roomId);
});

test('parola doğrulaması asenkron ve doğru sonuç verir', async () => {
    const rm = freshManager();
    const { roomId } = await rm.createRoom({ name: 'Parolalı', password: 'dogruparola', adminSocketId: ADMIN });

    assert.equal((await rm.joinRoom(roomId, 'v1', 'yanlisparola', '1.1.1.1')).needPassword, true);
    assert.equal((await rm.joinRoom(roomId, 'v1', 'dogruparola', '1.1.1.1')).success, true);
});
