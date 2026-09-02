/**
 * Ön yüz güvenlik başlıkları — üretimle yerelin ayrışmasını engeller.
 *
 * Bu dosyanın varlık sebebi somut bir üretim hatası: room.html satır içi bir
 * <script type="importmap"> taşıyordu. Backend sayfaları CSP'siz sunduğu için
 * yerelde ve duman testinde her şey çalışıyordu; Vercel'in `script-src 'self'`
 * başlığı ise satır içi script'i engelliyor, room.js `mediasoup-client` çıplak
 * adını çözemiyor ve MODÜL HİÇ ÇALIŞMIYORDU. Oda sahibi yönetici arayüzü
 * yerine boş izleyici ekranını görüyordu.
 *
 * İki iddia: (1) backend, Vercel'in gönderdiği başlıkların aynısını gönderir,
 * (2) hiçbir sayfa `script-src 'self'` altında çalışamayacak satır içi script
 * içermez.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { FRONTEND_SECURITY_HEADERS } = require('../securityHeaders');

const repoRoot = path.join(__dirname, '..', '..');
const publicDir = path.join(repoRoot, 'public');
const vercelConfigPath = path.join(repoRoot, 'vercel.json');

test('backend, Vercel ile aynı güvenlik başlıklarını gönderir', (t) => {
    // Backend imajının derleme bağlamında vercel.json yok; orada karşılaştıracak
    // bir şey de yok. Depoda çalışırken ise ayrışmaya izin vermiyoruz.
    if (!fs.existsSync(vercelConfigPath)) {
        t.skip('vercel.json bu bağlamda yok');
        return;
    }

    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, 'utf8'));
    const catchAll = vercelConfig.headers.find(h => h.source === '/(.*)');
    assert.ok(catchAll, 'vercel.json içinde tüm yolları kapsayan başlık bloğu yok');

    const vercelHeaders = Object.fromEntries(catchAll.headers.map(h => [h.key, h.value]));

    assert.deepEqual(
        FRONTEND_SECURITY_HEADERS,
        vercelHeaders,
        'backend ve vercel.json başlıkları ayrışmış: ikisini birlikte güncelleyin'
    );
});

test('hiçbir sayfa satır içi <script> içermez', () => {
    const csp = FRONTEND_SECURITY_HEADERS['Content-Security-Policy'];
    assert.match(csp, /script-src 'self'(;|$)/, 'script-src gevşetilmiş; bu test artık anlamsız');

    const pages = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
    assert.ok(pages.length > 0, 'public/ altında HTML sayfası bulunamadı');

    for (const page of pages) {
        // Yorum içindeki işaretleme çalışmaz; tarayıcı gibi davranıp atıyoruz
        // (bu dosyanın anlattığı hatayı açıklayan yorum da bir <script> geçiyor).
        const html = fs.readFileSync(path.join(publicDir, page), 'utf8')
            .replace(/<!--[\s\S]*?-->/g, '');

        // <script ...> açılışlarını yakala; src taşımayanlar satır içi demektir.
        // type="importmap" da dahil: import map'ler de script-src'a tabidir.
        const inline = [...html.matchAll(/<script\b([^>]*)>/gi)]
            .map(m => m[1])
            .filter(attrs => !/\bsrc\s*=/i.test(attrs));

        assert.deepEqual(
            inline,
            [],
            `${page} satır içi script içeriyor; \`script-src 'self'\` bunu üretimde ` +
            `engeller ve sayfanın modülleri hiç çalışmaz. Kodu ayrı bir .js dosyasına alın.`
        );
    }
});

test('room.html modülü çıplak ad yerine gerçek yoldan alır', () => {
    // Çıplak ad ancak import map ile çözülür, import map ise satır içi script.
    const roomJs = fs.readFileSync(path.join(publicDir, 'room.js'), 'utf8');
    const bareImports = [...roomJs.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)]
        .map(m => m[1])
        .filter(spec => !spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../'));

    assert.deepEqual(
        bareImports,
        [],
        'room.js çıplak modül adı kullanıyor; tarayıcı bunu import map olmadan çözemez'
    );
});

test('vendor bağımlılıkları kendi origin\'imizden sunuluyor', () => {
    // script-src 'self' zaten CDN'i engellerdi; bu kontrol, sayfanın sessizce
    // boş kalması yerine testin bağırmasını sağlar.
    for (const page of fs.readdirSync(publicDir).filter(f => f.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
        const externals = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi)]
            .map(m => m[1])
            .filter(src => /^(https?:)?\/\//.test(src));

        assert.deepEqual(externals, [], `${page} dış kaynaklı script yüklüyor: ${externals.join(', ')}`);
    }
});
