# VELOSTREAM medya güncellemesi — 6 Eylül 2026

Durum: backend/TURN 6 Eylül, arayüz 7 Eylül 2026'da üretime alındı. Canlı sitede TURN TLS üzerinden 45/45 tarayıcı kontrolü geçti.

## Uygulanan davranışlar

- Bitrate girdisi sonlu sayı ve aralık bakımından doğrulanır. UI kbps, RTP encoding bps kullanır. Hatalı Google min/max seçenekleri kaldırıldı; başlangıç seçeneği kbps. Toplam bütçe aşılmaz.
- Varsayılan VP8, en az 720p ve 1,5 Mbps hedefte iki görüntü katmanı üretir. Yardımcı katman hedefi 360p, ana katman seçilen çözünürlük. Kullanıcı ek katmanı kapatabilir. Başarısız veya sürekli CPU sınırlı kodlamada tek katmana dönüş vardır.
- Gerçek `ConsumerScore.score` okunur; kötüleşen bağlantıda hedef katman monoton azalır. Otomatiğe dönüş gerçek ve kaydedilmiş katmanları birlikte günceller. Manuel kalite consumer'ın `scalabilityMode` bilgisini kullanır.
- Socket oturumu değiştiğinde eski medya nesneleri ve bekleyen yanıtlar geçersizleşir. Canlı ekran ve mikrofon izleri korunup yeniden yayımlanır. Sinyalleşme 10 saniyelik gerçek onay kullanır. ICE iki denemeden sonra yeni bağlantı oturumuna geçer. Yönetici kopma toleransı 45 saniyedir.
- Film, metin/sunum ve etkileşim içerik türleri ana panelde bulunur. Video/sistem sesi hedefleri eşlenir; sohbet mikrofonu 80 ms hedef kullanır. Video tampon aralıkları sırasıyla 400–800, 150–350 ve 100–200 ms'dir. Tarayıcının gerçekleşen tamponu ayrıca ölçülür.
- Duraklatma manuel tercih olarak korunur. Yayın sesi görüntüyle durur, sohbet sesleri devam eder. Devam canlı yayına döner. Yayın ve konuşma ses seviyeleri ayrıdır; mobil Web Audio yolunda da aynı tercih uygulanır.
- Autoplay engelinde Sesi aç düğmesi; sinema/sohbet görünümü, PiP, tam ekran yedeği, isteğe bağlı wake lock ve giriş alanlarını dışlayan Space/M/F kısayolları eklendi. Tam ekranda kontroller kullanılmadığında gizlenir, klavye odağında görünür kalır.
- Kalite paneli rapor kimliği ve zaman farklarıyla bitrate/kayıp ölçer, ses akışlarını toplar; göndericide RTCP alıcı geri bildirimini eşler. Çözünürlük, FPS, codec, ilk görüntü, donma, encode/decode süresi, tampon, bağlantı yolu ve indirilebilir oturum özeti eklendi.
- Codec seçimi bağlı izleyicilerin ortak desteğini gözetir. Uyumlu codec bulunmadığında açık hata gösterilir. H264 etiketi donanım kodlama garantisi vermez.
- Hazır ayarlar bekleyen değişiklik olarak gösterilir; Uygula ile canlı kaynak yeniden seçilmeden kullanılır. Yeniden üretimde yeni gönderim transport'ı kullanılması, Chromium'da tekrar kullanılan simulcast MID/RID SDP hatasını önler.
- Producer/consumer/transport kapanışları mediasoup observer üzerinden haritaları ve sayaçları temizler. Medya işlemleri sahibiyle sınırlandırılır. Geç katılım kaynak metadata'sı alır; eski istemci ID listesi korunur.
- SFU başlangıç bant tahmini 1 Mbps; kullanılmayan minimum seçeneği kaldırıldı. Worker CPU ve tepe RSS ölçümleri `/metrics` içinde. Çalışmayan pipe iskeleti kaldırıldı. Bir odanın bir worker üzerinde çalışması değişmedi; bu sürüm çok izleyicili kapasite garantisi vermez.
- Sabit vendor dosyalarının önbelleği yeniden doğrulanır; güncel socket.io/mediasoup import'larında sürüm sorgusu eski immutable kaydını aşar. CI gerçek Chromium medya testini çalıştırır.

## Oracle üzerinde kapsam

Üretim projesi `/opt/screen-share`, compose projesi `screen-share`, backend servisi `mediasoup` / `mediasoup-backend`. Ortak Coolify proxy ve diğer projeler dağıtım komutlarına dahil edilmez. `docker compose down`, genel prune veya toplu restart kullanılmaz.

Yeni TURN servisi yalnızca `velostream-turn` adını kullanır. Resmi coturn 4.17.2-r0 imajı digest ile sabitlenir. Ayrı `.turn/` dizinindeki sırlar Git'e girmez. Kimlik bilgileri yalnızca odaya katılmış socket üzerinden 15 dakika ömürle verilir; istemcinin dört transport yolu da bunları kullanır ve yeniler.

| Trafik | Port |
|---|---|
| Üretim SFU UDP/TCP | 40000–44999 |
| TURN relay UDP | 45000–45999 |
| TURN UDP/TCP | 49999 |
| TURN TLS/TCP | 49998 |
| Geçici test SFU | 46000–46100 |
| Geçici test HTTP | 3100, SSH tünelinden |

49998–49999 TCP kuralı kullanıcı tarafından ayrıca açıkça onaylandı. Yardımcı firewall servisi yalnızca bu iki portu `velostream-turn` yorumuyla ekler; mevcut kuralları silmez. Ortak 443 portu değiştirilmedi. Yalnızca 443'e izin veren ağlar için ayrı TURN sunucusu/IP gerekir.

TLS sertifikası mevcut proxy'nin dosyasından **yalnızca `yahya-oracle.duckdns.org` için** okunup `.turn/certs` içine kopyalanır. Diğer sertifikalar kopyalanmaz; proxy dosyası değişmez. Günlük kontrol sertifika/anahtar eşleşmesini ve geçerliliği doğrular; değişiklikte yalnızca TURN'e SIGUSR2 gönderir. [Coturn sertifika yenileme davranışı](https://github.com/coturn/coturn/issues/725), [resmi TURN yapılandırması](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

## Dağıtım ve geri alma

1. Üretim sağlık ve aktif oda sayısını kontrol et; diğer konteynerlerin ID ve başlangıç zamanlarını kaydet.
2. Yeni kaynakları `.releases/` altında ayrı derle; mevcut backend imajını ve dağıtım dosyalarını yedekle.
3. Gerçek worker ile backend testleri ve gerçek Chromium medya testleri geçsin.
4. Sadece proje kaynaklarını güncelle. TURN sırlarını üretim ortamında tut. `docker compose -p screen-share -f docker-compose.yml -f docker-compose.turn.yml up -d --no-deps mediasoup turn` yalnızca bu iki servisi hedefler.
5. Backend sağlığını ve medya yolunu doğrula; frontend main dalı/Vercel yayımını doğrula. Diğer konteynerlerin ID/başlangıç zamanlarını karşılaştır. Geçici test servisini ve SSH tünelini kapat.
6. Geri almada backend ve arayüz birlikte önceki kaynak sürümüne taşınır. Eski backend 40000–49999 port aralığını kullandığı için önce yalnızca `velostream-turn` durdurulur; ardından önceki kaynak/compose ve geri dönüş imajıyla yalnızca `mediasoup` yeniden oluşturulur. Diğer projeler ve ortak proxy kapsam dışıdır. TURN tamamen kaldırılacaksa yalnızca onun konteyneri, yardımcı servis/zamanlayıcısı ve kendi yorumlu kuralı kaldırılır.

## Test kapsamı ve sınırlar

Yerelde 99/99 birim testi ve lint geçti; derleme tamamlandı. Son backend imajı Oracle üzerindeki ayrı test çalıştırmasında **122/122 test** geçti: 0 başarısız, 0 atlanan. Gerçek Chromium testinde yalnızca TURN TLS yoluyla hem test ortamında hem canlı sitede **45/45 kontrol** geçti: iki katman, düşük çözünürlük, canlı ayar, geç katılım, duraklatma, iki mikrofon, 10 saniyelik kopmadan toparlanma, mobil taşma ve CSP kontrolleri dahil.

Tarayıcı betiği Vercel'in `/room` yönlendirmesini ve yapılandırılmış ayrı sinyalleşme adresini destekler. Sadece bu adresin `/socket.io/` istekleri dış kaynak denetiminden ayrılır; beklenmeyen dış kaynaklar denetlenmeye devam eder.

Tarayıcı testi gerçek Chromium + mediasoup SFU + VP8/Opus kullanır. Kaynak hareketli 720p30 canvas ve osilatördür. Gerçek ekran seçicinin işletim sistemine özgü yakalama davranışı, iOS/Firefox fiziksel cihazları, 60–120 dakikalık oturum ve yüzlerce gerçek medya izleyicisi bu testin kapsamına girmez. FPS artışı veya yüzde performans iyileşmesi iddiası yapılmaz.

Gerçek ekranda içerik/sistem sesi desteği işletim sistemi ve tarayıcıya bağlıdır. İlk görüntü süresi video consumer isteğinden ilk `loadeddata` olayına kadardır. Kayıp/bitrate son örnek penceresini, donma toplamı görüntünün izlendiği örnekleri gösterir. Tampon hedefi garanti edilen gecikme değildir.

## Üretim doğrulama kaydı — 7 Eylül 2026

- Uygulama sürümü: `8812e8dd921732fc5d055feb44523a311bb5a755`. GitHub `main` dalına normal fast-forward push yapıldı. [GitHub CI](https://github.com/yahya308/screen-share-frontend/actions/runs/34110956636) ve Vercel dağıtımı başarılı.
- [Canlı arayüz](https://www.velostream.com.tr) üzerindeki `room.js` ve `media-policy.mjs` dosyalarının SHA-256 değerleri test edilen yerel dosyalarla aynı. Vendor yanıtları `public, max-age=0, must-revalidate` kullanıyor.
- Backend 6 Eylül 2026, **14:47:16 UTC**'de yenilendi. İmaj: `sha256:5e719f58a660720237f3ecaa5c7760ec7b112ea8f5aab778f80d5b7b5b73cff2`. Konteyner: `bf687d1b4be5`. 7 Eylül doğrulamasında 19,5 saati aşan çalışma süresi ve dört sağlıklı worker görüldü.
- TURN konteyneri: `f7884a4756a0`. Gerçek tarayıcı seçili adayında `iceTransportPolicy=relay`, `relayProtocol=tls`; kalite panelinde `TURN · TLS` doğrulandı. Dış TLS el sıkışması TLS 1.3 ve geçerli sertifika ile başarılı; sertifika sonu 12 Ekim 2026.
- Sertifika zamanlayıcısı etkin; 7 Eylül 00:27 UTC kontrolü başarıyla tamamlandı. Yalnızca onaylanan 49998–49999 TCP kuralını yöneten servis etkin.
- Canlı test kapandıktan sonra oda, kullanıcı, socket, producer ve consumer sayaçları sıfıra döndü. Diğer **18 konteynerin tam kimliği ve başlangıç zamanı** dağıtım öncesi kayıtla aynı.
- Yerel test kanıtları: `build/production-20260907/smoke-tls.log`, `viewer.png`, `viewer-mobile.png`, `publisher.png`. Sunucu test kaydı: `/opt/screen-share/.releases/final-media-20260906/tests.log`.
- Geçici `velostream-staging-20260906` konteyneri kimliği doğrulanıp kaldırıldı. Yerel SSH süreç kontrolünde açık test tüneli kalmadığı görüldü. Temizlik sonrası backend sağlık kontrolü tekrar başarılı; diğer 18 konteynerin başlangıç zamanları yine aynı.
- Kalıcı yedekler `/opt/screen-share/.releases/final-media-20260906/` içinde: `source-before.tar`, `rollback-image.tar.gz`, `deployed-image.tar.gz`, `images.sha256` ve dağıtım öncesi/sonrası konteyner kayıtları. Her iki imaj arşivi gzip ve SHA-256 kontrolünden geçti.
- Önceki Docker imajı 7 Eylül kontrolünde mevcut değildi. Bu nedenle `3a1a754` kaynak yedeği ayrı dizinde yeniden derlendi; çalışan servislere dokunulmadı. Geri dönüş imajı `sha256:ce317ef417cd8ae99d6ac4b5857188ff0fbb633b629aa5988ad9b62d22de992c`. Bu, önceki kaynaklardan yeniden derlenmiş imajdır; eski üretim ikilisinin birebir kopyası değildir. Gerektiğinde `docker load -i rollback-image.tar.gz` ile yalnızca bu imaj geri yüklenebilir.
