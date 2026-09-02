const announcedIp = process.env.ANNOUNCED_IP || '130.61.104.4';

module.exports = {
    // Public IP of the server (Oracle Cloud)
    announcedIp,

    // Port to listen on
    port: 3000,

    // Mediasoup settings
    mediasoup: {
        // Worker settings
        worker: {
            rtcMinPort: 40000,  // ⭐ Optimized port range start
            rtcMaxPort: 49999,  // ⭐ 10,000 ports for ~2,500-5,000 concurrent connections
            logLevel: 'warn',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp',
            ],
        },
        // Router settings
        router: {
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,        // ⭐ CD kalitesi (48kHz)
                    channels: 2,             // ⭐ Stereo (sistem sesi için)
                    parameters: {
                        useinbandfec: 1,     // ⭐ Forward Error Correction (paket kaybı telafisi)
                        usedtx: 0,           // ⭐ DTX KAPALI — sabit olmayan ortam gürültüsünde
                                             //   periyodik gürültü patlamaları ve "ön-kesik" yapar
                                             //   (bkz. Opus issue #89). Bant tasarrufu, ses kalitesine
                                             //   ve tutarlılığa değmez.
                        maxaveragebitrate: 128000,  // ⭐ 128 kbps yüksek kalite
                        stereo: 1,           // ⭐ Stereo garantisi (sistem sesi)
                        'sprop-stereo': 1,   // ⭐ Sender stereo bildirimi
                        ptime: 20,           // ⭐ 20ms paket boyutu (düşük gecikme + tutarlı)
                        cbr: 0               // ⭐ VBR (Variable Bitrate) - daha verimli
                    }
                },
                // ⭐ VP9 - FIRST for SVC support (better compression, scalable layers)
                {
                    kind: 'video',
                    mimeType: 'video/VP9',
                    clockRate: 90000,
                    parameters: {
                        'profile-id': 0,  // Profile 0 for screen content
                        'x-google-start-bitrate': 5000  // ⭐ Higher start for faster quality
                    },
                    rtcpFeedback: [
                        { type: 'nack' },
                        { type: 'nack', parameter: 'pli' },
                        { type: 'ccm', parameter: 'fir' },
                        { type: 'goog-remb' },
                        { type: 'transport-cc' }
                    ]
                },
                // VP8 - Fallback for older browsers
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: {
                        'x-google-start-bitrate': 5000  // ⭐ Higher start for faster quality
                    },
                    rtcpFeedback: [
                        { type: 'nack' },
                        { type: 'nack', parameter: 'pli' },
                        { type: 'ccm', parameter: 'fir' },
                        { type: 'goog-remb' },
                        { type: 'transport-cc' }
                    ]
                },
                // H264 - For iOS Safari compatibility
                {
                    kind: 'video',
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1
                    }
                }
            ]
        },
        // WebRtcTransport settings
        webRtcTransport: {
            listenIps: [
                {
                    ip: '0.0.0.0',
                    announcedIp
                }
            ],
            maxIncomingBitrate: 50000000, // 50 Mbps for high quality
            initialAvailableOutgoingBitrate: 10000000, // ⭐ 10 Mbps start for instant quality
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            // ⭐ Smooth streaming optimizations
            // Düşürüldü: 3 Mbps taban, zayıf/mobil bağlantıda mediasoup'un adaptive
            // bandwidth control'üne engel oluyordu ve paket kaybına yol açıyordu.
            minimumAvailableOutgoingBitrate: 1500000  // 1.5 Mbps taban (uyumlu adaptasyon)
        }
    },

    // HTTPS Configuration (SSL terminated by Nginx, but kept for reference)
    https: {
        domain: 'yahya-oracle.duckdns.org',
        cert: '/etc/letsencrypt/live/yahya-oracle.duckdns.org/fullchain.pem',
        key: '/etc/letsencrypt/live/yahya-oracle.duckdns.org/privkey.pem'
    }
};
