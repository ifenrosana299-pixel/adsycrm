const { trackShipment } = require('../lib/mengantar');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { tracking_number, courier } = req.query;
  if (!tracking_number || !courier) {
    res.status(400).json({ error: 'tracking_number and courier required' });
    return;
  }

  try {
    const data = await trackShipment(tracking_number, courier);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
