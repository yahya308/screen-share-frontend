// Pure media policy shared by the room and its regression tests.
export function screenSettings(height, fps, kbps) {
    height = Number(height); fps = Number(fps); kbps = Number(kbps);
    if (![240, 360, 480, 720, 1080].includes(height) || ![15, 24, 25, 30, 60].includes(fps) ||
        !Number.isFinite(kbps) || kbps < 250 || kbps > 20000) {
        throw new Error('Çözünürlük/FPS seçin; bitrate 250–20000 kbps arasında olmalı.');
    }
    return { height, width: Math.round(height * 16 / 9), fps, bitrateBps: Math.round(kbps * 1000) };
}

export function screenEncodings(settings, mimeType, adaptive = true) {
    const { height, fps, bitrateBps } = settings;
    const temporal = /h264/i.test(mimeType) ? {} : { scalabilityMode: 'L1T3' };
    if (adaptive && /vp8/i.test(mimeType) && height >= 720 && bitrateBps >= 1500000) {
        const low = Math.min(700000, Math.round(bitrateBps * 0.2));
        return [
            { rid: 'low', scaleResolutionDownBy: height / 360, maxBitrate: low, maxFramerate: fps, ...temporal },
            { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: bitrateBps - low, maxFramerate: fps, ...temporal }
        ];
    }
    return [{ maxBitrate: bitrateBps, maxFramerate: fps, ...temporal }];
}

export function layerLimits(encodings = []) {
    let spatial = Math.max(0, encodings.length - 1), temporal = 0;
    for (const enc of encodings) {
        const match = /L(\d+)T(\d+)/i.exec(enc.scalabilityMode || '');
        if (match) { spatial = Math.max(spatial, Number(match[1]) - 1); temporal = Math.max(temporal, Number(match[2]) - 1); }
    }
    return { spatial, temporal };
}

export function preferredLayers(encodings, quality) {
    const { spatial, temporal } = layerLimits(encodings);
    if (quality === 'low') return { spatialLayer: 0, temporalLayer: spatial > 0 ? temporal : 0 };
    if (quality === 'mid') return { spatialLayer: Math.max(0, spatial - 1), temporalLayer: spatial > 0 ? temporal : Math.max(0, temporal - 1) };
    return { spatialLayer: spatial, temporalLayer: temporal };
}

export function playoutTarget(contentType, metrics = {}) {
    const base = contentType === 'motion' ? 400 : contentType === 'interactive' ? 100 : 150;
    const ceiling = contentType === 'motion' ? 800 : contentType === 'interactive' ? 200 : 350;
    const network = (metrics.rttMs || 0) + (metrics.jitterMs || 0) * 3 + 80;
    return Math.round(Math.max(base, Math.min(ceiling, network + (metrics.lossPct > 2 ? 100 : 0))) / 50) * 50;
}

export function audioLevel(source, { muted, paused, master = 1, speech = 1 }) {
    if (muted || (paused && source === 'admin-sys-audio')) return 0;
    return Math.max(0, Math.min(1, master * (source === 'admin-sys-audio' ? 1 : speech)));
}

export function canUseShortcut(target) {
    return !target?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="dialog"]');
}

// Stats are cumulative. Keep baselines per report ID and never manufacture zero
// packet loss when the browser did not supply receiver feedback.
export class RtcSampler {
    constructor() { this.previous = new Map(); }
    sample(reports, sender = false) {
        const rows = Array.from(reports.values()), next = new Map();
        const result = { videoKbps: null, audioKbps: null, fps: null, width: 0, height: 0,
            lossPct: null, audioLossPct: null, jitterMs: null, audioJitterMs: null, rttMs: null,
            bufferMs: null, freezes: 0, freezeSeconds: 0, concealedSamples: 0,
            processingMs: null, qualityReason: null, codec: null, route: null, relayProtocol: null };
        const sum = { videoBytes: 0, audioBytes: 0, videoMs: 0, audioMs: 0,
            videoLost: 0, videoPackets: 0, audioLost: 0, audioPackets: 0, buffer: 0, emitted: 0,
            processing: 0, frames: 0 };
        const delta = (row, field) => {
            const prev = this.previous.get(row.id);
            return prev && Number.isFinite(row[field]) && Number.isFinite(prev[field])
                ? Math.max(0, row[field] - prev[field]) : null;
        };
        for (const r of rows) {
            next.set(r.id, r);
            if (r.type !== (sender ? 'outbound-rtp' : 'inbound-rtp') || !['video', 'audio'].includes(r.kind)) continue;
            const kind = r.kind, prev = this.previous.get(r.id);
            const elapsed = prev ? r.timestamp - prev.timestamp : 0;
            const bytes = delta(r, sender ? 'bytesSent' : 'bytesReceived');
            if (elapsed > 0 && bytes !== null) {
                sum[kind + 'Bytes'] += bytes / elapsed;
                sum[kind + 'Ms']++;
            }
            const feedback = sender ? rows.find(x => x.type === 'remote-inbound-rtp' && (x.localId === r.id || x.id === r.remoteId)) : r;
            if (feedback) {
                const lost = delta(feedback, 'packetsLost');
                const received = sender ? delta(r, 'packetsSent') : delta(r, 'packetsReceived');
                if (lost !== null && received !== null) {
                    sum[kind + 'Lost'] += lost;
                    sum[kind + 'Packets'] += received + (sender ? 0 : lost);
                }
                if (Number.isFinite(feedback.jitter)) result[kind === 'video' ? 'jitterMs' : 'audioJitterMs'] = Math.max(result[kind === 'video' ? 'jitterMs' : 'audioJitterMs'] || 0, feedback.jitter * 1000);
                if (Number.isFinite(feedback.roundTripTime)) result.rttMs = feedback.roundTripTime * 1000;
            }
            if (kind === 'video') {
                result.width = Math.max(result.width, r.frameWidth || 0);
                result.height = Math.max(result.height, r.frameHeight || 0);
                if (Number.isFinite(r.framesPerSecond)) result.fps = Math.max(result.fps || 0, r.framesPerSecond);
                result.freezes += delta(r, 'freezeCount') || 0;
                result.freezeSeconds += delta(r, 'totalFreezesDuration') || 0;
                const count = delta(r, sender ? 'framesEncoded' : 'framesDecoded');
                const duration = delta(r, sender ? 'totalEncodeTime' : 'totalDecodeTime');
                if (count > 0 && duration !== null) { sum.frames += count; sum.processing += duration; }
                if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') result.qualityReason = r.qualityLimitationReason;
                const codec = reports.get(r.codecId); if (codec) result.codec = codec.mimeType;
                const buffer = delta(r, 'jitterBufferDelay'), emitted = delta(r, 'jitterBufferEmittedCount');
                if (buffer !== null && emitted > 0) { sum.buffer += buffer; sum.emitted += emitted; }
            } else { result.concealedSamples += delta(r, 'concealedSamples') || 0; }
        }
        for (const kind of ['video', 'audio']) {
            if (sum[kind + 'Ms']) result[kind + 'Kbps'] = Math.round(sum[kind + 'Bytes'] * 8);
            if (sum[kind + 'Packets'] > 0) result[kind === 'video' ? 'lossPct' : 'audioLossPct'] = Math.min(100, 100 * sum[kind + 'Lost'] / sum[kind + 'Packets']);
        }
        if (sum.frames) result.processingMs = sum.processing / sum.frames * 1000;
        if (sum.emitted) result.bufferMs = sum.buffer / sum.emitted * 1000;
        const transport = rows.find(r => r.type === 'transport' && r.selectedCandidatePairId);
        const pair = transport ? reports.get(transport.selectedCandidatePairId) : rows.find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
        if (pair) {
            if (Number.isFinite(pair.currentRoundTripTime)) result.rttMs = pair.currentRoundTripTime * 1000;
            const local = reports.get(pair.localCandidateId), remote = reports.get(pair.remoteCandidateId);
            // A relay on the same NAT as the SFU can become a prflx candidate.
            // The selected candidate still carries its TURN URL/relayProtocol.
            const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay' || local?.relayProtocol || /^turns?:/.test(local?.url || '');
            result.route = relayed ? 'TURN' : (local?.protocol || remote?.protocol || '').toUpperCase() || null;
            result.relayProtocol = relayed ? local?.relayProtocol || (/^turns:/.test(local?.url || '') ? 'tls' : null) : null;
        }
        this.previous = next;
        return result;
    }
}
