// Proxy Cek Ongkir — semua via api-public.mengantar.com
const SEARCH_BASE = 'https://api-public.mengantar.com';
const ORIGIN_ID   = '5fc63315f8f44b34aa4c44c4'; // Gudang: Galur, Kulon Progo, DI Yogyakarta

// key = kode ekspedisi yang dipakai di app (EKSPEDISI_LIST js/app.js),
// value = key kurir di response allEstimatePublic
const COURIER_MAP = {
  JNE:       'JNE',
  JNT:       'JT',
  SICEPAT:   'SiCepat',
  ANTERAJA:  'anteraja',
  NINJA:     'Ninja',
  LION:      'lion',
  POS:       'pos',
  SAP:       'SAP',
  IDEXPRESS: 'iDexpress',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const keyword       = (req.query.keyword || '').trim();
  const destinationId = (req.query.destination_id || '').trim();
  const weight        = parseFloat(req.query.weight) || 1;

  // mode=search: cuma cari kandidat alamat (buat autocomplete), gak hitung ongkir
  if (req.query.mode === 'search') {
    if (!keyword) return res.status(400).json({ error: 'keyword wajib diisi' });
    try {
      const searchR = await fetch(
        `${SEARCH_BASE}/api/public/csorder/address/search?keyword=${encodeURIComponent(keyword)}`,
        { headers: { Accept: 'application/json' } }
      );
      const searchJson = await searchR.json();
      const list = (searchJson?.data || []).slice(0, 10).map(d => ({
        id:        d._id,
        provinsi:  d.PROVINCE_NAME,
        kabupaten: d.CITY_NAME,
        kecamatan: d.DISTRICT_NAME,
        kelurahan: d.SUBDISTRICT_NAME,
        label: `${d.PROVINCE_NAME}, ${d.CITY_NAME}, ${d.DISTRICT_NAME}, ${d.SUBDISTRICT_NAME}`,
      }));
      return res.status(200).json({ ok: true, data: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!keyword && !destinationId) return res.status(400).json({ error: 'keyword atau destination_id wajib diisi' });

  try {
    let dest;
    if (destinationId) {
      // CS udah pilih alamat presisi dari dropdown autocomplete -- skip pencarian ulang
      dest = {
        _id: destinationId,
        DISTRICT_NAME: req.query.kecamatan  || '',
        CITY_NAME:     req.query.kabupaten  || '',
        PROVINCE_NAME: req.query.provinsi   || '',
      };
    } else {
      const searchR = await fetch(
        `${SEARCH_BASE}/api/public/csorder/address/search?keyword=${encodeURIComponent(keyword)}`,
        { headers: { Accept: 'application/json' } }
      );
      const searchJson = await searchR.json();
      const candidates = searchJson?.data || [];
      if (!candidates.length) return res.status(200).json({ ok: false, reason: 'Alamat tujuan tidak ditemukan' });

      // Kalau ada kecamatan+kabupaten dikirim → cocokkan untuk presisi lebih tinggi
      const kecQ = (req.query.kecamatan || '').toLowerCase().trim();
      const kabQ = (req.query.kabupaten || '').toLowerCase().trim();
      if (kecQ && kabQ) {
        dest = candidates.find(d =>
          d.DISTRICT_NAME?.toLowerCase() === kecQ &&
          d.CITY_NAME?.toLowerCase() === kabQ
        ) || candidates.find(d =>
          d.CITY_NAME?.toLowerCase() === kabQ
        ) || candidates[0];
      } else {
        dest = candidates[0];
      }
      if (!dest) return res.status(200).json({ ok: false, reason: 'Alamat tujuan tidak ditemukan' });
    }

    // allEstimatePublic via api-public.mengantar.com
    const estR = await fetch(
      `${SEARCH_BASE}/api/order/allEstimatePublic?origin_id=${ORIGIN_ID}&destination_id=${dest._id}&weight=${weight}`,
      { headers: { Accept: 'application/json' } }
    );
    const estJson = await estR.json();
    if (!estJson?.success) return res.status(200).json({ ok: false, reason: 'Gagal ambil estimasi ongkir' });

    // Skor performa kurir (opsional) -- kalau API key belum diset/gagal, skor dikosongin
    // aja, gak ganggu harga/estimasi yang udah didapat.
    let scoreMap = {};
    let recommendedKey = null;
    const apiKey = process.env.MENGANTAR_API_KEY;
    if (apiKey) {
      try {
        const perfR = await fetch(
          `${SEARCH_BASE}/api/public/${apiKey}/order/getPerformancePublic`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ city: dest.CITY_NAME, allEstimateData: estJson.data }),
          }
        );
        const perfJson = await perfR.json();
        if (perfJson?.success) {
          (perfJson.data?.couriers || []).forEach(c => { scoreMap[c.key.toLowerCase()] = c.score; });
          recommendedKey = (perfJson.data?.recommended || '').toLowerCase() || null;
        }
      } catch (e) { /* diamkan -- skor optional */ }
    }

    // Buat lookup case-insensitive dari data API
    const dataLower = Object.fromEntries(
      Object.entries(estJson.data || {}).map(([k, v]) => [k.toLowerCase(), v])
    );

    const couriers = Object.entries(COURIER_MAP).map(([key, apiCourierKey]) => {
      const d = dataLower[apiCourierKey.toLowerCase()];
      const score = scoreMap[apiCourierKey.toLowerCase()];
      const recommended = recommendedKey === apiCourierKey.toLowerCase();
      if (!d) return { key, unsupported: true, score: score ?? null, recommended };
      return {
        key,
        price: d.price,
        unsupported: !!d.unsupported,
        estimate_delivery: d.estimatedDate || d.estimate_delivery || '',
        score: score ?? null,
        recommended,
      };
    });

    return res.status(200).json({
      ok: true,
      destination: {
        kecamatan: dest.DISTRICT_NAME,
        kabupaten: dest.CITY_NAME,
        provinsi:  dest.PROVINCE_NAME,
      },
      couriers,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
