#!/usr/bin/env node
/**
 * VELOSTREAM sinyalleşme yük testi
 * ================================
 *
 * README'deki "1.000+ eşzamanlı izleyici" iddiası hiçbir ölçüme dayanmıyordu.
 * Bu betik gerçek tavanı bulmak için sanal izleyiciler açar ve her birine
 * izleyici el sıkışmasının TAMAMINI yaptırır:
 *
 *     join-room → getRouterRtpCapabilities → createWebRtcTransport
 *              → getProducers → consume (her producer için)
 *
 * DTLS bağlanmaz ve medya çözülmez; ölçülen şey sinyalleşme yolu ve
 * mediasoup consumer tahsisi — yani odanın gerçekte tıkandığı yer. Bir
 * worker'ın taşıyabildiği consumer sayısı, oda başına izleyici tavanını
 * belirler (bkz. Ö-2: her oda tek router, yani tek çekirdek).
 *
 * Kullanım:
 *   1) Tarayıcıdan bir oda açın ve yayını başlatın (video producer olmalı).
 *   2) Oda kimliğini URL'den kopyalayın.
 *   3) node backend/loadtest/signaling-load.js
 *
 * Ortam değişkenleri:
 *   URL       Sinyalleşme sunucusu       (varsayılan http://localhost:3000)
 *   ROOM_ID   Hedef oda kimliği          (zorunlu)
 *   PASSWORD  Oda parolası               (varsa)
 *   VIEWERS   Sanal izleyici sayısı      (varsayılan 200)
 *   RAMP_MS   Kaç ms'de rampalanacak     (varsayılan 30000)
 *   HOLD_MS   Hedefe ulaşınca bekleme    (varsayılan 30000)
 *
 * Sunucu tarafını eş zamanlı izleyin:
 *   watch -n2 'curl -s localhost:3000/metrics | grep velostream_worker'
 */

const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const ROOM_ID = process.env.ROOM_ID;
const PASSWORD = process.env.PASSWORD || null;
const VIEWERS = parseInt(process.env.VIEWERS || '200', 10);
const RAMP_MS = parseInt(process.env.RAMP_MS || '30000', 10);
const HOLD_MS = parseInt(process.env.HOLD_MS || '30000', 10);

if (!ROOM_ID) {
    console.error('ROOM_ID gerekli. Örnek:');
    console.error('  ROOM_ID=<oda-kimliği> VIEWERS=500 node backend/loadtest/signaling-load.js');
    process.exit(1);
}

const sockets = [];
const latencies = [];
const errors = new Map();
let joined = 0;
let consumed = 0;

function recordError(stage, message) {
    const key = `${stage}: ${message}`;
    errors.set(key, (errors.get(key) || 0) + 1);
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function emit(socket, event, payload) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: 'zaman aşımı (10 sn)' }), 10000);
        const done = (result) => { clearTimeout(timer); resolve(result); };
        if (payload === undefined) socket.emit(event, done);
        else socket.emit(event, payload, done);
    });
}

async function spawnViewer(index) {
    const started = Date.now();
    const socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);

    const connected = await new Promise((resolve) => {
        socket.once('connect', () => resolve(true));
        socket.once('connect_error', (e) => { recordError('connect', e.message); resolve(false); });
        setTimeout(() => resolve(false), 15000);
    });
    if (!connected) return;

    const join = await emit(socket, 'join-room', {
        roomId: ROOM_ID,
        password: PASSWORD,
        nickname: `yuk_${index}_${Math.random().toString(36).slice(2, 7)}`
    });
    if (join?.error) { recordError('join-room', join.error); return; }
    joined++;

    const caps = await emit(socket, 'getRouterRtpCapabilities');
    if (!caps || caps.error) { recordError('rtpCapabilities', caps?.error || 'boş yanıt'); return; }

    const transport = await emit(socket, 'createWebRtcTransport', { sender: false });
    if (!transport?.params || transport.params.error) {
        recordError('createWebRtcTransport', transport?.params?.error || 'boş yanıt');
        return;
    }

    const producerIds = await emit(socket, 'getProducers');
    if (!Array.isArray(producerIds) || !producerIds.length) {
        recordError('getProducers', 'yayın yok — önce yayını başlatın');
        return;
    }

    for (const producerId of producerIds) {
        // Router'ın kendi yetenekleri geçerli bir üst küme; canConsume geçer.
        const result = await emit(socket, 'consume', {
            transportId: transport.params.id,
            producerId,
            rtpCapabilities: caps
        });
        if (result?.params?.error) { recordError('consume', result.params.error); continue; }
        socket.emit('resume', { consumerId: result.params.id });
        consumed++;
    }

    latencies.push(Date.now() - started);
}

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report() {
    console.log('\n──────── SONUÇ ────────');
    console.log(`Hedef izleyici     : ${VIEWERS}`);
    console.log(`Odaya giren        : ${joined}`);
    console.log(`Açılan consumer    : ${consumed}`);
    console.log(`El sıkışma p50     : ${percentile(latencies, 50)} ms`);
    console.log(`El sıkışma p95     : ${percentile(latencies, 95)} ms`);
    console.log(`El sıkışma p99     : ${percentile(latencies, 99)} ms`);
    console.log(`En yavaş           : ${latencies.length ? Math.max(...latencies) : 0} ms`);

    if (errors.size) {
        console.log('\nHatalar:');
        for (const [key, count] of [...errors].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(count).padStart(5)} × ${key}`);
        }
    } else {
        console.log('\nHata yok.');
    }
    console.log('\nSunucu tarafı için: curl -s ' + URL + '/metrics | grep velostream_');
}

async function main() {
    console.log(`${VIEWERS} izleyici ${RAMP_MS / 1000} sn'de rampalanıyor → ${URL} / oda ${ROOM_ID}`);
    const gap = VIEWERS > 1 ? RAMP_MS / VIEWERS : 0;

    const pending = [];
    for (let i = 0; i < VIEWERS; i++) {
        pending.push(spawnViewer(i));
        if (gap) await wait(gap);
        if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${VIEWERS} başlatıldı (giren: ${joined})`);
    }

    await Promise.all(pending);
    console.log(`\nHedefe ulaşıldı, ${HOLD_MS / 1000} sn tutuluyor...`);
    await wait(HOLD_MS);

    report();
    sockets.forEach(s => s.disconnect());
    process.exit(0);
}

process.on('SIGINT', () => { report(); process.exit(0); });

main().catch((error) => { console.error(error); report(); process.exit(1); });
