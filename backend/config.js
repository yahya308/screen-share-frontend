module.exports = {
    // Public IP of the server (Oracle Cloud)
    announcedIp: '130.61.104.4',

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
                    clockRate: 48000,
                    channels: 2,
                    parameters: {
                        useinbandfec: 1,  // ⭐ Packet loss recovery
                        usedtx: 1         // ⭐ Discontinuous transmission (bandwidth saving)
                    }
                },
                // ⭐ VP9 - Best for screen sharing (30-50% better compression)
                {
                    kind: 'video',
                    mimeType: 'video/VP9',
                    clockRate: 90000,
                    parameters: {
                        'profile-id': 0  // Profile 0 optimized for screen content
                    }
                },
                // VP8 - Fallback for older browsers
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: {
                        'x-google-start-bitrate': 1000
                    }
                },
                // ⭐ H264 - For iOS Safari compatibility
                {
                    kind: 'video',
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',  // Baseline profile
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
                    announcedIp: '130.61.104.4'
                }
            ],
            maxIncomingBitrate: 50000000, // 50 Mbps for high quality
            initialAvailableOutgoingBitrate: 5000000, // Start at 5 Mbps for faster playback
            enableUdp: true,
            enableTcp: true,
            preferUdp: true
        }
    },

    // HTTPS Configuration (SSL terminated by Nginx, but kept for reference)
    https: {
        domain: 'yahya-oracle.duckdns.org',
        cert: '/etc/letsencrypt/live/yahya-oracle.duckdns.org/fullchain.pem',
        key: '/etc/letsencrypt/live/yahya-oracle.duckdns.org/privkey.pem'
    }
};
