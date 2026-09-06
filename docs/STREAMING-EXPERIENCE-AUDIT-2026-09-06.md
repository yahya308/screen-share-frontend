**VELOSTREAM — yayın ve izleyici deneyimi incelemesi**

6 Eylül 2026 · İncelenen çalışma kopyası: `main`, `3a1a754` (4 Eylül 2026). Kurulu ve kilitli sürümler: mediasoup `3.19.13`, mediasoup-client `3.18.1`.

Akıcılığı artırmak için ilk iş bitrate birimlerini, uygulamanın otomatik kalite kararını ve bağlantı sonrası medya kurulumunu düzeltmek. Daha sonra gerçek çözünürlük uyarlaması ve ölçüme dayalı oynatma tamponu eklenebilir. Kodda bulunan hatalar aşağıda doğrulama sonuçlarıyla ayrılmıştır; üretimde ne kadar FPS veya donma iyileşmesi sağlayacakları henüz ölçülmemiştir.

İnceleme güncel kaynak kodu, kurulu kütüphaneler, mevcut testler ve birincil teknik kaynaklar üzerinden yapıldı. Mevcut graphify haritası ilgili fonksiyonlara ulaşmak için kullanıldı; eski satır numaraları ve eski araştırma raporu güncel kodla karşılaştırıldı. Canlı dağıtımın bu commit ile aynı olduğu doğrulanmadı. Bu makinede gerçek ekran yakalama, SFU üzerinden oynatma ve uzun süreli ağ testi yapılmadı.

Mevcut yapıda korunmaya değer parçalar var: SFU dağıtımı, consumer'ı duraklatılmış oluşturup istemci hazır olduğunda başlatma, Opus NACK/FEC ayarları, film/sunum içerik türü, ilk kodlanan kareyi kontrol etme, ayrı mikrofon yayını ve temel bağlantı istatistikleri. Son değişiklikler bu alanları geliştirmiş; aşağıdaki sorunlar bu yapı üzerinde kalmış.

| Sıra | Bulgu / iş | Kullanıcıya etkisi | Durum |
|---|---|---|---|
| 1 | Google video bitrate seçeneklerinin birimleri yanlış | Başlangıç ve bant uyarlaması çelişkili parametrelerle çalışıyor | Kod ve seçenek çıktısıyla doğrulandı |
| 2 | Consumer skoru yanlış okunuyor | Uygulamanın otomatik kalite mantığı kötü bağlantıyı iyi sanıyor | Gerçek API biçimiyle doğrulandı |
| 3 | Reconnect eski medya nesnelerini kullanabiliyor | Bağlantı geri geldiği halde görüntü/ses dönmeyebilir | Fonksiyon düzeyinde doğrulandı |
| 4 | Gerçek çözünürlük katmanları yok | Yavaş izleyicide netlik ve akıcılık birlikte korunamıyor | Mimari sınır |
| 5 | TURN yapılandırması istemciye bağlanmamış | Kısıtlı ağlarda medya kurulamayabilir | Kod akışıyla doğrulandı |
| 6 | Duraklatma genel autoplay dinleyicisiyle çakışıyor | Duraklat düğmesi videoyu yeniden oynatıyor | Olay sırası taklidiyle doğrulandı |
| 7 | Film tamponu sonradan gelen sese uygulanmayabiliyor | Ses/video tampon tercihi tutarsız kalabiliyor | Consumer oluşturma sırasıyla doğrulandı |
| 8 | Kalite ölçümleri teşhis için eksik ve kısmen yanıltıcı | Takılmanın ağdan mı cihazdan mı geldiği anlaşılamıyor | Kod incelemesi |
| 9 | Codec seçimi izleyici desteğini hesaba katmıyor | Desteklenmeyen codec'te izleyici görüntüsüz kalabilir | Kod akışıyla doğrulandı |
| 10 | Yayın sırasında hazır kalite ayarı yalnızca formu değiştiriyor | Kullanıcı kaliteyi değiştirdiğini sanabilir | Kod incelemesi |

**1. Bitrate birimlerini düzeltmek — ilk öncelik**

[room.js:1424](C:/Users/yahya/Desktop/screen_share/public/room.js:1424) arayüzdeki kbps değerini bps'e çeviriyor. Bu değer `encodings.maxBitrate` için doğru. Ancak aynı değer [room.js:1453](C:/Users/yahya/Desktop/screen_share/public/room.js:1453) içindeki `videoGoogleStartBitrate`, `videoGoogleMaxBitrate` ve `videoGoogleMinBitrate` seçeneklerine de aktarılıyor. Kurulu mediasoup-client bunları dönüştürmeden `x-google-*-bitrate` SDP alanlarına yazıyor; libwebrtc bu alanları kbps olarak yorumluyor. [libwebrtc bitrate ayrıştırması](https://webrtc.googlesource.com/src/+/5788235ac856f62f1522d1491c4a8b00dba10c82/media/engine/webrtc_media_engine.cc)

Gerçek `startStream()` fonksiyonunu sahte medya uçlarıyla çalıştırınca, arayüzde **5000 kbps** için şu çıktı elde edildi:

```text
encodings.maxBitrate       = 5,000,000 bps
videoGoogleStartBitrate    = 4,000,000
videoGoogleMaxBitrate      = 5,000,000
videoGoogleMinBitrate      = 3,000,000
```

Google seçenekleri korunacaksa start/max değerlerinin bu örnekte 4000/5000 olması gerekir. Sayısal ölçek hatası 1000 kattır; bu, ağda gerçekten 1000 kat veri gönderildiği anlamına gelmez. Gerçek kodlayıcı davranışını diğer sınırlar ve tarayıcı belirler.

Öneri: değişken adlarını `bitrateKbps` ve `bitrateBps` olarak ayır; gereksiz Google seçeneklerini kaldırmayı değerlendir; en azından bps/kbps dönüşümünü düzelt. Sabit yüzde 60 minimumunu ayrıca değerlendir: doğru birimde bile yavaş bağlantıya inme alanını daraltabilir. Girdi için sonlu sayı, alt/üst sınır ve geçerli hazır ayar doğrulaması ekle. Önce SDP parametrelerini, ardından kontrollü upload daralmasındaki gerçek gönderimi doğrula.

**2. Otomatik kalite kararı gerçek skor nesnesini yanlış okuyor**

[server.js:825](C:/Users/yahya/Desktop/screen_share/backend/server.js:825), consumer `score` olayını [svcLayers.js:88](C:/Users/yahya/Desktop/screen_share/backend/svcLayers.js:88) içindeki `overallScore()` fonksiyonuna götürüyor. Bu fonksiyon yalnızca dizi kabul ediyor. Oysa consumer olayı `{ score, producerScore, producerScores }` biçiminde bir nesne gönderiyor. [Mediasoup ConsumerScore tanımı](https://mediasoup.org/documentation/v3/mediasoup/api/#ConsumerScore)

Doğrulamada `{ score: 2, producerScore: 10, producerScores: [10] }` girdisi **10** olarak okundu; mevcut `autoAdjustConsumerLayers()` hiçbir katman düşürme çağrısı yapmadı. Mediasoup'un kendi bant tahmini bundan bağımsız çalışabilir; bozulan parça uygulamanın ek kalite kararıdır.

Öneri: producer ve consumer skorlarını ayrı işle; izleyici tarafı kalite kararı için doğru alanı kullan; gerçek olay biçimini test et. Mevcut skor testleri yalnızca dizileri sınadığı için hata kaçmış.

Aynı işte iki tutarsızlık daha giderilmeli: tek uzamsal katmanda skor 6, 4 ve 2 için mevcut politika sırasıyla temporal 1, 2 ve 1 seçiyor; kalite kötüleştikçe hedef düzenli azalmıyor. Ayrıca [server.js:889](C:/Users/yahya/Desktop/screen_share/backend/server.js:889) otomatiğe dönüşte gerçek tercihleri en yükseğe çıkarırken bellekteki mevcut katman değerlerini güncellemiyor. Karar durumu ile gerçekten uygulanan durum birlikte tutulmalı.

**3. Bağlantı yeniden kurulduğunda medya ayrıca toparlanmalı**

Sunucu disconnect sırasında ilgili transport'ları kapatıyor: [RoomManager.js:420](C:/Users/yahya/Desktop/screen_share/backend/RoomManager.js:420). İstemcide [room.js:319](C:/Users/yahya/Desktop/screen_share/public/room.js:319) yalnızca bildirim gösteriyor. Sonraki `initMediasoup()` çağrısı `closed === false` olan eski istemci nesnelerini yeterli sayıp erken dönebiliyor: [room.js:703](C:/Users/yahya/Desktop/screen_share/public/room.js:703).

Gerçek fonksiyona `connectionState: 'failed', closed: false` durumundaki transport verildiğinde hem yayıncı hem izleyici yolunda **0 yeni sunucu isteği, 0 state sıfırlama** görüldü. ICE restart da sunucudan silinmiş bir transport'ı geri getiremez. Yayıncının rejoin yolunda mikrofon yeniden yayımlanıyor, ekran yayını için eşdeğer bir toparlanma yolu bulunmuyor.

Öneri: her bağlantı oturumunu bir kimlikle izle; önceki oturuma ait transport ve bekleyen istekleri geçersizleştir; başarılı join sonrasında receive transport'ını yeniden oluşturup mevcut producer'ları tekrar al. Yayıncının ekran track'i hâlâ canlıysa yeniden yayınla; sona ermişse yeniden paylaşma düğmesi göster. Promise tabanlı sinyalleşmeye timeout ve sınırlı tekrar ekle. [room.js:745](C:/Users/yahya/Desktop/screen_share/public/room.js:745) içindeki 1,5 saniye sonra koşulsuz başarı bildiren bağlantı fallback'ini de bu kapsamda düzelt. Oda sahibinin 5 saniyelik bekleme süresini hedef ağlarda ölçerek artır.

**4. Zayıf bağlantıda gerçek çözünürlük seçimi için ikinci bir görüntü katmanı gerekiyor**

[room.js:1450](C:/Users/yahya/Desktop/screen_share/public/room.js:1450) tek encoding üretiyor; [room.js:2495](C:/Users/yahya/Desktop/screen_share/public/room.js:2495) VP8/AV1/VP9 için `L1T3`, H264 için katmansız seçenek döndürüyor. Mevcut düşük/orta/yüksek izleyici seçimi 1080p yayını o izleyiciye özel 720p veya 480p'ye çeviremez. Zamansal katman düşüşü yalnızca kare hızını azaltabilir; H264 seçeneğinde bu imkân da mevcut yapılandırmada yok.

Öneri: ölçümle açılan iki katmanlı VP8 simulcast deneyi yap; örneğin bir ana görüntü ve 360p/480p yardımcı görüntü. Hedef, zayıf izleyicinin daha düşük çözünürlükte akıcı izlemesi. Ek kodlama ve upload yükü nedeniyle zayıf yayıncı cihazlarında tek katmana dönüş bulunmalı. Üç katmanı herkese zorunlu açmak için henüz ölçüm yok.

İkinci katmandan önce [room.js:2358](C:/Users/yahya/Desktop/screen_share/public/room.js:2358) düzeltilmeli: consumer'ın `encodings.length` değerinden katman sayısı çıkarılıyor. SFU'nun gönderdiği consumer parametrelerinde bu dizi simulcast'te de tek elemanlı olabilir; katman bilgisi `scalabilityMode` içindedir. `L3T3` örneğinde “Yüksek” seçimi şu an spatial **0** gönderdi, beklenen üst katman **2** idi. [Mediasoup RTP alıcı parametreleri](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpReceiveParameters)

**5. TURN uç noktası kullanılmalı**

[ICE yapılandırma uç noktası](C:/Users/yahya/Desktop/screen_share/api/ice-config/index.js) TURN bilgileri üretebiliyor. Ancak güncel `room.js` bu uç noktayı çağırmıyor; dört transport oluşturma yolu da sunucudan gelen `params` nesnesini doğrudan kullanıyor. Örnekler: [room.js:770](C:/Users/yahya/Desktop/screen_share/public/room.js:770), [room.js:836](C:/Users/yahya/Desktop/screen_share/public/room.js:836). Sunucunun cevabında da `iceServers` yok.

Öneri: ICE yapılandırmasını istemcide yükleyip send/receive transport'larına geçir; kısa ömürlü kimlik bilgilerini gerektiğinde yenile. Kısıtlı ağlar için uygun bir TLS relay yolu hazırla ve `relay` zorunlu bir testte gerçekten seçildiğini doğrula. Sunucunun doğrudan TCP adayı sunması, TURN relay yolu sağlamaz. Üretimde TURN servisinin kurulmuş ve erişilebilir olup olmadığı bu incelemede doğrulanmadı. [Mediasoup TURN yapılandırma API'si](https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-updateIceServers)

**6. Duraklatma kullanıcı tercihi olarak tutulmalı**

[room.js:2197](C:/Users/yahya/Desktop/screen_share/public/room.js:2197) videoyu duraklatıyor. Aynı click olayı document seviyesine çıkınca [room.js:1066](C:/Users/yahya/Desktop/screen_share/public/room.js:1066) içindeki genel dinleyici `unlockRemoteAudioPlayback()` çağırıyor; fonksiyon duraklatılmış videoyu yeniden oynatıyor.

Gerçek event handler'ları sırasıyla çalıştırıldığında:

```text
Düğme handler'ı sonrası paused: true
Document click handler'ı sonrası paused: false
```

Ayrıca duraklat düğmesi yalnızca video elementini durduruyor; ayrı sistem sesi elementinin oynatılması devam ediyor. Öneri: `userPaused` tercihini autoplay engeli durumundan ayır. Genel ses açma dinleyicisi manuel duraklatmayı bozmamalı. Yayın görüntüsü ve sistem sesi birlikte duraklamalı; sohbet mikrofonlarının devam edip etmeyeceği açık ürün davranışı olmalı. Devam düğmesi canlı yayına döndüğünü belirtmeli; mevcut sistemde geçmişe dönük oynatma yok.

**7. Film tamponunu her consumer oluşturulduğunda uygula ve gerçek gecikmeyi ölç**

[room.js:967](C:/Users/yahya/Desktop/screen_share/public/room.js:967) tamponu video oluşturulurken uyguluyor. Audio dalında aynı çağrı yok. Gerçek `consumeProducer()` fonksiyonunda önce video, sonra ses oluşturulduğunda film modundaki tercihler **video: 400 ms, audio: null** oldu. Sonradan odaya katılım bu sırayla gerçekleşebilir; içerik türü tekrar değiştirilirse tüm mevcut alıcılar yeniden ayarlanıyor.

Öneri: her yeni alıcının tamponunu kaynak türüne göre ayarla. Video ve sistem sesini eşleştir; sohbet mikrofonlarını gereksiz yere film tamponuna bağlamamayı değerlendir. Kütüphane `consumer.rtpReceiver` ve `producer.rtpSender` alanlarını zaten sunuyor; özel `handler._pc` alanlarına bağımlılık azaltılabilir.

Bu bulgu tek başına duyulur senkron kaymasını kanıtlamaz. Tarayıcı senkronize track'ler için kendi düzeltmesini yapabilir. `jitterBufferTarget` bir tercihtir; gerçek gecikme garantisi değildir. Ortalama gerçekleşen gecikmeyi sayaç farklarından hesapla, ardından sabit 150/400 ms düzenini ağ koşullarına göre yavaş değişen, sınırlandırılmış bir politikayla karşılaştır. [W3C jitterBufferTarget](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget)

**8. Takılmayı ölçen bir sağlık paneli ve oturum özeti ekle**

[room.js:2254](C:/Users/yahya/Desktop/screen_share/public/room.js:2254) bitrate/FPS/RTT/kayıp gösteriyor; donma sayısını ve kodlama darboğazını toplamıyor. Paket kaybı bütün oturumun toplamından hesaplandığından son birkaç saniyedeki kötüleşme uzun seansta gizlenebilir. Yayıncıda kayıp/jitter, bunları sağlamayan `outbound-rtp` nesnesinden okunuyor; ilgili alıcı raporları ilişkilendirilmiyor. Çoklu seste değerler toplanmak yerine son bulunan raporla üzerine yazılıyor. Döngü eski PeerConnection'ı kapatıp yenisine geçildiğinde de yeniden bağlanmalı.

Önerilen veriler: ilk görüntü süresi; `freezeCount` ve `totalFreezesDuration` farkları; gerçek çözünürlük/FPS; `qualityLimitationReason`; kare başına encode/decode süresi; 2–5 saniyelik kayıp ve bitrate farkları; gerçek jitter buffer gecikmesi; seste `concealedSamples`; seçili aday çiftinin UDP/TCP/relay türü. Desteklenmeyen alanlar “ölçülemiyor” olmalı. Ekrana “ağ yavaş”, “yayıncı kodlama yükü yüksek” veya “izleyici cihazı yetişemiyor” gibi anlaşılır sonuçlar çıkarılabilir. [W3C WebRTC istatistikleri](https://www.w3.org/TR/webrtc-stats/)

**9. Codec seçimi oda uyumluluğunu korumalı**

[room.js:2461](C:/Users/yahya/Desktop/screen_share/public/room.js:2461) yalnızca yayıncı cihazının ortak router yeteneklerine bakıyor. AV1 seçildiğinde onu çözemeyen izleyici için [server.js:774](C:/Users/yahya/Desktop/screen_share/backend/server.js:774) `Cannot consume` dönüyor; istemci [room.js:945](C:/Users/yahya/Desktop/screen_share/public/room.js:945) bunu yalnızca konsola yazıyor. İzleyiciye özel başka codec'te görüntü üretme yolu bulunmuyor.

Öneri: oda için ortak codec desteğini değerlendir; sonradan katılan desteklenmeyen cihazda anlaşılır hata ve uyumlu yayın seçeneği sun. “H264 — donanım hızlandırma” etiketi garantili sonuç gibi görünmemeli: yalnızca codec adı o cihazda donanım kodlayıcısı kullanıldığını ispatlamaz. Codec kararını gerçek encode/decode süresi, FPS, CPU sınırlaması ve izleyici uyumluluğuyla doğrula. Bu turda VP8, H264 ve AV1 arasında gerçek cihaz performans karşılaştırması yapılmadı.

**10. Kalite kontrolleri yaptığı işlemi doğru göstermeli**

[room.js:1361](C:/Users/yahya/Desktop/screen_share/public/room.js:1361) hazır ayar tıklandığında yalnızca form alanlarını ve düğme stilini değiştiriyor. Canlı track veya encoding güncellenmiyor. İçerik türü canlı uygulanabiliyor; codec için “sonraki yayında” açıklaması var; çözünürlük/FPS/bitrate için aynı açıklık yok.

Öneri: uygulanmamış ayarı belirt veya canlı uygulanabilen değerleri `applyConstraints`/encoding güncellemesiyle uygula. “Seçilen: 1080p60” ile “Gönderilen: 720p30” ayrı gösterilmeli. Film kullanımında içerik türü gelişmiş ayarlar içinde gizli kalmamalı. Film, metin ve düşük gecikme gerektiren etkileşimli kullanım için anlaşılır hazır profiller düşünülebilir.

**Uzun oturumlar için diğer teknik işler**

- [server.js:632](C:/Users/yahya/Desktop/screen_share/backend/server.js:632) `transport.on('close')` dinliyor; kurulu mediasoup close bildirimini observer üzerinde yayıyor. Consumer kapanışları için oda haritasını/sayaçları temizleyen karşılıklar da eksik. Tekrarlı yayın durdur/başlat ve reconnect sonrasında kapalı nesneler ile sayaçlar birikmemeli; temizlik tek seferlik ve olayın doğru yüzeyinde olmalı.
- [config.js:128](C:/Users/yahya/Desktop/screen_share/backend/config.js:128) içindeki `minimumAvailableOutgoingBitrate`, kurulu `Router.createWebRtcTransport()` tarafından okunan bir seçenek değil. Dolayısıyla “etkin 1,5 Mbps taban” kabul edilerek performans yorumu yapılmamalı. Gerçek minimum API'siyle karıştırılmamalı. Başlangıç için kullanılan **10 Mbps** tahmini ise aktif; zayıf ağda kademeli başlangıçla karşılaştırılmalı.
- Bir oda tek router/worker üzerinde. Çok izleyici hedefinde gerçek medya çıkışı ve worker yükü ölçülmeli. Yaklaşık 5 Mbps görüntü × 100 izleyici = 500 Mbps video yükü; buna ses, RTP/IP ve yeniden iletim yükü eklenir. Bu kapasite ölçümü değildir. [RoomManager.js:544](C:/Users/yahya/Desktop/screen_share/backend/RoomManager.js:544) içindeki pipe iskeleti aktif akışa bağlı değil; çalışır bir ölçekleme çözümü sayılmamalı.
- [Vercel vendor önbelleği](C:/Users/yahya/Desktop/screen_share/vercel.json:25) sabit dosya adına bir yıllık `immutable` veriyor. Kütüphane güncellemesi sırasında dosya adı/içerik hash'i değişmezse eski istemciler eski paketi kullanabilir.
- README ve eski kalite araştırması mevcut codec/katman düzeniyle eşleştirilmeli. Önceki deneyimlere dayanan performans iddiaları, ölçüm ve tarayıcı sürümüyle birlikte tutulmalı.

**İzleyici deneyimine eklenebilecek küçük ama görünür özellikler**

- Autoplay engellenirse açık bir “Sesi aç” düğmesi ve durum mesajı.
- Sistem sesi ile konuşma sesine ayrı ses seviyesi; sonradan katılanlar için producer kaynak türü metadata'sının da gönderilmesi.
- Sinema görünümü, sohbeti kapatma, dokunmaya uygun ve gerektiğinde gizlenen kontroller.
- Desteklenen tarayıcıda resim içinde resim; mobil tam ekran hatası için anlaşılır yedek davranış.
- Kullanıcı isterse ekranı açık tutma; görünürlük değişiminde tekrar ele alma.
- Sohbet alanına yazarken çalışmayan Space/M/F kısayolları ve erişilebilir kontrol adları.

**Doğrulama sonuçları ve önerilen kabul planı**

`npm run lint`: **0 hata, 3 kullanılmayan fonksiyon uyarısı**. Mevcut birim testleri: **89/89 başarılı**. Tam `npm test` Windows sandbox'ında alt süreç açılırken `spawn EPERM` verdi; kurulu mediasoup worker dosyası da mevcut değil. Alt süreç gerektirmeyen birim testleri `node --test --test-isolation=none` ile çalıştırıldı. Entegrasyon ve tarayıcı duman testi tamamlandı olarak raporlanmıyor.

Ek doğrulamalar uygulama fonksiyonları kaynak koddan alınarak Node VM içinde, sahte tarayıcı/medya uçlarıyla çalıştırıldı. Doğrulananlar: yanlış bitrate seçenekleri, ConsumerScore biçimi, eski transport ile erken dönüş, sonradan eklenen audio receiver'ın tamponu, duraklatmanın document click ile geri alınması ve çok katmanlı consumer'da manuel kalite hesabı. Bunlar ağ/FPS benchmark'ı değildir.

Önerilen uygulama sırası:

1. Birim hatası, skor biçimi, reconnect ve duraklatma düzeltmeleri; gerçek API biçimli regresyon kontrolleri.
2. TURN ve her consumer için tampon ayarı; ilk kare/donma/encode-decode ölçümleri.
3. Aynı cihaz ve içerikte tek değişkenli karşılaştırmalar: bitrate politikası, film tamponu ve iki katmanlı yayın.
4. Cihaz sonuçlarına göre codec/preset seçimi ve arayüz iyileştirmeleri.

| Deneme | Uygulama | Değerlendirme |
|---|---|---|
| Gerçek içerik | Yazı kaydırma, 24/25/30 FPS film, hareketli 60 FPS içerik | Gerçek yakalama/encode/decode FPS ve okunabilirlik |
| Ağ daralması | 10 → 3 → 1 Mbps, ayrı upload/download sınırları; %1–3 kayıp; farklı RTT/jitter | Son pencere kaybı, donma süresi, katman geçişi ve toparlanma |
| Ağ değişimi | 3/10/30 saniyelik kopmalar, Wi-Fi/mobil geçişi | Sayfa yenilemeden ses ve görüntünün dönmesi veya anlaşılır yeniden paylaşma akışı |
| TURN | Doğrudan UDP/TCP yollarının ayrı engellenmesi, relay zorunlu test | Seçili relay adayı ve medya akışı |
| Uzun izleme | Aynı içerikle en az 60–120 dakika | Donma/saate, toplam donma oranı, ses bozulması, A/V farkı, bellek ve consumer sayısı |
| Cihaz uyumu | Chrome/Edge/Firefox, iOS Safari; düşük ve yüksek güçlü cihazlar | Codec uyumu, ses açma, tam ekran, gerçek kodlayıcı yükü |
| Tekrar/katılım | Yayın açıkken geç katılım; 20 durdur/başlat turu | Doğru tampon, ses kaynağı, kapanmış consumer kalmaması |

Gerçek ekran yakalama testi gerekli: mevcut duman testi hareketli canvas kullanıyor; bu, `getDisplayMedia` ekran kaynağının tarayıcıya özgü kodlama davranışını bütünüyle temsil etmez. Mevcut yük testi de DTLS kurup medya çözmediğini açıkça belirtiyor. [Duman testi](C:/Users/yahya/Desktop/screen_share/scripts/smoke-browser.js:243), [yük testinin kapsamı](C:/Users/yahya/Desktop/screen_share/backend/loadtest/signaling-load.js:13).

İlk ölçümde mevcut sürümün başlangıç değerleri kaydedilmeli. Başarı; aynı koşullarda donma süresi ve ses kaybının azalması, ilk kare/toparlanma süresinin iyileşmesi ve CPU/upload yükünün kabul edilebilir kalmasıyla gösterilmeli. Sabit FPS artışı veya yüzde iyileşme için henüz veri yok.
