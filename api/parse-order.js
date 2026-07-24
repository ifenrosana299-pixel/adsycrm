export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text wajib' });

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
          content: `Parse teks order WhatsApp ini ke JSON. Jawab HANYA dengan JSON valid, tanpa teks lain.

Format JSON yang harus diisi:
{
  "no": "",
  "nama": "",
  "hp": "",
  "alamat": "",
  "kelurahan": "",
  "kecamatan": "",
  "kabupaten": "",
  "provinsi": "",
  "kodepos": "",
  "jumlah_pesanan": "",
  "quantity": "",
  "pembayaran": "",
  "total_pembayaran": "",
  "rincian_pembayaran": "",
  "instruksi_pengiriman": "",
  "keterangan": "",
  "keluhan": ""
}

Catatan:
- no: nomor order (baris pertama, contoh "No. 13. JNE-MENG" atau "13. JNE")
- hp: nomor HP customer (format 08xxx atau 628xxx)
- quantity: hanya angka (misal "2")
- total_pembayaran: hanya angka tanpa titik/koma (misal "150000")
- rincian_pembayaran: format ongkir|pot.ongkir|admin|pot.admin|harga (misal "13000|0|5000|0|120000"), kosongkan jika tidak ada
- pembayaran: "COD" atau "Transfer"
- jumlah_pesanan: isi lengkap termasuk nama produk (misal "2 Botol HerbaMax")
- kodepos: 5 digit angka saja

Teks order:
${text}`
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const claudeData = await response.json();
    const rawText = claudeData.content?.[0]?.text?.trim() || '{}';

    const jsonStr = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      const parsed = JSON.parse(jsonStr);
      return res.status(200).json(parsed);
    } catch {
      return res.status(200).json({});
    }
  } catch (err) {
    console.error('[parse-order]', err);
    return res.status(500).json({ error: err.message });
  }
}
