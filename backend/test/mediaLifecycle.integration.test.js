process.env.ROOMS_DB_PATH = ':memory:';
process.env.MEDIASOUP_WORKERS = '1';
process.env.MAX_ROOMS_PER_IP = '100';
process.env.CREATE_ROOM_MAX = '500';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const server = require('../server');
let base, admin, viewer, roomId, room;
const clients = [];
async function connect() {
    const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
}
const emit = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, ...(payload === undefined ? [] : [payload]));
test.before(async () => {
    base = 'http://127.0.0.1:' + (await server.start({ port: 0 })).port;
    admin = await connect();
    const created = await emit(admin, 'create-room', { name: 'Medya Regresyon', maxUsers: 20 });
    roomId = created.roomId;
    await emit(admin, 'admin-rejoin', { roomId, nickname: 'yayinci', adminToken: created.adminToken });
    viewer = await connect(); await emit(viewer, 'join-room', { roomId, nickname: 'izleyici' });
    room = server.getRoomManager().getRoom(roomId);
});
test.after(async () => { clients.forEach(socket => socket.disconnect()); await server.stop(); });

test('ICE credentials require joining; viewer codec intersections persist', async () => {
    const outsider = await connect();
    assert.ok((await emit(outsider, 'get-ice-config')).error);
    assert.ok(Array.isArray((await emit(viewer, 'get-ice-config')).iceServers));
    const result = await emit(viewer, 'video-capabilities', { codecs: ['video/vp8'] });
    assert.deepEqual(result.codecs, ['video/vp8']);
    assert.deepEqual(server.getRoomManager().socketRooms.get(viewer.id).videoCodecs, ['video/vp8']);
    assert.deepEqual((await emit(admin, 'video-capabilities', { codecs: ['video/vp8', 'video/av1'] })).codecs, ['video/vp8']);
});

test('transport ownership, real score policy, auto reset, and observer cleanup', async () => {
    const send = (await emit(admin, 'createWebRtcTransport', { sender: true })).params;
    const recv = (await emit(viewer, 'createWebRtcTransport', { sender: false })).params;
    assert.ok((await emit(viewer, 'restartIce', { transportId: send.id })).error);
    assert.ok((await emit(viewer, 'close-transport', { transportId: send.id })).error);
    const codec = room.router.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === 'video/vp8');
    const produced = await emit(admin, 'transport-produce', {
        transportId: send.id, kind: 'video', appData: { source: 'screen' },
        rtpParameters: {
            codecs: [{ mimeType: codec.mimeType, payloadType: codec.preferredPayloadType, clockRate: 90000, parameters: {}, rtcpFeedback: codec.rtcpFeedback }],
            encodings: [{ ssrc: 10001, scalabilityMode: 'L1T3' }, { ssrc: 10002, scalabilityMode: 'L1T3' }], rtcp: { cname: 'media-regression' }
        }
    });
    assert.ok(produced.id, produced.error);
    const list = await emit(viewer, 'getProducers', { metadata: true });
    assert.deepEqual(list, [{ id: produced.id, kind: 'video', source: 'screen' }]);
    assert.deepEqual(await emit(viewer, 'getProducers'), [produced.id], 'legacy clients still receive IDs');
    const result = await emit(viewer, 'consume', { transportId: recv.id, producerId: produced.id, rtpCapabilities: room.router.rtpCapabilities });
    assert.ok(result.params.id, result.params.error);
    const data = room.consumers.get(result.params.id);
    assert.equal(data.autoQuality.maxSpatialLayer, 1);
    assert.ok((await emit(admin, 'resume', { consumerId: result.params.id })).error);
    assert.equal((await emit(viewer, 'resume', { consumerId: result.params.id })).success, true);
    data.consumer.emit('score', { score: 2, producerScore: 10, producerScores: [10, 10] });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(data.autoQuality.spatialLayer, 0);
    assert.equal(data.autoQuality.temporalLayer, 0);
    await emit(viewer, 'setAutoLayers', { consumerId: result.params.id });
    assert.equal(data.autoQuality.spatialLayer, 1);
    assert.equal(data.autoQuality.temporalLayer, 2);
    await emit(admin, 'close-transport', { transportId: send.id });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(room.producers.size, 0); assert.equal(room.consumers.size, 0);
    assert.equal(room.transportsById.has(send.id), false);
    assert.equal(room.isStreaming, false);
    assert.equal(server.workerManager.getStats()[0].producers, 0);
    assert.equal(server.workerManager.getStats()[0].consumers, 0);
    await emit(viewer, 'close-transport', { transportId: recv.id });
});

test('twenty transport cycles leave maps empty and unknown resume returns an ack', async () => {
    for (let i = 0; i < 20; i++) {
        const { params } = await emit(viewer, 'createWebRtcTransport', { sender: false });
        assert.ok(params.id, params.error);
        await emit(viewer, 'close-transport', { transportId: params.id });
    }
    assert.equal(room.transports.size, 0); assert.equal(room.transportsById.size, 0);
    assert.ok((await emit(viewer, 'resume', { consumerId: 'missing' })).error);
});
