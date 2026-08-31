const test = require('node:test');
const assert = require('node:assert/strict');

const rateLimiter = require('../RateLimiter');

const IP = '203.0.113.10';

test.beforeEach(() => {
    rateLimiter.attempts.clear();
});

test('temiz bir IP bloklu değildir', () => {
    assert.deepEqual(rateLimiter.isBlocked(IP, 'r1'), { blocked: false, remainingTime: 0 });
});

test('5. başarısız denemede blok başlar', () => {
    let result;
    for (let i = 0; i < 5; i++) result = rateLimiter.recordFailedAttempt(IP, 'r1');

    assert.equal(result.blocked, true);
    assert.equal(result.remainingAttempts, 0);
    assert.equal(rateLimiter.isBlocked(IP, 'r1').blocked, true);
});

test('kalan deneme sayısı geri sayar', () => {
    assert.equal(rateLimiter.recordFailedAttempt(IP, 'r1').remainingAttempts, 4);
    assert.equal(rateLimiter.recordFailedAttempt(IP, 'r1').remainingAttempts, 3);
});

test('blok oda başına ayrışır', () => {
    for (let i = 0; i < 5; i++) rateLimiter.recordFailedAttempt(IP, 'r1');

    assert.equal(rateLimiter.isBlocked(IP, 'r1').blocked, true);
    assert.equal(rateLimiter.isBlocked(IP, 'r2').blocked, false, 'başka oda etkilenmemeli');
});

test('blok IP başına ayrışır', () => {
    for (let i = 0; i < 5; i++) rateLimiter.recordFailedAttempt(IP, 'r1');
    assert.equal(rateLimiter.isBlocked('203.0.113.11', 'r1').blocked, false);
});

test('başarılı girişten sonra sayaç sıfırlanır', () => {
    rateLimiter.recordFailedAttempt(IP, 'r1');
    rateLimiter.recordFailedAttempt(IP, 'r1');
    rateLimiter.resetAttempts(IP, 'r1');
    assert.equal(rateLimiter.recordFailedAttempt(IP, 'r1').remainingAttempts, 4);
});

test('süresi dolan blok kalkar ve kayıt temizlenir', () => {
    for (let i = 0; i < 5; i++) rateLimiter.recordFailedAttempt(IP, 'r1');

    const record = rateLimiter.attempts.get(`${IP}:r1`);
    record.blockedUntil = Date.now() - 1;

    assert.equal(rateLimiter.isBlocked(IP, 'r1').blocked, false);
    assert.equal(rateLimiter.attempts.has(`${IP}:r1`), false, 'kayıt silinmeli');
});

test('cleanup yalnızca süresi dolmuş blokları siler', () => {
    for (let i = 0; i < 5; i++) rateLimiter.recordFailedAttempt('1.1.1.1', 'r1');
    for (let i = 0; i < 5; i++) rateLimiter.recordFailedAttempt('2.2.2.2', 'r1');
    rateLimiter.attempts.get('1.1.1.1:r1').blockedUntil = Date.now() - 1;

    rateLimiter.cleanup();

    assert.equal(rateLimiter.attempts.has('1.1.1.1:r1'), false);
    assert.equal(rateLimiter.attempts.has('2.2.2.2:r1'), true);
});

test('kalan süre saniye cinsinden ve pozitif raporlanır', () => {
    for (let i = 0; i < 5; i++) rateLimiter.recordFailedAttempt(IP, 'r1');
    const { remainingTime } = rateLimiter.isBlocked(IP, 'r1');
    assert.ok(remainingTime > 0 && remainingTime <= 180, `beklenmeyen süre: ${remainingTime}`);
});
