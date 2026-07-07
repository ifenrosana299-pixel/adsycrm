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

// Heuristik best-effort dari sinyal terstruktur + teks history kurir Indonesia — tuning lanjutan
// kemungkinan masih perlu setelah lihat lebih banyak sampel data asli.
function mapTrackingStage({ resi, statusCategory, entries }) {
  if (!resi) return 'MENUNGGU_RESI';
  const cat = (statusCategory || '').toUpperCase();
  const arr = Array.isArray(entries) ? entries : [];
  const latest = arr.length ? arr[arr.length - 1] : null;
  const latestDesc = (latest && latest.desc || '').toLowerCase();

  if (cat.includes('RETUR') || cat.includes('RETURN') || arr.some(e => RETUR_PATTERN.test(e.desc || ''))) return 'RETUR';
  if (cat === 'DELIVERED' || /diterima oleh|delivered/.test(latestDesc)) return 'SAMPAI';

  const hasStructuredProblem = arr.some(e => e.group === 'UNDELIVERED' || e.tag === 'actionRequired' || !!e.reasonDelivery);
  if (hasStructuredProblem || arr.some(e => PROBLEM_PATTERN.test(e.desc || ''))) return 'BERMASALAH';

  if (/sedang diantar|dalam pengantaran|out for delivery|kurir menuju|\botw\b|akan dikirim ke alamat penerima|with delivery courier/.test(latestDesc)) return 'OTW';
  if (/kota tujuan|gudang tujuan|tiba di kota|received at destination/.test(latestDesc)) return 'KOTA_TUJUAN';
  return 'DIKIRIM';
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
    return { stage: mapTrackingStage({ resi, ...normalized }), detail: normalized.detail };
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
            newRepeats.push({ ...rep, status_resi: result.stage, status_resi_updated_at: new Date().toISOString(), status_resi_detail: result.detail });
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
