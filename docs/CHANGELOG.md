# Changelog — Kalite & Ses İyileştirmeleri (2026-06-13)

Bu sürüm, ses bug'larını gidermeye, yayın/ses kalitesini artırmaya ve oda içi deneyimi iyileştirmeye odaklanır.
Detaylı analiz için `docs/QUALITY-AUDIO-RESEARCH.md` dosyasına bakın.

## 🔴 Kritik ses düzeltmeleri

### B1 — Admin mikrofonu yayından önce açılınca ses gitmiyor
- **Dosya:** `public/room.js`
- **Kök neden:** Mikrofon, `producerTransport` oluştuktan sonra (`startStream`) hiç yayımlanmıyordu.
- **Çözüm:** Yeni `republishAdminMic()` fonksiyonu; `startStream()` sonunda ve mic toggle'da çağrılır. Transport hazır değilse birkaç kez dener.

### B2a — İzleyici sesi açık olsa bile gelmiyor (autoplay)
- **Dosya:** `public/room.js`
- **Kök neden:** Ayrı `<audio>` elementleri `.play()` çağrılmadan `autoplay` ile bırakılıyordu; tarayıcı autoplay politikası engelliyordu.
- **Çözüm:** `playAudioElement()` her elementte `play()` çağırır, reddedilirse sessiz modda dener; `setupAudioGestureUnlock()` ilk kullanıcı etkileşiminde bekleyen tüm sesleri açar.

### B2b — İzleyici mikrofonu kapansa bile ses geliyor (temizlik yarışı)
- **Dosya:** `public/room.js`
- **Kök neden:** Consumer'larda `producerclose`/`trackended` dinlenmiyordu; temizlik sadece socket event'ine bağlıydı.
- **Çözüm:** `attachConsumerCleanup()` her consumer'a `producerclose`/`trackended`/`transportclose` ekler; paylaşılan `closeAndRemoveConsumer()` güvenli temizlik yapar.

### B3 — Opus DTX kaynaklı cızırtı/kesik
- **Dosyalar:** `backend/config.js`, `public/room.js`
- **Kök neden:** `usedtx:1` / `opusDtx:1` sabit olmayan gürültüde periyodik patlama ve ön-kesik yapıyor (Opus issue #89).
- **Çözüm:** Tüm producer ve router seviyesinde DTX kapatıldı (`usedtx:0`, `opusDtx:0`). Mikrofon bitrate 48→64kbps'e çıkarıldı.

### B4 — Audio mute durumunun video'ya bağlanması
- **Dosya:** `public/room.js`
- **Kök neden:** `audioEl.muted = remoteVideo.muted` — video sessiz modda düşerse ses elementleri de sessiz kalıyordu.
- **Çözüm:** Bağımsız `audioMutedState` + `syncAllAudioElements()`. Mute/volume tüm elementlerde tutarlı.

## 🟠 Kalite & tutarlılık

- **A4:** `autoGainControl:true` tüm mikrofon `getUserMedia` çağrılarına eklendi.
- **A5:** VAD eşiği histeresisli (başlama 0.025 / bitirme 0.012); fan/klavye tetilemeler azaldı.
- **A8:** Ses seviyesi `localStorage`'a kaydedilir / geri yüklenir.
- **V2:** `minimumAvailableOutgoingBitrate` 3 Mbps → 1.5 Mbps (zayıf bağlantı adaptasyonu).
- **V8:** Stats paneline ses metrikleri eklendi (bitrate, loss, jitter).
- **V4/U5:** Socket.io reconnection açık + reconnect bildirimleri; `resetMediaState()` reconnect'te çift element/transport birikmesini önler.
- **A2:** Opus `ptime:20` eklendi (tutarlı paket boyutu / düşük gecikme).

## 🟡 Kullanıcı deneyimi

- **U1:** Yayın sahibi konuşurken video alanında konuşma halkası (`speaking-ring`).
- **U2:** Mikrofon ve sistem sesi butonları net açık/kapalı görsel state (renk + metin).
- **U3:** Sistem sesi kapatıp açınca tekrar ekran paylaşım izin diyaloğu çıkmıyor (mevcut track yeniden kullanılıyor).
- **U4:** İzleyiciler için `beforeunload` çıkış uyarısı.
- **U7:** Yüksek paket kaybında otomatik "bağlantı zayıf" uyarısı.

## 🛠️ Altyapı / backend

- **`backend/server.js`:** `new-producer` bildirimi artık `{ id, kind, source }` gönderiyor (client audio/video'yu ayırt edebiliyor; eski id-only formatla uyumlu).
- **`backend/config.js`:** DTX kapalı, `ptime` eklendi, bitrate tabanı düşürüldü; açıklayıcı yorumlar.

## ✅ Geriye dönük uyumluluk
- `new-producer` event'i hem obje hem düz id kabul eder.
- `consumeProducer` imzası geriye uyumlu.
- Yeni bağımlılık eklenmedi.
- Tüm dosyalar `node --check` ile doğrulandı.
