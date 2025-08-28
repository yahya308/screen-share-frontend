# Ekran Paylaşım Uygulaması

Node.js + WebRTC tabanlı basit bir ekran paylaşım uygulaması. Yayıncı ekranını paylaşabilir, izleyici ise canlı olarak izleyebilir.

## Özellikler

- 🎥 Ekran paylaşımı (getDisplayMedia API)
- 🔄 Peer-to-peer WebRTC bağlantısı
- 📱 Mobil uyumlu arayüz
- 🔍 Tam ekran izleme
- ⚡ Gerçek zamanlı bağlantı durumu
- 🎯 Basit ve kullanıcı dostu arayüz

## Kurulum

1. **Bağımlılıkları yükleyin:**
   ```bash
   npm install
   ```

2. **Sunucuyu başlatın:**
   ```bash
   npm start
   ```

3. **Tarayıcıda açın:**
   - Yayıncı: `http://localhost:3000/`
   - İzleyici: `http://localhost:3000/watch`

## Kullanım

### Yayıncı (Ekran Paylaşan)
1. `http://localhost:3000/` adresine gidin
2. "Ekranını Paylaş" butonuna tıklayın
3. Paylaşmak istediğiniz ekranı seçin
4. İzleyici otomatik olarak bağlanacaktır

### İzleyici
1. `http://localhost:3000/watch` adresine gidin
2. Yayıncı paylaşım başlattığında otomatik olarak bağlanacaksınız
3. "Tam Ekran" butonu ile tam ekran izleyebilirsiniz

## Teknik Detaylar

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vanilla JavaScript + WebRTC
- **Signaling:** Socket.IO
- **STUN Server:** Google (stun:stun.l.google.com:19302)
- **Ekran Yakalama:** getDisplayMedia API

## Proje Yapısı

```
├── server.js              # Ana sunucu dosyası
├── package.json           # Proje bağımlılıkları
├── README.md             # Bu dosya
└── public/               # Statik dosyalar
    ├── broadcaster.html  # Yayıncı arayüzü
    └── viewer.html       # İzleyici arayüzü
```

## Gereksinimler

- Node.js 14+ 
- Modern tarayıcı (Chrome, Firefox, Safari, Edge)
- HTTPS (production için) - WebRTC gereksinimi

## Geliştirme

Geliştirme modunda çalıştırmak için:
```bash
npm run dev
```

## Lisans

MIT
