#!/usr/bin/env node
/**
 * Mikrofon gürültü engelleme — gerçek Chromium, üretim CSP'si.
 *
 * Birim testleri kip seçimini doğrular ama modelin tarayıcıda gerçekten
 * çalıştığını göstermez. Bu betik şunları yakalar:
 *   - CSP WebAssembly derlemesini engelliyor mu ('wasm-unsafe-eval'),
 *   - worklet AudioWorkletGlobalScope'ta yükleniyor mu (orada URL bile yok),
 *   - model gürültüyü gerçekten bastırıyor mu ve konuşmayı koruyor mu,
 *   - model yüklenemezse kurulum asılı kalmadan reddediliyor mu.
 *
 * Konuşma yerine formant sentezi kullanılır (ses teli darbeleri + ünlü
 * formantları + "s" sürtünmesi + kelime araları): depoya ses kaydı eklemeden
 * modelin konuşma gibi tanıdığı bir sinyal. Gürültü: pembe gürültü (fan) ve
 * klavye tıkırtısı, 5 dB SNR.
 *
 * Kullanım: npm run build && node scripts/test-noise-suppression.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    console.error('Playwright kurulu değil: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
}
const { FRONTEND_SECURITY_HEADERS } = require('../backend/securityHeaders');

const publicDir = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${name}${detail ? ' — ' + detail : ''}`);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const [key, value] of Object.entries(FRONTEND_SECURITY_HEADERS)) res.setHeader(key, value);
    if (url.pathname === '/__noise-test.html') {
        res.setHeader('Content-Type', TYPES['.html']);
        res.end('<!doctype html><meta charset="utf-8"><title>Gürültü engelleme testi</title>');
        return;
    }
    const file = path.join(publicDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404;
        res.end();
        return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});

/** Sayfada çalışır: sinyali üret, işlemciden gerçek zamanlı geçir, ölç. */
async function measure() {
    const mic = await import('/mic-processing.mjs');
    const SR = 48000;
    const out = { available: mic.aiNoiseSuppressionAvailable() };
    if (!out.available) return out;

    // ---------- Sinyal ----------
    let seed = 12345;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const seconds = 8, N = SR * seconds;
    const speech = new Float32Array(N);
    const speechMask = new Uint8Array(N);
    const vowels = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];
    // İki kutuplu rezonatör (formant).
    const resonate = (x, f, bw) => {
        const r = Math.exp(-Math.PI * bw / SR), c = 2 * r * Math.cos(2 * Math.PI * f / SR), g = 1 - r;
        const y = new Float32Array(x.length);
        for (let i = 2; i < x.length; i++) y[i] = g * x[i] + c * y[i - 1] - r * r * y[i - 2];
        return y;
    };
    let t = Math.round(0.8 * SR), phase = 0, word = 0;
    while (t < N - SR) {
        const syllables = 2 + Math.floor(rand() * 3);
        for (let s = 0; s < syllables; s++) {
            const len = Math.round((0.16 + rand() * 0.08) * SR);
            const v = vowels[(word * 3 + s) % vowels.length];
            const f0 = 115 + rand() * 60;
            const source = new Float32Array(len);
            let prev = 0;
            for (let i = 0; i < len; i++) {
                phase += (f0 * (1 + 0.08 * Math.sin(2 * Math.PI * i / len))) / SR;
                const pulse = phase >= 1 ? 1 : 0;
                if (phase >= 1) phase -= 1;
                prev = 0.96 * prev + pulse; // spektral eğim
                source[i] = prev;
            }
            const voiced = new Float32Array(len);
            v.forEach((f, k) => { const y = resonate(source, f, 80 + 40 * k); for (let i = 0; i < len; i++) voiced[i] += y[i] / (k + 1); });
            for (let i = 0; i < len; i++) {
                const env = Math.sin(Math.PI * i / len) ** 0.6;
                speech[t + i] += voiced[i] * env;
                speechMask[t + i] = 1;
            }
            t += len;
            if (rand() < 0.4) { // "s" sürtünmesi
                const flen = Math.round(0.07 * SR);
                const noise = new Float32Array(flen);
                for (let i = 0; i < flen; i++) noise[i] = gauss();
                const hiss = resonate(resonate(noise, 6000, 2500), 7000, 3000);
                for (let i = 0; i < flen; i++) { speech[t + i] += hiss[i] * 0.25 * Math.sin(Math.PI * i / flen); speechMask[t + i] = 1; }
                t += flen;
            }
            t += Math.round(0.04 * SR);
        }
        t += Math.round((0.45 + rand() * 0.3) * SR);
        word++;
    }
    const rms = (x, mask, want = 1) => { let e = 0, n = 0; for (let i = 0; i < x.length; i++) if (!mask || mask[i] === want) { e += x[i] * x[i]; n++; } return Math.sqrt(e / Math.max(1, n)); };
    const sRms = rms(speech, speechMask);
    for (let i = 0; i < N; i++) speech[i] *= 0.1 / sRms;

    // Pembe gürültü (Voss-McCartney yaklaşımı) + klavye tıkırtıları.
    const noise = new Float32Array(N);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < N; i++) {
        const w = gauss();
        b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
        noise[i] = b0 + b1 + b2 + w * 0.1848;
    }
    const clicks = new Float32Array(N);
    for (let c = Math.round(0.3 * SR); c < N - SR / 10; c += Math.round((0.08 + rand() * 0.2) * SR)) {
        const len = Math.round(0.02 * SR);
        for (let i = 0; i < len; i++) clicks[c + i] += gauss() * Math.exp(-i / (0.004 * SR)) * (0.6 + 0.4 * rand());
    }
    const nRms = rms(noise), cRms = rms(clicks);
    const snr = 10 ** (5 / 20);
    const mix = new Float32Array(N);
    for (let i = 0; i < N; i++) mix[i] = speech[i] + (noise[i] / nRms * 0.7 + clicks[i] / cRms * 0.7) * 0.1 / snr;

    // ---------- Gerçek zamanlı işleme ----------
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    const buffer = ctx.createBuffer(1, N, SR);
    buffer.copyToChannel(mix, 0);
    const player = ctx.createBufferSource();
    player.buffer = buffer;
    const feed = ctx.createMediaStreamDestination();
    player.connect(feed);
    const rawTrack = feed.stream.getAudioTracks()[0];

    const startedAt = performance.now();
    let failures = 0;
    const ns = await mic.createNoiseSuppressor(rawTrack, { onFailure: () => failures++ });
    out.setupMs = Math.round(performance.now() - startedAt);
    out.contextState = ns.context.state;
    out.trackState = ns.track.readyState;

    // Karşılaştırma kanalı: ham iz, işlemcisiz ama aynı türde bir bağlam
    // geçişinden (AudioContext → iz) geçer. İki kanal aynı kaydedicide:
    // kaydedici tamponu, başlama anı ve bağlam geçişi ikisinde ortak,
    // aradaki fark yalnızca worklet tamponu + model gecikmesi.
    const hopCtx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
    await hopCtx.resume();
    const hop = hopCtx.createMediaStreamDestination();
    hopCtx.createMediaStreamSource(new MediaStream([rawTrack])).connect(hop);
    const recordedRaw = new Float32Array(N + SR), recorded = new Float32Array(N + SR);
    let written = 0;
    const merger = ctx.createChannelMerger(2);
    ctx.createMediaStreamSource(hop.stream).connect(merger, 0, 0);
    ctx.createMediaStreamSource(new MediaStream([ns.track])).connect(merger, 0, 1);
    const recorder = ctx.createScriptProcessor(4096, 2, 2);
    recorder.onaudioprocess = (e) => {
        const raw = e.inputBuffer.getChannelData(0), processed = e.inputBuffer.getChannelData(1);
        const n = Math.min(raw.length, recorded.length - written);
        if (n > 0) { recordedRaw.set(raw.subarray(0, n), written); recorded.set(processed.subarray(0, n), written); }
        written += n;
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    merger.connect(recorder);
    recorder.connect(mute);
    mute.connect(ctx.destination);
    player.start();
    await new Promise(r => setTimeout(r, (seconds + 0.8) * 1000));
    out.failures = failures;

    // ---------- Ölçüm ----------
    // 10 ms'lik enerji zarflarıyla çıktıyı temiz konuşmaya hizala.
    const F = 480, frames = Math.floor(N / F);
    const env = (x, offset = 0) => {
        const e = new Float64Array(frames);
        for (let f = 0; f < frames; f++) { let s = 0; for (let i = 0; i < F; i++) { const v = x[offset + f * F + i] || 0; s += v * v; } e[f] = s / F; }
        return e;
    };
    const cleanEnv = env(speech), mixEnv = env(mix);
    const logEnv = e => Array.from(e, v => Math.log10(v + 1e-10));
    const cleanLog = logEnv(cleanEnv);
    const centered = (values) => { const mean = values.reduce((a, b) => a + b, 0) / values.length; return values.map(v => v - mean); };
    const cleanCentered = centered(cleanLog);
    let bestLag = 0, best = -Infinity;
    for (let lag = 0; lag < SR / F; lag++) { // 0..1 s
        const o = centered(logEnv(env(recorded, lag * F)));
        let c = 0;
        for (let f = 0; f < frames; f++) c += o[f] * cleanCentered[f];
        if (c > best) { best = c; bestLag = lag; }
    }
    const outEnv = env(recorded, bestLag * F);
    // İşlemci gecikmesi: işlenmiş kanalın karşılaştırma kanalına göre kayması.
    const segStart = Math.round(1.5 * SR), segLen = 4 * SR, maxLag = Math.round(0.2 * SR);
    let latencyLag = 0, latencyBest = -Infinity;
    for (let lag = 0; lag < maxLag; lag += 8) {
        let c = 0;
        for (let i = 0; i < segLen; i += 4) c += recordedRaw[segStart + i] * recorded[segStart + i + lag];
        if (c > latencyBest) { latencyBest = c; latencyLag = lag; }
    }
    out.latencyMs = Math.round(latencyLag / SR * 1000);
    await hopCtx.close();

    // Çerçeve sınıfları: geçişlerden 3 çerçeve uzak konuşma/sessizlik.
    const frameSpeech = new Uint8Array(frames);
    for (let f = 0; f < frames; f++) { let any = 0; for (let i = 0; i < F; i++) any |= speechMask[f * F + i]; frameSpeech[f] = any; }
    const near = (f, v) => { for (let d = -3; d <= 3; d++) { const k = f + d; if (k >= 0 && k < frames && frameSpeech[k] !== v) return true; } return false; };
    let inNoise = 0, outNoise = 0, cleanSpeech = 0, outSpeech = 0, nN = 0, nS = 0;
    for (let f = 100; f < frames - 10; f++) { // ilk saniye: modelin ısınması
        if (frameSpeech[f] === 0 && !near(f, 0)) { inNoise += mixEnv[f]; outNoise += outEnv[f]; nN++; }
        if (frameSpeech[f] === 1 && !near(f, 1)) { cleanSpeech += cleanEnv[f]; outSpeech += outEnv[f]; nS++; }
    }
    out.noiseFrames = nN;
    out.speechFrames = nS;
    out.noiseReductionDb = 10 * Math.log10(inNoise / Math.max(outNoise, 1e-20));
    out.speechLevelDb = 10 * Math.log10(outSpeech / Math.max(cleanSpeech, 1e-20));

    // Ham iz bitince (cihaz çıkarıldı) işlenmiş iz de kapanmalı.
    rawTrack.stop();
    rawTrack.dispatchEvent(new Event('ended'));
    await new Promise(r => setTimeout(r, 200));
    out.closesWithRawTrack = ns.context.state === 'closed' && ns.track.readyState === 'ended';

    // Model yüklenemezse kurulum asılı kalmamalı.
    const brokenStart = performance.now();
    const brokenFeed = ctx.createMediaStreamDestination();
    try {
        await mic.createNoiseSuppressor(brokenFeed.stream.getAudioTracks()[0], { workletUrl: '/vendor/yok.worklet.js', timeoutMs: 3000 });
        out.brokenRejected = false;
    } catch {
        out.brokenRejected = true;
    }
    out.brokenMs = Math.round(performance.now() - brokenStart);
    await ctx.close();
    return out;
}

(async () => {
    await new Promise(resolve => server.listen(0, resolve));
    const base = `http://localhost:${server.address().port}`;
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}/__noise-test.html`);

    const r = await page.evaluate(measure);
    console.log(JSON.stringify(r));
    check('Chromium yapay zekâ gürültü engellemeyi destekliyor', r.available);
    if (r.available) {
        check('model üretim CSP\'si altında yüklenip hazır oluyor', r.trackState === 'live' && r.contextState === 'running', `${r.setupMs} ms`);
        check('işlem sırasında arıza bildirilmiyor', r.failures === 0);
        // Beklenen ≈ 32 ms: 640 örnek worklet tamponu + GTCRN'in ~18 ms'si.
        check('işlemcinin eklediği gecikme 45 ms altında', r.latencyMs >= 10 && r.latencyMs < 45, `${r.latencyMs} ms`);
        check('konuşma aralarında gürültü en az 15 dB bastırılıyor', r.noiseReductionDb >= 15, `${r.noiseReductionDb.toFixed(1)} dB (${r.noiseFrames} çerçeve)`);
        check('konuşma seviyesi korunuyor (en fazla 6 dB kayıp)', r.speechLevelDb >= -6 && r.speechLevelDb <= 3, `${r.speechLevelDb.toFixed(1)} dB (${r.speechFrames} çerçeve)`);
        check('ham iz bitince işlenmiş iz ve bağlam kapanıyor', r.closesWithRawTrack);
        check('model yüklenemezse kurulum asılı kalmadan reddediliyor', r.brokenRejected && r.brokenMs < 4000, `${r.brokenMs} ms`);
    }
    const csp = errors.filter(e => /Content Security Policy|wasm/i.test(e));
    check('CSP ihlali yok', csp.length === 0, csp.slice(0, 2).join(' | '));

    await browser.close();
    server.close();
    const failed = results.filter(x => !x.ok);
    console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti`);
    process.exit(failed.length ? 1 : 0);
})().catch((err) => {
    console.error('GÜRÜLTÜ TESTİ ÇÖKTÜ:', err);
    process.exit(2);
});
