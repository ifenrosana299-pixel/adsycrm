export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 wajib' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 }
            },
            {
              type: 'text',
              text: `Ini adalah screenshot percakapan WhatsApp antara CS dan pelanggan yang gagal melakukan repeat order produk herbal/suplemen.

Ekstrak informasi berikut dalam 1-2 kalimat singkat:
- Apa alasan pelanggan tidak mau repeat order?
- Bagaimana kondisi/respon pelanggan?

Jawab langsung tanpa label/header, cukup 1-2 kalimat ringkas dalam Bahasa Indonesia.`
            }
          ]
        }]
      })
    });

    if (!response.ok) throw new Error(`Claude API error ${response.status}`);
    const data = await response.json();
    const hasil = data.content?.[0]?.text?.trim() || '';
    return res.status(200).json({ hasil });
  } catch (err) {
    console.error('[analyze-gagal-repeat]', err);
    return res.status(500).json({ error: err.message });
  }
}
