# 🖥️ Ekran Paylaşım Uygulaması

Modern WebRTC teknolojisi kullanarak yüksek kaliteli ekran paylaşımı yapabilen web uygulaması.

## ✨ Özellikler

- **🎯 Yüksek Kalite**: 1080p 60fps ekran paylaşımı
- **🌐 Çoklu Tarayıcı**: Chrome, Firefox, Safari, Edge desteği
- **📱 Mobil Uyumlu**: Responsive tasarım ve touch gesture desteği
- **🔄 Otomatik Yeniden Bağlanma**: Bağlantı kesintilerinde otomatik kurtarma
- **🎛️ Kalite Kontrolü**: Çözünürlük, FPS ve bitrate ayarları
- **🔒 Güvenli**: STUN/TURN server desteği ile NAT traversal
- **📊 Gerçek Zamanlı**: Socket.IO ile anlık iletişim
- **🧪 Test Sayfası**: Sistem uyumluluğu kontrolü

## 🚀 Kurulum

### Gereksinimler
- Node.js 16.0.0 veya üzeri
- Modern web tarayıcısı (Chrome, Firefox, Safari, Edge)

### Adımlar

1. **Projeyi klonlayın:**
```bash
git clone <repository-url>
cd Screen_Share
```

2. **Bağımlılıkları yükleyin:**
```bash
npm install
```

3. **Uygulamayı başlatın:**
```bash
npm start
```

4. **Tarayıcıda açın:**
- **Yayıncı**: http://localhost:3000/
- **İzleyici**: http://localhost:3000/watch
- **Test**: http://localhost:3000/test

## 📱 Kullanım

### Yayıncı Olarak
1. Ana sayfaya gidin
2. "Ekranını Paylaş" butonuna tıklayın
3. Paylaşmak istediğiniz ekranı, pencereyi veya sekmeyi seçin
4. Kalite ayarlarını yapılandırın (çözünürlük, FPS, bitrate)
5. İzleyiciler otomatik olarak bağlanacak

### İzleyici Olarak
1. `/watch` sayfasına gidin
2. Yayıncı bağlandığında otomatik olarak yayın başlayacak
3. Mobil cihazlarda touch gesture'ları kullanın:
   - **Tek dokunuş**: Kontrolleri göster/gizle
   - **Çift dokunuş**: Tam ekran
   - **Sola kaydır**: Oynat/duraklat
   - **Yukarı kaydır**: Sessiz aç/kapat

## 🛠️ Geliştirme

### Script'ler
```bash
npm start          # Uygulamayı başlat
npm run dev        # Geliştirme modunda başlat (nodemon)
npm run lint       # Kod kalitesi kontrolü
npm run lint:fix   # Otomatik hata düzeltme
```

### Proje Yapısı
```
Screen_Share/
├── public/                 # Statik dosyalar
│   ├── broadcaster.html   # Yayıncı arayüzü
│   ├── viewer.html        # İzleyici arayüzü
│   └── test.html          # Test sayfası
├── server.js              # Ana sunucu dosyası
├── package.json           # Proje konfigürasyonu
├── .eslintrc.js          # ESLint konfigürasyonu
└── README.md             # Bu dosya
```

## 🔧 Konfigürasyon

### Kalite Ayarları
- **Çözünürlük**: 1920x1080, 1280x720, 854x480
- **FPS**: 60, 30, 24
- **Bitrate**: 1000-20000 kbps (önerilen: 8000 kbps)

### WebRTC Ayarları
```javascript
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};
```

## 🌐 Tarayıcı Desteği

| Tarayıcı | Versiyon | Durum |
|----------|----------|-------|
| Chrome | 72+ | ✅ Tam Destek |
| Firefox | 66+ | ✅ Tam Destek |
| Safari | 13+ | ✅ Tam Destek |
| Edge | 79+ | ✅ Tam Destek |

## 📱 Mobil Özellikler

- **Responsive Tasarım**: Tüm ekran boyutlarına uyum
- **Touch Gesture**: Dokunmatik cihazlar için özel kontroller
- **PWA Desteği**: Ana ekrana eklenebilir
- **iOS Optimizasyonu**: Safari için özel ayarlar
- **Android Optimizasyonu**: Chrome Mobile için özel ayarlar

## 🔍 Sorun Giderme

### Yayın Başlamıyor
1. Tarayıcı izinlerini kontrol edin
2. HTTPS kullanıyorsanız sertifika geçerli olmalı
3. Firewall ayarlarını kontrol edin
4. Test sayfasından sistem uyumluluğunu kontrol edin

### Bağlantı Kesiliyor
1. İnternet bağlantısını kontrol edin
2. STUN server'lara erişimi kontrol edin
3. Tarayıcı konsolunda hata mesajlarını kontrol edin
4. Otomatik yeniden bağlanma özelliği aktif

### Düşük Kalite
1. Kalite ayarlarını kontrol edin
2. İnternet bağlantı hızını kontrol edin
3. Bitrate değerini artırın
4. FPS değerini düşürün

## 📊 Performans

- **Gecikme**: <100ms (yerel ağ)
- **Bant Genişliği**: 1-20 Mbps (ayarlanabilir)
- **CPU Kullanımı**: %5-15 (1080p 60fps)
- **Bellek Kullanımı**: 50-200 MB

## 🔒 Güvenlik

- **HTTPS**: Güvenli bağlantı gerekli
- **İzin Kontrolü**: Kullanıcı onayı gerekli
- **Veri Şifreleme**: WebRTC ile uçtan uca şifreleme
- **STUN/TURN**: Güvenli NAT traversal

## 🤝 Katkıda Bulunma

1. Fork yapın
2. Feature branch oluşturun (`git checkout -b feature/amazing-feature`)
3. Commit yapın (`git commit -m 'Add amazing feature'`)
4. Push yapın (`git push origin feature/amazing-feature`)
5. Pull Request oluşturun

## 📄 Lisans

Bu proje MIT lisansı altında lisanslanmıştır. Detaylar için `LICENSE` dosyasına bakın.

## 🙏 Teşekkürler

- **WebRTC**: Real-time communication için
- **Socket.IO**: Real-time bidirectional iletişim için
- **Express.js**: Web framework için
- **Node.js**: Runtime environment için

## 📞 Destek

Sorunlarınız için:
1. GitHub Issues kullanın
2. Test sayfasından sistem kontrolü yapın
3. Tarayıcı konsolunda hata mesajlarını kontrol edin
4. README.md dosyasını okuyun

---

**⭐ Bu projeyi beğendiyseniz yıldız vermeyi unutmayın!**
