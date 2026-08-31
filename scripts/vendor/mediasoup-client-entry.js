/**
 * mediasoup-client için ESM giriş noktası.
 *
 * Paket CommonJS yayınlıyor ("use strict" + exports.X = ..., __esModule: true).
 * lib/index.js doğrudan ESM'e paketlenirse tarayıcı
 * `import { Device } from 'mediasoup-client'` satırında
 * "does not provide an export named 'Device'" der; varsayılan içe aktarma da
 * `undefined` gelir (paketin bir `default` dışa aktarımı yok).
 *
 * Adlandırılmış yeniden dışa aktarım kullanıyoruz: esbuild CJS'teki
 * `exports.X = ...` atamalarını statik olarak çözüp gerçek adlandırılmış
 * dışa aktarımlar üretiyor.
 */

export {
    Device,
    detectDevice,
    detectDeviceAsync,
    parseScalabilityMode,
    version,
    types,
    ortc,
    enhancedEvents,
    FakeHandler,
    debug
} from 'mediasoup-client';
