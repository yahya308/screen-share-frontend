# Mikrofon gürültü engelleme — 13 Ekim 2026

## Özet

Mikrofon gürültü engellemesi tarayıcının yerleşik `getUserMedia` filtresinden
**GTCRN** sinir ağına taşındı. Model tarayıcıda, AudioWorklet + WebAssembly
ile, ses gönderilmeden önce çalışır; sunucuya ek yük getirmez.

Arayüzdeki **Gürültü Engelleme** aç/kapa anahtarı aynen kaldı:

| Anahtar | Ne olur |
|---|---|
| Açık (varsayılan) | GTCRN. Tarayıcının kendi gürültü engellemesi kapatılır, yankı engelleme ve otomatik kazanç açık kalır. |
| Açık, ama model bu cihazda çalışamıyor | Tarayıcının yerleşik gürültü engellemesi. Durum satırı ve bir bildirim bunu söyler. |
| Kapalı | Gürültü engelleme yok (müzik, enstrüman). |

Tercih önceki sürümle aynı `velo_mic_noise_suppression` anahtarında tutulur;
daha önce kapatan kullanıcı kapalı kalır.

## Ölçümler

Temiz konuşma (TTS) üzerine 5 tür gürültü eklendi, her yöntem gerçek
Chromium'da çalıştırıldı. PESQ (geniş bant) ve STOI kalite/anlaşılırlık,
SI-SDR bozulma, "Bastırma" konuşma aralarındaki gürültü düşüşüdür.

| Ortalama (5 gürültü) | PESQ | STOI | SI-SDR | Bastırma |
|---|---|---|---|---|
| İşlemsiz | 1.14 | 0.890 | 5.5 dB | 0 dB |
| Tarayıcının yerleşik NS'i (eski davranış) | 1.45 | 0.869 | — | 15.5 dB |
| RNNoise | 1.58 | 0.917 | 6.7 dB | 23.3 dB |
| **GTCRN** | **1.95** | **0.933** | **13.1 dB** | **28.7 dB** |
| Tarayıcı NS'i + GTCRN üst üste | 1.74 | 0.893 | — | 40.8 dB |

- Klavye tıkırtısında tarayıcı NS'i 2.9 dB, RNNoise 7.5 dB, GTCRN 40 dB bastırıyor.
- Tarayıcı NS'i anlaşılırlığı (STOI) işlemsiz sesin bile altına düşürüyor.
- İkisini üst üste kullanmak daha çok bastırıyor ama konuşmayı bozuyor; bu
  yüzden model açıkken tarayıcının NS'i kapatılıyor.
- Tarayıcı NS'i satırındaki SI-SDR, gerçek zamanlı kayıt örnek düzeyinde
  hizalanamadığı için verilmedi (PESQ/STOI hizalamaya dayanıklı).

Uçtan uca (yayıncının sahte mikrofonunda fan gürültülü konuşma, SFU üzerinden
izleyicide ölçülen ses, 20 ms çerçeve enerjisinin 10. yüzdeliği):

| Anahtar | Gürültü tabanı | Konuşma (95. yüzdelik) |
|---|---|---|
| Kapalı | −30 dB | −18 dB |
| Açık, tarayıcı NS'ine düşmüş | −49 dB | −18 dB |
| Açık (GTCRN) | −82 dB | −19 dB |

Maliyet: 16 ms'lik çerçeve başına 0,51 ms (masaüstü, tek çekirdeğin %3'ü).
Eklenen gecikme ≈ 32 ms (640 örnek worklet tamponu + modelin ~18 ms'si).
Model 192 KB; yalnızca mikrofon düğmesine yaklaşan kullanıcıya indirilir.

## Sınırlar

- GTCRN 16 kHz'de çalışır: konuşma 8 kHz'e kadar iletilir ("HD telefon"
  kalitesi). Bu bant anlaşılırlığın neredeyse tamamını taşır; tam bant
  isteyen anahtarı kapatabilir.
- Model WebAssembly SIMD ister (Chrome 91+, Firefox 89+, Safari 16.4+). Daha
  eski tarayıcılar ve mikrofon örnekleme hızı 48 kHz olmayan Firefox kurulumları
  tarayıcının NS'ine düşer.
- Ölçümler sentetik gürültü ve TTS konuşmayla yapıldı; gerçek mikrofon,
  oda yankısı ve kalabalık ortam (başka konuşmacılar) farklı sonuç verebilir.
  Model başka insanların konuşmasını gürültü saymaz.
- Düşük seviye telefonlarda çerçeve maliyeti 5-8 kat artabilir; mobilde ses
  bağlamı daha büyük tamponla (`latencyHint: 'balanced'`) açılır.

## Tasarım

- `scripts/vendor/noise-suppressor-worklet.js` → `public/vendor/noise-suppressor.worklet.js`
  (esbuild), model `@sapphi-red/gtcrn-wasm@0.0.3` → `public/vendor/gtcrn.wasm`.
- `public/mic-processing.mjs`: kısıtlar, motor seçimi, işlemci kurulumu.
- Worklet hiçbir koşulda mikrofonu susturmaz: model hazır olana kadar ve
  herhangi bir hatada sesi işlemeden geçirir ve ana iş parçacığına bildirir.
- Arıza bildirimleri: worklet/WASM hatası, ilk 3 saniyede mutlak sıfır giriş
  (bozuk kaynak düğümü), ses bağlamının 2 saniyeden uzun durması (iOS
  kesintisi). Hepsinde mikrofon kesintisiz tarayıcı NS'ine geçer; o oturumda
  model yeniden denenmez, anahtar kapatılıp açılırsa denenir.
- Konuşma göstergesi (VAD) model açıkken işlemcinin bağlamını ve çıktısını
  kullanır: fazladan AudioContext açılmaz, klavye sesi göstergeyi yakmaz.

### Düzeltilen eski hata

Önceki anahtar, açık mikrofonda gürültü engellemeyi `applyConstraints` ile
değiştiriyordu. Chrome bu sözü çözüyor ama ayarı değiştirmiyor; anahtar
yalnızca bildirim gösteriyordu. Ayrıca Chrome, aynı cihazdan eski iz açıkken
farklı işleme ayarıyla istenen ikinci ize eski ayarı veriyor. Yeni kod önce
değiştirmeyi deneyip `getSettings` ile doğrular, olmazsa eski izi bırakıp
yeniden ister ve producer'ın izini değiştirir. Model ↔ kapalı geçişinde ham
iz zaten aynı ayarda olduğu için yeniden alınmaz, kesinti olmaz.

## CSP

`script-src 'self' 'wasm-unsafe-eval'`. `'wasm-unsafe-eval'` yalnızca
WebAssembly derlemesine izin verir; satır içi script ve `eval()` hâlâ
engelli. Olmadan model worklet içinde derlenemez ve herkes tarayıcı NS'ine
düşer. `vercel.json` ve `backend/securityHeaders.js` birlikte güncellendi.

## Testler

- `backend/test/micProcessing.test.js`: tercih okuma, motor seçimi, kısıtlar.
- `scripts/test-noise-suppression.js` (CI): üretim CSP'si altında model
  yüklenir; formant sentezli konuşma + pembe gürültü + klavye 5 dB SNR'de
  gerçek zamanlı işlenir. Bastırma ≥ 15 dB, konuşma kaybı ≤ 6 dB, işlemci
  gecikmesi < 45 ms, ham iz bitince kapanma, model yoksa asılı kalmama.
  `'wasm-unsafe-eval'` kaldırıldığında test kalır (doğrulandı).
- `scripts/smoke-browser.js`: gerçek odada yayıncı ve izleyici mikrofonu
  modelden geçer; anahtar açık mikrofonda kapatılıp açılınca gönderilen iz
  değişir ve tarayıcı NS'i kapalıdır; tercih kalıcıdır; model indirilemeyen
  izleyicide mikrofon tarayıcı NS'i GERÇEKTEN açık olarak yayınlanır.

## Dağıtım — 13 Ekim 2026

- Ön yüz: `main` → Vercel. Canlıda CSP `'wasm-unsafe-eval'` içeriyor; model,
  worklet, `mic-processing.mjs` ve `room.js` yerel derlemeyle birebir aynı.
- Backend (Oracle, `/opt/screen-share`): dağıtım anında 0 oda / 0 kullanıcı.
  Yeni imaj `screen-share-mediasoup` (`sha256:8bf487655a01…`) içinde gerçek
  worker'larla **125/125** test geçti (`.releases/noise-20261013/tests.log`;
  entegrasyon testlerinin istemcisi geçici konteynere ayrıca kuruldu, imaja
  girmedi). Yalnızca `mediasoup` servisi yeniden oluşturuldu
  (`up -d --no-deps mediasoup`); diğer 22 konteynerin başlangıç zamanı aynı
  (`started-before.txt` / `started-after.txt`).
- Canlı sitede duman testi **48/48**. Canlı SFU üzerinden anahtar ölçümü (fan
  gürültüsü, izleyicide/yayıncıda duyulan ses): kapalı −30 dB, açık −82 dB
  gürültü tabanı; yayıncı ve izleyici için, mikrofon açılmadan önce ve açıkken.
- Geri dönüş: önceki imaj `velostream-rollback:20261013`
  (`sha256:5e719f58a660…`, arşivi `.releases/final-media-20260906/deployed-image.tar.gz`),
  önceki kaynak `.releases/noise-20261013/source-before.tar`. Ön yüz ve backend
  birlikte geri alınmalı: önceki ön yüzün CSP'sinde `'wasm-unsafe-eval'` yok,
  ama bu yalnızca modeli devre dışı bırakır (tarayıcı NS'ine düşülür), ses kesilmez.
