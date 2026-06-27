export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { imageBase64, mimeType, produk } = req.body;

  if (!imageBase64 || !produk) {
    return res.status(400).json({ error: 'Data tidak lengkap (imageBase64 & produk wajib)' });
  }

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
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType || 'image/jpeg',
                data: imageBase64,
              }
            },
            {
              type: 'text',
              text: `Ini adalah foto testimoni pelanggan produk ${produk} (herbal/suplemen kesehatan).

Ekstrak informasi berikut dalam format JSON:
{
  "nama_customer": "nama pelanggan jika terlihat di gambar (isi null jika tidak ada)",
  "khasiat": "manfaat/khasiat produk yang disebutkan pelanggan (singkat, 1-2 kalimat)",
  "ringkasan": "ringkasan keseluruhan isi testimoni (1-2 kalimat)"
}

Jawab HANYA dengan JSON valid, tanpa teks lain.`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const claudeData = await response.json();
    const rawText = claudeData.content?.[0]?.text?.trim() || '{}';

    // Strip markdown code block jika ada
    const jsonStr = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      const parsed = JSON.parse(jsonStr);
      return res.status(200).json({
        nama_customer: parsed.nama_customer || null,
        khasiat:       parsed.khasiat       || null,
        ringkasan:     parsed.ringkasan     || null,
      });
    } catch {
      // Fallback: return raw text sebagai ringkasan
      return res.status(200).json({
        nama_customer: null,
        khasiat:       rawText,
        ringkasan:     rawText,
      });
    }
  } catch (err) {
    console.error('[analyze-testimoni]', err);
    return res.status(500).json({ error: err.message });
  }
}
