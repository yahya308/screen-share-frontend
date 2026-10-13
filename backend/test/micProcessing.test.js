const test = require('node:test');
const assert = require('node:assert/strict');
let mic;
test.before(async () => { mic = await import('../../public/mic-processing.mjs'); });

test('aç/kapa tercihi önceki sürümün anahtarıyla okunur, varsayılan açık', () => {
    assert.equal(mic.parseNoiseSuppressionPreference('true'), true);
    // Daha önce kapatan kullanıcı kapalı kalmalı.
    assert.equal(mic.parseNoiseSuppressionPreference('false'), false);
    assert.equal(mic.parseNoiseSuppressionPreference(null), true);
    assert.equal(mic.parseNoiseSuppressionPreference('bozuk-deger'), true);
});

test('anahtar açıkken model, yoksa tarayıcı; kapalıyken hiçbiri', () => {
    const all = { aiAvailable: true, browserAvailable: true };
    assert.equal(mic.resolveNoiseEngine(true, all), 'ai');
    assert.equal(mic.resolveNoiseEngine(false, all), 'off');
    assert.equal(mic.resolveNoiseEngine(true, { aiAvailable: false, browserAvailable: true }), 'browser');
    assert.equal(mic.resolveNoiseEngine(true, { aiAvailable: false, browserAvailable: false }), 'off');
    assert.equal(mic.resolveNoiseEngine(false, { aiAvailable: false, browserAvailable: true }), 'off');
});

test('yapay zekâ kipinde tarayıcının gürültü engellemesi kapanır, yankı ve kazanç açık kalır', () => {
    // İki gürültü engelleyici üst üste konuşmayı bozuyor (PESQ 1.95 → 1.74).
    const ai = mic.micConstraints('ai');
    assert.equal(ai.noiseSuppression, false);
    assert.equal(ai.echoCancellation, true);
    assert.equal(ai.autoGainControl, true);
    // GTCRN 48 kHz mono çerçeve bekliyor.
    assert.equal(ai.sampleRate, 48000);
    assert.equal(ai.channelCount, 1);

    assert.equal(mic.micConstraints('browser').noiseSuppression, true);
    assert.equal(mic.micConstraints('off').noiseSuppression, false);
    // Kısıtı tanımayan tarayıcıya hiç gönderilmez.
    assert.equal('noiseSuppression' in mic.micConstraints('browser', { browserAvailable: false }), false);
});
