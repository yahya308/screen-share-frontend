const test = require('node:test');
const assert = require('node:assert/strict');

const { getClientIp, normalizeIp } = require('../clientIp');

test('X-Real-IP her şeyden önce gelir', () => {
    const ip = getClientIp({
        headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' },
        address: '10.0.0.1'
    });
    assert.equal(ip, '203.0.113.9');
});

test('istemcinin uydurduğu X-Forwarded-For ön eki yok sayılır', () => {
    // Nginx $proxy_add_x_forwarded_for ile ekler: "<istemcinin yazdığı>, <gerçek>"
    const ip = getClientIp({
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
        address: '10.0.0.1'
    });
    assert.equal(ip, '203.0.113.9', 'son hop gerçek istemcidir');
});

test('çok hop\'lu zincirde de son öge alınır', () => {
    const ip = getClientIp({
        headers: { 'x-forwarded-for': 'evil, 1.1.1.1 , 2.2.2.2,   203.0.113.9  ' },
        address: '10.0.0.1'
    });
    assert.equal(ip, '203.0.113.9');
});

test('başlık yoksa soket adresine düşer', () => {
    assert.equal(getClientIp({ headers: {}, address: '198.51.100.7' }), '198.51.100.7');
});

test('IPv4-mapped IPv6 öneki temizlenir', () => {
    assert.equal(getClientIp({ headers: {}, address: '::ffff:198.51.100.7' }), '198.51.100.7');
    assert.equal(normalizeIp('::FFFF:10.0.0.5'), '10.0.0.5');
});

test('aynı istemci farklı yazımlarla aynı anahtarı üretir', () => {
    // Ban listesi ve parola limiti bu eşitliğe dayanıyor
    const a = getClientIp({ headers: { 'x-real-ip': '::ffff:203.0.113.9' }, address: '' });
    const b = getClientIp({ headers: { 'x-forwarded-for': 'x, 203.0.113.9' }, address: '' });
    assert.equal(a, b);
});

test('bozuk girdilerde çökmez', () => {
    assert.equal(getClientIp(undefined), '');
    assert.equal(getClientIp({}), '');
    assert.equal(getClientIp({ headers: { 'x-forwarded-for': '   ,  ' } }), '');
    assert.equal(getClientIp({ headers: { 'x-real-ip': 42 } }), '');
});
