const test = require('node:test');
const assert = require('node:assert/strict');

const { issueToken, verifyToken, TOKEN_BYTES } = require('../adminAuth');

test('issueToken sabit uzunlukta hex üretir', () => {
    const token = issueToken();
    assert.equal(token.length, TOKEN_BYTES * 2);
    assert.match(token, /^[0-9a-f]+$/);
});

test('issueToken her çağrıda farklı değer üretir', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => issueToken()));
    assert.equal(tokens.size, 200);
});

test('verifyToken doğru token için true döner', () => {
    const token = issueToken();
    assert.equal(verifyToken(token, token), true);
});

test('verifyToken yanlış token için false döner', () => {
    assert.equal(verifyToken(issueToken(), issueToken()), false);
});

test('verifyToken tek karakter farkı yakalar', () => {
    const token = issueToken();
    const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);
    assert.equal(verifyToken(token, tampered), false);
});

test('verifyToken boş, eksik ve tip uyumsuz girdileri reddeder', () => {
    const token = issueToken();
    for (const bad of ['', null, undefined, 0, {}, [], token.slice(0, -1), token + 'a']) {
        assert.equal(verifyToken(token, bad), false, `reddedilmeliydi: ${String(bad)}`);
    }
    // Beklenen tarafın kendisi boşsa hiçbir şey doğrulanamaz (oda token'sız kalamaz)
    assert.equal(verifyToken('', ''), false);
    assert.equal(verifyToken(undefined, token), false);
});
