const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../metrics');

function fakeDeps({ rooms = [], workers = [], sockets = 0 } = {}) {
    const roomMap = new Map(rooms.map((r, i) => [`oda-${i}`, { isStreaming: r.streaming }]));
    return {
        io: { sockets: { sockets: { size: sockets } } },
        workerManager: { getStats: () => workers },
        roomManager: {
            rooms: roomMap,
            getRoomUserCount: (roomId) => rooms[Number(roomId.split('-')[1])].users
        }
    };
}

test('boş sunucuda geçerli çıktı üretir', () => {
    const output = metrics.render({ workerManager: null, roomManager: null, io: null });

    assert.match(output, /^velostream_up 1$/m);
    assert.match(output, /^velostream_rooms 0$/m);
    assert.match(output, /^velostream_users 0$/m);
    assert.ok(output.endsWith('\n'), 'Prometheus formatı sonda yeni satır ister');
});

test('oda ve kullanıcı toplamlarını doğru sayar', () => {
    const output = metrics.render(fakeDeps({
        rooms: [{ users: 3, streaming: true }, { users: 7, streaming: false }],
        sockets: 12
    }));

    assert.match(output, /^velostream_rooms 2$/m);
    assert.match(output, /^velostream_rooms_streaming 1$/m);
    assert.match(output, /^velostream_users 10$/m);
    assert.match(output, /^velostream_largest_room_users 7$/m);
    assert.match(output, /^velostream_socket_connections 12$/m);
});

test('worker kırılımı etiketlenerek verilir', () => {
    const output = metrics.render(fakeDeps({
        workers: [
            { index: 0, pid: 1, consumers: 40, producers: 2, rooms: 1 },
            { index: 1, pid: 2, consumers: 5, producers: 1, rooms: 3 }
        ]
    }));

    assert.match(output, /^velostream_worker_consumers\{worker="0"\} 40$/m);
    assert.match(output, /^velostream_worker_consumers\{worker="1"\} 5$/m);
    assert.match(output, /^velostream_worker_rooms\{worker="1"\} 3$/m);
    assert.match(output, /^velostream_workers_alive 2$/m);
});

test('oda kimliği etiket olarak kullanılmaz', () => {
    // Kardinalite patlamasını önlemek için bilinçli bir karar
    const output = metrics.render(fakeDeps({ rooms: [{ users: 1, streaming: false }] }));
    assert.equal(output.includes('oda-0'), false);
});

test('METRICS_TOKEN tanımlıysa token zorunlu', () => {
    const opts = { token: 'gizli', ip: '203.0.113.5' };

    assert.equal(metrics.isAuthorized({ headers: {}, query: {} }, opts), false);
    assert.equal(metrics.isAuthorized({ headers: {}, query: { token: 'yanlis' } }, opts), false);
    assert.equal(metrics.isAuthorized({ headers: {}, query: { token: 'gizli' } }, opts), true);
    assert.equal(metrics.isAuthorized({ headers: { authorization: 'Bearer gizli' }, query: {} }, opts), true);
});

test('token yoksa yalnızca özel ağdan erişilir', () => {
    const req = { headers: {}, query: {} };

    assert.equal(metrics.isAuthorized(req, { token: '', ip: '127.0.0.1' }), true);
    assert.equal(metrics.isAuthorized(req, { token: '', ip: '10.1.2.3' }), true);
    assert.equal(metrics.isAuthorized(req, { token: '', ip: '172.16.0.9' }), true);
    assert.equal(metrics.isAuthorized(req, { token: '', ip: '192.168.1.4' }), true);

    assert.equal(metrics.isAuthorized(req, { token: '', ip: '203.0.113.5' }), false);
    assert.equal(metrics.isAuthorized(req, { token: '', ip: '172.32.0.1' }), false, '172.32 özel aralık değil');
    assert.equal(metrics.isAuthorized(req, { token: '', ip: '' }), false);
});
