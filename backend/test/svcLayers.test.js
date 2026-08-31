const test = require('node:test');
const assert = require('node:assert/strict');

const { getMaxSpatialLayer, getMaxTemporalLayer, pickLayers, overallScore } = require('../svcLayers');

// ==================== scalabilityMode AYRIŞTIRMA ====================

test('L3T3_KEY üç uzamsal, üç zamansal katman verir', () => {
    const encodings = [{ scalabilityMode: 'L3T3_KEY' }];
    assert.equal(getMaxSpatialLayer(encodings), 2);
    assert.equal(getMaxTemporalLayer(encodings), 2);
});

test('L1T3 yalnızca zamansal katman verir', () => {
    const encodings = [{ scalabilityMode: 'L1T3' }];
    assert.equal(getMaxSpatialLayer(encodings), 0, 'eski davranış korunmalı');
    assert.equal(getMaxTemporalLayer(encodings), 2);
});

test('simulcast (çok encoding) uzamsal katman olarak sayılır', () => {
    const encodings = [{ rid: 'r0' }, { rid: 'r1' }, { rid: 'r2' }];
    assert.equal(getMaxSpatialLayer(encodings), 2);
});

test('SVC ve simulcast birlikteyse büyük olan alınır', () => {
    assert.equal(getMaxSpatialLayer([{ scalabilityMode: 'L3T3' }]), 2);
    assert.equal(getMaxSpatialLayer([{ scalabilityMode: 'L1T3' }, { scalabilityMode: 'L1T3' }]), 1);
});

test('eksik veya bozuk scalabilityMode çökmez', () => {
    assert.equal(getMaxTemporalLayer([]), 0);
    assert.equal(getMaxTemporalLayer([{}]), 0);
    assert.equal(getMaxTemporalLayer([{ scalabilityMode: 'saçma' }]), 0);
    assert.equal(getMaxSpatialLayer([{ scalabilityMode: null }]), 0);
    assert.equal(getMaxSpatialLayer(), 0);
});

// ==================== KADEME ====================

const full = { maxSpatialLayer: 2, maxTemporalLayer: 2, spatialLayer: 2, temporalLayer: 2 };

test('iyi skorda en yüksek katmanlarda kalır', () => {
    assert.deepEqual(pickLayers(10, full), { spatialLayer: 2, temporalLayer: 2 });
});

test('hafif bozulmada önce kare hızı düşer, çözünürlük korunur', () => {
    assert.deepEqual(pickLayers(6, full), { spatialLayer: 2, temporalLayer: 1 });
});

test('orta bozulmada çözünürlük düşer, akıcılık geri gelir', () => {
    const state = { ...full, spatialLayer: 2, temporalLayer: 1 };
    assert.deepEqual(pickLayers(4, state), { spatialLayer: 1, temporalLayer: 2 });
});

test('ağır bozulmada en alt kademeye inilir', () => {
    const state = { ...full, spatialLayer: 1, temporalLayer: 2 };
    assert.deepEqual(pickLayers(1, state), { spatialLayer: 0, temporalLayer: 1 });
});

test('katmanlar hiçbir zaman negatif olmaz', () => {
    const single = { maxSpatialLayer: 0, maxTemporalLayer: 0, spatialLayer: 0, temporalLayer: 0 };
    assert.deepEqual(pickLayers(0, single), { spatialLayer: 0, temporalLayer: 0 });
});

test('histerezis: sınırda skorla kalite yükseltilmez', () => {
    // Düşük katmandayız; skor 7 "iyi" ama yükselme için yeterli değil
    const degraded = { ...full, spatialLayer: 0, temporalLayer: 1 };
    assert.deepEqual(pickLayers(7, degraded), { spatialLayer: 0, temporalLayer: 1 });
    // 8 ve üstünde yükselir
    assert.deepEqual(pickLayers(9, degraded), { spatialLayer: 2, temporalLayer: 2 });
});

test('histerezis düşüşü engellemez', () => {
    // Kalite kötüleşiyorsa beklemeden inilmeli
    const state = { ...full };
    assert.deepEqual(pickLayers(2, state), { spatialLayer: 0, temporalLayer: 1 });
});

// ==================== SKOR ====================

test('overallScore en kötü katmanı alır', () => {
    assert.equal(overallScore([{ score: 9 }, { score: 4 }, { score: 7 }]), 4);
});

test('overallScore boş/bozuk girdide iyimser davranır', () => {
    assert.equal(overallScore([]), 10);
    assert.equal(overallScore(undefined), 10);
    assert.equal(overallScore([{}, { score: null }]), 10);
});
