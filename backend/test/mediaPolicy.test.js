const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildIceConfig } = require('../iceConfig');
let policy;
test.before(async () => { policy = await import('../../public/media-policy.mjs'); });

test('bitrate budget stays in bps and the two layers share the total', () => {
    const settings = policy.screenSettings('1080', '60', '5000');
    assert.equal(settings.bitrateBps, 5000000);
    const layers = policy.screenEncodings(settings, 'video/VP8');
    assert.equal(layers.length, 2);
    assert.equal(layers.reduce((sum, e) => sum + e.maxBitrate, 0), 5000000);
    assert.equal(layers[0].scaleResolutionDownBy, 3);
    assert.equal(policy.screenEncodings(settings, 'video/VP8', false).length, 1);
    assert.equal(policy.screenEncodings(settings, 'video/H264')[0].scalabilityMode, undefined);
    for (const value of ['NaN', 'Infinity', 0, -1, 20001]) assert.throws(() => policy.screenSettings(720, 30, value));
    assert.throws(() => policy.screenSettings(720, 120, 5000));
});

test('a single consumer encoding can represent multiple spatial layers', () => {
    const encodings = [{ scalabilityMode: 'L2T3' }];
    assert.deepEqual(policy.preferredLayers(encodings, 'high'), { spatialLayer: 1, temporalLayer: 2 });
    assert.deepEqual(policy.preferredLayers(encodings, 'low'), { spatialLayer: 0, temporalLayer: 2 });
    assert.deepEqual(policy.preferredLayers([{ scalabilityMode: 'L1T3' }], 'low'), { spatialLayer: 0, temporalLayer: 0 });
});

test('film and interactive buffers have bounded budgets', () => {
    assert.equal(policy.playoutTarget('motion'), 400);
    assert.equal(policy.playoutTarget('detail'), 150);
    assert.equal(policy.playoutTarget('interactive'), 100);
    assert.equal(policy.playoutTarget('motion', { rttMs: 900, jitterMs: 200, lossPct: 10 }), 800);
    assert.equal(policy.playoutTarget('interactive', { rttMs: 900 }), 200);
});

test('manual pause silences stream audio but preserves speech', () => {
    const state = { muted: false, paused: true, master: 0.8, speech: 0.5 };
    assert.equal(policy.audioLevel('admin-sys-audio', state), 0);
    assert.equal(policy.audioLevel('viewer-mic', state), 0.4);
    assert.equal(policy.audioLevel('admin-mic', { ...state, muted: true }), 0);
});

test('stats use per-report deltas, sum voices, and tolerate SSRC replacement', () => {
    const sampler = new policy.RtcSampler();
    const rows = t => new Map([
        ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: t, bytesReceived: t * 100, packetsReceived: t / 10, packetsLost: t / 100, freezeCount: t / 1000, totalFreezesDuration: t / 2000, jitterBufferDelay: t / 5, jitterBufferEmittedCount: t, framesDecoded: t / 10, totalDecodeTime: t / 1000 }],
        ['a1', { id: 'a1', type: 'inbound-rtp', kind: 'audio', timestamp: t, bytesReceived: t * 4 }],
        ['a2', { id: 'a2', type: 'inbound-rtp', kind: 'audio', timestamp: t, bytesReceived: t * 8 }]
    ]);
    assert.equal(sampler.sample(rows(1000)).videoKbps, null);
    const measured = sampler.sample(rows(2000));
    assert.equal(measured.videoKbps, 800);
    assert.equal(measured.audioKbps, 96);
    assert.equal(measured.lossPct, 100 * 10 / 110);
    assert.equal(measured.bufferMs, 200);
    assert.equal(measured.freezes, 1);
    assert.equal(measured.processingMs, 10);
    const replaced = new Map([['new', { id: 'new', type: 'inbound-rtp', kind: 'video', timestamp: 3000, bytesReceived: 200 }]]);
    assert.equal(sampler.sample(replaced).videoKbps, null);
});

test('sender loss and jitter come from receiver feedback and relay is detected', () => {
    const sampler = new policy.RtcSampler();
    const rows = t => new Map([
        ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: t, bytesSent: t * 100, packetsSent: t / 10, remoteId: 'feedback', codecId: 'codec' }],
        ['feedback', { id: 'feedback', type: 'remote-inbound-rtp', localId: 'out', timestamp: t, packetsLost: t / 100, jitter: 0.012 }],
        ['codec', { id: 'codec', type: 'codec', mimeType: 'video/VP8' }],
        ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', currentRoundTripTime: 0.1 }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' }]
    ]);
    sampler.sample(rows(1000), true);
    const measured = sampler.sample(rows(2000), true);
    assert.equal(measured.lossPct, 10); assert.equal(measured.jitterMs, 12);
    assert.equal(measured.route, 'TURN'); assert.equal(measured.codec, 'video/VP8');
    const withoutFeedback = rows(3000); withoutFeedback.delete('feedback');
    assert.equal(sampler.sample(withoutFeedback, true).lossPct, null);
});

test('TURN behind the SFU NAT can report a peer-reflexive local candidate', () => {
    const measured = new policy.RtcSampler().sample(new Map([
        ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local' }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'prflx', relayProtocol: 'tls', url: 'turns:turn.example.test:49998?transport=tcp', protocol: 'udp' }]
    ]));
    assert.equal(measured.route, 'TURN');
    assert.equal(measured.relayProtocol, 'tls');
});

test('TURN credentials are short lived, unique and HMAC authenticated', () => {
    const env = { TURN_HOST: 'turn.example.test', TURN_SECRET: 'test-only', TURN_PORT: '49999', TURN_TLS_PORT: '49998', TURN_TTL_SECONDS: '900' };
    const ice = buildIceConfig(env, 1000000), config = ice.iceServers[0];
    assert.equal(config.username.split(':')[0], '1900');
    assert.equal(ice.expiresAt, 1900000);
    assert.equal(config.credential, crypto.createHmac('sha1', env.TURN_SECRET).update(config.username).digest('base64'));
    assert.notEqual(config.username, buildIceConfig(env, 1000000).iceServers[0].username);
    assert.ok(config.urls.includes('turns:turn.example.test:49998?transport=tcp'));
    assert.deepEqual(buildIceConfig({}, 1000).iceServers, []);
});
