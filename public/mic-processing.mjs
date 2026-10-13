/**
 * Mikrofon gürültü engelleme.
 *
 * Arayüzdeki aç/kapa anahtarı tek karardır:
 *   açık   — GTCRN sinir ağı (AudioWorklet + WebAssembly). Tarayıcının kendi
 *            gürültü engellemesi KAPALI, yankı engelleme ve otomatik kazanç
 *            açık kalır: ikisi üst üste binince konuşma kalitesi düşüyor
 *            (ölçüm: docs/NOISE-SUPPRESSION-2026-10-13.md). Model bu
 *            tarayıcıda çalışamıyorsa ya da arızalanırsa tarayıcının
 *            yerleşik gürültü engellemesine düşülür.
 *   kapalı — gürültü engelleme yok (müzik, enstrüman).
 *
 * GTCRN modeli 16 kHz'de çalışır: konuşma 8 kHz'e kadar iletilir.
 *
 * Saf fonksiyonlar Node testlerinden de içe aktarılır; tarayıcı API'leri
 * yalnızca çağrıldıklarında kullanılır.
 */

const WORKLET_URL = '/vendor/noise-suppressor.worklet.js?v=gtcrn-0.0.3';
const MODEL_URL = '/vendor/gtcrn.wasm?v=0.0.3';
const PROCESSOR_NAME = 'velo-noise-suppressor';
// wasm SIMD doğrulama modülü (wasm-feature-detect). GTCRN derlemesi SIMD
// istiyor: Chrome 91+, Firefox 89+, Safari 16.4+.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/**
 * Kayıtlı aç/kapa tercihini oku (`'true'`/`'false'`, önceki sürümle aynı
 * anahtar). Kayıt yoksa ya da bozuksa açık.
 */
export function parseNoiseSuppressionPreference(saved) {
    return saved !== 'false';
}

/**
 * Aç/kapa tercihini bu cihazda gerçekten çalışabilecek motora çevir:
 * 'ai' | 'browser' | 'off'.
 */
export function resolveNoiseEngine(enabled, { aiAvailable, browserAvailable }) {
    if (!enabled) return 'off';
    if (aiAvailable) return 'ai';
    return browserAvailable ? 'browser' : 'off';
}

/** Motor için getUserMedia ses kısıtları. */
export function micConstraints(engine, { browserAvailable = true } = {}) {
    const audio = { echoCancellation: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 };
    if (browserAvailable) audio.noiseSuppression = engine === 'browser';
    return audio;
}

export function browserNoiseSuppressionAvailable() {
    const supported = navigator.mediaDevices?.getSupportedConstraints?.();
    return !supported || supported.noiseSuppression === true;
}

export function aiNoiseSuppressionAvailable() {
    try {
        return typeof AudioWorkletNode === 'function'
            && typeof window.AudioContext === 'function'
            && 'audioWorklet' in window.AudioContext.prototype
            && typeof window.MediaStreamAudioDestinationNode === 'function'
            && WebAssembly.validate(SIMD_PROBE);
    } catch {
        return false;
    }
}

let modelPromise = null;

/** Modeli (192 KB) bir kez indir; başarısız olursa sonraki çağrı yeniden dener. */
export function preloadNoiseModel() {
    if (!modelPromise) {
        modelPromise = fetch(MODEL_URL, { credentials: 'same-origin' }).then((response) => {
            if (!response.ok) throw new Error('Gürültü modeli indirilemedi (' + response.status + ')');
            return response.arrayBuffer();
        });
        modelPromise.catch(() => { modelPromise = null; });
    }
    return modelPromise;
}

function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
    ]).finally(() => clearTimeout(timer));
}

/**
 * Ham mikrofon izini GTCRN'den geçirip yeni bir ses izi üretir.
 *
 * Döndürülen iz, model hazır ve ses bağlamı gerçekten çalışır durumdayken
 * verilir; bu sağlanamazsa söz reddedilir ve çağıran tarayıcının gürültü
 * engellemesine döner. Sonradan bir arıza olursa (worklet hatası, kaynağın
 * hiç ses vermemesi, bağlamın kapanması) `onFailure` bir kez çağrılır; o
 * ana kadar worklet sesi işlemeden geçirerek mikrofonu açık tutar.
 */
export async function createNoiseSuppressor(rawTrack, { onFailure, latencyHint = 'interactive', timeoutMs = 8000, workletUrl = WORKLET_URL } = {}) {
    const context = new AudioContext({ sampleRate: 48000, latencyHint });
    let source = null, node = null, track = null, closed = false, failed = false;
    let established = false, earlyFailure = null, stalledTimer = null;

    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(stalledTimer);
        try { node?.port.postMessage('close'); } catch { /* bağlam kapanmış olabilir */ }
        try { source?.disconnect(); node?.disconnect(); } catch { /* zaten ayrılmış */ }
        track?.stop();
        context.close().catch(() => { /* zaten kapalı */ });
    };
    // Kurulum bitmeden gelen arıza kurulumu başarısız sayar; sonrası çağırana
    // bir kez bildirilir.
    const reportFailure = (reason) => {
        if (closed || failed) return;
        if (!established) { if (!earlyFailure) earlyFailure = reason; return; }
        failed = true;
        onFailure?.(new Error(reason));
    };

    try {
        // Bağlam kullanıcı etkileşiminden hemen sonra açılıyor; askıda
        // doğduysa beklemeden başlatmayı dene.
        if (context.state === 'suspended') context.resume().catch(() => { /* aşağıda tekrar denenir */ });

        const [model] = await withTimeout(
            Promise.all([preloadNoiseModel(), context.audioWorklet.addModule(workletUrl)]),
            timeoutMs, 'Gürültü engelleme modeli zamanında yüklenemedi'
        );
        // Firefox, bağlamdan farklı örnekleme hızındaki bir izi bağlamayı
        // reddediyor; o durumda burada hata alınır ve tarayıcı kipine dönülür.
        source = context.createMediaStreamSource(new MediaStream([rawTrack]));
        node = new AudioWorkletNode(context, PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            processorOptions: { wasmBinary: model }
        });
        const destination = context.createMediaStreamDestination();
        destination.channelCount = 1;

        const ready = new Promise((resolve, reject) => {
            node.port.onmessage = ({ data }) => {
                if (data?.type === 'ready') resolve();
                else if (data?.type === 'error') {
                    reject(new Error(data.message || 'Gürültü engelleme başlatılamadı'));
                    reportFailure('Gürültü engelleme işlemcisi hata verdi: ' + data.message);
                } else if (data?.type === 'silent-input') {
                    reportFailure('Gürültü engelleme girişine ses gelmiyor');
                }
            };
        });
        node.onprocessorerror = () => reportFailure('Gürültü engelleme işlemcisi durdu');
        source.connect(node);
        node.connect(destination);

        await withTimeout(ready, timeoutMs, 'Gürültü engelleme modeli zamanında başlamadı');
        if (context.state !== 'running') {
            await withTimeout(context.resume(), 1500, 'Ses işleme bağlamı başlatılamadı').catch(() => { /* durum aşağıda denetleniyor */ });
        }
        if (context.state !== 'running') throw new Error('Ses işleme bağlamı başlatılamadı');
        if (earlyFailure) throw new Error(earlyFailure);

        // Bağlam durursa worklet hiç çalışmaz ve iz SESSİZ kalır. iOS'ta telefon
        // görüşmesi ya da ses oturumu değişimi bağlamı 'interrupted'/'suspended'
        // yapabiliyor: önce sürdürmeyi dene, olmazsa ham ize dönülsün.
        context.onstatechange = () => {
            if (closed) return;
            clearTimeout(stalledTimer);
            if (context.state === 'running') return;
            if (context.state === 'closed') { reportFailure('Ses işleme bağlamı kapandı'); return; }
            context.resume().catch(() => { /* zamanlayıcı karar verecek */ });
            stalledTimer = setTimeout(() => {
                if (context.state !== 'running') reportFailure('Ses işleme bağlamı durdu');
            }, 2000);
        };
        rawTrack.addEventListener('ended', close, { once: true });

        track = destination.stream.getAudioTracks()[0];
        established = true;
        return { track, context, node, close };
    } catch (err) {
        close();
        throw err;
    }
}
