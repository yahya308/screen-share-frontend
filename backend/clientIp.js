/**
 * clientIp - Ters vekil arkasında gerçek istemci IP'sini tek bir yerden çözer.
 *
 * Önceki kod `x-forwarded-for` başlığının İLK parçasını alıyordu. Nginx bu
 * başlığı `$proxy_add_x_forwarded_for` ile *ekliyor*, yani istemcinin kendi
 * gönderdiği değer listenin başında kalıyor ve doğrudan güvenilir kabul
 * ediliyordu: sahte bir başlıkla hem ban listesi hem de parola deneme limiti
 * etkisiz hale geliyordu.
 *
 * Doğru sıra:
 *   1. X-Real-IP        — nginx bunu $remote_addr'dan yazar, istemci etkileyemez
 *   2. XFF'in SON ögesi — vekile en yakın hop, yani nginx'in gördüğü adres
 *   3. Soketin kendi adresi (vekilsiz/doğrudan bağlantı)
 */

/** IPv4-mapped IPv6 önekini ve boşlukları temizle. */
function normalizeIp(value) {
    if (typeof value !== 'string') return '';
    let ip = value.trim().toLowerCase();
    if (!ip) return '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

/**
 * @param {{ headers?: Object, address?: string }} handshake Socket.io handshake
 * @returns {string} Normalize edilmiş istemci IP'si ('' olabilir)
 */
function getClientIp(handshake) {
    const headers = (handshake && handshake.headers) || {};

    const realIp = normalizeIp(headers['x-real-ip']);
    if (realIp) return realIp;

    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        const hops = forwarded.split(',').map(normalizeIp).filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
    }

    return normalizeIp(handshake && handshake.address);
}

module.exports = { getClientIp, normalizeIp };
