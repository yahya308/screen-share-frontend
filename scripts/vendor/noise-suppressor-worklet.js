/* global sampleRate */
/**
 * Mikrofon gürültü engelleme işlemcisi — AudioWorklet içinde GTCRN.
 *
 * GTCRN küçük bir konuşma iyileştirme ağı (~48 bin parametre). 48 kHz'lik
 * 768 örneklik (16 ms) çerçeveler alır, içeride 16 kHz'e indirip modeli
 * çalıştırır ve sonucu tekrar 48 kHz'e çıkarır. Tarayıcının yerleşik gürültü
 * engellemesine göre fan, klavye ve uğultuyu çok daha fazla bastırıyor;
 * ölçümler docs/NOISE-SUPPRESSION-2026-10-13.md içinde.
 *
 * Tasarım kuralı: bu düğüm hiçbir koşulda mikrofonu SUSTURMAMALI. Model
 * yüklenene kadar ve herhangi bir hatadan sonra giriş olduğu gibi geçirilir;
 * ana iş parçacığına haber verilir, o da tarayıcının gürültü engellemesine
 * geçer.
 *
 * Bu dosya scripts/build-vendor.js ile public/vendor/ altına paketlenir.
 */
import { loadGtcrnModule } from '@sapphi-red/gtcrn-wasm';

const QUANTUM = 128;
const FRAME = 768;
const QUANTA_PER_FRAME = FRAME / QUANTUM;
const F32 = Float32Array.BYTES_PER_ELEMENT;
// Gerçek bir mikrofon tamamen sıfır üretmez (gürültü tabanı hep vardır).
// Açılıştan itibaren bu kadar süre mutlak sıfır gelirse kaynak düğümü
// bozuktur (ör. iOS'ta ses oturumu kesintisi): ana iş parçacığı ham ize döner.
const SILENT_INPUT_LIMIT_SECONDS = 3;

class VeloNoiseSuppressor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.frameIn = new Float32Array(FRAME);
        this.frameOut = new Float32Array(FRAME);
        this.slot = 0;
        this.ready = false;
        this.failed = false;
        this.closed = false;
        this.silentSamples = 0;
        this.silenceChecked = false;
        this.port.onmessage = (event) => { if (event.data === 'close') this.close(); };

        // locateFile şart: verilmezse yükleyici `new URL(...)` çağırıyor ve
        // AudioWorkletGlobalScope'ta URL tanımlı değil. Model zaten
        // wasmBinary olarak geldiği için dönen yol hiç kullanılmıyor.
        loadGtcrnModule({ wasmBinary: options.processorOptions.wasmBinary, locateFile: file => file })
            .then((module) => {
                if (this.closed) return;
                this.module = module;
                this.openState();
                this.ready = true;
                this.port.postMessage({ type: 'ready' });
            })
            .catch(err => this.fail(err));
    }

    openState() {
        const m = this.module;
        this.state = m._gtcrn_create();
        this.inPtr = m._malloc(FRAME * F32);
        this.outPtr = m._malloc(FRAME * F32);
        if (!this.state || !this.inPtr || !this.outPtr) throw new Error('GTCRN belleği ayrılamadı');
    }

    freeState() {
        const m = this.module;
        if (!m) return;
        if (this.inPtr) m._free(this.inPtr);
        if (this.outPtr) m._free(this.outPtr);
        if (this.state) m._gtcrn_destroy(this.state);
        this.inPtr = this.outPtr = this.state = 0;
    }

    fail(err) {
        if (this.failed) return;
        this.failed = true;
        this.port.postMessage({ type: 'error', message: String(err?.message || err) });
    }

    close() {
        this.closed = true;
        try { this.freeState(); } catch { /* bellek zaten bırakılmış olabilir */ }
    }

    /** Bir çerçeveyi modelden geçir; sayısal taşma olursa durumu sıfırla. */
    runModel() {
        const m = this.module;
        const inIndex = this.inPtr / F32, outIndex = this.outPtr / F32;
        // HEAPF32 bellek büyürse yeniden oluşturulur: her çerçevede taze oku.
        m.HEAPF32.set(this.frameIn, inIndex);
        m._gtcrn_process_48k(this.state, this.inPtr, this.outPtr);
        const result = m.HEAPF32.subarray(outIndex, outIndex + FRAME);
        let energy = 0;
        for (let i = 0; i < FRAME; i++) energy += result[i] * result[i];
        if (Number.isFinite(energy)) {
            this.frameOut.set(result);
        } else {
            // Model durumunda NaN/Inf: bu çerçeveyi ham geçir, ağı baştan başlat.
            this.frameOut.set(this.frameIn);
            this.freeState();
            this.openState();
        }
    }

    watchForDeadInput(input) {
        if (this.silenceChecked) return;
        for (let i = 0; i < input.length; i++) {
            if (input[i] !== 0) { this.silenceChecked = true; return; }
        }
        this.silentSamples += input.length;
        if (this.silentSamples >= sampleRate * SILENT_INPUT_LIMIT_SECONDS) {
            this.silenceChecked = true;
            this.port.postMessage({ type: 'silent-input' });
        }
    }

    process(inputs, outputs) {
        if (this.closed) return false;
        const output = outputs[0][0];
        const input = inputs[0]?.[0];
        if (!input) { output.fill(0); return true; }
        this.watchForDeadInput(input);

        if (!this.ready || this.failed) { output.set(input); return true; }

        try {
            this.frameIn.set(input, this.slot * QUANTUM);
            if (this.slot === QUANTA_PER_FRAME - 1) this.runModel();
            // İşlenen çerçeve sonraki altı quantum boyunca okunur:
            // 640 örnek (~13 ms) tamponlama + modelin kendi gecikmesi.
            const readSlot = (this.slot + 1) % QUANTA_PER_FRAME;
            output.set(this.frameOut.subarray(readSlot * QUANTUM, (readSlot + 1) * QUANTUM));
            this.slot = readSlot;
        } catch (err) {
            this.fail(err);
            output.set(input);
        }
        return true;
    }
}

registerProcessor('velo-noise-suppressor', VeloNoiseSuppressor);
