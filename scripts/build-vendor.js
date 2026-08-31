#!/usr/bin/env node
/**
 * Üçüncü taraf istemci kütüphanelerini public/vendor/ altına üretir.
 *
 * Daha önce socket.io cdnjs'ten, mediasoup-client esm.sh'ten yükleniyordu:
 * her biri giriş sayfasında keyfi kod çalıştırabilecek konumda bir alan adı,
 * hiçbirinde SRI yok ve biri erişilemezse uygulama hiç açılmıyordu. Artık
 * ikisi de kendi origin'imizden, package.json'da sabitlenmiş sürümlerle
 * sunuluyor — bu da katı bir CSP'yi (script-src 'self') mümkün kılıyor.
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'public', 'vendor');

fs.mkdirSync(vendorDir, { recursive: true });

// socket.io-client hazır bir tarayıcı derlemesi yayınlıyor: olduğu gibi kopyala.
const socketIoSource = path.join(root, 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js');
fs.copyFileSync(socketIoSource, path.join(vendorDir, 'socket.io.min.js'));
console.log('✅ vendor/socket.io.min.js');

// mediasoup-client CommonJS yayınlıyor; doğrudan paketlenirse tarayıcı
// `import { Device }` satırında patlar. Adlandırılmış dışa aktarımları
// yeniden yayınlayan bir ESM girişinden paketliyoruz.
esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'vendor', 'mediasoup-client-entry.js')],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
    outfile: path.join(vendorDir, 'mediasoup-client.esm.js'),
    logLevel: 'warning'
});
console.log('✅ vendor/mediasoup-client.esm.js');

for (const file of ['socket.io.min.js', 'mediasoup-client.esm.js']) {
    const size = fs.statSync(path.join(vendorDir, file)).size;
    console.log(`   ${file}: ${(size / 1024).toFixed(0)} KB`);
}
