/**
 * Ön yüz güvenlik başlıkları.
 *
 * Ön yüz iki yerden sunuluyor: üretimde Vercel (statik), yerelde ve
 * konteynerde bu sunucu. Daha önce yalnızca Vercel başlık gönderiyordu,
 * dolayısıyla test ettiğimiz sayfa üretimdekiyle aynı politikayla
 * çalışmıyordu — room.html'deki satır içi import map yerelde sorunsuz
 * çalışıp üretimde sessizce engellendi ve oda sayfası hiç açılmadı.
 *
 * Kaynak doğruluk noktası kökteki vercel.json'dır; buradaki kopya backend
 * imajının derleme bağlamında o dosya bulunmadığı için var. securityHeaders
 * testi ikisinin ayrışmadığını doğruluyor.
 */

const FRONTEND_SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; font-src 'self'; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self), display-capture=(self)'
};

module.exports = { FRONTEND_SECURITY_HEADERS };
