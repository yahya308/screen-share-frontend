const crypto = require('crypto');

module.exports = (req, res) => {
  try {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    // STUN servers
    const stunServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ];

    const iceServers = [...stunServers];

    const turnHost = process.env.TURN_HOST;
    const turnPort = process.env.TURN_PORT || '3478';
    const turnTlsPort = process.env.TURN_TLS_PORT || '5349';
    const turnTlsEnabled = ((process.env.TURN_ENABLE_TLS || '').toLowerCase() === 'true') || Boolean(process.env.TURN_TLS_PORT);
    const turnTransports = (process.env.TURN_TRANSPORTS || 'udp,tcp')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);

    const turnUsername = process.env.TURN_USERNAME;
    const turnPassword = process.env.TURN_PASSWORD;
    const turnSecret = process.env.TURN_SECRET;
    const turnRealm = process.env.TURN_REALM || 'realm';

    const pushTurnServers = (username, credential) => {
      turnTransports.forEach(transport => {
        iceServers.push({
          urls: `turn:${turnHost}:${turnPort}?transport=${transport}`,
          username,
          credential,
          realm: turnRealm
        });
      });

      if (turnTlsEnabled) {
        iceServers.push({
          urls: `turns:${turnHost}:${turnTlsPort}?transport=tcp`,
          username,
          credential,
          realm: turnRealm
        });
      }
    };

    if (turnHost) {
      if (turnSecret) {
        const ttlSeconds = parseInt(process.env.TURN_TTL_SECONDS || '3600', 10);
        const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:user`;
        const hmac = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
        pushTurnServers(username, hmac);
      } else if (turnUsername && turnPassword) {
        pushTurnServers(turnUsername, turnPassword);
      }
    }

    return res.status(200).json({ iceServers, iceCandidatePoolSize: 10 });
  } catch (e) {
    console.error('Error building ICE config:', e);
    return res.status(200).json({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceCandidatePoolSize: 10
    });
  }
};
