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
const OTW_PATTERN         = /sedang diantar|dalam pengantaran|out for delivery|kurir menuju|\botw\b|akan dikirim ke alamat penerima|with delivery courier|delivery courier|diantar ke alamat|on delivery|1st attempt|2nd attempt|percobaan/i;
const KOTA_TUJUAN_PATTERN = /kota tujuan|gudang tujuan|tiba di kota|received at destination|received at warehouse|process and forward|inbound|sti-dest/i;

// Entry fase PICKUP (jemput dari pengirim di kota asal) — kata "gagal"/"percobaan" di fase ini
// (mis. gagal dijemput, retry penjemputan) soal ambil paket dari toko, BUKAN soal antar ke
// penerima. Ketauan dari resi Lion asli (C1QSTIEB): "GAGAL DIJEMPUT...PERCOBAAN PENJEMPUTAN
// ULANG" kepancing regex OTW/Bermasalah padahal paket belum sampai kota tujuan sama sekali.
function isPickupPhase(e) {
  return !!(e && e.code && /pickup/i.test(e.code));
}

// Field `receiver` di history J&T cuma keisi PAS beneran udah diterima penerima (entry lain
// selalu kosong) — sinyal lebih reliable daripada tebak kata, soalnya J&T juga punya format
// "Paket telah diterima" TANPA kata "oleh X" (ketauan dari resi asli JJ6000043832), yang bikin
// regex "diterima oleh" gak nangkep dan salah kebaca OTW/status lama.
function hasReceivedBy(e) {
  return !!(e && e.receivedBy);
}

// "Diterima oleh X" cuma sinyal SAMPAI kalau X itu PENERIMA, bukan nama counter/kota asal sendiri.
// Ketauan dari resi J&T asli (JJ6000055580): "Paket telah diterima oleh KULONPROGO" — itu counter
// cabang asal nerima buat manifest, sama sekali belum dikirim, tapi teksnya identik pola sama
// "diterima oleh <penerima>" yang beneran delivered.
function isSelfReceipt(e) {
  if (!e || !e.place) return false;
  const m = /diterima oleh\s+(.+)/i.exec(e.descOnly || '');
  if (!m) return false;
  const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(m[1]) === norm(e.place);
}

function computeProgressStep(entries) {
  let step = 2; // resi sudah discan sistem kurir minimal = Dikirim
  (entries || []).forEach(e => {
    if (isPickupPhase(e)) return;
    const d = (e.desc || '').toLowerCase();
    if (OTW_PATTERN.test(d)) step = Math.max(step, 4);
    // e.atDestination = sinyal terstruktur POS (bandingin kode cabang event vs kode cabang tujuan
    // order) — teks POS pake "tiba di Cabang X", bukan "tiba di kota" kayak di pattern, jadi gak
    // kedeteksi kalau cuma andelin regex. Ketauan dari resi asli BAC04072635010ACF3B9.
    else if (e.atDestination || KOTA_TUJUAN_PATTERN.test(d)) step = Math.max(step, 3);
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
  const reachedStep = computeProgressStep(arr);

  let stage;
  if (cat.includes('RETUR') || cat.includes('RETURN') || arr.some(e => RETUR_PATTERN.test(e.desc || ''))) {
    stage = 'RETUR';
  } else if (cat === 'DELIVERED' || (/diterima oleh|\bdelivered\b|\bpod\b/.test(latestDesc) && !isSelfReceipt(latest)) || hasReceivedBy(latest)) {
    stage = 'SAMPAI';
  } else {
    const hasStructuredProblem = arr.some(e => !isPickupPhase(e) && (e.group === 'UNDELIVERED' || e.tag === 'actionRequired' || !!e.reasonDelivery));
    if (hasStructuredProblem || arr.some(e => !isPickupPhase(e) && !e.isPos && PROBLEM_PATTERN.test(e.desc || ''))) {
      stage = 'BERMASALAH';
    } else if (reachedStep >= 4) {
      stage = 'OTW';
    } else if (reachedStep >= 3) {
      stage = 'KOTA_TUJUAN';
    } else {
      stage = 'DIKIRIM';
    }
  }
  return { stage, step: stage === 'SAMPAI' ? 5 : reachedStep };
}

function normalizeMengantar(json) {
  if (!json || !json.success || !json.data) return null;
  const d = json.data;
  const history = Array.isArray(d.history) ? d.history : [];
  // Gabung desc + code — beberapa kurir (Lion: "STI-DEST"/"POD"/"DEL") taruh sinyal penting di code, bukan desc.
  // descOnly/code/place dipisah lagi buat isPickupPhase()/isSelfReceipt() yang butuh field asli.
  const entries = history.map(h => ({
    desc: [h.desc, h.code].filter(Boolean).join(' '),
    descOnly: h.desc || '',
    code: h.code || null,
    place: h.counter_name || h.city_name || null,
    receivedBy: (h.receiver || '').trim() || null,
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
  // reasonDelivery = ANY percobaan antar yang gagal/di-reschedule (field reason_delivery keisi) —
  // by design langsung dianggep BERMASALAH dari percobaan pertama gagal (keputusan user: biar CS
  // bisa proaktif follow up ke pembeli, bukan nunggu kurir nyerah total/FAILEDTODELIVERED).
  // isPos = true -> desc-nya di-skip dari tebak-kata PROBLEM_PATTERN generik (dipinjem dari
  // kosakata JNE) — soalnya problem POS udah ditentuin murni dari reasonDelivery di atas, gak
  // perlu tebak dari teks bebas lagi (mencegah jalur lain nyasar kayak "tidak ditempat").
  // destNopen = kode cabang tujuan akhir order (bukan kprk/hub induk) — dipakai bandingin ke nopen
  // tiap event INLOCATION buat mastiin "tiba di cabang TUJUAN" vs cuma numpang lewat hub.
  const destNopen = (d.connote_customfield && d.connote_customfield.destination_nopen) || null;
  const entries = history.map(h => ({
    desc: [h.content, h.content2].filter(Boolean).join(' '),
    group: null, tag: null, isPos: true,
    atDestination: !!(destNopen && h.state === 'INLOCATION' && h.nopen === destNopen),
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
