module.exports = (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    const signalingUrl = process.env.VITE_SIGNALING_URL || process.env.SIGNALING_URL || '';

    return res.status(200).json({ signalingUrl });
  } catch (e) {
    console.error('Error building config:', e);
    return res.status(200).json({ signalingUrl: '' });
  }
};
