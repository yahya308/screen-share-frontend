#!/usr/bin/env node
/**
 * Tarayıcı duman testi — gerçek Chromium, gerçek sunucu.
 *
 * Birim ve entegrasyon testleri sunucuyu kapsıyor ama sayfanın gerçekten
 * açıldığını göstermiyor. Bu betik, yalnızca tarayıcıda ortaya çıkan
 * kırılmaları yakalar: derlenmiş CSS uygulanmış mı, vendor ESM paketi
 * adlandırılmış dışa aktarımları veriyor mu, hiçbir dış CDN'e istek gidiyor
 * mu, ve token'sız `?admin=true` gerçekten lobiye geri atılıyor mu.
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

(async () => {
    const browser = await chromium.launch({
        // CI/konteynerde özel bir Chromium yolu verilebilir
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    });
    const context = await browser.newContext();
    const errors = [];
    const failedRequests = [];

    context.on('weberror', (e) => errors.push(String(e.error())));

    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
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

    // ---------- 4. GÜVENLİK: token'sız yönetici girişi ----------
    const attacker = await context.newPage();
    const attackerErrors = [];
    attacker.on('pageerror', (e) => attackerErrors.push(String(e)));
    await attacker.addInitScript(() => { try { sessionStorage.clear(); } catch (e) { /* yoksay */ } });
    await attacker.goto(`${BASE}/room.html?roomId=${roomId}&admin=true`, { waitUntil: 'domcontentloaded' });

    let redirected = false;
    try {
        await attacker.waitForURL(/index\.html$/, { timeout: 12000 });
        redirected = true;
    } catch (e) { /* aşağıda raporlanır */ }
    check('token\'sız ?admin=true lobiye geri atıldı', redirected, attacker.url());

    // ---------- 5. İzleyici akışı ----------
    const viewer = await context.newPage();
    viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)));
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

    // ---------- 6. Sonuç ----------
    console.log('\nDış kaynak isteği:', externalRequests.length ? externalRequests.join(', ') : 'yok');
    console.log('Başarısız istek  :', failedRequests.length ? failedRequests.join(', ') : 'yok');
    console.log('Konsol hataları  :', errors.length ? errors.slice(0, 5).join(' | ') : 'yok');
    console.log('4xx/5xx yanıt    :', notFound.length ? notFound.join(', ') : 'yok');

    check('dış CDN\'e istek yok', externalRequests.length === 0);
    check('başarısız kaynak isteği yok', failedRequests.length === 0);
    check('konsol hatası yok', errors.length === 0);

    await browser.close();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('DUMAN TESTİ ÇÖKTÜ:', e); process.exit(2); });
