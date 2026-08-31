/**
 * Oda oluşturma DoS yüzeyinin gerçekten kapandığını soket katmanında doğrular.
 * Ayrı bir dosya çünkü limitler modül yükleme anında ortamdan okunuyor.
 */

process.env.ROOMS_DB_PATH = ':memory:';
process.env.MEDIASOUP_WORKERS = '1';
process.env.CREATE_ROOM_MAX = '3';
process.env.MAX_ROOMS_PER_IP = '2';

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
    return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('tek istemci sunucunun oda kotasını dolduramaz', async () => {
    const attacker = await connect();

    // MAX_ROOMS_PER_IP = 2
    assert.equal((await emit(attacker, 'create-room', { name: 'Spam 1' })).success, true);
    assert.equal((await emit(attacker, 'create-room', { name: 'Spam 2' })).success, true);

    const third = await emit(attacker, 'create-room', { name: 'Spam 3' });
    assert.match(third.error, /en fazla 2 oda/, 'eşzamanlı oda limiti uygulanmalı');
});

test('oda oluşturma hızı sınırlanır', async () => {
    const attacker = await connect();
    // Önceki test zaten 3 hak tüketti (CREATE_ROOM_MAX = 3, anahtar IP)
    const next = await emit(attacker, 'create-room', { name: 'Spam 4' });

    assert.match(next.error, /Çok sık oda açıyorsunuz/);
    assert.match(next.error, /\d+ saniye/, 'ne zaman tekrar deneneceği söylenmeli');
});

test('yeni soket açmak hız sınırını sıfırlamaz', async () => {
    // Limit IP'ye bağlı, sokete değil: yeniden bağlanmak kotayı tazelemez.
    const fresh = await connect();
    const result = await emit(fresh, 'create-room', { name: 'Yeni Soket' });
    assert.match(result.error, /Çok sık oda açıyorsunuz/);
});
