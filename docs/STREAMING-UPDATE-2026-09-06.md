# VELOSTREAM medya güncellemesi — 6 Eylül 2026

Durum: kod, birim testleri ve TLS üzerinden gerçek tarayıcı doğrulaması tamamlandı. Üretim dağıtım kaydı aşağıda tutulur.

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
6. Sorunda önceki backend imajına ve önceki kaynak/compose dosyalarına dön; yalnızca `mediasoup` servisini yeniden oluştur. TURN kaldırılacaksa yalnızca `velostream-turn` ve onun iki servis dosyası/kuralı kaldırılır.

## Test kapsamı ve sınırlar

Yerelde 99/99 birim testi ve lint geçti; derleme tamamlandı. Gerçek Chromium testinde yalnızca TURN TLS yoluyla 45/45 kontrol geçti: iki katman, düşük çözünürlük, canlı ayar, geç katılım, duraklatma, iki mikrofon, 10 saniyelik kopmadan toparlanma, mobil taşma ve CSP kontrolleri dahil. Son backend imajının test sonucu ve dağıtım kaydı aşağıda eklenir.

Tarayıcı testi gerçek Chromium + mediasoup SFU + VP8/Opus kullanır. Kaynak hareketli 720p30 canvas ve osilatördür. Gerçek ekran seçicinin işletim sistemine özgü yakalama davranışı, iOS/Firefox fiziksel cihazları, 60–120 dakikalık oturum ve yüzlerce gerçek medya izleyicisi bu testin kapsamına girmez. FPS artışı veya yüzde performans iyileşmesi iddiası yapılmaz.

Gerçek ekranda içerik/sistem sesi desteği işletim sistemi ve tarayıcıya bağlıdır. İlk görüntü süresi video consumer isteğinden ilk `loadeddata` olayına kadardır. Kayıp/bitrate son örnek penceresini, donma toplamı görüntünün izlendiği örnekleri gösterir. Tampon hedefi garanti edilen gecikme değildir.
