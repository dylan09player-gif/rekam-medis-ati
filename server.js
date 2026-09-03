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

const DEFAULT_USERS = [
  { id: 'usr-1', username: 'dr.dylan', nama: 'dr. Dylan Fadhilah', role: 'Dokter', password: 'dylan', created_at: '2026-08-01T00:00:00.000Z' },
  { id: 'usr-2', username: 'dr.medika', nama: 'dr. Medika', role: 'Dokter', password: 'medika', created_at: '2026-08-01T00:00:00.000Z' },
  { id: 'usr-3', username: 'perawat', nama: 'Ns. Perawat Jaga', role: 'Perawat', password: 'perawat', created_at: '2026-08-01T00:00:00.000Z' }
];

const DEFAULT_TINDAKAN = [
  { id: 'TND-1', nama: 'Rawat Luka / Ganti Perban', tarif: 35000, kategori: 'Tindakan Medis' },
  { id: 'TND-2', nama: 'Injeksi / Suntik Obat', tarif: 25000, kategori: 'Tindakan Medis' },
  { id: 'TND-3', nama: 'Jahit Luka / Hecting', tarif: 75000, kategori: 'Tindakan Bedah Minor' },
  { id: 'TND-4', nama: 'Nebulisasi / Terapi Uap', tarif: 50000, kategori: 'Terapi Saluran Napas' },
  { id: 'TND-5', nama: 'Cek Gula Darah Sewaktu (GDS)', tarif: 20000, kategori: 'Laboratorium Sederhana' },
  { id: 'TND-6', nama: 'Cek Asam Urat', tarif: 25000, kategori: 'Laboratorium Sederhana' },
  { id: 'TND-7', nama: 'Cek Kolesterol Total', tarif: 30000, kategori: 'Laboratorium Sederhana' },
  { id: 'TND-8', nama: 'EKG / Rekam Jantung', tarif: 100000, kategori: 'Diagnostik' },
  { id: 'TND-9', nama: 'Oksigenasi / Pasang O2', tarif: 30000, kategori: 'Tindakan Medis' },
  { id: 'TND-10', nama: 'Ekstraksi Benda Asing / Korpus Alienum', tarif: 50000, kategori: 'Tindakan Medis' }
];

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    const content = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(content);
    let modified = false;
    if (!Array.isArray(data.users) || data.users.length === 0) {
      data.users = [...DEFAULT_USERS];
      modified = true;
    }
    if (!Array.isArray(data.tindakan) || data.tindakan.length === 0) {
      data.tindakan = [...DEFAULT_TINDAKAN];
      modified = true;
    }
    
    // Auto-enrich / seed master WHO ICD-10 dataset
    const masterIcdFile = path.join(__dirname, 'icd10_master.json');
    if (fs.existsSync(masterIcdFile)) {
      try {
        const masterList = JSON.parse(fs.readFileSync(masterIcdFile, 'utf8'));
        if (Array.isArray(masterList) && masterList.length > 0) {
          if (!Array.isArray(data.icd10) || data.icd10.length < masterList.length) {
            const currentCodes = new Set((data.icd10 || []).map(i => (i.code || i.kode || '').trim().toUpperCase()));
            let addedCount = 0;
            data.icd10 = data.icd10 || [];
            masterList.forEach(m => {
              const code = (m.code || '').trim().toUpperCase();
              if (code && !currentCodes.has(code)) {
                data.icd10.push({
                  id: `ICD-${data.icd10.length}`,
                  code: m.code,
                  description: m.description
                });
                currentCodes.add(code);
                addedCount++;
              }
            });
            if (addedCount > 0 || data.icd10.length === masterList.length) {
              modified = true;
            }
          }
        }
      } catch (e) {}
    }

    if (modified) {
      try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
    }
    return data;
  } catch (err) {
    console.error('Error reading DB:', err);
    return {};
  }
}

let sseClients = [];

function notifyClients() {
  const payload = `data: update\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.res.write(payload);
      return true;
    } catch (e) {
      return false;
    }
  });
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    notifyClients();
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

function logStockMutation(db, mutation) {
  if (!Array.isArray(db.stock_mutations)) db.stock_mutations = [];
  const now = new Date();
  const nowIndo = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const entry = {
    id: mutation.id || `MUT-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    tanggal: mutation.tanggal || nowIndo,
    created_at: mutation.created_at || now.toISOString(),
    type: mutation.type || 'OUT', // 'IN' | 'OUT' | 'ADJUST'
    namaObat: String(mutation.namaObat || mutation.nama || 'Obat').trim(),
    satuan: mutation.satuan || 'tab',
    qty: Math.abs(parseInt(mutation.qty) || 0),
    delta: parseInt(mutation.delta) || 0, // positive or negative
    stokSebelum: parseInt(mutation.stokSebelum) || 0,
    stokSesudah: parseInt(mutation.stokSesudah) || 0,
    refType: mutation.refType || 'RESEP_POLI', // 'SURAT_JALAN' | 'RESEP_POLI' | 'REVISI_RECORD' | 'BATAL_BEROBAT' | 'STOK_OPNAME'
    refId: mutation.refId || '',
    refDoc: mutation.refDoc || '',
    pasien: mutation.pasien || '',
    nik: mutation.nik || '',
    petugas: mutation.petugas || 'Petugas Medis',
    keterangan: mutation.keterangan || ''
  };
  db.stock_mutations.unshift(entry);
  if (db.stock_mutations.length > 5000) {
    db.stock_mutations = db.stock_mutations.slice(0, 5000);
  }
  return entry;
}


app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: connected\n\n`);
  
  const client = { id: Date.now() + Math.random(), res };
  sseClients.push(client);

  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(pingInterval);
    }
  }, 15000);
  
  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

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

// WhaCenter WhatsApp Helper Function
function sendWhaCenterNotif(number, message) {
  const db = readDB();
  const deviceId = db.settings?.whacenter_device_id || "83f3428d66d811ef2f2d78e289bae57c";

  if (!number || !message) return Promise.resolve(null);

  let cleanNumber = String(number).replace(/[^0-9]/g, '');
  if (cleanNumber.startsWith('0')) {
    cleanNumber = '62' + cleanNumber.substring(1);
  }

  try {
    const postData = JSON.stringify({
      device_id: deviceId,
      number: cleanNumber,
      message: message
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'app.whacenter.com',
        path: '/api/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log('WhaCenter API Response:', body);
          resolve(body);
        });
      });

      req.on('error', (err) => {
        console.error('WhaCenter HTTP Error:', err);
        resolve(null);
      });

      req.write(postData);
      req.end();
    });
  } catch (e) {
    console.error('WhaCenter Exception:', e);
    return Promise.resolve(null);
  }
}

// ============================================================
// AUTHENTICATION & USER MANAGEMENT ENDPOINTS
// ============================================================

// Universal User Login (Multi-Account)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username dan Password wajib diisi' });
  }

  const db = readDB();
  const users = db.users || [];
  const cleanUser = String(username).trim().toLowerCase();
  const cleanPass = String(password).trim();
  const masterPass = db.settings?.gate_password || "231067";

  // Check if master password used
  if (cleanPass === masterPass) {
    // Check if user exists, otherwise create or return generic officer
    let matchedUser = users.find(u => 
      (u.username && u.username.toLowerCase() === cleanUser) ||
      (u.nama && u.nama.toLowerCase() === cleanUser)
    );
    if (!matchedUser) {
      matchedUser = {
        id: 'usr-master',
        username: cleanUser,
        nama: cleanUser.startsWith('dr.') ? cleanUser : `dr. ${cleanUser}`,
        role: 'Dokter',
        created_at: new Date().toISOString()
      };
    }
    const { password: _, ...safeUser } = matchedUser;
    return res.json({ success: true, status: 'SUCCESS', user: safeUser, message: 'Login berhasil (Master Key)' });
  }

  // Normal user credentials check
  const matchedUser = users.find(u => 
    ((u.username && u.username.toLowerCase() === cleanUser) ||
     (u.nama && u.nama.toLowerCase() === cleanUser)) &&
    String(u.password).trim() === cleanPass
  );

  if (matchedUser) {
    const { password: _, ...safeUser } = matchedUser;
    return res.json({ success: true, status: 'SUCCESS', user: safeUser, message: 'Login berhasil' });
  }

  return res.status(401).json({ success: false, error: 'Username atau Password salah!' });
});

// User Registration (Buat Akun Petugas Baru)
app.post('/api/auth/register', (req, res) => {
  const { nama, username, role, password } = req.body;
  if (!nama || !username || !password) {
    return res.status(400).json({ success: false, error: 'Nama, Username, dan Password wajib diisi!' });
  }

  const db = readDB();
  if (!db.users) db.users = [];

  const cleanUser = String(username).trim().toLowerCase();
  const exists = db.users.some(u => u.username && u.username.toLowerCase() === cleanUser);
  if (exists) {
    return res.status(400).json({ success: false, error: 'Username sudah digunakan, silakan pilih username lain.' });
  }

  const newUser = {
    id: 'usr-' + Date.now(),
    nama: String(nama).trim(),
    username: cleanUser,
    role: role || 'Perawat',
    password: String(password).trim(),
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDB(db);

  const { password: _, ...safeUser } = newUser;
  return res.status(201).json({ success: true, user: safeUser, message: 'Akun petugas berhasil dibuat!' });
});

// Legacy Gate Login (Pass: 231067)
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

// Get Users List (For Direktur & Dropdowns)
app.get('/api/users', (req, res) => {
  const db = readDB();
  const users = (db.users || []).map(({ password, ...u }) => u);
  res.json(users);
});

// Create User (Admin)
app.post('/api/users', (req, res) => {
  const { nama, username, role, password } = req.body;
  if (!nama || !username) {
    return res.status(400).json({ error: 'Nama dan Username wajib diisi' });
  }
  const db = readDB();
  if (!db.users) db.users = [];
  const cleanUser = String(username).trim().toLowerCase();
  if (db.users.some(u => u.username && u.username.toLowerCase() === cleanUser)) {
    return res.status(400).json({ error: 'Username sudah digunakan' });
  }
  const newUser = {
    id: 'usr-' + Date.now(),
    nama: String(nama).trim(),
    username: cleanUser,
    role: role || 'Perawat',
    password: password ? String(password).trim() : '123456',
    created_at: new Date().toISOString()
  };
  db.users.push(newUser);
  writeDB(db);
  const { password: _, ...safeUser } = newUser;
  res.status(201).json({ success: true, user: safeUser });
});

// Update User
app.put('/api/users/:id', (req, res) => {
  const db = readDB();
  if (!db.users) return res.status(404).json({ error: 'User tidak ditemukan' });
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User tidak ditemukan' });

  const { nama, username, role, password } = req.body;
  if (nama) db.users[idx].nama = String(nama).trim();
  if (username) db.users[idx].username = String(username).trim().toLowerCase();
  if (role) db.users[idx].role = role;
  if (password && String(password).trim() !== '') {
    db.users[idx].password = String(password).trim();
  }
  writeDB(db);
  const { password: _, ...safeUser } = db.users[idx];
  res.json({ success: true, user: safeUser });
});

// Delete User
app.delete('/api/users/:id', (req, res) => {
  const db = readDB();
  if (!db.users) return res.status(404).json({ error: 'User tidak ditemukan' });
  db.users = db.users.filter(u => u.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
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
// TINDAKAN MEDIS & TARIF ENDPOINTS
// ============================================================

app.get('/api/tindakan', (req, res) => {
  const db = readDB();
  res.json(db.tindakan || []);
});

app.post('/api/tindakan', (req, res) => {
  const { nama, tarif, kategori } = req.body;
  if (!nama) {
    return res.status(400).json({ error: 'Nama tindakan wajib diisi' });
  }
  const db = readDB();
  if (!db.tindakan) db.tindakan = [];
  const newTindakan = {
    id: 'TND-' + Date.now(),
    nama: String(nama).trim(),
    tarif: parseSafeInt(tarif, 0),
    kategori: kategori ? String(kategori).trim() : 'Tindakan Medis',
    created_at: new Date().toISOString()
  };
  db.tindakan.unshift(newTindakan);
  writeDB(db);
  res.status(201).json({ success: true, tindakan: newTindakan });
});

app.put('/api/tindakan/:id', (req, res) => {
  const db = readDB();
  if (!db.tindakan) return res.status(404).json({ error: 'Tindakan tidak ditemukan' });
  const idx = db.tindakan.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Tindakan tidak ditemukan' });

  const { nama, tarif, kategori } = req.body;
  if (nama) db.tindakan[idx].nama = String(nama).trim();
  if (tarif !== undefined) db.tindakan[idx].tarif = parseSafeInt(tarif, 0);
  if (kategori) db.tindakan[idx].kategori = String(kategori).trim();
  
  writeDB(db);
  res.json({ success: true, tindakan: db.tindakan[idx] });
});

app.delete('/api/tindakan/:id', (req, res) => {
  const db = readDB();
  if (!db.tindakan) return res.status(404).json({ error: 'Tindakan tidak ditemukan' });
  db.tindakan = db.tindakan.filter(t => t.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
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

// Helper: Parse a single CSV line properly handling quotes
function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i+1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// Fetch helper from Google Sheets Apps Script or Direct CSV
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
            resolve(data);
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
  let gData = {};
  try {
    const syncUrl = gsheetUrl + (gsheetUrl.includes('?') ? '&' : '?') + 'action=sync';
    const fetched = await fetchFromGSheet(syncUrl);
    if (typeof fetched === 'object' && fetched !== null) {
      gData = fetched;
    }
  } catch(e) {}

  let synced = { icd10: 0, medicines: 0, employees: 0 };

  // 1. Mirror ICD-10 (100% Mengikuti Data Real dari Google Sheets)
  if (Array.isArray(gData.icd10) && gData.icd10.length > 0) {
    db.icd10 = gData.icd10.map((item, i) => ({
      id: item.id || ('ICD-' + i),
      code: String(item.code || item.kode || '').trim(),
      description: String(item.description || item.nama || item.diagnosis || '').trim()
    })).filter(x => x.code || x.description);
    synced.icd10 = db.icd10.length;
  }

  // 2. Mirror Medicines (100% Mengikuti Data Real dari Google Sheets: baris, nama, stok, harga, satuan)
  let medList = Array.isArray(gData.medicines) && gData.medicines.length > 0 ? gData.medicines : [];
  if (medList.length === 0) {
    try {
      const csvObat = await fetchFromGSheet('https://docs.google.com/spreadsheets/d/1sNDmrxb4cB1eYKO-CbBXCWOElOCuiBRdJLG6ERrJkqY/export?format=csv&gid=318839291');
      if (typeof csvObat === 'string' && csvObat.includes(',')) {
        const lines = csvObat.trim().split(/\r?\n/).filter(l => l.trim() !== '');
        medList = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCSVLine(lines[i]);
          if (!cols[0]) continue;
          medList.push({
            nama: cols[0],
            stok: cols[1],
            satuan: cols[2] || 'strip',
            harga: cols[3],
            kategori: cols[4] || 'Gudang PT ATI'
          });
        }
      }
    } catch(e) {}
  }

  if (medList.length > 0) {
    db.medicines = medList.map((gMed, i) => {
      const cleanName = String(gMed.nama || '').trim();
      return {
        id: 'MED-' + (i + 1),
        nama: cleanName,
        stok: parseSafeInt(gMed.stok, 0),
        satuan: String(gMed.satuan || '-').trim(),
        harga: parseSafeInt(gMed.harga, 0),
        kategori: String(gMed.kategori || 'Gudang PT ATI').trim()
      };
    }).filter(m => m.nama !== '');
    synced.medicines = db.medicines.length;
  }

  // 3. Mirror Employees (1,406 Pasien / Karyawan 100% Real dari Google Sheets)
  let empList = [];
  try {
    const csvKary = await fetchFromGSheet('https://docs.google.com/spreadsheets/d/1sNDmrxb4cB1eYKO-CbBXCWOElOCuiBRdJLG6ERrJkqY/export?format=csv&gid=2005972852');
    if (typeof csvKary === 'string' && csvKary.includes(',')) {
      const lines = csvKary.trim().split(/\r?\n/).filter(l => l.trim() !== '');
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const noUrut = cols[0] || String(i);
        const npk = cols[1] || '';
        const nama = cols[2] || '';
        if (!npk && !nama) continue;
        empList.push({
          id: 'EMP-' + i,
          no: noUrut,
          nikPabrik: npk,
          nik: npk,
          nama: nama,
          dept: cols[3] || 'PT ATI',
          departemen: cols[3] || 'PT ATI',
          gender: cols[4] || 'Laki-laki',
          golDarah: cols[5] || '-',
          tglLahir: cols[6] || '',
          tgl_lahir: cols[6] || '',
          hp: cols[7] || '',
          no_hp: cols[7] || '',
          saldoObat: parseInt((cols[8] || '').replace(/\./g, '')) || 0,
          sectionName: cols[9] || '',
          birthPlace: cols[10] || ''
        });
      }
    }
  } catch(e) {
    console.error('Error fetching direct CSV employees:', e);
  }

  // Fallback to gData.employees if CSV fetch failed
  if (empList.length === 0 && Array.isArray(gData.employees) && gData.employees.length > 0) {
    empList = gData.employees.map((gEmp, i) => {
      const noUrut = gEmp.no || String(i + 1);
      const empNik = String(gEmp.nikPabrik || gEmp.nik || '').trim();
      const empNama = String(gEmp.nama || '').trim();
      return {
        id: 'EMP-' + (i + 1),
        no: noUrut,
        nikPabrik: empNik,
        nik: empNik,
        nama: empNama,
        dept: String(gEmp.dept || gEmp.departemen || 'PT ATI').trim(),
        departemen: String(gEmp.dept || gEmp.departemen || 'PT ATI').trim(),
        gender: String(gEmp.gender || 'Laki-laki').trim(),
        golDarah: String(gEmp.golDarah || '-').trim(),
        tglLahir: String(gEmp.tglLahir || gEmp.tgl_lahir || '').trim(),
        tgl_lahir: String(gEmp.tglLahir || gEmp.tgl_lahir || '').trim(),
        hp: String(gEmp.hp || gEmp.no_hp || '').trim(),
        no_hp: String(gEmp.hp || gEmp.no_hp || '').trim(),
        saldoObat: parseInt(String(gEmp.saldoObat || gEmp.sisaLimit || '0').replace(/\./g, '')) || 0,
        sectionName: String(gEmp.sectionName || '').trim(),
        birthPlace: String(gEmp.birthPlace || '').trim()
      };
    }).filter(e => e.nikPabrik || e.nama);
  }

  if (empList.length > 0) {
    db.employees = empList;
    synced.employees = db.employees.length;
  }

  // 4. Mirror/Merge Records (Kunjungan Pasien) dari Google Sheets jika tersedia
  if (Array.isArray(gData.records) && gData.records.length > 0) {
    const existingRecs = db.records || [];
    gData.records.forEach(gRec => {
      if (!gRec.id && !gRec.namaPasien) return;
      const recId = String(gRec.id || '').trim();
      const existing = existingRecs.find(r => r.id === recId);
      if (!existing) {
        existingRecs.push({
          id: recId || ('RM-' + Date.now() + Math.floor(Math.random() * 1000)),
          tanggal: gRec.tanggal || new Date().toISOString().split('T')[0],
          nikPabrik: gRec.nikPabrik || '',
          namaPasien: gRec.namaPasien || '',
          dept: gRec.dept || '',
          keluhan: gRec.keluhan || '',
          asesmen: gRec.asesmen || '',
          plan: gRec.plan || '',
          pemeriksa: gRec.pemeriksa || '',
          linkFoto: gRec.linkFoto || ''
        });
      }
    });
    db.records = existingRecs;
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
    medicines: (db.medicines || []).map(m => ({ nama: m.nama || '', stok: parseSafeInt(m.stok, 0), satuan: m.satuan || 'strip', kategori: m.kategori || 'Obat' })),
    employees: (db.employees || []).map(e => ({ nikPabrik: e.nik || e.nikPabrik || '', nama: e.nama || '', dept: e.departemen || e.dept || '', gender: e.gender || '', tglLahir: e.tgl_lahir || e.tglLahir || '', hp: e.no_hp || e.hp || '', saldoObat: e.saldoObat || '', sectionName: e.sectionName || '', birthPlace: e.birthPlace || '' }))
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
        stok: parseSafeInt(m.stok, 0),
        satuan: m.satuan || 'strip',
        harga: parseSafeInt(m.harga, 0),
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
  newMed.stok = parseSafeInt(newMed.stok, 0);
  newMed.harga = parseSafeInt(newMed.harga, 0);
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

    const diff = newStok - (parseInt(oldMed.stok) || 0);
    if (diff !== 0) {
      logStockMutation(db, {
        type: 'ADJUST',
        namaObat: newNama,
        satuan: newSatuan,
        qty: Math.abs(diff),
        delta: diff,
        stokSebelum: parseInt(oldMed.stok) || 0,
        stokSesudah: newStok,
        refType: 'STOK_OPNAME',
        refDoc: 'Penyesuaian Manual / Opname',
        petugas: namaPetugas,
        keterangan: alasanEdit
      });
    }

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

app.post('/api/medicines/transfer', (req, res) => {
  const db = readDB();
  if (!db.medicines) return res.status(404).json({ error: 'Obat tidak ditemukan' });

  const { sender, receiver, items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Daftar obat kosong atau tidak valid' });
  }

  const updatedMedicines = [];
  const auditLogs = [];
  const noSurat = `SJ-${Date.now()}`;
  const nowIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

  for (const item of items) {
    const idx = db.medicines.findIndex(m => m.id === item.id);
    if (idx !== -1) {
      const oldMed = { ...db.medicines[idx] };
      const qtySent = parseSafeInt(item.qty, 0);
      const prevStok = parseSafeInt(oldMed.stok, 0);
      const newStok = prevStok + qtySent;

      db.medicines[idx] = {
        ...oldMed,
        stok: newStok
      };

      logStockMutation(db, {
        tanggal: nowIndo,
        created_at: new Date().toISOString(),
        type: 'IN',
        namaObat: oldMed.nama,
        satuan: oldMed.satuan || 'tab',
        qty: qtySent,
        delta: +qtySent,
        stokSebelum: prevStok,
        stokSesudah: newStok,
        refType: 'SURAT_JALAN',
        refId: noSurat,
        refDoc: noSurat,
        petugas: `${sender || 'Apotek Nafila'} ➔ ${receiver || 'Perawat PT ATI'}`,
        keterangan: `Surat Jalan Pengiriman Obat No: ${noSurat} (${sender || 'Apotek Nafila'})`
      });

      updatedMedicines.push(db.medicines[idx]);
      auditLogs.push(`• ${oldMed.nama}: *${oldMed.stok || 0}* ➔ *${newStok}* (+${qtySent} ${oldMed.satuan || 'strip'})`);
    }
  }

  if (updatedMedicines.length === 0) {
    return res.status(400).json({ error: 'Tidak ada obat valid yang diperbarui' });
  }

  // Save Surat Jalan to database
  const newSuratJalan = {
    id: 'SJ-' + Date.now(),
    noSurat: noSurat,
    tanggal: nowIndo,
    created_at: new Date().toISOString(),
    sender: sender || 'Apotek Nafila',
    receiver: receiver || 'Perawat PT ATI',
    items: items.map(item => {
      const matched = db.medicines.find(m => m.id === item.id);
      return {
        id: item.id,
        name: item.name || (matched ? matched.nama : 'Obat'),
        qty: parseSafeInt(item.qty, 0),
        initial: item.initial !== undefined ? parseSafeInt(item.initial, 0) : (matched ? matched.stok - parseSafeInt(item.qty, 0) : 0),
        final: item.final !== undefined ? parseSafeInt(item.final, 0) : (matched ? matched.stok : 0),
        satuan: item.satuan || (matched ? matched.satuan : 'strip')
      };
    })
  };

  if (!db.surat_jalan) db.surat_jalan = [];
  db.surat_jalan.unshift(newSuratJalan);

  writeDB(db);
  autoPushMedicinesToGSheet(db);
  notifyClients();

  // Kirim Audit Log ke Telegram Bot
  const nowWIB = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const telegramText = 
`🚚 *[SURAT JALAN - PENGIRIMAN OBAT]* 🚚
━━━━━━━━━━━━━━━━━━━━
📄 *No. Surat Jalan:* \`${noSurat}\`
👤 *Pengirim (Apotek):* ${sender || '-'}
👤 *Penerima (PT ATI):* ${receiver || '-'}
━━━━━━━━━━━━━━━━━━━━
📦 *Daftar Obat Terkirim:*
${auditLogs.join('\n')}

⏱ _Waktu: ${nowWIB} WIB_
🏥 _Sistem Rekam Medis PT ATI_`;

  sendTelegramNotif(telegramText);

  res.json({ success: true, updated: updatedMedicines, suratJalan: newSuratJalan });
});

// Endpoint Riwayat Surat Jalan
app.get('/api/surat-jalan', (req, res) => {
  const db = readDB();
  const list = db.surat_jalan || [];
  res.json(list);
});

app.delete('/api/surat-jalan/:id', (req, res) => {
  const db = readDB();
  if (!db.surat_jalan) return res.json({ success: true });
  db.surat_jalan = db.surat_jalan.filter(s => s.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// Endpoint Riwayat & Audit Mutasi Stok Obat (In - Out - Audit Trail)
app.get('/api/stock-mutations', (req, res) => {
  const db = readDB();
  let mutations = db.stock_mutations || [];
  const { startDate, endDate, medicine, type } = req.query;

  if (startDate) {
    const sDate = new Date(`${startDate}T00:00:00`);
    mutations = mutations.filter(m => {
      const d = new Date(m.created_at || m.tanggal);
      return isNaN(d.getTime()) || d >= sDate;
    });
  }
  if (endDate) {
    const eDate = new Date(`${endDate}T23:59:59`);
    mutations = mutations.filter(m => {
      const d = new Date(m.created_at || m.tanggal);
      return isNaN(d.getTime()) || d <= eDate;
    });
  }
  if (medicine) {
    const mClean = String(medicine).toLowerCase().trim();
    mutations = mutations.filter(m => m.namaObat && m.namaObat.toLowerCase().includes(mClean));
  }
  if (type) {
    mutations = mutations.filter(m => m.type === type);
  }

  res.json(mutations);
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

app.put('/api/patients/:id', (req, res) => {
  const db = readDB();
  if (!db.employees) return res.status(404).json({ error: 'Karyawan tidak ditemukan' });
  const param = decodeURIComponent(req.params.id);
  const idx = db.employees.findIndex(e => 
    String(e.id) === String(param) || 
    String(e.nikPabrik) === String(param) || 
    String(e.nik) === String(param) ||
    (e.nama && e.nama.toLowerCase() === param.toLowerCase())
  );
  if (idx !== -1) {
    db.employees[idx] = {
      ...db.employees[idx],
      ...req.body,
      nikPabrik: req.body.nikPabrik || db.employees[idx].nikPabrik,
      nik: req.body.nikPabrik || db.employees[idx].nikPabrik,
      nama: req.body.nama || db.employees[idx].nama,
      dept: req.body.dept !== undefined ? req.body.dept : db.employees[idx].dept,
      departemen: req.body.dept !== undefined ? req.body.dept : db.employees[idx].dept,
      gender: req.body.gender || db.employees[idx].gender,
      golDarah: req.body.golDarah || db.employees[idx].golDarah || '-',
      tglLahir: req.body.tglLahir || db.employees[idx].tglLahir,
      tgl_lahir: req.body.tglLahir || db.employees[idx].tglLahir,
      hp: req.body.hp !== undefined ? req.body.hp : (db.employees[idx].hp || ''),
      no_hp: req.body.hp !== undefined ? req.body.hp : (db.employees[idx].hp || ''),
      saldoObat: req.body.saldoObat !== undefined ? parseInt(String(req.body.saldoObat).replace(/\./g, '')) || 0 : (parseInt(String(db.employees[idx].saldoObat || db.employees[idx].sisaLimit || '0').replace(/\./g, '')) || 0),
      sectionName: req.body.sectionName !== undefined ? req.body.sectionName : (db.employees[idx].sectionName || ''),
      birthPlace: req.body.birthPlace !== undefined ? req.body.birthPlace : (db.employees[idx].birthPlace || '')
    };
    writeDB(db);
    return res.json({ success: true, employee: db.employees[idx] });
  }
  res.status(404).json({ error: 'Karyawan tidak ditemukan' });
});

app.delete('/api/patients/:id', (req, res) => {
  const db = readDB();
  if (!db.employees) return res.status(404).json({ error: 'Karyawan tidak ditemukan' });
  db.employees = db.employees.filter(e => e.id !== req.params.id && e.nikPabrik !== req.params.id);
  writeDB(db);
  res.json({ success: true });
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
  records.sort((a, b) => new Date(b.created_at || b.tanggal) - new Date(a.created_at || a.tanggal));
  res.json(records);
});

app.post('/api/records', (req, res) => {
  const db = readDB();
  const newRecord = req.body;
  if (!newRecord || !newRecord.namaPasien) {
    return res.status(400).json({ error: 'Nama pasien wajib diisi.' });
  }

  // 1. SMART DEDUPLICATION GUARD (Anti-Double Click / Sinyal Lola)
  // Cek apakah ada kunjungan yang sama persis untuk pasien yang sama dalam 2 menit terakhir (120 detik)
  if (!db.records) db.records = [];
  const nowMs = Date.now();
  const DUPLICATE_WINDOW_MS = 2 * 60 * 1000; // 2 Menit

  const recentDuplicate = db.records.find(r => {
    const rTime = r.created_at ? new Date(r.created_at).getTime() : 0;
    if (rTime <= 0 || (nowMs - rTime) > DUPLICATE_WINDOW_MS) return false;

    const rNik = String(r.nikPabrik || '').trim().toLowerCase();
    const newNik = String(newRecord.nikPabrik || '').trim().toLowerCase();
    const rNama = String(r.namaPasien || '').trim().toLowerCase();
    const newNama = String(newRecord.namaPasien || '').trim().toLowerCase();

    const isSamePatient = (newNik && rNik === newNik) || (newNama && rNama === newNama);
    if (!isSamePatient) return false;

    const rKeluhan = String(r.keluhan || '').trim().toLowerCase();
    const newKeluhan = String(newRecord.keluhan || '').trim().toLowerCase();
    const rAsesmen = String(r.asesmen || '').trim().toLowerCase();
    const newAsesmen = String(newRecord.asesmen || '').trim().toLowerCase();

    return (rKeluhan === newKeluhan) || (rAsesmen === newAsesmen);
  });

  if (recentDuplicate) {
    console.log(`⚡ [IDEMPOTENCY] Mencegah input ganda: ${newRecord.namaPasien} (${newRecord.nikPabrik || '-'}) dalam 2 menit.`);
    return res.status(200).json({
      ...recentDuplicate,
      _isDuplicatePrevented: true,
      _message: 'Data kunjungan sudah tercatat sebelumnya. Pemotongan stok ganda dicegah.'
    });
  }

  // Generate ID & Created At
  newRecord.id = 'REC-' + Date.now();
  newRecord.created_at = newRecord.created_at || new Date().toISOString();
  
  // 2. Auto-Deduct Stock from resep list & Log Mutation
  const logObatTeks = [];
  if (Array.isArray(newRecord.resep)) {
    if (!db.medicines) db.medicines = [];
    newRecord.resep.forEach(item => {
      const namaObat = item.namaObat || item.obat || '';
      const qty = parseSafeInt(item.qty || item.jumlah, 1);
      if (namaObat) {
        const med = db.medicines.find(m => m.nama && m.nama.toLowerCase() === namaObat.toLowerCase());
        if (med) {
          const prevStok = parseSafeInt(med.stok, 0);
          const nextStok = Math.max(0, prevStok - qty);
          med.stok = nextStok;
          logStockMutation(db, {
            tanggal: newRecord.tanggal,
            created_at: newRecord.created_at,
            type: 'OUT',
            namaObat: med.nama,
            satuan: med.satuan || 'tab',
            qty: qty,
            delta: -qty,
            stokSebelum: prevStok,
            stokSesudah: nextStok,
            refType: 'RESEP_POLI',
            refId: newRecord.id,
            refDoc: 'Kunjungan Pasien',
            pasien: newRecord.namaPasien || '',
            nik: newRecord.nikPabrik || '',
            petugas: newRecord.pemeriksa || 'Petugas Medis',
            keterangan: `Resep Kunjungan: ${newRecord.namaPasien || ''} (${newRecord.asesmen || 'Pemeriksaan'})`
          });
          logObatTeks.push(`${med.nama} (${qty}) - Sisa: ${med.stok}`);
        }
      }
    });
  }

  // 3. Potong Saldo Obat Pasien Secara Atomik di Server
  const grandTotalBiaya = Number(newRecord.totalBiaya || 0);
  if (grandTotalBiaya > 0 && Array.isArray(db.patients)) {
    const pIdx = db.patients.findIndex(p => 
      (p.nikPabrik && newRecord.nikPabrik && p.nikPabrik === newRecord.nikPabrik) ||
      (p.nama && newRecord.namaPasien && p.nama.toLowerCase() === newRecord.namaPasien.toLowerCase())
    );
    if (pIdx !== -1) {
      const oldSaldo = parseInt(db.patients[pIdx].saldoObat) || 0;
      db.patients[pIdx].saldoObat = oldSaldo - grandTotalBiaya;
    }
  }

  // 4. Mark as pantauan if flagged (Deduplicate per employee)
  if (newRecord.isPantauan) {
    if (!db.pantauan) db.pantauan = [];
    const existIdx = db.pantauan.findIndex(p => 
      (p.nikPabrik && p.nikPabrik === newRecord.nikPabrik) || 
      (p.namaPasien && p.namaPasien.toLowerCase() === newRecord.namaPasien.toLowerCase())
    );
    const pantauanItem = {
      id: existIdx !== -1 ? db.pantauan[existIdx].id : ('PP-' + Date.now()),
      nikPabrik: newRecord.nikPabrik,
      namaPasien: newRecord.namaPasien,
      dept: newRecord.dept || '-',
      keluhan: newRecord.keluhan,
      asesmen: newRecord.asesmen,
      status: 'AKTIF',
      tanggal: newRecord.tanggal || new Date().toLocaleDateString('id-ID')
    };
    if (existIdx !== -1) {
      db.pantauan[existIdx] = pantauanItem;
    } else {
      db.pantauan.unshift(pantauanItem);
    }
  }

  // 5. Simpan Record ke Database
  db.records.unshift(newRecord);
  writeDB(db);

  // 6. RESPON CEPAT KE BROWSER PETUGAS (Agar Layar HP Tidak Menggantung / Loading Lama)
  res.status(201).json(newRecord);

  // 7. PENGIRIMAN NOTIFIKASI TELEGRAM & G-SHEET DI BACKGROUND (ASINKRON)
  setImmediate(() => {
    try {
      const nowWIB = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      
      let kelaikanList = [];
      if (newRecord.izinSakit) kelaikanList.push('📄 ISTIRAHAT SAKIT (Surkes)');
      if (newRecord.isPantauan) kelaikanList.push('🔴 PASIEN PANTAUAN K3');
      if (kelaikanList.length === 0) kelaikanList.push('🟢 FIT TO WORK');
      const statusKelaikanTeks = kelaikanList.join(' | ');

      const logTindakanTeks = Array.isArray(newRecord.tindakan) && newRecord.tindakan.length > 0
        ? newRecord.tindakan.map(t => `• ${t.nama || 'Tindakan'} (${t.qty || 1}x) [Tarif: Rp ${(t.subtotal || 0).toLocaleString('id-ID')}]`).join('\n')
        : '• -';

      const obatDetailTeks = logObatTeks.length > 0
        ? logObatTeks.map(o => `• ${o}`).join('\n')
        : (Array.isArray(newRecord.resep) && newRecord.resep.length > 0
            ? newRecord.resep.map(r => `• ${r.namaObat || r.obat} (${r.qty || 1})`).join('\n')
            : '• -');

      const totalBiayaTeks = Number(newRecord.totalBiaya || 0).toLocaleString('id-ID');
      const biayaTindakanTeks = Number(newRecord.biayaTindakan || 0).toLocaleString('id-ID');
      const biayaObatTeks = Number(newRecord.biayaObat || 0).toLocaleString('id-ID');

      const telegramText = 
`🏥 <b>LAPORAN HASIL PEMERIKSAAN PASIEN</b>
━━━━━━━━━━━━━━━━━━━━
🕐 <b>Waktu:</b> ${nowWIB} WIB
👤 <b>Pasien:</b> <b>${newRecord.namaPasien || '-'}</b>
🔢 <b>NPK / NIK:</b> <code>${newRecord.nikPabrik || '-'}</code>
🏢 <b>Bagian / Dept:</b> ${newRecord.dept || 'PT ATI'}
━━━━━━━━━━━━━━━━━━━━
📋 <b>DATA REKAM MEDIS (SOAP):</b>
• <b>[S] Keluhan Utama:</b>
  ${newRecord.keluhan || '-'}

• <b>[O] Pemeriksaan Fisik & Tanda Vital:</b>
  ${newRecord.objektif || '-'}

• <b>[A] Diagnosis (ICD-10):</b>
  ${newRecord.asesmen || '-'}

• <b>[P] Tindakan Medis:</b>
${logTindakanTeks}

• <b>[P] Terapi Obat & Sisa Stok:</b>
${obatDetailTeks}
━━━━━━━━━━━━━━━━━━━━
⚖️ <b>STATUS KELAIKAN:</b>
<b>${statusKelaikanTeks}</b>

💰 <b>RINCIAN BIAYA BEROBAT:</b>
• Biaya Tindakan : Rp ${biayaTindakanTeks}
• Biaya Obat     : Rp ${biayaObatTeks}
• <b>TOTAL TAGIHAN : Rp ${totalBiayaTeks}</b>

👨‍⚕️ <b>Nakes Pemeriksa:</b> <b>${newRecord.pemeriksa || '-'}</b>
━━━━━━━━━━━━━━━━━━━━
🏥 <i>Sistem Rekam Medis & Manajemen Klinik PT ATI</i>`;

      sendTelegramNotif(telegramText);
    } catch (err) {
      console.error('Telegram notification error:', err);
    }

    // Auto Push to Google Sheets if configured
    try {
      autoPushMedicinesToGSheet(db);
    } catch (err) {
      console.error('Auto push medicines error:', err);
    }

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
  });
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
  const alasanKoreksi = updatedData.alasanKoreksi || 'Revisi / Koreksi Data Rekam Medis';
  const petugasKoreksi = updatedData.pemeriksa || oldRecord.pemeriksa || 'Petugas Medis';

  // 1. Restore old medicine stock
  if (Array.isArray(oldRecord.resep) && oldRecord.resep.length > 0 && db.medicines) {
    oldRecord.resep.forEach(item => {
      const namaObat = (item.namaObat || item.obat || '').trim();
      const qty = parseInt(item.qty || item.jumlah) || 1;
      if (namaObat) {
        const cleanName = namaObat.toLowerCase();
        const med = db.medicines.find(m => m.nama && (m.nama.trim().toLowerCase() === cleanName || m.nama.trim().toLowerCase().includes(cleanName) || cleanName.includes(m.nama.trim().toLowerCase())));
        if (med) {
          const prevStok = parseInt(med.stok) || 0;
          const nextStok = prevStok + qty;
          med.stok = nextStok;
          logStockMutation(db, {
            tanggal: updatedData.tanggal || oldRecord.tanggal,
            type: 'ADJUST',
            namaObat: med.nama,
            satuan: med.satuan || 'tab',
            qty: qty,
            delta: +qty,
            stokSebelum: prevStok,
            stokSesudah: nextStok,
            refType: 'REVISI_RECORD',
            refId: oldRecord.id,
            refDoc: 'Revisi (Kembalikan Resep Lama)',
            pasien: oldRecord.namaPasien || '',
            nik: oldRecord.nikPabrik || '',
            petugas: petugasKoreksi,
            keterangan: `Revisi Resep Lama: ${oldRecord.namaPasien || ''} (+${qty} ${med.satuan || 'tab'}) - ${alasanKoreksi}`
          });
        }
      }
    });
  } else if (oldRecord.plan && db.medicines) {
    // Fallback if old record had legacy plan text
    let cleaned = String(oldRecord.plan).replace(/Resep:\s*/i, '').replace(/\[Total:\s*Rp\s*[^\]]+\]/gi, '').trim();
    const planItems = cleaned.split(/[;,]/).map(p => p.trim()).filter(Boolean);
    planItems.forEach(p => {
      const match = p.match(/^(.+?)(?:\s+\d+x\d+)?\s+No\.(\d+)/i) || p.match(/^(.+?)(?:\s+(\d+))?$/);
      const name = match ? match[1].replace(/\[.*?\]/g, '').trim() : p.replace(/\[.*?\]/g, '').trim();
      const qty = match && match[2] ? parseInt(match[2]) : 1;
      if (name) {
        const cleanName = name.toLowerCase();
        const med = db.medicines.find(m => m.nama && (m.nama.trim().toLowerCase() === cleanName || m.nama.trim().toLowerCase().includes(cleanName) || cleanName.includes(m.nama.trim().toLowerCase())));
        if (med) {
          const prevStok = parseInt(med.stok) || 0;
          const nextStok = prevStok + qty;
          med.stok = nextStok;
          logStockMutation(db, {
            tanggal: updatedData.tanggal || oldRecord.tanggal,
            type: 'ADJUST',
            namaObat: med.nama,
            satuan: med.satuan || 'tab',
            qty: qty,
            delta: +qty,
            stokSebelum: prevStok,
            stokSesudah: nextStok,
            refType: 'REVISI_RECORD',
            refId: oldRecord.id,
            refDoc: 'Revisi (Kembalikan Resep Lama)',
            pasien: oldRecord.namaPasien || '',
            nik: oldRecord.nikPabrik || '',
            petugas: petugasKoreksi,
            keterangan: `Revisi Resep Lama: ${oldRecord.namaPasien || ''} (+${qty})`
          });
        }
      }
    });
  }

  // 2. Deduct new medicine stock
  if (Array.isArray(updatedData.resep) && updatedData.resep.length > 0 && db.medicines) {
    updatedData.resep.forEach(item => {
      const namaObat = (item.namaObat || item.obat || '').trim();
      const qty = parseInt(item.qty || item.jumlah) || 1;
      if (namaObat) {
        const cleanName = namaObat.toLowerCase();
        const med = db.medicines.find(m => m.nama && (m.nama.trim().toLowerCase() === cleanName || m.nama.trim().toLowerCase().includes(cleanName) || cleanName.includes(m.nama.trim().toLowerCase())));
        if (med) {
          const prevStok = parseInt(med.stok) || 0;
          const nextStok = Math.max(0, prevStok - qty);
          med.stok = nextStok;
          logStockMutation(db, {
            tanggal: updatedData.tanggal || oldRecord.tanggal,
            type: 'OUT',
            namaObat: med.nama,
            satuan: med.satuan || 'tab',
            qty: qty,
            delta: -qty,
            stokSebelum: prevStok,
            stokSesudah: nextStok,
            refType: 'REVISI_RECORD',
            refId: oldRecord.id,
            refDoc: 'Revisi (Resep Baru)',
            pasien: updatedData.namaPasien || oldRecord.namaPasien || '',
            nik: updatedData.nikPabrik || oldRecord.nikPabrik || '',
            petugas: petugasKoreksi,
            keterangan: `Revisi Resep Baru: ${updatedData.namaPasien || oldRecord.namaPasien || ''} (-${qty} ${med.satuan || 'tab'})`
          });
        }
      }
    });
  }

  db.records[idx] = { ...oldRecord, ...updatedData };
  writeDB(db);
  autoPushMedicinesToGSheet(db);
  notifyClients();
  res.json(db.records[idx]);
});

app.delete('/api/records/:id', (req, res) => {
  const db = readDB();
  if (!db.records) return res.status(404).json({ error: 'Data rekam medis tidak ditemukan' });
  
  const recordIndex = db.records.findIndex(r => r.id === req.params.id);
  if (recordIndex === -1) {
    return res.status(404).json({ error: 'Data rekam medis tidak ditemukan' });
  }

  const oldRecord = db.records[recordIndex];
  const deletedBy = req.body?.deletedBy || 'Petugas Medis';
  const reason = req.body?.reason || 'Pasien batal berobat / Koreksi data';

  // 1. Restore medicine stock
  const restoredMeds = [];
  if (Array.isArray(oldRecord.resep) && oldRecord.resep.length > 0 && db.medicines) {
    oldRecord.resep.forEach(item => {
      const namaObat = (item.namaObat || item.obat || '').trim();
      const qty = parseInt(item.qty || item.jumlah) || 1;
      if (namaObat) {
        const cleanName = namaObat.toLowerCase();
        const med = db.medicines.find(m => m.nama && (m.nama.trim().toLowerCase() === cleanName || m.nama.trim().toLowerCase().includes(cleanName) || cleanName.includes(m.nama.trim().toLowerCase())));
        if (med) {
          const prevStok = parseInt(med.stok) || 0;
          const nextStok = prevStok + qty;
          med.stok = nextStok;
          logStockMutation(db, {
            tanggal: oldRecord.tanggal,
            type: 'ADJUST',
            namaObat: med.nama,
            satuan: med.satuan || 'tab',
            qty: qty,
            delta: +qty,
            stokSebelum: prevStok,
            stokSesudah: nextStok,
            refType: 'BATAL_BEROBAT',
            refId: oldRecord.id,
            refDoc: 'Batal Berobat (Hapus Rekam Medis)',
            pasien: oldRecord.namaPasien || '',
            nik: oldRecord.nikPabrik || '',
            petugas: deletedBy,
            keterangan: `Pembatalan Berobat (${reason}): Kembalikan stok pasien ${oldRecord.namaPasien || ''} (+${qty} ${med.satuan || 'tab'})`
          });
          restoredMeds.push(`${med.nama} (+${qty} ${med.satuan || 'item'})`);
        }
      }
    });
  } else if (oldRecord.plan && db.medicines) {
    let cleaned = String(oldRecord.plan).replace(/Resep:\s*/i, '').replace(/\[Total:\s*Rp\s*[^\]]+\]/gi, '').trim();
    const planItems = cleaned.split(/[;,]/).map(p => p.trim()).filter(Boolean);
    planItems.forEach(p => {
      const match = p.match(/^(.+?)(?:\s+\d+x\d+)?\s+No\.(\d+)/i) || p.match(/^(.+?)(?:\s+(\d+))?$/);
      const name = match ? match[1].replace(/\[.*?\]/g, '').trim() : p.replace(/\[.*?\]/g, '').trim();
      const qty = match && match[2] ? parseInt(match[2]) : 1;
      if (name) {
        const cleanName = name.toLowerCase();
        const med = db.medicines.find(m => m.nama && (m.nama.trim().toLowerCase() === cleanName || m.nama.trim().toLowerCase().includes(cleanName) || cleanName.includes(m.nama.trim().toLowerCase())));
        if (med) {
          const prevStok = parseInt(med.stok) || 0;
          const nextStok = prevStok + qty;
          med.stok = nextStok;
          logStockMutation(db, {
            tanggal: oldRecord.tanggal,
            type: 'ADJUST',
            namaObat: med.nama,
            satuan: med.satuan || 'tab',
            qty: qty,
            delta: +qty,
            stokSebelum: prevStok,
            stokSesudah: nextStok,
            refType: 'BATAL_BEROBAT',
            refId: oldRecord.id,
            refDoc: 'Batal Berobat (Hapus Rekam Medis)',
            pasien: oldRecord.namaPasien || '',
            nik: oldRecord.nikPabrik || '',
            petugas: deletedBy,
            keterangan: `Pembatalan Berobat (${reason}): Kembalikan stok pasien ${oldRecord.namaPasien || ''} (+${qty})`
          });
          restoredMeds.push(`${med.nama} (+${qty} ${med.satuan || 'item'})`);
        }
      }
    });
  }

  // 2. Remove record from db.records
  db.records.splice(recordIndex, 1);

  // 3. Remove from pantauan if applicable
  if (Array.isArray(db.pantauan) && oldRecord.nikPabrik) {
    db.pantauan = db.pantauan.filter(p => p.nikPabrik !== oldRecord.nikPabrik);
  }

  // 4. Save to database
  writeDB(db);
  autoPushMedicinesToGSheet(db);
  notifyClients();

  // 5. Send Telegram Audit Notification
  const resepText = restoredMeds.length > 0
    ? restoredMeds.map(m => `• ${m}`).join('\n')
    : (Array.isArray(oldRecord.resep) && oldRecord.resep.length > 0
        ? oldRecord.resep.map(r => `• ${r.namaObat || r.obat} (${r.qty || 1} item)`).join('\n')
        : '• Tidak ada obat yang diresepkan');

  const nowWIB = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const telegramMsg = 
`🗑️ <b>AUDIT TRAIL: PENGHAPUSAN REKAM MEDIS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Pasien:</b> ${oldRecord.namaPasien || '-'} (NPK: ${oldRecord.nikPabrik || '-'})
🏢 <b>Bagian/Dept:</b> ${oldRecord.dept || 'PT ATI'}
📅 <b>Tgl Berobat:</b> ${oldRecord.tanggal || '-'}
🩺 <b>Keluhan / Diag:</b> ${oldRecord.keluhan || '-'} | ${oldRecord.asesmen || '-'}

💊 <b>Stok Obat Dikembalikan ke Gudang:</b>
${resepText}

💰 <b>Billing Dibatalkan:</b> Rp ${(oldRecord.totalBiaya || 0).toLocaleString('id-ID')}

⚠️ <b>Alasan Penghapusan:</b>
<i>"${reason}"</i>

👨‍⚕️ <b>Dihapus Oleh:</b> <b>${deletedBy}</b>
⏰ <b>Waktu Hapus:</b> ${nowWIB} WIB
━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ <i>Status: Data rekam medis telah dihapus, stok obat otomatis dikembalikan, dan penagihan billing telah dikoreksi.</i>`;

  sendTelegramNotif(telegramMsg);

  res.json({
    success: true,
    message: 'Rekam medis berhasil dihapus, stok obat dikembalikan, dan laporan audit terkirim ke Telegram.',
    restoredMedicines: restoredMeds,
    deletedRecord: oldRecord
  });
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

app.post('/api/send-wa', async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ success: false, error: 'Nomor dan pesan wajib diisi' });
    }

    const rawResponse = await sendWhaCenterNotif(number, message);
    let parsed = null;
    let isOk = false;
    try {
      if (rawResponse) {
        parsed = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
        if (parsed.status === true || parsed.status === 'true' || parsed.status === 'success' || parsed.status === 200 || parsed.status === '200') {
          isOk = true;
        }
      }
    } catch (errParse) {
      console.log('Error parsing JSON from WhaCenter:', errParse.message);
    }

    res.json({ success: isOk, response: parsed || rawResponse });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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
