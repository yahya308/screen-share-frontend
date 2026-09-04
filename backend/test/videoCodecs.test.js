/**
 * Router video codec yapılandırması.
 *
 * Bu dosya iki somut üretim sorununu kalıcı olarak kapatıyor:
 *
 * 1) H264 seviyesi '42e01f' (Level 3.1) idi ve tavanı 1280x720@30. H264
 *    seçilse bile 1080p taşınamıyor, yüksek çözünürlükte kare hızı çöküyordu.
 * 2) AV1 hiç tanımlı değildi. Ekran içeriği kodlaması (screen content coding)
 *    libwebrtc'de ekran kaynaklı track'ler için otomatik açılıyor ve dar
 *    bantta belirgin fark yaratıyor; codec router'da yoksa istemci onu hiç
 *    göremez.
 *
 * Testler mediasoup worker'ı GEREKTİRMEZ — yalnızca ortc doğrulaması çalışır,
 * dolayısıyla mediasoup'un derlenmediği makinelerde de koşar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ortc = require('../node_modules/mediasoup/node/lib/ortc.js');
const config = require('../config');

const mediaCodecs = config.mediasoup.router.mediaCodecs;
const videoCodecs = mediaCodecs.filter(c => c.kind === 'video');
const mimeTypes = videoCodecs.map(c => c.mimeType.toLowerCase());

test('router yapılandırması mediasoup doğrulamasından geçer', () => {
    // Elle yazılmış bir codec girdisi (ör. AV1) hatalıysa sunucu ancak ilk oda
    // açılışında patlıyor. Burada açılışa gerek kalmadan yakalıyoruz.
    const caps = ortc.generateRouterRtpCapabilities(mediaCodecs);
    assert.ok(caps.codecs.length > 0);
});

test('AV1 router codec listesinde', () => {
    assert.ok(
        mimeTypes.includes('video/av1'),
        'AV1 tanımlı değil; istemci ekran içeriği kodlamasını hiç seçemez'
    );
});

test('H264 seviyesi 1080p taşıyabiliyor', () => {
    const h264 = videoCodecs.find(c => c.mimeType.toLowerCase() === 'video/h264');
    assert.ok(h264, 'H264 tanımlı değil');

    const profileLevelId = h264.parameters?.['profile-level-id'];
    assert.ok(profileLevelId, 'profile-level-id yok');

    // profile-level-id son baytı level_idc'dir: 0x1f=31 (3.1), 0x28=40 (4.0),
    // 0x2a=42 (4.2). Level 3.1'in tavanı 1280x720@30 — 1080p için yetmez.
    const levelIdc = parseInt(profileLevelId.slice(-2), 16);
    assert.ok(
        levelIdc >= 0x28,
        `H264 seviyesi çok düşük (level_idc=${levelIdc}); 1080p için en az 0x28 (Level 4.0) gerekir`
    );
});

test('VP9 hâlâ tanımlı (ekranda kullanılmıyor ama kaldırılmadı)', () => {
    // İstemci ekran paylaşımında VP9'u tercih etmiyor (webrtc:13016, tek uzamsal
    // katmanlı VP9 screencast 5 fps'e kilitleniyor) ama codec'i router'dan
    // düşürmek eski istemcilerle pazarlığı kırar.
    assert.ok(mimeTypes.includes('video/vp9'));
});

test('istemcinin seçebileceği tüm ekran codec\'leri router\'da var', () => {
    // room.js CODEC_ORDER'daki her seçenek burada karşılık bulmalı; yoksa
    // kullanıcı arayüzden seçer ve sessizce başka bir codec'e düşer.
    for (const mime of ['video/av1', 'video/vp8', 'video/h264', 'video/vp9']) {
        assert.ok(mimeTypes.includes(mime), `${mime} router'da yok`);
    }
});
