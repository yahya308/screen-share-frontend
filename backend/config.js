module.exports = {
    // Public IP of the server (Hetzner VPS)
    announcedIp: '167.235.53.246',

    // Port to listen on
    port: 3000,

    // Mediasoup settings
    mediasoup: {
        // Worker settings
        worker: {
            rtcMinPort: 2000,
            rtcMaxPort: 2020,
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
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters:
                    {
                        'x-google-start-bitrate': 1000
                    }
                }
            ]
        },
        // WebRtcTransport settings
        webRtcTransport: {
            listenIps: [
                {
                    ip: '0.0.0.0',
                    announcedIp: '167.235.53.246'
                }
            ],
            maxIncomingBitrate: 25000000, // Increased to 25 Mbps to support high quality
            initialAvailableOutgoingBitrate: 1000000,
        }
    },

    // HTTPS Configuration
    https: {
        domain: 'yahya-sfu.duckdns.org',
        cert: '/etc/letsencrypt/live/yahya-sfu.duckdns.org/fullchain.pem',
        key: '/etc/letsencrypt/live/yahya-sfu.duckdns.org/privkey.pem'
    }
};
