#!/usr/bin/env node
/**
 * Tarayıcı duman testi — gerçek Chromium, gerçek sunucu.
 *
 * Birim ve entegrasyon testleri sunucuyu kapsıyor ama sayfanın gerçekten
 * açıldığını göstermiyor. Bu betik, yalnızca tarayıcıda ortaya çıkan
 * kırılmaları yakalar: derlenmiş CSS uygulanmış mı, vendor ESM paketi
 * adlandırılmış dışa aktarımları veriyor mu, hiçbir dış CDN'e istek gidiyor
 * mu, CSP sayfanın kendi kodunu engelliyor mu, ve token'sız `?admin=true`
 * yönetici arayüzünü açıyor mu.
 *
 * Sunucu artık ön yüzü üretimdekiyle (Vercel) aynı CSP başlığıyla sunuyor;
 * yoksa bu betik gerçekte sevk edilenden farklı bir sayfayı test eder —
 * satır içi import map tam olarak böyle gözden kaçmıştı.
 *
 * Kullanım:
 *   cd backend && node -e "require('./server.js').start({port:3100})" &
 *   BASE=http://localhost:3100 node scripts/smoke-browser.js
 */
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (e) {
    console.error('Playwright kurulu değil. Duman testi isteğe bağlıdır:');
    console.error('  npm i -D playwright && npx playwright install chromium');
    process.exit(0);
}

const BASE = process.env.BASE || 'http://localhost:3100';
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * Sayfadaki RTCPeerConnection'ları yakalayıp `window.__rtcStats(tip, kind)`
 * yardımcısını kurar. Uygulama transport'ları modül kapsamında tuttuğu için
 * dışarıdan erişilemiyor; kurucuyu sarmalamak tek yol. Transport'lar bu
 * çağrıdan SONRA oluştuğundan sayfa yüklendikten sonra kurmak yeterli.
 */
async function captureRtcStats(target) {
    await target.evaluate(() => {
        const pcs = [];
        const Orig = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...args) {
            const pc = new Orig(...args);
            pcs.push(pc);
            return pc;
        };
        window.RTCPeerConnection.prototype = Orig.prototype;
        Object.setPrototypeOf(window.RTCPeerConnection, Orig);

        window.__rtcStats = async (type, kind) => {
            const total = { framesEncoded: 0, framesDecoded: 0, bytesSent: 0, bytesReceived: 0, pliCount: 0, scalabilityMode: null };
            for (const pc of pcs) {
                (await pc.getStats()).forEach((r) => {
                    if (r.type !== type || r.kind !== kind) return;
                    total.framesEncoded += r.framesEncoded || 0;
                    total.framesDecoded += r.framesDecoded || 0;
                    total.bytesSent += r.bytesSent || 0;
                    total.bytesReceived += r.bytesReceived || 0;
                    total.pliCount += r.pliCount || 0;
                    if (r.scalabilityMode) total.scalabilityMode = r.scalabilityMode;
                });
            }
            return total;
        };
    });
}

(async () => {
    const browser = await chromium.launch({
        // CI/konteynerde özel bir Chromium yolu verilebilir
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    });
    const context = await browser.newContext();
    const errors = [];
    const failedRequests = [];
    // CSP ihlalleri konsola "hata" olarak düşer ama diğer hatalarla karışır.
    // Ayrı tutuyoruz: sayfanın kendi kodunun engellenmesi tek başına raporlanacak
    // kadar önemli — engellenen bir import map room.js'i tamamen sustururken
    // sayfa "sadece izleyici ekranı" gibi görünüyordu.
    const cspViolations = [];
    const noteError = (text) => {
        errors.push(text);
        if (/Content Security Policy/i.test(text)) cspViolations.push(text);
    };

    context.on('weberror', (e) => noteError(String(e.error())));

    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') noteError(m.text()); });
    page.on('pageerror', (e) => noteError(String(e)));
    page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
    const notFound = [];
    context.on('response', (r) => { if (r.status() >= 400) notFound.push(`${r.status()} ${r.url()}`); });

    // ---------- 1. Lobi ----------
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    check('lobi sayfası yüklendi', await page.title() !== '');

    // Tailwind derlenmiş CSS gerçekten uygulanmış mı?
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    const btnStyled = await page.evaluate(() => {
        const b = document.getElementById('btnCreateRoom');
        if (!b) return '';
        const cs = getComputedStyle(b);
        // Tailwind sınıfı gerçekten uygulanmışsa yuvarlatma ve dolgu gelir
        return `${cs.borderRadius}|${cs.paddingLeft}|${cs.backgroundImage.slice(0, 20)}`;
    });
    check('derlenmiş Tailwind CSS uygulandı', /^[1-9]/.test(btnStyled) && !btnStyled.startsWith('0px|0px'), btnStyled);
    check('özel <style> bloğu korundu', bodyBg.includes('gradient'));

    // Dış kaynağa istek gitmiyor mu?
    const externalRequests = [];
    page.on('request', (r) => {
        const u = r.url();
        if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) externalRequests.push(u);
    });

    // ---------- 2. Oda oluştur ----------
    await page.click('#btnCreateRoom');
    await page.fill('#createNickname', 'yayinci');
    await page.fill('#roomName', 'Duman Testi Odasi');
    await page.fill('#roomMaxUsers', '20');
    await page.click('#btnConfirmCreate');

    await page.waitForURL(/room\.html\?roomId=.*admin=true/, { timeout: 15000 });
    const roomUrl = page.url();
    const roomId = new URL(roomUrl).searchParams.get('roomId');
    check('oda oluştu ve yönetici olarak yönlendirildi', !!roomId, roomId);

    const token = await page.evaluate((id) => sessionStorage.getItem(`velo_admin_token_${id}`), roomId);
    check('adminToken sessionStorage\'a yazıldı', /^[0-9a-f]{64}$/.test(token || ''));

    // ---------- 3. Oda sayfası + mediasoup-client ----------
    await page.waitForTimeout(2500);
    const roomName = await page.textContent('#roomName');
    check('admin-rejoin başarılı, oda adı geldi', roomName === 'Duman Testi Odasi', roomName);

    const msLoaded = await page.evaluate(() => {
        return fetch('/vendor/mediasoup-client.esm.js').then(r => r.ok);
    });
    check('mediasoup-client kendi origin\'imizden sunuluyor', msLoaded);

    const adminUiVisible = await page.isVisible('#btnStartStream');
    check('yönetici arayüzü açıldı', adminUiVisible);

    // Bildirilen üretim hatası buydu: CSP satır içi import map'i engelliyor,
    // room.js modülü hiç çalışmıyor ve oda sahibi yönetici paneli yerine boş
    // izleyici ekranını görüyordu. Sayfa gerçekten CSP altında mı sunuldu ve
    // kendi kodumuz engellendi mi — ikisini de açıkça soruyoruz.
    const cspHeader = await page.evaluate(async () => {
        const r = await fetch(location.pathname, { cache: 'no-store' });
        return r.headers.get('content-security-policy') || '';
    });
    check('oda sayfası üretimdeki CSP ile sunuldu', /script-src 'self'/.test(cspHeader), cspHeader.slice(0, 60));
    check('CSP sayfanın kendi kodunu engellemedi', cspViolations.length === 0, cspViolations[0] || '');

    // ---------- 4. GÜVENLİK: token'sız yönetici girişi ----------
    const attacker = await context.newPage();
    const attackerErrors = [];
    attacker.on('pageerror', (e) => attackerErrors.push(String(e)));
    await attacker.addInitScript(() => { try { sessionStorage.clear(); } catch (e) { /* yoksay */ } });
    await attacker.goto(`${BASE}/room.html?roomId=${roomId}&admin=true`, { waitUntil: 'domcontentloaded' });

    await attacker.waitForTimeout(2500);

    // Artık lobiye geri atmıyoruz: yetkisiz ziyaretçi izleyici olarak devam
    // ediyor. Güvenlik iddiası aynı ve daha doğrudan — yönetici arayüzü
    // AÇILMAMALI.
    const attackerStartVisible = await attacker.isVisible('#btnStartStream').catch(() => false);
    const attackerPanelHidden = await attacker.evaluate(
        () => document.getElementById('adminPanel')?.classList.contains('hidden')
    );
    check(
        'token\'sız ?admin=true yönetici arayüzünü açmıyor',
        attackerStartVisible === false && attackerPanelHidden === true,
        `başlatBtnGörünür=${attackerStartVisible} panelGizli=${attackerPanelHidden}`
    );

    // ---------- 5. İzleyici akışı ----------
    const viewer = await context.newPage();
    viewer.on('pageerror', (e) => noteError('viewer: ' + String(e)));
    await viewer.goto(`${BASE}/room.html?roomId=${roomId}`, { waitUntil: 'domcontentloaded' });
    await viewer.waitForSelector('#nicknameModal', { state: 'visible', timeout: 10000 }).catch(() => {});
    await viewer.fill('#nicknameInput', 'izleyici1').catch(() => {});
    await viewer.click('#btnConfirmNickname').catch(() => {});
    await viewer.waitForTimeout(2500);

    const userCount = await page.textContent('#userCount').catch(() => '?');
    check('izleyici katıldı ve sayaç güncellendi', userCount === '2', `sayaç=${userCount}`);

    const userItems = await page.locator('#userListContainer [data-socket-id]').count();
    check('kullanıcı listesi çizildi', userItems === 2, `${userItems} satır`);

    // Moderasyon butonu (delege dinleyici) çalışıyor mu?
    const kickBtn = await page.locator('#userListContainer button[data-action="kick"]').count();
    check('moderasyon butonları satır içi onclick olmadan üretildi', kickBtn === 1);

    // ---------- 6. Medya gerçekten akıyor mu? ----------
    // Bildirilen üretim hatası: yayıncı yayını başlatıyor, kendi önizlemesini
    // sorunsuz görüyor, sunucu hata döndürmüyor — ama izleyicide ekran siyah.
    // Sebep yanlış bir scalabilityMode'du: kodlayıcı hiç çalışmıyordu. Hiçbir
    // birim testi bunu göremez; ancak gerçek kodlayıcı + gerçek SFU ile ölçülür.
    //
    // Ekran seçici otomatikleştirilemediği için getDisplayMedia'yı hareketli bir
    // canvas ile değiştiriyoruz. Kaynağın ötesindeki her şey (codec seçimi,
    // scalabilityMode, produce, SFU, consume, decode) gerçek koddur.
    await page.bringToFront();
    await captureRtcStats(page);
    await captureRtcStats(viewer);

    await page.evaluate(() => {
        const cv = document.createElement('canvas');
        cv.width = 640; cv.height = 360;
        const ctx = cv.getContext('2d');
        let f = 0;
        setInterval(() => {
            f++;
            ctx.fillStyle = `hsl(${f % 360},70%,45%)`;
            ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.fillStyle = '#fff';
            ctx.font = '48px sans-serif';
            ctx.fillText('F' + f, 40, 180);
        }, 100);
        const stream = cv.captureStream(30);
        navigator.mediaDevices.getDisplayMedia = async () => stream;
    });

    await page.click('#btnStartStream');
    await page.waitForTimeout(9000);

    const sent = await page.evaluate(() => window.__rtcStats('outbound-rtp', 'video'));
    check(
        'yayıncının kodlayıcısı kare üretti',
        sent.framesEncoded > 0,
        `framesEncoded=${sent.framesEncoded} bytesSent=${sent.bytesSent} mode=${sent.scalabilityMode || '-'}`
    );

    const received = await viewer.evaluate(() => window.__rtcStats('inbound-rtp', 'video'));
    check(
        'izleyici görüntüyü çözdü (siyah ekran yok)',
        received.framesDecoded > 0,
        `framesDecoded=${received.framesDecoded} pli=${received.pliCount}`
    );

    const viewerVideo = await viewer.evaluate(() => {
        const v = document.getElementById('remoteVideo');
        return { readyState: v?.readyState ?? -1, width: v?.videoWidth ?? 0 };
    });
    check(
        'izleyicinin video elementinde gerçek kare var',
        viewerVideo.readyState >= 2 && viewerVideo.width > 0,
        `readyState=${viewerVideo.readyState} genişlik=${viewerVideo.width}`
    );

    // ---------- 7. Sorgu parametresi olmadan yönetici ----------
    // Bildirilen üretim hatası: oda oluşturunca yönetici yerine izleyici tarafı
    // açılıyordu. Yönetici modu artık URL'e değil token'a bağlı; `?admin=true`
    // hiç olmasa bile sekmede sır varsa yönetici arayüzü açılmalı.
    await page.goto(`${BASE}/room.html?roomId=${roomId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const adminWithoutFlag = await page.isVisible('#btnStartStream').catch(() => false);
    check('token varken ?admin=true olmadan da yönetici açılıyor', adminWithoutFlag === true);

    // ---------- 8. Sonuç ----------
    console.log('\nDış kaynak isteği:', externalRequests.length ? externalRequests.join(', ') : 'yok');
    console.log('Başarısız istek  :', failedRequests.length ? failedRequests.join(', ') : 'yok');
    console.log('Konsol hataları  :', errors.length ? errors.slice(0, 5).join(' | ') : 'yok');
    console.log('CSP ihlali       :', cspViolations.length ? cspViolations.slice(0, 3).join(' | ') : 'yok');
    console.log('4xx/5xx yanıt    :', notFound.length ? notFound.join(', ') : 'yok');

    check('dış CDN\'e istek yok', externalRequests.length === 0);
    check('başarısız kaynak isteği yok', failedRequests.length === 0);
    check('konsol hatası yok', errors.length === 0);

    await browser.close();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('DUMAN TESTİ ÇÖKTÜ:', e); process.exit(2); });
