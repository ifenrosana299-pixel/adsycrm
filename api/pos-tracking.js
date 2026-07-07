const { trackPos } = require('../lib/mengantar');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { resi } = req.query;
  if (!resi) { res.status(400).json({ error: 'resi required' }); return; }

  try {
    const data = await trackPos(resi);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};
