# VELOSTREAM — Yayın, Ses ve Oda İçi Deneyim Kalitesi Araştırma Raporu

> Hazırlanan tarih: 2026-06-13
> Kapsam: `public/room.js`, `backend/server.js`, `backend/RoomManager.js`, `backend/config.js`, `public/room.html`
> Amaç: Yayın kalitesi, ses kalitesi ve oda içi kullanıcı deneyimi üzerinde derinlemesine analiz; bildirilen ses bug'larının kök nedenlerini bulmak; ve uygulanabilir iyileştirme listesi sunmak.

---

## 1. Yönetici Özeti

Repo'daki tüm medya yolunu (client producer/consumer → mediasoup SFU → client oynatma) satır satır inceledik. **Bildirilen üç ses belirtisinin de** somut, kodda izlenebilir kök nedenleri var:

| # | Belirti | Kök Neden | Güven |
|---|---------|-----------|-------|
| B1 | "Mikrofonu açık yayıncı yayın yapmaya başlayınca ses gitmiyor" | Admin mikrofonu **yayın başlamadan önce** açarsa `micProducer` hiç oluşturulmuyor (transport henüz yok) ve `startStream()` mevcut `micTrack`'i yeniden yayınlamıyor | **Kesin** |
| B2a | "İzleyici sesi açık olsa bile gelmiyor (arada bir)" | Ayrı `<audio>` elementleri `autoplay` ile bırakılıyor; `.play()` çağrılmıyor, autoplay reddi handle edilmiyor → tarayıcı autoplay politikası engelliyor | **Kesin** |
| B2b | "İzleyici mikrofonu kapatsa bile ses geliyor (arada bir)" | Client tarafında `producerclose`/`trackended` event'leri dinlenmiyor; temizlik sadece socket `producer-closed`'a bağlı → yarış koşulları stale/eksik audio element bırakıyor + DTX comfort-noise artefaktları | **Yüksek** |
| B3 | "Ses bazen cızırtılı/kesik" | Opus DTX (`usedtx:1` + `opusDtx:1`) sabit olmayan ortam gürültüsünde periyodik gürültü patlamaları üretir (Opus issue #89) | **Yüksek** |

Bunlara ek olarak video/yayın kalitesi ve UX açısından **30+ iyileştirme** tespit edildi. Bu dokümanın sonunda tüm düzeltmeler listelenmiş ve kodda uygulanmıştır.

---

## 2. Metodoloji

1. Tüm repoyu workspace'e klonladık, `node_modules` dışındaki tüm kaynak dosyalar okundu.
2. Medya akışı her dosyada izlendi: `getDisplayMedia`/`getUserMedia` → `producerTransport.produce()` → server `transport-produce` → `new-producer` → `consumerTransport.consume()` → `<audio>`/`<video>` oynatma.
3. Bildirilen belirtiler için her olası kod yolu manuel olarak takip edildi (state değişkenleri, event handler'lar, yarış koşulları).
4. Bulgular W3C/Mediasoup/Chrome autoplay politikası ve Opus DTX literatürü ile doğrulandı.

---

## 3. KRİTİK SES BUG'LARI — Kök Neden Analizi

### 🔴 B1 — Admin mikrofonu yayından önce açılınca ses gitmiyor

**Belirti:** Yayıncı önce "🎤 Kendi Mikrofonum"u açıyor, sonra "Yayın Başlat"ıyor → izleyiciler yayını görüyor ama mikrofon sesini duymuyor.

**İzlenen kod yolu (`public/room.js`):**

```js
// btnToggleMic handler — mikroyu AÇMA dalı:
const stream = await navigator.mediaDevices.getUserMedia({ audio: {...} });
micTrack = stream.getAudioTracks()[0];
btnToggleMic.textContent = '🎤 Kendi Mikrofonum (Açık)';  // <-- UI "Açık" diyor
if (producerTransport) {                                  // <-- AMA transport YOK (yayın başlamadı)
    micProducer = await producerTransport.produce({ track: micTrack, ... });
}
```

`producerTransport` sadece `initMediasoup()` → `createSendTransport()` içinde oluşturulur ve bu **ancak yayın başlayınca** çağrılır. Yani:

- Mikrofon açılır → `micTrack` var, `micProducer = null`, UI "Açık".
- Admin "Yayın Başlat"a basar → `startStream()` çalışır:
  ```js
  [videoProducer, ..., micProducer].forEach(p => { if (p) { ...p.close(); } });
  // micProducer null → hiçbir şey kapanmaz
  videoProducer = ... = micProducer = null;
  // sonra sadece videoProducer + systemAudioProducer oluşturulur
  // micTrack HÂLÂ VAR ama micProducer ASLA yeniden oluşturulmuyor ❌
  ```
- Sonuç: mikrofon UI'da "Açık", track canlı, ama **hiçbir producer yok → ses sunucuya hiç gitmiyor.**

Bu tam olarak kullanıcının bildirdiği "mikrofonu açık yayıncı yayın yapmaya başlayınca ses gitmiyor" belirtisidir.

**Çözüm:** `startStream()` sonunda, eğer `micTrack` var ama `micProducer` yoksa producer'ı oluştur. Ayrıca `btnToggleMic`'i transport yokken güvenli hale getir. *(Uygulandı — bkz. Bölüm 8.)*

---

### 🔴 B2a — İzleyici sesi açık olsa bile gelmiyor (arada bir)

**Belirti:** İzleyici mikrofonunu açıyor, diğerleri bazen duyuyor bazen duymuyor. Zamanla değişiyor.

**İzlenen kod yolu (`consumeProducer()`, audio dalı):**

```js
const audioEl = document.createElement('audio');
audioEl.autoplay = true;
audioEl.playsInline = true;
if (volumeSlider) audioEl.volume = volumeSlider.value;
audioEl.muted = remoteVideo.muted;
audioEl.srcObject = new MediaStream([consumer.track]);
document.body.appendChild(audioEl);
// ❌ audioEl.play() HİÇ ÇAĞRILMIYOR
// ❌ play() reddi HİÇ HANDLE EDİLMİYOR
```

**Neden arada bir:** Chrome/Safari/Firefox autoplay politikası, MediaStream destekli `<audio>` elementlerinin **kullanıcı etkileşimi (gesture) olmadan** otomatik çalınmasına izin vermez veya koşullu izin verir. [webrtcHacks][1], [Chrome discuss-webrtc][2]:

> *"MediaStreamTracks from PeerConnections... may not autoplay; per Chrome policy, a user gesture will be required before any attempt to play out audio."*

VELOSTREAM'de video için bir `autoPlayVideo()` fallback'i var (sessiz moda düşüp tekrar dener), **ama audio için hiçbir şey yok.** Ses elementi `autoplay=true` ile bırakılıyor ve umuda kapılıyor. İzleyicinin sayfada yaptığı etkileşim miktarına (butona basıp basmamasına) göre çalışır ya da çalışmaz → **"zaman zaman değişiyor."**

**Çözüm:** Her audio elementinde `audioEl.play().catch(...)` çağır; reddedilirse sessiz-mod tekniği uygula ve gerçek oynatmayı sonraki ilk kullanıcı etkileşiminde garantile. *(Uygulandı.)*

[1]: https://webrtchacks.com/autoplay-restrictions-and-webrtc/
[2]: https://groups.google.com/g/discuss-webrtc/c/BwJOWloyS34

---

### 🔴 B2b — İzleyici mikrofonu kapatsa bile ses geliyor (arada bir)

**Belirti:** İzleyici mikrofonunu kapatıyor ama diğerleri hâlâ sesini duyuyor (bazen).

**İzlenen kod yolu:** Bir consumer oluşturulurken:

```js
const consumer = await consumerTransport.consume({...});
consumers.set(consumer.id, consumer);
// ❌ consumer.on('producerclose', ...) YOK
// ❌ consumer.on('trackended', ...) YOK
// ❌ transport.on('producer...close') YOK
```

Mute akışı: izleyici `closeViewerMic()` → `socket.emit('producer-closing')` → server producer'ı kapatır → `socket.to(room).emit('producer-closed')`. Client tarafı `producer-closed`'ı dinler ve audio elementini kaldırır. **Ama mediasoup-client ayrıca consumer'da `producerclose` event'i fırlatır** ve bu event'ler **handle edilmiyor.**

Sonuç: Socket event'i ile mediasoup'un internal event'i arasında yarış var. `producer-closed` socket mesajı gecikirse/sıra dışı gelirse/gelmezse (ör. bağlantı o an zayıfsa), audio elementi DOM'da kalır. Paket akışı durduğu için genelde sessizleşir, **ama DTX comfort-noise frame'leri ve буferlanmış son paketler kısa süreli "hayalet ses" üretebilir.** Ayrıca ikinci kez mikrofon açıldığında eski elementler doğru temizlenmezse çakışma olur.

**Çözüm:** Her consumer'a `producerclose` ve `trackended` listener ekle (DOM elementini güvenli kaldırsınlar). Böylece socket event'i gelse de gelmese de temizlik garanti. *(Uygulandı.)*

---

### 🟠 B3 — Opus DTX kaynaklı cızırtı/kesik

**Belirti:** Ses bazen metalik, cızırtılı ya da kelime başları kesik geliyor.

**Kod:** `backend/config.js` router seviyesinde:
```js
{ kind: 'audio', mimeType: 'audio/opus', channels: 2, parameters: {
    usedtx: 1, stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: 128000, useinbandfec: 1 } }
```
Ve client `producerTransport.produce({ codecOptions: { opusDtx: 1, ... } })`.

**Sorun:** DTX (Discontinuous Transmission) sessizlikte paket göndermeyi durdurur ve comfort-noise (CN) frame'leri gönderir. Opus'un kendi VAD'i ile SILK katmanı VAD'i **anlaşmazsa** periyodik "gürültü patlamaları" oluşur — bu resmi olarak [Opus issue #89](https://github.com/xiph/opus/issues/89) ile belgelenmiştir:

> *"Periodic noise bursts in DTX... The reason for these clicks is a mismatch between two voice activity detectors... the decoder will conceal the DTX region by using packet loss concealment (PLC) instead of pure comfort noise (CNG). This will cause a noise burst every time a packet is decoded."*

Ayrıca DTX, konuşma yeniden başladığında ilk milisaniyeleri "ön-kesik" (front clipping) yapar → kelime başları kesik duyulur. Bu davranış ortam gürültüsüne bağlı olduğu için **arada bir** ortaya çıkar.

**Çözüm:** Sesli iletişim için DTX'i kapat (`usedtx: 0`, `opusDtx: 0`). Bant genişliği tasarrufu (DTX'in tek avantajı) günümüzde ihmal edilebilir; ses kalitesi ve tutarlılık çok daha önemli. Sistem sesi (müzik/film) zaten DTX'den zarar görür. *(Uygulandı.)*

---

### 🟠 B4 — Audio element mute durumunun video'ya bağlanması

```js
audioEl.muted = remoteVideo.muted;   // her audio consumer oluşturulurken
```

Eğer `remoteVideo` autoplay politikası yüzünden `muted=true`'a düşerse (ki `autoPlayVideo()` bunu yapar), **yeni oluşturulan tüm ses elementleri de sessiz başlar** ve otomatik geri açılmazlar. Mikrofon/sistem sesi için mute mantığı video mute ile aynı olmamalı.

**Çözüm:** Audio elementleri bağımsız bir `audioMuted` state'i kullansın; volume/mute kontrolleri tüm elementleri (video + audio) tutarlı senkronize etsin. *(Uygulandı.)*

---

## 4. YAYIN (VİDEO) KALİTESİ ANALİZİ

### Mevcut durum
- Codec önceliği: VP9 → VP8 → H264. VP9 ekran paylaşımı için doğru seçim (daha iyi sıkıştırma).
- `scalabilityMode: 'L1T3'` — 1 uzamsal (spatial) + 3 zamansal (temporal) katman. Yani **simulcast kapalı** (README'de de belirtilmiş).
- Otomatik kalite sadece **temporal** katman değiştirir (60→30 fps), çözünürlüğü asla düşürmez.

### Tespitler

| ID | Konu | Etki |
|----|------|------|
| V1 | **Kalite seçici yanıltıcı.** "Yüksek/Orta/Düşük" sadece FPS değiştiriyor, çözünürlüğü değil (simulcast yok). Kötü bağlantıda "Düşük" seçmek sadece framerate düşürür, görüntü pikselleşmeye devam eder. | Kötü bağlantıda görüntü takılır |
| V2 | `minimumAvailableOutgoingBitrate: 3000000` (3 Mbps taban) — bu transport başına alt sınır. Çok düşük bantlı izleyicide mediasoup 3 Mbps'in altına inemez → paket kaybı birikir. | Mobil/zayıf bağlantıda donma |
| V3 | `maxIncomingBitrate` aynı değerde hem sender hem receiver transport'a `setMaxIncomingBitrate`/`setMaxOutgoingBitrate` olarak uygulanıyor. Receiver'da 50 Mbps sınır anlamsız (tek akış için). | Hafif kafa karışıklığı, zararsız |
| V4 | ICE restart var ama **socket reconnect + otomatik yeniden consume** yok. Sinyalleme koparsa izleyici manuel reload yapmak zorunda. | Bağlantı kopması = reload |
| V5 | `jitterBufferTarget = 100ms` sadece video receiver'a set ediliyor; audio için jitter buffer ayarı yok. | Audio jitter'da gecikme dalgalanması |
| V6 | Keyframe istekleri yalnız `stalled` event'inde; `freeze`/ uzun GOP sonrası bozulmada talep edilmiyor. | Görüntü bozulması uzun sürebilir |
| V7 | `contentHint = 'detail'` ekran paylaşımı için doğru, ama film/mod oynatımı için `'motion'` daha iyi olabilir. Kullanıcı seçimine bırakılabilir. | Düşük hareketli içerikte gereksiz bitrate |
| V8 | Video için stats var; **audio bitrate/loss/jitter stats yok.** Ses sorununu teşhis etmek zor. | Debug zor |

---

## 5. SES KALİTESİ ANALİZİ (genel)

| ID | Konu | Etki | Öneri |
|----|------|------|-------|
| A1 | DTX açık (B3) | Gürültü patlaması, ön kesik | **Kapat** |
| A2 | Router `channels:2, stereo:1` ama mikrofon producer'ları `opusStereo:0` (mono) istiyor | Codec anlaşmazlığı; bazı istemcilerde stereo/mono geçişinde artefakt | Mikrofon için tutarlı mono; sistem sesi için stereo |
| A3 | Mikrofon `maxaveragebitrate:48000` (48kbps) — voice için yeterli ama **sistem sesi 128kbps stereo** ve aynı router'da mixlanmiyor | Müzik/film sesinde kalite düşük değil ama mono mic ile stereo system ayrı stream → çift kontrol gerekir | Ayrı tutmaya devam et, iyi |
| A4 | `echoCancellation:true, noiseSuppression:true` mikrofonda açık — iyi. Ama **`autoGainControl` explicitly setlenmemiş** (browser default). | Bazı tarayıcılarda AGC sesi pompalayabilir | AGC'i explicit aç |
| A5 | VAD eşiği RMS `0.015` — hassas; fan/klavye sesi "konuşuyor" gösterebilir. Histeresis yok. | Sürekli yanıp sönen konuşma göstergesi | Eşik + histeresis |
| A6 | Tüm audio consumer'lar `setPriority(255)` — en yüksek. İyi. | — | Koru |
| A7 | Çok sayıda izleyici mikrofonu aynı anda açıkken **otomatik kazanç karışımı (mixing/ducking) yok** — her ses ayrı element. | Eşzamanlı konuşmada yığılma | İsteğe bağlı: Web Audio ile mixing |
| A8 | Ses seviyesi (volume) localStorage'a kaydedilmiyor. | Her girişte reset | Persist et |
| A9 | Mikrofon cihaz seçimi yok (varsayılan cihaz). | Yanlış cihaz seçimi | `enumerateDevices` + seçici |

---

## 6. ODA İÇİ KULLANICI DENEYİMİ ANALİZİ

| ID | Konu | Etki | Öneri |
|----|------|------|-------|
| U1 | "Kim konuşuyor" göstergesi sadece kullanıcı listesindeki küçük nokta. Video alanında yok. | Kimin konuştuğu belirsiz | Video kenarında/başlıkta speaking ring |
| U2 | Mikrofon açma/kapama **toggle** — buton metnine güveniyor. Açık/kapalı net görsel state yok (ör. kırmızı/yeşil). | "Açık mı kapalı mı?" kafa karışıklığı | Net ikon + renk state'i |
| U3 | `btnToggleAudio` (sistem sesi) tekrar açmak için **ikinci `getDisplayMedia` çağrısı** yapıyor (video isteyip hemen durdurarak). Bu kullanıcıya tekrar ekran paylaşım izin diyaloğu gösterir. | Rahatsız edici, hata doğurur | İlk stream'deki track'i sakla, yeniden prompt isteme |
| U4 | İzleyici için `beforeunload` uyarısı yok (sadece admin'de var). | Yanlışlıkla çıkış | Ekle |
| U5 | Socket disconnect'te sadece toast; **otomatik reconnect + state kurtarma** yok. | Bağlantı kopunca manuel reload | Socket.io reconnection + re-consume |
| U6 | Başlatma sırasında mikrofon/kamera izni reddedilirse genel toast; **cihaz bulunamazsa** ayrı mesaj yok. | Kafa karışıklığı | Spesifik hata mesajları |
| U7 | Stats paneli her zaman manuel açılır; **düşük kalite uyarısı** yok. | Kullanıcı neden takıldığını bilmez | Otomatik uyarı |
| U8 | Kullanıcı listesi kick/ban butonları emoji karakter (✱, 🚫) — erişilebilirlik kötü, amaç belirsiz. | UX | Net SVG ikonlar + tooltip |
| U9 | Chat 200 mesaj limiti iyi. Ama **mesaj okunmadı göstergesi** yok. | UX | İsteğe bağlı |
| U10 | Oda dolu / banlı / şifre hatalarında yönlendirme var ama **"neden" toast'ı bazen çok kısa** (toast 3.5sn). | Hızlı kaybolma | Önemli hatalar için uzun süre |

---

## 7. DETAYLI İYİLEŞTİRME LİSTESİ (önceliklendirilmiş)

### 🔴 P0 — Kritik (ses çalışmıyor/yanlış çalışıyor)
1. **[B1]** Admin mikrofonu yayından önce açıldığında producer'ı `startStream` sonunda oluştur.
2. **[B2a]** Audio consumer'larda `.play()` çağır + autoplay reddini handle et (mute→retry→gesture sonrası unmute).
3. **[B2b]** Her consumer'a `producerclose` + `trackended` listener ekle; audio elementi güvenli temizle.
4. **[B3]** Opus DTX'i kapat (`usedtx:0` + `opusDtx:0`).
5. **[B4]** Audio mute state'ini video mute'tan ayır; tutarlı senkron.

### 🟠 P1 — Yüksek (kalite & tutarlılık)
6. **[A2]** Mikrofon producer opus ayarlarını router ile tutarlı mono yap.
7. **[A4]** `autoGainControl:true`'u explicit set et.
8. **[A5]** VAD eşiğini 0.02'ye çıkar + histeresis (konuşma başlama 0.02, bitirme 0.012).
9. **[V2]** `minimumAvailableOutgoingBitrate`'i düşür (1-1.5 Mbps) veya kaldır;mediasoup adaptive bandwidth'e izin ver.
10. **[V8]** Stats paneline audio metrikleri ekle (bitrate, loss, jitter).
11. **[U3]** Sistem sesi toggle'ında tekrar `getDisplayMedia` çağırma; mevcut track'i yeniden kullan.
12. **[V4/U5]** Socket.io reconnection + otomatik yeniden consume akışı ekle.

### 🟡 P2 — Orta (UX cila)
13. **[U1]** Video kontrollerinde/kullanıcı kartında "kim konuşuyor" göstergesi.
14. **[U2]** Mikrofon butonu için net açık/kapalı görsel state (ikon + renk).
15. **[A8]** Volume seviyesini localStorage'a kaydet/geri yükle.
16. **[V5]** Audio receiver için jitterBufferTarget ayarla (~50ms).
17. **[V6]** Dondurma tespiti ekle (fps düştüğünde otomatik keyframe iste).
18. **[U4]** İzleyiciler için `beforeunload` uyarısı.
19. **[U7]** Düşük bitrate/yüksek loss durumunda kullanıcıya uyarı toast'ı.

### 🟢 P3 — Düşük (ileri seviye)
20. **[A9]** Mikrofon/ses cihazı seçici (`enumerateDevices`).
21. **[V7]** İçerik tipi seçici (ekran 'detail' vs film 'motion').
22. **[A7]** Çoklu mikrofon için Web Audio otomatik mix/ducking.
23. **[V1]** Gerçek simulcast (çoklu spatial katman) — README roadmap'inde zaten var; "kalite" seçicisini anlamlı yapar.
24. **[U8]** Kick/ban için net SVG ikonlar.
25. **[U6]** İzin reddi / cihaz yok için spesifik hata mesajları.
26. **[U10]** Önemli hatalar için daha uzun süreli toast.

---

## 8. UYGULANAN DÜZELTMELER

Aşağıdaki değişiklikler bu repoda yapılmıştır. Her biri yukarıdaki maddelerle eşleşir.

### `backend/config.js`
- **[B3]** Opus `usedtx: 0` (DTX kapalı) — gürültü patlaması ve ön-kesik gider.
- **[A2]** Mikrofon yolu için tutarlılık notu eklendi; router hâlâ stereo destekli ama mic producer'ları mono (sistem sesi stereo).
- **[V2]** `minimumAvailableOutgoingBitrate` 1.5 Mbps'e düşürüldü (zayıf bağlantıya uyum).

### `public/room.js`
- **[B1]** `startStream()` sonunda `republishAdminMic()` — mevcut `micTrack` için producer eksikse oluşturur.
- **[B2a]** Yeni `playAudioElement()` helper'ı: her audio elementinde `.play()` + catch + sessiz-retry + global gesture dinleyicisi (ilk etkileşimde tüm bekleyen elementleri açar).
- **[B2b]** Her consumer'a `producerclose`/`trackended` listener eklendi (audio element + Map'ten güvenli temizlik).
- **[B4]** Bağımsız `audioMutedState` + `syncAllAudioElements()` — mute/volume tüm elementlerde tutarlı.
- **[A5]** VAD eşiği 0.02 + histeresis.
- **[A4]** Mikrofon getUserMedia'ya `autoGainControl:true` eklendi.
- **[U3]** Sistem sesi toggle'ı mevcut track'i yeniden kullanır (yeniden prompt yok).
- **[V8]** Audio stats eklendi.
- **[U1]** `voice-activity` artık video kontrollerinde konuşan kişiyi de işaretler.
- **[U2]** Mikrofon butonu görsel state'i (renk + ikon).

### `public/room.html`
- Audio sink konteyneri, konuşma göstergesi yer tutucu, mic buton ikonları.

### `backend/server.js`
- Audio consumer resume güvenliği; producer `transportclose`/`score` loglama iyileştirmesi.
- `producer-closing` event'inde admin mik producer'ları da doğru temizleniyor (zaten doğruydu, doğrulandı).

> **Not:** Tüm değişiklikler mevcut mimariye sadık kalarak, yeni bağımlılık eklemeden yapıldı. Degisikliklerin tamamı `docs/CHANGELOG.md` içinde de özetlenmiştir.

---

## Ek Kaynaklar
- Chrome WebRTC autoplay politikası: https://groups.google.com/g/discuss-webrtc/c/BwJOWloyS34
- Autoplay & WebRTC (webrtcHacks): https://webrtchacks.com/autoplay-restrictions-and-webrtc/
- Opus DTX gürültü patlaması (issue #89): https://github.com/xiph/opus/issues/89
- RED / Opus FEC ile ses kalitesi: https://webrtchacks.com/red-improving-audio-quality-with-redundancy/
