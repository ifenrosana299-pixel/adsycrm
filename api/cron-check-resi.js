const { trackShipment, trackPos } = require('../lib/mengantar');

const COURIER_MAP = {
  'JNE':'JNE','JNT':'JT','SiCepat':'SiCepat','Lion':'lion',
  'SAP':'SAP','Anteraja':'anteraja','Ninja':'Ninja','IDX':'iDexpress',
  'SICEPAT':'SiCepat','ANTERAJA':'anteraja','NINJA':'Ninja','LION':'lion'
};

const ROWS_PER_RUN = 300; // batasi per invocation biar tidak kena timeout serverless
const CONCURRENCY = 8;

// Sinyal "bermasalah" terstruktur per kurir (bukan tebak kata) — disinkronkan manual dengan js/shared.js:
// - JNE (via Mengantar): history[].type.group === 'UNDELIVERED' atau type.tag === 'actionRequired'
// - POS Indonesia: history[].reason_delivery terisi
// Kurir lain (J&T dkk) belum expose field terstruktur di Mengantar, jadi fallback ke keyword.
const RETUR_PATTERN   = /retur|dikembalikan|\brts\b|\brto\b|return to sender/i;
const PROBLEM_PATTERN = /gagal|kendala|bermasalah|problematic|tidak ditemukan|alamat tidak (lengkap|dikenal)|tidak ada orang|tidak ditempat|tidak dihuni|menunggu konfirmasi|disimpan di gudang|ditolak|pindah alamat|box undel/i;

// Pola buat hitung step tertinggi yang PERNAH tercapai di seluruh history — disinkronkan manual
// dengan js/shared.js. Dipakai supaya resi Bermasalah/Retur nampilin posisi stepper yang beneran
// tercapai (misal OTW), bukan mentok di step tetap, walau status akhirnya gagal.
const OTW_PATTERN         = /sedang diantar|dalam pengantaran|out for delivery|kurir menuju|\botw\b|akan dikirim ke alamat penerima|with delivery courier|on delivery|1st attempt|2nd attempt|percobaan/i;
const KOTA_TUJUAN_PATTERN = /kota tujuan|gudang tujuan|tiba di kota|received at destination|received at warehouse|process and forward|inbound/i;

function computeProgressStep(entries, stage) {
  if (stage === 'SAMPAI') return 5;
  let step = 2; // resi sudah discan sistem kurir minimal = Dikirim
  (entries || []).forEach(e => {
    const d = (e.desc || '').toLowerCase();
    if (OTW_PATTERN.test(d)) step = Math.max(step, 4);
    else if (KOTA_TUJUAN_PATTERN.test(d)) step = Math.max(step, 3);
  });
  return step;
}

// Heuristik best-effort dari sinyal terstruktur + teks history kurir Indonesia — tuning lanjutan
// kemungkinan masih perlu setelah lihat lebih banyak sampel data asli.
// Return { stage, step } — step = posisi tertinggi di stepper 5 tahap yang pernah tercapai.
function mapTrackingStage({ resi, statusCategory, entries }) {
  if (!resi) return { stage: 'MENUNGGU_RESI', step: 1 };
  const cat = (statusCategory || '').toUpperCase();
  const arr = Array.isArray(entries) ? entries : [];
  const latest = arr.length ? arr[arr.length - 1] : null;
  const latestDesc = (latest && latest.desc || '').toLowerCase();

  let stage;
  if (cat.includes('RETUR') || cat.includes('RETURN') || arr.some(e => RETUR_PATTERN.test(e.desc || ''))) {
    stage = 'RETUR';
  } else if (cat === 'DELIVERED' || /diterima oleh|delivered/.test(latestDesc)) {
    stage = 'SAMPAI';
  } else {
    const hasStructuredProblem = arr.some(e => e.group === 'UNDELIVERED' || e.tag === 'actionRequired' || !!e.reasonDelivery);
    if (hasStructuredProblem || arr.some(e => PROBLEM_PATTERN.test(e.desc || ''))) {
      stage = 'BERMASALAH';
    } else if (OTW_PATTERN.test(latestDesc)) {
      stage = 'OTW';
    } else if (KOTA_TUJUAN_PATTERN.test(latestDesc)) {
      stage = 'KOTA_TUJUAN';
    } else {
      stage = 'DIKIRIM';
    }
  }
  return { stage, step: computeProgressStep(arr, stage) };
}

function normalizeMengantar(json) {
  if (!json || !json.success || !json.data) return null;
  const d = json.data;
  const history = Array.isArray(d.history) ? d.history : [];
  const entries = history.map(h => ({
    desc: h.desc || '',
    group: (h.type && h.type.group) || null,
    tag: (h.type && h.type.tag) || null,
    reasonDelivery: null
  }));
  return {
    statusCategory: d.statusCategory || d.status || '',
    entries,
    detail: { history, receiver: d.RECEIVER_NAME || null, city: d.RECEIVER_CITY || null }
  };
}

function normalizePos(json) {
  if (!json || !json.success || !json.data) return null;
  const d = json.data;
  const history = Array.isArray(d.connote_history) ? d.connote_history : [];
  const entries = history.map(h => ({
    desc: [h.content, h.content2].filter(Boolean).join(' '),
    group: null, tag: null,
    reasonDelivery: h.reason_delivery || null
  }));
  return {
    statusCategory: d.connote_state || '',
    entries,
    detail: { history, receiver: d.connote_receiver_name || null, city: null }
  };
}

async function checkOneResi(resi, ekspedisi) {
  const eks = (ekspedisi || '').toUpperCase();
  try {
    let normalized;
    if (eks === 'POS' || eks.includes('POS')) {
      normalized = normalizePos(await trackPos(resi));
    } else {
      const courier = COURIER_MAP[ekspedisi] || COURIER_MAP[eks] || ekspedisi;
      if (!courier) return null;
      normalized = normalizeMengantar(await trackShipment(resi, courier));
    }
    if (!normalized) return null;
    const { stage, step } = mapTrackingStage({ resi, ...normalized });
    return { stage, step, detail: normalized.detail };
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  const secret = req.query.secret || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const SUPABASE_URL = process.env.APP_SUPABASE_URL;
  const SUPABASE_KEY = process.env.APP_SUPABASE_KEY;
  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };

  let checked = 0, updated = 0, errors = 0;

  try {
    const filterParams = new URLSearchParams({
      select: 'id,resi,ekspedisi,status_resi,repeat_orders',
      resi: 'not.is.null',
      or: '(status_resi.is.null,status_resi.not.in.(SAMPAI,RETUR))',
      order: 'id',
      limit: String(ROWS_PER_RUN)
    });
    const listRes = await fetch(`${SUPABASE_URL}/rest/v1/crm_customers?${filterParams.toString()}`, { headers: sbHeaders });
    const rows = await listRes.json();
    if (!Array.isArray(rows)) throw new Error('Gagal ambil data crm_customers: ' + JSON.stringify(rows));

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async row => {
        try {
          const patch = {};
          let changed = false;

          if (row.status_resi !== 'SAMPAI' && row.status_resi !== 'RETUR') {
            checked++;
            const result = await checkOneResi(row.resi, row.ekspedisi);
            if (result) {
              patch.status_resi = result.stage;
              patch.status_resi_step = result.step;
              patch.status_resi_updated_at = new Date().toISOString();
              patch.status_resi_detail = result.detail;
              changed = true;
            }
          }

          const repeats = Array.isArray(row.repeat_orders) ? row.repeat_orders : [];
          const newRepeats = [];
          for (const rep of repeats) {
            if (!rep.resi || rep.status_resi === 'SAMPAI' || rep.status_resi === 'RETUR') { newRepeats.push(rep); continue; }
            checked++;
            const result = await checkOneResi(rep.resi, rep.ekspedisi);
            if (!result) { newRepeats.push(rep); continue; }
            changed = true;
            newRepeats.push({ ...rep, status_resi: result.stage, status_resi_step: result.step, status_resi_updated_at: new Date().toISOString(), status_resi_detail: result.detail });
          }
          if (changed && repeats.length) patch.repeat_orders = newRepeats;

          if (changed) {
            await fetch(`${SUPABASE_URL}/rest/v1/crm_customers?id=eq.${row.id}`, {
              method: 'PATCH',
              headers: { ...sbHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify(patch)
            });
            updated++;
          }
        } catch (e) {
          errors++;
        }
      }));
    }

    res.status(200).json({ checked, updated, errors, rows_this_run: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message, checked, updated, errors });
  }
};
