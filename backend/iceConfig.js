const crypto = require('crypto');

function buildIceConfig(env = process.env, now = Date.now()) {
    const iceServers = [];
    const ttl = Math.max(120, Math.min(3600, Number(env.TURN_TTL_SECONDS) || 900));
    if (env.TURN_HOST && env.TURN_SECRET) {
        const username = `${Math.floor(now / 1000) + ttl}:${crypto.randomBytes(6).toString('hex')}`;
        const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
        const port = env.TURN_PORT || '3478';
        const urls = [`turn:${env.TURN_HOST}:${port}?transport=udp`, `turn:${env.TURN_HOST}:${port}?transport=tcp`];
        if (env.TURN_TLS_PORT) urls.push(`turns:${env.TURN_HOST}:${env.TURN_TLS_PORT}?transport=tcp`);
        iceServers.push({ urls, username, credential });
    }
    return { iceServers, expiresAt: now + ttl * 1000 };
}

module.exports = { buildIceConfig };
