const test = require('node:test');
const assert = require('node:assert/strict');

const EventLimiter = require('../EventLimiter');

test('pencere dolana kadar izin verir', () => {
    const limiter = new EventLimiter(3, 1000);
    assert.equal(limiter.consume('ip', 0).allowed, true);
    assert.equal(limiter.consume('ip', 10).allowed, true);
    assert.equal(limiter.consume('ip', 20).allowed, true);
    assert.equal(limiter.consume('ip', 30).allowed, false);
});

test('reddedilen çağrı retryAfter saniyesi bildirir', () => {
    const limiter = new EventLimiter(1, 10_000);
    limiter.consume('ip', 0);
    const denied = limiter.consume('ip', 1_000);

    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfter, 9);
});

test('pencere kayınca yeniden izin verir', () => {
    const limiter = new EventLimiter(2, 1000);
    limiter.consume('ip', 0);
    limiter.consume('ip', 100);
    assert.equal(limiter.consume('ip', 200).allowed, false);
    assert.equal(limiter.consume('ip', 1101).allowed, true, 'ilk iki kayıt pencereden çıkmalı');
});

test('anahtarlar birbirini etkilemez', () => {
    const limiter = new EventLimiter(1, 1000);
    limiter.consume('a', 0);
    assert.equal(limiter.consume('a', 1).allowed, false);
    assert.equal(limiter.consume('b', 1).allowed, true);
});

test('reset anahtarı temizler', () => {
    const limiter = new EventLimiter(1, 1000);
    limiter.consume('a', 0);
    limiter.reset('a');
    assert.equal(limiter.consume('a', 1).allowed, true);
});

test('cleanup süresi geçmiş anahtarları düşürür', () => {
    const limiter = new EventLimiter(5, 1000);
    limiter.consume('a', 0);
    limiter.consume('b', 900);

    limiter.cleanup(1500);

    assert.equal(limiter.size, 1, 'yalnızca güncel anahtar kalmalı');
});

test('temizlik zamanlayıcısı süreci ayakta tutmaz', () => {
    const limiter = new EventLimiter(1, 1000);
    assert.equal(limiter.cleanupTimer.hasRef(), false);
});
