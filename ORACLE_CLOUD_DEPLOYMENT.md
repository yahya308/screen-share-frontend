# Oracle Cloud Deployment Guide

Bu rehber, WebRTC Mediasoup backend'ini Oracle Cloud sunucusuna Docker ile deploy etmek için adım adım talimatlar içerir.

## Ön Hazırlık

### Sunucu Bilgileri
- **IP:** 130.61.104.4
- **Domain:** yahya-oracle.duckdns.org
- **Portainer:** https://130.61.104.4:9443

### Gerekli Portlar

| Port | Protocol | Amaç |
|------|----------|------|
| 80 | TCP | Let's Encrypt HTTP challenge |
| 443 | TCP | HTTPS & WebSocket |
| 40000-49999 | UDP | WebRTC Media (RTP/RTCP) |

---

## Adım 1: Oracle Cloud Security List Yapılandırması

Oracle Cloud Console'da güvenlik kurallarını açın:

1. [Oracle Cloud Console](https://cloud.oracle.com/) → **Networking** → **Virtual Cloud Networks**
2. VCN'nizi seçin → **Security Lists** → Default Security List
3. **Add Ingress Rules** butonuna tıklayın ve şu kuralları ekleyin:

```
Source: 0.0.0.0/0
Protocol: TCP
Destination Port: 80
Description: HTTP for Let's Encrypt

Source: 0.0.0.0/0
Protocol: TCP
Destination Port: 443
Description: HTTPS WebSocket

Source: 0.0.0.0/0
Protocol: UDP
Destination Port: 40000-49999
Description: WebRTC Media Ports
```

---

## Adım 2: Sunucuya Bağlanma

```bash
ssh ubuntu@130.61.104.4
```

---

## Adım 3: Linux Firewall (iptables) Yapılandırması

Oracle Cloud varsayılan olarak iptables kullanır. Portları açın:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 40000:49999 -j ACCEPT

# Kuralları kalıcı hale getir
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

---

## Adım 4: SSL Sertifikası Alma (Let's Encrypt)

Certbot ile SSL sertifikası alın:

```bash
# Certbot kur
sudo apt-get update
sudo apt-get install -y certbot

# Sertifika al (standalone mode - nginx çalışmadan önce)
sudo certbot certonly --standalone -d yahya-oracle.duckdns.org
```

E-posta adresinizi girin ve şartları kabul edin.

---

## Adım 5: Proje Dosyalarını Sunucuya Yükleme

### Seçenek A: Git ile

```bash
# Proje dizini oluştur
sudo mkdir -p /opt/screen-share
cd /opt/screen-share

# Repo'yu klonla (public repo ise)
sudo git clone https://github.com/yahya308/screen-share-frontend.git .

# veya backend branch'i varsa
sudo git clone -b main https://github.com/yahya308/screen-share-backend.git .
```

### Seçenek B: SCP ile (Lokal makineden)

Windows PowerShell'den:

```powershell
# Tüm proje dosyalarını yükle
scp -r "C:\Users\yahya\Desktop\Screen_Share - Kopya\*" ubuntu@130.61.104.4:/tmp/screen-share/

# Sunucuda taşı
ssh ubuntu@130.61.104.4 "sudo mv /tmp/screen-share /opt/screen-share"
```

### Seçenek C: Portainer ile (GUI)

1. https://130.61.104.4:9443 adresine git
2. Stacks → Add Stack
3. docker-compose.yml içeriğini yapıştır
4. GitHub repo URL'sini ekle (opsiyonel)

---

## Adım 6: Docker Compose ile Başlatma

```bash
cd /opt/screen-share

# Servisleri başlat
sudo docker-compose up -d --build

# Logları kontrol et
sudo docker-compose logs -f
```

---

## Adım 7: Kontrol ve Test

### Servis Durumu

```bash
sudo docker-compose ps
```

Beklenen çıktı:
```
NAME                COMMAND                  SERVICE     STATUS
mediasoup-backend   "node server.js"         mediasoup   Up
nginx-proxy         "/docker-entrypoint.…"   nginx       Up
```

### SSL Kontrolü

```bash
curl -I https://yahya-oracle.duckdns.org
```

### WebSocket Testi

Tarayıcınızda Developer Console açıp:
```javascript
const socket = io("https://yahya-oracle.duckdns.org");
socket.on('connect', () => console.log('Connected!'));
```

---

## Adım 8: Vercel Frontend'i Güncelleme

Frontend zaten `yahya-oracle.duckdns.org` adresine bağlanacak şekilde güncellendi. 

GitHub'a push'ladığınızda Vercel otomatik deploy edecektir:

```bash
cd "C:\Users\yahya\Desktop\Screen_Share - Kopya"
git add .
git commit -m "Migrate backend to Oracle Cloud"
git push
```

---

## Sorun Giderme

### Container başlamıyorsa

```bash
# Logları kontrol et
sudo docker-compose logs mediasoup
sudo docker-compose logs nginx

# Yeniden başlat
sudo docker-compose restart
```

### SSL sertifikası bulunamıyorsa

```bash
# Sertifika var mı kontrol et
sudo ls -la /etc/letsencrypt/live/yahya-oracle.duckdns.org/

# Yoksa yeniden al
sudo certbot certonly --standalone -d yahya-oracle.duckdns.org
```

### Port açık değilse

```bash
# iptables kurallarını kontrol et
sudo iptables -L -n | grep -E "(80|443|40000)"

# Dinlenen portları kontrol et
sudo netstat -tlnp | grep -E "(80|443|3000)"
```

### WebRTC bağlantı problemi

```bash
# UDP portlarının açık olduğunu doğrula
sudo docker exec mediasoup-backend node -e "console.log(require('./config').mediasoup.worker)"
```

---

## Otomatik Yeniden Başlatma

Docker container'ları sunucu yeniden başladığında otomatik başlar (`restart: unless-stopped`).

SSL sertifikası yenileme için certbot container'ı 12 saatte bir kontrol eder.

---

## Faydalı Komutlar

```bash
# Tüm logları izle
sudo docker-compose logs -f

# Sadece mediasoup logları
sudo docker-compose logs -f mediasoup

# Container'ları durdur
sudo docker-compose down

# Yeniden build et ve başlat
sudo docker-compose up -d --build

# Container'a bağlan
sudo docker exec -it mediasoup-backend /bin/bash
```
