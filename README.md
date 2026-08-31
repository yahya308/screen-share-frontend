# VELOSTREAM

**Mediasoup (SFU) tabanlı, bire-çok gerçek zamanlı ekran paylaşımı.**
Yayıncı ekranını bir kez gönderir, sunucu her izleyiciye yeniden dağıtır —
transkodlama yok, yayıncının yükü izleyici sayısıyla artmaz.

Ön yüz Vercel'de statik, sinyalleşme ve SFU Oracle Cloud'da Docker Compose ile
çalışır.

---

## İçindekiler

- [Ne yapar](#ne-yapar)
- [Mimari](#mimari)
- [Güvenlik modeli](#güvenlik-modeli)
- [Kurulum](#kurulum)
- [Yapılandırma](#yapılandırma)
- [Dağıtım](#dağıtım)
- [Test](#test)
- [İzleme ve yük testi](#izleme-ve-yük-testi)
- [Kapasite](#kapasite)
- [Bilinen sınırlar](#bilinen-sınırlar)
- [Lisans](#lisans)

---

## Ne yapar

**Yayıncı (oda sahibi)**
- Ekran paylaşımı: 144p–1080p, 24–60 FPS, 1–20 Mbps ayarlanabilir
- Sistem sesi ve mikrofon ayrı ayrı açılıp kapanabilir; mikrofonda gürültü
  bastırma anahtarı ve canlı seviye göstergesi var
- Odayı parolayla kilitleme, izleyici mikrofonunu ve sohbeti kapatma
- Kullanıcı atma (kick) ve IP bazlı yasaklama (ban)

**İzleyici**
- Tek tıkla katılım, takma adla giriş
- Otomatik kalite: bağlantı zayıfladığında sunucu önce kare hızını, sonra
  çözünürlüğü kademeli düşürür (VP9 SVC)
- İzin verildiyse mikrofonla konuşma, konuşma göstergesi (VAD)
- Sohbet, izleyici listesi

**Ortak**
- Mobil tarayıcı desteği (izleyici modu birincil; ekran paylaşımı tarayıcı
  desteğine bağlıdır)
- iOS Safari için H264 yedeği

---

## Mimari

```mermaid
graph LR
    A[Yayıncı] -->|WebRTC| B[Mediasoup SFU]
    B -->|WebRTC| C[İzleyici 1]
    B -->|WebRTC| D[İzleyici 2]
    B -->|WebRTC| E[İzleyici N]

    A -.Socket.io.-> F[Sinyalleşme]
    C -.Socket.io.-> F
    D -.Socket.io.-> F

    style B fill:#0ea5e9,color:#fff
    style F fill:#8b5cf6,color:#fff
```

| Katman | Teknoloji | Nerede çalışır |
|---|---|---|
| Ön yüz | Vanilla JS (ES modülleri) + Tailwind (derlenmiş) | Vercel |
| Sinyalleşme | Node.js 18+, Express, Socket.io | Oracle Cloud VPS |
| SFU | Mediasoup 3 | aynı VPS, worker başına bir süreç |
| Oda kaydı | better-sqlite3 (RAM'e eşlenik, açılışta sıfırlanır) | aynı VPS |
| TLS / ters vekil | Nginx + Let's Encrypt (Certbot) | aynı VPS |
| ICE yardımcıları | Vercel serverless (`api/config`, `api/ice-config`) | Vercel |

**Kaynak:** ~7.600 satır — `backend/` 12 dosya, `public/` 4 dosya,
`backend/test/` 10 dosya (98 test).

### Odaların yaşam döngüsü

Odalar bellekte yaşar; SQLite yalnızca lobi listesi ve parola özeti için
kullanılır ve **her açılışta temizlenir** (`clearAllRooms`). Yani sunucu
yeniden başlatıldığında canlı oda kalmaz — bu bilinçli bir tercih, tek
örnekli dağıtımı basit tutuyor. Çok örnekli bir kurulum isteniyorsa oda
durumunun Redis'e taşınması gerekir.

Oda sahibi bağlantısını kaybederse oda 5 saniyelik bir süre boyunca ayakta
kalır; bu süre içinde token'ıyla dönerse oda kaldığı yerden devam eder.

---

## Güvenlik modeli

Bu bölüm önemli, çünkü yetkilendirme tamamen buna dayanıyor.

**Yönetici yetkisi bir sırra bağlıdır.** `create-room` yanıtı yalnızca odayı
kuran istemciye 32 baytlık bir `adminToken` döndürür. İstemci bunu
`sessionStorage`'da tutar ve `admin-rejoin` sırasında sunar; sunucu sabit
zamanlı karşılaştırmayla doğrular. URL'deki `?admin=true` tek başına hiçbir
yetki vermez ve token oda listesinde asla görünmez. Token'ın sahibi başka bir
sekmeden dönerse yöneticilik devredilir (`admin-superseded`).

**İstemci IP'si X-Real-IP'den okunur** (yoksa `X-Forwarded-For` zincirinin son
ögesinden). Nginx bu başlığı `$remote_addr`'dan yazdığı için istemci
değiştiremez; ban listesi ve parola deneme limiti buna dayanır.

**Kötüye kullanım sınırları:** IP başına eşzamanlı 3 oda ve 10 dakikada 5 oda
oluşturma; soket başına dakikada 30 lobi sorgusu; 5 saniyede 10 sohbet
mesajı; 5 hatalı parolada 3 dakika blok. Parolalar bcrypt (10 tur) ile
**asenkron** doğrulanır — senkron sürüm olay döngüsünü bloke ediyordu.

**Üretimde CORS kapalı başlar:** `NODE_ENV=production` iken `ALLOWED_ORIGINS`
boşsa sunucu açılışta durur.

**Ön yüz katı bir CSP altında çalışır** (`script-src 'self'`): tüm üçüncü
taraf kütüphaneler `public/vendor/` altından, sabitlenmiş sürümlerle sunulur;
satır içi olay işleyicisi yoktur.

---

## Kurulum

### Gereksinimler

- Node.js 18+ (yerel geliştirme ve testler)
- Docker + Docker Compose (sunucu)
- Genel IP'li bir VPS ve bir alan adı (TLS için)

### Yerel geliştirme

```bash
git clone https://github.com/yahya308/screen-share-frontend.git
cd screen-share-frontend

# Ön yüz varlıklarını üret (Tailwind CSS + vendor kütüphaneleri)
npm install
npm run build

# Sinyalleşme sunucusu
cd backend
npm install
cp ../.env.example ../.env    # düzenleyin
node server.js                # http://localhost:3000
```

Sunucu, `public/` dizinini de aynı origin'den sunar; tarayıcıda
`http://localhost:3000` açmanız yeterlidir. `getDisplayMedia` güvenli bağlam
ister — `localhost` güvenli sayılır, uzak bir IP sayılmaz.

---

## Yapılandırma

Tüm değişkenler ve varsayılanları **[`.env.example`](.env.example)** dosyasında
açıklanmıştır. Kritik olanlar:

| Değişken | Zorunlu | Ne işe yarar |
|---|---|---|
| `ANNOUNCED_IP` | evet | Mediasoup'un duyurduğu genel IP; yanlışsa medya akmaz |
| `ALLOWED_ORIGINS` | üretimde evet | CORS izin listesi; boşsa üretimde sunucu açılmaz |
| `MEDIASOUP_WORKERS` | hayır | Worker sayısı; boşsa `os.availableParallelism()` |
| `METRICS_TOKEN` | hayır | `/metrics` için token; yoksa uç nokta yalnızca özel ağdan yanıtlar |
| `LOG_LEVEL` | hayır | `error`/`warn`/`info`/`debug` (varsayılan `info`) |
| `SIGNALING_URL` | Vercel'de evet | Tarayıcının bağlanacağı sinyalleşme adresi |
| `TURN_HOST`, `TURN_SECRET` | hayır | TURN relay; kimlik bilgileri 15 dk ömürlü üretilir |

### Güvenlik duvarı

```bash
ufw allow 443/tcp           # Nginx (TLS)
ufw allow 40000:49999/udp   # WebRTC medya
ufw allow 40000:49999/tcp   # WebRTC (UDP engelliyse yedek)
```

`3000/tcp` **dışarı açılmamalıdır**; Nginx yerelden vekillik eder.

---

## Dağıtım

### Sinyalleşme + SFU (Oracle Cloud, Docker Compose)

```bash
ssh <sunucu>
cd screen-share-frontend
git pull

docker compose up -d --build
docker compose logs -f mediasoup
```

`docker-compose.yml` üç servis çalıştırır: `mediasoup` (uygulama, host ağı),
`nginx` (TLS sonlandırma ve WebSocket vekilliği) ve `certbot` (sertifika
yenileme). Uygulama servisine 20 saniyelik `stop_grace_period` tanımlıdır:
SIGTERM alındığında sunucu odalara `server-restarting` yayınlar, soketleri,
mediasoup worker'larını ve veritabanını sırayla kapatır. Yani dağıtım artık
canlı odaları habersiz koparmaz — ama odalar yine de yeniden başlatmayı
atlatamaz (bkz. *Odaların yaşam döngüsü*).

### Ön yüz (Vercel)

`main` dalına yapılan her push otomatik dağıtılır. Vercel `npm run build`
çalıştırır; bu, Tailwind CSS'i derler ve `public/vendor/` altındaki
kütüphaneleri üretir. Üretilen dosyalar depoda da tutulur, böylece derleme
adımı olmadan da (`npx serve public`) çalışır.

---

## Test

```bash
cd backend
npm test          # 98 test, ~6 saniye
```

`node --test` kullanılır; ek bir test çatısı yoktur. Kapsam:

- **Yetkilendirme (entegrasyon):** gerçek Socket.io sunucusu ve istemcileriyle,
  token'sız bir istemcinin yönetici olamadığı, reddedilen istekten sonra
  kick/ban/toggle çağrılarının da yetkisiz kaldığı ve parola korumasının
  yönetici yolundan atlatılamadığı doğrulanır
- **DoS limitleri (entegrasyon):** tek istemcinin sunucu oda kotasını
  dolduramadığı, yeni soket açmanın limiti sıfırlamadığı
- **Lobi yayını (entegrasyon):** oda içindeki istemcilerin lobi trafiği almadığı,
  sayaç güncellemelerinin toplulaştırıldığı
- **Dayanıklılık (entegrasyon):** worker ölünce odadakilerin bilgilendirildiği,
  düzgün kapanmada istemcilerin uyarıldığı
- **Birim testler:** `adminAuth`, `clientIp`, `RateLimiter`, `EventLimiter`,
  `RoomManager`, `WorkerManager`, `svcLayers`, `metrics`

CI (`.github/workflows/ci.yml`) her push'ta lint ve testleri çalıştırır.

---

## İzleme ve yük testi

### Metrikler

```bash
curl -s localhost:3000/metrics | grep velostream_
```

Prometheus formatında: oda ve kullanıcı toplamları, en kalabalık oda, bağlı
soket sayısı, **worker başına** consumer/producer/oda sayısı ve bellek.
`METRICS_TOKEN` tanımlıysa token zorunludur; tanımsızsa uç nokta yalnızca
loopback/özel ağdan yanıt verir, dışarıya 404 döner.

Oda kimlikleri etiket olarak kullanılmaz (kardinalite patlaması).

### Yük testi

```bash
# 1) Tarayıcıdan bir oda açıp yayını başlatın, oda kimliğini kopyalayın
cd backend
ROOM_ID=<oda-kimliği> VIEWERS=500 RAMP_MS=60000 npm run loadtest
```

Sanal izleyiciler izleyici el sıkışmasının tamamını yapar (`join-room` →
`getRouterRtpCapabilities` → `createWebRtcTransport` → `getProducers` →
`consume`) ve p50/p95/p99 gecikme ile hata dağılımını raporlar. DTLS bağlanmaz,
medya çözülmez: ölçülen şey sinyalleşme yolu ve mediasoup consumer tahsisi —
odanın gerçekte tıkandığı yer. Eş zamanlı olarak `/metrics` üzerinden worker
yükünü izleyin.

---

## Kapasite

**Ölçülmüş bir rakam henüz yok.** Bu bölüm, sayı üretmek yerine tavanı neyin
belirlediğini açıklar; gerçek sayıyı yukarıdaki yük testiyle kendi
donanımınızda bulun.

Belirleyici sınır şu: **bir oda tek bir mediasoup router'ında, yani tek bir
CPU çekirdeğinde çalışır.** Sunucudaki diğer çekirdekler başka odalara hizmet
eder; tek bir yayının izleyicileri arasında paylaşılmaz. Dolayısıyla oda
başına tavan, bir worker'ın taşıyabildiği consumer sayısıdır ve bu; çözünürlük,
kare hızı ve bit hızıyla doğrudan değişir.

Depoda çok worker'lı dağıtım için `pipeToRouter` iskeleti mevcut
(`RoomManager.ensurePipeTransport`) ama **bağlı değil** — bkz. bilinen sınırlar.

---

## Bilinen sınırlar

- **Oda başına tek worker.** `getTransportInfo`/`ensurePipeTransport` yazılmış
  ama çağrılmıyor; bir odanın izleyicileri ek çekirdeklere dağıtılamıyor.
- **Yeniden başlatma odaları kapatır.** Oda durumu bellekte; çok örnekli
  dağıtım için Redis gerekir.
- **Kayıt (recording) yok.**
- **Ekran paylaşımı mobilde sınırlı.** Tarayıcı desteğine bağlı; mobilde
  izleyici modu birincil kullanım.

---

## Lisans

MIT — bkz. [LICENSE](LICENSE).
