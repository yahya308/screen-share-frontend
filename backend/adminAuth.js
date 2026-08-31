/**
 * adminAuth - Oda yöneticiliği için paylaşılan sır üretimi ve doğrulaması.
 *
 * Yönetici yetkisi daha önce yalnızca istemcinin beyanına dayanıyordu
 * (`room.html?admin=true`), yani oda kimliğini bilen herkes yönetici
 * olabiliyordu. Artık odayı kuran istemciye bir kez verilen bu token
 * olmadan hiçbir soket 'admin' rolüne geçemez.
 */

const crypto = require('crypto');

const TOKEN_BYTES = 32;

/** Yeni bir yönetici token'ı üret (64 karakter hex). */
function issueToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Sabit zamanlı token karşılaştırması.
 * Uzunluk farkı token'ın kendisini sızdırmaz; token'lar zaten sabit uzunlukta.
 * @returns {boolean}
 */
function verifyToken(expected, provided) {
    if (typeof expected !== 'string' || typeof provided !== 'string') return false;
    if (expected.length === 0 || expected.length !== provided.length) return false;

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
}

module.exports = { issueToken, verifyToken, TOKEN_BYTES };
