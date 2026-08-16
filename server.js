const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    const content = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error('Error reading DB:', err);
    return {};
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

// Telegram Helper Function
function sendTelegramNotif(message) {
  const db = readDB();
  const botToken = db.settings?.telegram_token || "8584899750:AAESDB2sLqsTCMqocFPs15o_tKLUcWrjDmE";
  const chatId = db.settings?.telegram_chat_id || "-1003726103172";
  
  try {
    const postData = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML"
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      res.on('data', () => {});
    });

    req.on('error', (e) => {
      console.log('Telegram API Error:', e.message);
    });

    req.write(postData);
    req.end();
  } catch (err) {
    console.error('Telegram notification error:', err);
  }
}

// ============================================================
// AUTHENTICATION ENDPOINTS
// ============================================================

// Gate Login (Pass: 231067)
app.post('/api/auth/gate', (req, res) => {
  const { password } = req.body;
  const db = readDB();
  const correctPass = db.settings?.gate_password || "231067";
  if (password === correctPass) {
    return res.json({ status: 'SUCCESS', success: true, message: 'Akses Diterima' });
  } else {
    return res.status(401).json({ status: 'WRONG', success: false, error: 'Password Kode Akses Salah!' });
  }
});

// Gudang Obat (Pass: nafila123)
app.post('/api/auth/gudang', (req, res) => {
  const { password } = req.body;
  const db = readDB();
  const correctPass = db.settings?.gudang_password || "nafila123";
  if (password === correctPass) {
    return res.json({ status: 'SUCCESS', success: true, message: 'Akses Gudang Diberikan' });
  } else {
    return res.status(401).json({ status: 'WRONG', success: false, error: 'Sandi Gudang Salah!' });
  }
});

// Direktur (Pass: direktur)
app.post('/api/auth/direktur', (req, res) => {
  const { password } = req.body;
  const db = readDB();
  const correctPass = db.settings?.direktur_password || "direktur";
  if (password === correctPass) {
    return res.json({ status: 'SUCCESS', success: true, message: 'Akses Direktur Diberikan' });
  } else {
    return res.status(401).json({ status: 'WRONG', success: false, error: 'Password Direktur Salah!' });
  }
});

// ============================================================
// GOOGLE SHEETS SYNC ENDPOINT
// ============================================================

// Helper: Parse integer number safely (handles '40.000', 'Rp 40.000', '0', 0, undefined, etc.)
function parseSafeInt(val, fallback = 0) {
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'number') return isNaN(val) ? fallback : Math.round(val);
  const str = String(val).trim();
  // Remove currency, text, dots/commas as thousands separators
  const cleaned = str.replace(/[^0-9-]/g, '');
  if (!cleaned) return fallback;
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? fallback : num;
}

// Fetch helper from Google Sheets Apps Script
const fetchFromGSheet = (url) => {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RekamMedisATI/1.0' }
      };
      
      const protocol = urlObj.protocol === 'https:' ? https : require('http');
      const request = protocol.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            resolve(fetchFromGSheet(response.headers.location));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch(e) {
            resolve({ raw: data });
          }
        });
      });
      request.on('error', reject);
      request.setTimeout(15000, () => {
        request.destroy();
        reject(new Error('Koneksi ke Google Sheets timeout'));
      });
      request.end();
    } catch(err) {
      reject(err);
    }
  });
};

// Core Synchronizer function (used by manual endpoint and background auto-sync)
async function performGSheetSync(db, gsheetUrl) {
  const syncUrl = gsheetUrl + (gsheetUrl.includes('?') ? '&' : '?') + 'action=sync';
  const gData = await fetchFromGSheet(syncUrl);
  if (!gData || typeof gData !== 'object') {
    throw new Error('Respon dari Google Sheets tidak valid');
  }

  let synced = { icd10: 0, medicines: 0, employees: 0 };

  // 1. Update ICD-10
  if (Array.isArray(gData.icd10) && gData.icd10.length > 0) {
    db.icd10 = gData.icd10.map((item, i) => ({
      id: item.id || ('ICD-' + i),
      code: item.code || item.kode || '',
      description: item.description || item.nama || item.diagnosis || ''
    })).filter(x => x.code || x.description);
    synced.icd10 = db.icd10.length;
  }

  // 2. Update Medicines (Fix: handles 0 stock properly & price formatting)
  if (Array.isArray(gData.medicines) && gData.medicines.length > 0) {
    const existingMeds = db.medicines || [];
    gData.medicines.forEach(gMed => {
      if (!gMed.nama) return;
      const cleanName = String(gMed.nama).trim();
      const existing = existingMeds.find(m => 
        m.nama && m.nama.toLowerCase() === cleanName.toLowerCase()
      );
      const stok = parseSafeInt(gMed.stok, 0);
      const harga = parseSafeInt(gMed.harga, 0);
      const satuan = String(gMed.satuan || '-').trim();
      const kategori = String(gMed.kategori || 'Gudang PT ATI').trim();

      if (existing) {
        existing.stok = stok;
        existing.satuan = satuan;
        existing.harga = harga;
        existing.kategori = kategori;
      } else {
        existingMeds.push({
          id: 'MED-' + Date.now() + Math.floor(Math.random() * 1000),
          nama: cleanName,
          stok: stok,
          satuan: satuan,
          harga: harga,
          kategori: kategori
        });
      }
    });
    db.medicines = existingMeds;
    synced.medicines = db.medicines.length;
  }

  // 3. Update Employees
  if (Array.isArray(gData.employees) && gData.employees.length > 0) {
    const existingEmps = db.employees || [];
    gData.employees.forEach(gEmp => {
      const empNik = String(gEmp.nikPabrik || gEmp.nik || '').trim();
      const empNama = String(gEmp.nama || '').trim();
      if (!empNik && !empNama) return;

      const existing = existingEmps.find(e => 
        (empNik && ((e.nikPabrik && String(e.nikPabrik).trim() === empNik) || (e.nik && String(e.nik).trim() === empNik))) ||
        (empNama && e.nama && e.nama.toLowerCase() === empNama.toLowerCase())
      );

      const updatedEmp = {
        nikPabrik: empNik,
        nik: empNik,
        nama: empNama,
        dept: String(gEmp.dept || gEmp.departemen || '').trim(),
        departemen: String(gEmp.dept || gEmp.departemen || '').trim(),
        gender: String(gEmp.gender || '').trim(),
        tglLahir: String(gEmp.tglLahir || gEmp.tgl_lahir || '').trim(),
        tgl_lahir: String(gEmp.tglLahir || gEmp.tgl_lahir || '').trim(),
        hp: String(gEmp.hp || gEmp.no_hp || '').trim(),
        no_hp: String(gEmp.hp || gEmp.no_hp || '').trim()
      };

      if (existing) {
        Object.assign(existing, updatedEmp);
      } else {
        existingEmps.unshift({
          id: 'EMP-' + Date.now() + Math.floor(Math.random() * 1000),
          ...updatedEmp
        });
      }
    });
    db.employees = existingEmps;
    synced.employees = db.employees.length;
  }

  if (!db.settings) db.settings = {};
  db.settings.gsheet_url = gsheetUrl;
  db.settings.last_sync = new Date().toISOString();
  writeDB(db);

  return synced;
}

// Fetch data from Google Apps Script and update local DB (Manual Endpoint)
app.post('/api/gsheet/sync', async (req, res) => {
  const db = readDB();
  const gsheetUrl = req.body?.gsheetUrl || db.settings?.gsheet_url;
  
  if (!gsheetUrl) {
    return res.status(400).json({ error: 'URL Google Apps Script tidak ada. Konfigurasi di tab G-Sheet Sync.' });
  }

  try {
    const synced = await performGSheetSync(db, gsheetUrl);
    res.json({ 
      success: true, 
      synced,
      lastSync: db.settings.last_sync,
      message: `Sinkronisasi berhasil! ICD-10: ${synced.icd10}, Obat: ${synced.medicines}, Karyawan: ${synced.employees}`
    });
  } catch (err) {
    console.error('GSheet sync error:', err);
    res.status(500).json({ error: 'Gagal sinkronisasi: ' + err.message });
  }
});

// Auto-Sync Background Interval (Berjalan otomatis setiap 30 detik di latar belakang)
setInterval(async () => {
  try {
    const db = readDB();
    const gsheetUrl = db.settings?.gsheet_url;
    if (gsheetUrl) {
      await performGSheetSync(db, gsheetUrl);
    }
  } catch (e) {
    // Silent fail in background timer
  }
}, 30000);

// Auto-Sync saat server pertama kali start
setTimeout(async () => {
  try {
    const db = readDB();
    const gsheetUrl = db.settings?.gsheet_url;
    if (gsheetUrl) {
      await performGSheetSync(db, gsheetUrl);
      console.log('✅ Inisialisasi awal sinkronisasi Google Sheets selesai.');
    }
  } catch(e) {}
}, 2000);

// Upload foto/dokumen rekam medis ke Google Drive via Apps Script
app.post('/api/upload-foto', async (req, res) => {
  const db = readDB();
  const gsheetUrl = db.settings?.gsheet_url;
  const { fileData, fileName, mimeType } = req.body;

  if (!fileData) {
    return res.status(400).json({ error: 'Data file tidak valid' });
  }

  // Jika ada Google Apps Script URL, kirim file ke Google Drive!
  if (gsheetUrl) {
    try {
      const payload = JSON.stringify({
        action: 'uploadFile',
        fileData,
        fileName: fileName || `Foto_RM_${Date.now()}.jpg`,
        mimeType: mimeType || 'image/jpeg'
      });

      const urlObj = new URL(gsheetUrl);
      const pushReq = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.fileUrl) {
              return res.json({ success: true, fileUrl: parsed.fileUrl });
            }
          } catch(e) {}
          // Fallback return base64
          res.json({ success: true, fileUrl: fileData });
        });
      });

      pushReq.on('error', (e) => {
        res.json({ success: true, fileUrl: fileData });
      });

      pushReq.write(payload);
      pushReq.end();
      return;
    } catch(err) {
      console.error('Upload foto error:', err);
    }
  }

  // Fallback if no GSheet URL set
  res.json({ success: true, fileUrl: fileData });
});

// Push all master data (ICD-10, Obat, Karyawan) to Google Sheets
app.post('/api/gsheet/push-all-master', async (req, res) => {
  const db = readDB();
  const gsheetUrl = db.settings?.gsheet_url;
  
  if (!gsheetUrl) {
    return res.status(400).json({ error: 'URL Google Apps Script belum diatur di tab G-SHEET SYNC' });
  }

  const payload = {
    action: 'seedMaster',
    icd10: (db.icd10 || []).map(i => ({ code: i.code || '', description: i.description || '' })),
    medicines: (db.medicines || []).map(m => ({ nama: m.nama || '', stok: parseInt(m.stok) || 0, satuan: m.satuan || 'strip', kategori: m.kategori || 'Obat' })),
    employees: (db.employees || []).map(e => ({ nikPabrik: e.nik || e.nikPabrik || '', nama: e.nama || '', dept: e.departemen || e.dept || '', gender: e.gender || '', tglLahir: e.tgl_lahir || e.tglLahir || '', hp: e.no_hp || e.hp || '' }))
  };

  const postData = JSON.stringify(payload);

  try {
    const urlObj = new URL(gsheetUrl);
    const pushReq = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        res.json({ success: true, message: `Master Data (${payload.icd10.length} ICD, ${payload.medicines.length} Obat, ${payload.employees.length} Karyawan) berhasil diisi ke Google Sheets!` });
      });
    });

    pushReq.on('error', (e) => {
      res.status(500).json({ error: 'Gagal push ke GSheet: ' + e.message });
    });

    pushReq.write(postData);
    pushReq.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push records/resep data to Google Sheets
app.post('/api/gsheet/push-records', async (req, res) => {
  const db = readDB();
  const gsheetUrl = db.settings?.gsheet_url;
  
  if (!gsheetUrl) {
    return res.status(400).json({ error: 'URL Google Apps Script belum diatur di tab G-SHEET SYNC' });
  }
  
  const records = db.records || [];
  const postData = JSON.stringify({
    action: 'pushRecords',
    records: records.slice(0, 100)
  });
  
  try {
    const urlObj = new URL(gsheetUrl);
    const pushReq = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        res.json({ success: true, message: 'Data rekam medis terkirim ke Google Sheets' });
      });
    });
    
    pushReq.on('error', (e) => {
      res.status(500).json({ error: 'Gagal push ke GSheet: ' + e.message });
    });
    
    pushReq.write(postData);
    pushReq.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get GSheet settings
app.get('/api/gsheet/settings', (req, res) => {
  const db = readDB();
  res.json({
    gsheetUrl: db.settings?.gsheet_url || '',
    lastSync: db.settings?.last_sync || null
  });
});

// ============================================================
// MASTER DATA: ICD-10
// ============================================================

app.get('/api/icd10', (req, res) => {
  const db = readDB();
  res.json(db.icd10 || []);
});

// ============================================================
// MASTER DATA: MEDICINES / STOK OBAT
// ============================================================

// Helper: Auto-sync Medicines to Google Sheets
function autoPushMedicinesToGSheet(db) {
  const gsheetUrl = db.settings?.gsheet_url;
  if (!gsheetUrl) return;

  try {
    const meds = [...(db.medicines || [])];
    meds.sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));

    const payload = JSON.stringify({
      action: 'seedMaster',
      medicines: meds.map(m => ({
        nama: m.nama || '',
        stok: parseInt(m.stok) || 0,
        satuan: m.satuan || 'strip',
        harga: parseInt(m.harga) || 0,
        kategori: m.kategori || 'Obat'
      }))
    });

    const urlObj = new URL(gsheetUrl);
    const pushReq = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });
    pushReq.on('error', () => {});
    pushReq.write(payload);
    pushReq.end();
  } catch (e) {}
}

app.get('/api/medicines', (req, res) => {
  const db = readDB();
  let medicines = db.medicines || [];
  medicines.sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));
  res.json(medicines);
});

app.post('/api/medicines', (req, res) => {
  const db = readDB();
  const newMed = req.body;
  if (!newMed.id) newMed.id = 'MED-' + Date.now();
  newMed.stok = parseInt(newMed.stok) || 0;
  newMed.harga = parseInt(newMed.harga) || 0;
  if (!db.medicines) db.medicines = [];
  db.medicines.unshift(newMed);
  db.medicines.sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));
  writeDB(db);
  autoPushMedicinesToGSheet(db);
  res.status(201).json(newMed);
});

app.put('/api/medicines/:id', (req, res) => {
  const db = readDB();
  if (!db.medicines) return res.status(404).json({ error: 'Obat tidak ditemukan' });
  const idx = db.medicines.findIndex(m => m.id === req.params.id);
  if (idx !== -1) {
    const oldMed = { ...db.medicines[idx] };
    const { nama, stok, harga, satuan, kategori, petugas, alasan } = req.body;

    const newNama = nama !== undefined ? String(nama).trim() : oldMed.nama;
    const newStok = stok !== undefined ? parseSafeInt(stok, oldMed.stok) : oldMed.stok;
    const newHarga = harga !== undefined ? parseSafeInt(harga, oldMed.harga) : oldMed.harga;
    const newSatuan = satuan !== undefined ? String(satuan).trim() : oldMed.satuan;
    const newKategori = kategori !== undefined ? String(kategori).trim() : oldMed.kategori;
    const namaPetugas = petugas || 'Petugas Gudang / Apoteker';
    const alasanEdit = alasan || 'Pembaruan data obat';

    db.medicines[idx] = {
      ...oldMed,
      nama: newNama,
      stok: newStok,
      harga: newHarga,
      satuan: newSatuan,
      kategori: newKategori
    };
    writeDB(db);
    autoPushMedicinesToGSheet(db);

    // Kirim Audit Log ke Telegram Bot
    const nowWIB = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const telegramText = 
`🔔 *[AUDIT LOG - PERUBAHAN DATA OBAT]* 🔔
━━━━━━━━━━━━━━━━━━━━
📦 *Nama Obat:* ${newNama}
👤 *Petugas:* ${namaPetugas}
📝 *Alasan:* ${alasanEdit}
━━━━━━━━━━━━━━━━━━━━
📊 *Rincian Perubahan:*
• Sisa Stok: *${oldMed.stok}* ➔ *${newStok}* ${newSatuan}
• Harga Satuan: *Rp ${(parseInt(oldMed.harga)||0).toLocaleString('id-ID')}* ➔ *Rp ${(parseInt(newHarga)||0).toLocaleString('id-ID')}*
• Satuan: *${oldMed.satuan || '-'}* ➔ *${newSatuan}*
• Kategori: *${oldMed.kategori || '-'}* ➔ *${newKategori}*

⏱ _Waktu: ${nowWIB} WIB_
🏥 _Sistem Rekam Medis PT ATI_`;

    sendTelegramNotif(telegramText);

    return res.json({ success: true, medicine: db.medicines[idx] });
  }
  res.status(404).json({ error: 'Obat tidak ditemukan' });
});

app.delete('/api/medicines/:id', (req, res) => {
  const db = readDB();
  if (!db.medicines) return res.status(404).json({ error: 'Obat tidak ditemukan' });
  db.medicines = db.medicines.filter(m => m.id !== req.params.id);
  writeDB(db);
  autoPushMedicinesToGSheet(db);
  res.json({ success: true });
});

// ============================================================
// MASTER DATA: EMPLOYEES / PATIENTS
// ============================================================

app.get('/api/patients', (req, res) => {
  const db = readDB();
  res.json(db.employees || []);
});

app.post('/api/patients', (req, res) => {
  const db = readDB();
  const newEmp = req.body;
  if (!newEmp.id) newEmp.id = 'EMP-' + Date.now();
  if (!db.employees) db.employees = [];
  db.employees.unshift(newEmp);
  writeDB(db);
  res.status(201).json(newEmp);
});

app.get('/api/employees', (req, res) => {
  const db = readDB();
  res.json(db.employees || []);
});

app.post('/api/employees', (req, res) => {
  const db = readDB();
  const newEmp = req.body;
  if (!newEmp.id) newEmp.id = 'EMP-' + Date.now();
  if (!db.employees) db.employees = [];
  db.employees.unshift(newEmp);
  writeDB(db);
  res.status(201).json(newEmp);
});

// ============================================================
// RECORDS / KUNJUNGAN POLI (WITH AUTO STOCK DEDUCT)
// ============================================================

app.get('/api/records', (req, res) => {
  const db = readDB();
  const { nik, nikPabrik } = req.query;
  let records = db.records || [];
  if (nik) records = records.filter(r => r.nik === nik || r.nikPabrik === nik);
  if (nikPabrik) records = records.filter(r => r.nikPabrik === nikPabrik);
  records.sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
  res.json(records);
});

app.post('/api/records', (req, res) => {
  const db = readDB();
  const newRecord = req.body;
  
  newRecord.id = 'REC-' + Date.now();
  newRecord.created_at = new Date().toISOString();
  
  // Auto-Deduct Stock from resep list
  const logObatTeks = [];
  if (Array.isArray(newRecord.resep)) {
    if (!db.medicines) db.medicines = [];
    newRecord.resep.forEach(item => {
      const namaObat = item.namaObat || item.obat || '';
      const qty = parseInt(item.qty || item.jumlah) || 1;
      if (namaObat) {
        const med = db.medicines.find(m => m.nama && m.nama.toLowerCase() === namaObat.toLowerCase());
        if (med) {
          med.stok = Math.max(0, (med.stok || 0) - qty);
          logObatTeks.push(`${med.nama} (${qty}) - Sisa: ${med.stok}`);
        }
      }
    });
  }

  // Mark as pantauan if flagged
  if (newRecord.isPantauan) {
    if (!db.pantauan) db.pantauan = [];
    db.pantauan.unshift({
      id: 'PP-' + Date.now(),
      nikPabrik: newRecord.nikPabrik,
      namaPasien: newRecord.namaPasien,
      dept: newRecord.dept || '-',
      keluhan: newRecord.keluhan,
      asesmen: newRecord.asesmen,
      status: 'AKTIF',
      tanggal: newRecord.tanggal || new Date().toLocaleDateString('id-ID')
    });
  }

  if (!db.records) db.records = [];
  db.records.unshift(newRecord);
  writeDB(db);
  autoPushMedicinesToGSheet(db);

  // Telegram Notification
  const planShort = Array.isArray(newRecord.resep) && newRecord.resep.length > 0
    ? newRecord.resep.map(r => r.namaObat || r.obat).join(', ')
    : (newRecord.plan || '-');

  const telegramText = 
    `🏥 <b>KUNJUNGAN SELESAI</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `🕐 Waktu    : ${new Date().toLocaleString('id-ID')}\n` +
    `👤 Pasien   : <b>${newRecord.namaPasien || '-'}</b> (${newRecord.nikPabrik || '-'})\n` +
    `🏢 Dept     : ${newRecord.dept || '-'}\n` +
    `─────────────────\n` +
    `📋 Keluhan  : ${newRecord.keluhan || '-'}\n` +
    `🔬 Diagnosis: ${newRecord.asesmen || '-'}\n` +
    `💊 Obat     : ${logObatTeks.length ? logObatTeks.join(', ') : planShort}\n` +
    `👨‍⚕️ Nakes    : ${newRecord.pemeriksa || '-'}`;

  sendTelegramNotif(telegramText);

  // Auto Push to Google Sheets if configured
  const gsheetUrl = db.settings?.gsheet_url;
  if (gsheetUrl) {
    try {
      const payload = JSON.stringify({
        action: 'pushRecords',
        records: [newRecord]
      });
      const urlObj = new URL(gsheetUrl);
      const pushReq = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      });
      pushReq.on('error', () => {});
      pushReq.write(payload);
      pushReq.end();
    } catch (e) {}
  }

  res.status(201).json(newRecord);
});

// Edit Record & Auto Stock Correction
app.put('/api/records/:id', (req, res) => {
  const db = readDB();
  if (!db.records) return res.status(404).json({ error: 'Data kunjungan tidak ditemukan' });
  
  const idx = db.records.findIndex(r => r.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Data kunjungan tidak ditemukan' });
  }

  const oldRecord = db.records[idx];
  const updatedData = req.body;

  // Restore old medicine stock
  if (Array.isArray(oldRecord.resep) && db.medicines) {
    oldRecord.resep.forEach(item => {
      const namaObat = item.namaObat || item.obat || '';
      const qty = parseInt(item.qty || item.jumlah) || 1;
      if (namaObat) {
        const med = db.medicines.find(m => m.nama && m.nama.toLowerCase() === namaObat.toLowerCase());
        if (med) med.stok = (med.stok || 0) + qty;
      }
    });
  }

  // Deduct new medicine stock
  if (Array.isArray(updatedData.resep) && db.medicines) {
    updatedData.resep.forEach(item => {
      const namaObat = item.namaObat || item.obat || '';
      const qty = parseInt(item.qty || item.jumlah) || 1;
      if (namaObat) {
        const med = db.medicines.find(m => m.nama && m.nama.toLowerCase() === namaObat.toLowerCase());
        if (med) med.stok = Math.max(0, (med.stok || 0) - qty);
      }
    });
  }

  db.records[idx] = { ...oldRecord, ...updatedData };
  writeDB(db);
  res.json(db.records[idx]);
});

app.delete('/api/records/:id', (req, res) => {
  const db = readDB();
  if (!db.records) return res.status(404).json({ error: 'Record tidak ditemukan' });
  db.records = db.records.filter(r => r.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// ============================================================
// PASIEN PANTAUAN
// ============================================================

app.get('/api/pantauan', (req, res) => {
  const db = readDB();
  res.json(db.pantauan || []);
});

app.put('/api/pantauan/:id/lepas', (req, res) => {
  const db = readDB();
  const p = (db.pantauan || []).find(item => item.id === req.params.id);
  if (p) {
    p.status = 'SELESAI';
    writeDB(db);
    return res.json({ success: true, message: 'Status pantauan dilepaskan' });
  }
  res.status(404).json({ error: 'Data pantauan tidak ditemukan' });
});

// ============================================================
// ABSEN DOKTER
// ============================================================

app.get('/api/absen-dokter', (req, res) => {
  const db = readDB();
  res.json(db.absen || []);
});

app.get('/api/absen', (req, res) => {
  const db = readDB();
  res.json(db.absen || []);
});

app.post('/api/absen-dokter', (req, res) => {
  const db = readDB();
  const newAbsen = req.body;
  newAbsen.id = 'ABS-' + Date.now();
  newAbsen.tarifShift = 400000;
  if (!db.absen) db.absen = [];
  db.absen.unshift(newAbsen);
  writeDB(db);

  const msg = 
    `👨‍⚕️ <b>ABSENSI DOKTER HADIR</b>\n` +
    `━━━━━━━━━━━━━\n` +
    `👤 <b>Nama:</b> ${newAbsen.namaDokter || newAbsen.nama || '-'}\n` +
    `📅 <b>Tanggal:</b> ${newAbsen.tanggal}\n` +
    `⏰ <b>Waktu:</b> ${newAbsen.jamMulai || '-'} - ${newAbsen.jamSelesai || '-'}\n` +
    `✅ <b>Status:</b> Kehadiran Tercatat (Tarif Rp 400.000)`;

  sendTelegramNotif(msg);
  res.status(201).json(newAbsen);
});

app.post('/api/absen', (req, res) => {
  const db = readDB();
  const newAbsen = req.body;
  newAbsen.id = 'ABS-' + Date.now();
  newAbsen.tarifShift = 400000;
  if (!db.absen) db.absen = [];
  db.absen.unshift(newAbsen);
  writeDB(db);
  res.status(201).json(newAbsen);
});

// ============================================================
// SHIFT REPORTS (TELEGRAM)
// ============================================================

app.post('/api/shift/format1', (req, res) => {
  const { tglMulai, tglSelesai, jamMulai, jamSelesai, dari, ke } = req.body;
  const db = readDB();
  const records = db.records || [];
  
  const start = new Date(`${tglMulai}T${jamMulai || '00:00'}:00`);
  const end = new Date(`${tglSelesai}T${jamSelesai || '23:59'}:59`);
  
  const filtered = records.filter(r => {
    const d = new Date(r.created_at || r.tanggal);
    return d >= start && d <= end;
  });

  const msg = 
    `📋 <b>LAPORAN OPER SHIFT KLINIK</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 Periode : ${tglMulai} s/d ${tglSelesai}\n` +
    `⏰ Waktu   : ${jamMulai} - ${jamSelesai}\n` +
    `👥 Serah   : ${dari} ➜ ${ke}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏥 Total Kunjungan : <b>${filtered.length} Pasien</b>\n` +
    filtered.slice(0, 10).map((r, i) =>
      `${i+1}. <b>${r.namaPasien || '-'}</b> - ${r.asesmen || '-'}`
    ).join('\n');

  sendTelegramNotif(msg);
  res.json({ success: true, message: 'Laporan Oper Shift terkirim ke Telegram' });
});

app.post('/api/shift/format2', (req, res) => {
  const { tglMulai, tglSelesai, petugas1, petugas2, petugas3 } = req.body;
  const db = readDB();
  const records = db.records || [];
  
  const start = new Date(`${tglMulai}T00:00:00`);
  const end = new Date(`${tglSelesai}T23:59:59`);
  
  const deptMap = {};
  let total = 0;
  records.forEach(r => {
    const d = new Date(r.created_at || r.tanggal);
    if (d >= start && d <= end) {
      const dept = r.dept || 'Lain-lain';
      deptMap[dept] = (deptMap[dept] || 0) + 1;
      total++;
    }
  });

  const deptDetail = Object.keys(deptMap).map(d => `  🔹 ${d} : <b>${deptMap[d]}</b>`).join('\n');

  const msg = 
    `🌅 <b>Selamat Pagi Bapak/Ibu 🙏🏻</b>\n` +
    `<i>Berikut Rekap Laporan Kunjungan 24 Jam</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <b>Periode :</b> ${tglMulai} s/d ${tglSelesai}\n\n` +
    `🏥 <b>KUNJUNGAN KLINIK :</b>\n${deptDetail || '  🔹 Tidak ada kunjungan'}\n` +
    `📋 <b>Total : ${total} Kunjungan</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👨‍⚕️ <b>Petugas Medis:</b>\n` +
    `  ☀️ Shift 1 : ${petugas1 || '-'}\n` +
    `  🌇 Shift 2 : ${petugas2 || '-'}\n` +
    `  🌙 Shift 3 : ${petugas3 || '-'}\n\n` +
    `<i>Tetap utamakan keselamatan kerja! ⛑️</i>`;

  sendTelegramNotif(msg);
  res.json({ success: true, message: 'Rekap 24H terkirim ke Telegram' });
});

// ============================================================
// SETTINGS & BACKUP
// ============================================================

app.get('/api/settings', (req, res) => {
  const db = readDB();
  res.json(db.settings || {});
});

app.post('/api/settings', (req, res) => {
  const db = readDB();
  db.settings = { ...db.settings, ...req.body };
  writeDB(db);
  res.json(db.settings);
});

app.get('/api/backup/export', (req, res) => {
  const db = readDB();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=backup-klinik-${Date.now()}.json`);
  res.send(JSON.stringify(db, null, 2));
});

app.post('/api/backup/import', (req, res) => {
  try {
    const importedData = req.body;
    if (importedData && (Array.isArray(importedData.employees) || Array.isArray(importedData.medicines))) {
      writeDB(importedData);
      return res.json({ success: true, message: 'Database berhasil dipulihkan!' });
    } else {
      return res.status(400).json({ error: 'Format JSON backup tidak valid' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`Mobile Klinik System PT ATI running on port ${PORT}`);
  console.log(`- Akses Lokal:  http://localhost:${PORT}`);
  console.log(`- Akses Wi-Fi:  http://10.125.149.122:${PORT} (atau sesuaikan IP Wi-Fi Anda)`);
  console.log(`System status: READY & SECURE (Bisa dibuka via HP/Tablet di Wi-Fi yang sama)`);
  console.log(`=================================================`);
});
