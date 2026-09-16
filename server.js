const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const whatsappService = require('./services/whatsapp');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Anti-cache header for all API responses to ensure real-time consistency
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname)));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CHATS_FILE = path.join(DATA_DIR, 'chat_sessions.json');
const KONTROL_FILE = path.join(DATA_DIR, 'kontrol_pasien.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Uploads folder for WhatsApp attachments & medical documents
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function loadChatSessions() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const content = fs.readFileSync(CHATS_FILE, 'utf8');
      const loaded = JSON.parse(content);
      if (Array.isArray(loaded)) return loaded;
    }
  } catch (err) {
    console.error('[Chat Sessions] Error reading chat_sessions.json:', err.message);
  }
  return [];
}

function saveChatSessions(chats) {
  try {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2), 'utf8');
  } catch (err) {
    console.error('[Chat Sessions] Error saving chat_sessions.json:', err.message);
  }
}

let chatSessions = loadChatSessions();

function loadKontrolPasien() {
  try {
    if (fs.existsSync(KONTROL_FILE)) {
      const content = fs.readFileSync(KONTROL_FILE, 'utf8');
      const loaded = JSON.parse(content);
      if (Array.isArray(loaded)) return loaded;
    }
  } catch (err) {
    console.error('[Kontrol Pasien] Error reading kontrol_pasien.json:', err.message);
  }
  return [];
}

function saveKontrolPasien(list) {
  try {
    fs.writeFileSync(KONTROL_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('[Kontrol Pasien] Error saving kontrol_pasien.json:', err.message);
  }
}

// Hubungkan WhatsApp Service ke Socket.io
whatsappService.setSocketIO(io);

// Callback pesan WA masuk / keluar dari HP fisik
whatsappService.setOnMessageReceived(async (sessionType, msgData) => {
  const { senderPhone, senderName, text, rawJid, participant, mediaUrl, mediaType, fileName, isFromMe, messageId } = msgData;

  let formattedPhone = senderPhone;
  if (senderPhone.startsWith('62')) {
    formattedPhone = '0' + senderPhone.slice(2);
  }

  const cleanDigits = (senderPhone || '').replace(/\D/g, '');
  const suffix8 = cleanDigits.length >= 8 ? cleanDigits.slice(-8) : cleanDigits;

  let session = chatSessions.find(s => {
    if (s.rawJid && (s.rawJid === rawJid || s.rawJid === participant)) return true;
    if (rawJid && s.rawJid && (rawJid.includes(s.patientPhone) || s.rawJid.includes(senderPhone))) return true;
    if (s.patientPhone === senderPhone || s.patientPhone === formattedPhone) return true;
    const sDigits = (s.patientPhone || '').replace(/\D/g, '');
    if (suffix8 && sDigits.endsWith(suffix8)) return true;
    return false;
  });

  const db = readDB();
  const allPatients = db.employees || db.patients || [];

  if (!session) {
    const regPatient = allPatients.find(p => {
      const pDigits = (p.hp || p.noHp || p.telepon || '').replace(/\D/g, '');
      return (suffix8 && pDigits.endsWith(suffix8)) || (p.nama && p.nama.toLowerCase() === senderName.toLowerCase());
    });

    session = {
      id: 'CHAT-' + Date.now(),
      patientId: regPatient ? (regPatient.nikPabrik || regPatient.nik || regPatient.id) : ('PAS-' + Date.now().toString().slice(-4)),
      patientName: regPatient ? regPatient.nama : senderName,
      patientPhone: formattedPhone || senderPhone,
      nikPabrik: regPatient ? (regPatient.nikPabrik || regPatient.nik || '') : '',
      dept: regPatient ? (regPatient.dept || regPatient.departemen || '') : '',
      rawJid: rawJid,
      sessionType: sessionType,
      updatedAt: Date.now(),
      unreadCount: isFromMe ? 0 : 1,
      messages: []
    };
    chatSessions.unshift(session);
  } else {
    if (rawJid && (!session.rawJid || session.rawJid.includes('@lid'))) {
      session.rawJid = rawJid;
    }
    if (!isFromMe && senderName && session.patientName.startsWith('Pasien ')) {
      session.patientName = senderName;
    }
    if (!isFromMe) {
      session.unreadCount = (session.unreadCount || 0) + 1;
    }
    session.updatedAt = Date.now();
    const sIdx = chatSessions.indexOf(session);
    if (sIdx > 0) {
      chatSessions.splice(sIdx, 1);
      chatSessions.unshift(session);
    }
  }

  if (messageId && session.messages.some(m => m.messageId === messageId)) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

  const newMsg = {
    messageId: messageId || null,
    sender: isFromMe ? 'staff' : 'patient',
    staffName: isFromMe ? (sessionType === 'apotek' ? 'Apotek (via HP)' : 'Klinik (via HP)') : undefined,
    text: text,
    mediaUrl: mediaUrl || null,
    mediaType: mediaType || null,
    fileName: fileName || null,
    timestamp: timestamp,
    rawTime: Date.now()
  };

  session.messages.push(newMsg);
  saveChatSessions(chatSessions);

  io.emit('wa_new_message', {
    chatId: session.id,
    sessionType: sessionType,
    message: newMsg,
    chatSession: session
  });
});


const DEFAULT_USERS = [
  { id: 'usr-1', username: 'dr.dylan', nama: 'dr. Dylan Fadhilah', role: 'Dokter', password: 'dylan', noWa: '081291868456', created_at: '2026-08-01T00:00:00.000Z' },
  { id: 'usr-2', username: 'dr.medika', nama: 'dr. Medika', role: 'Dokter', password: 'medika', noWa: '081234567890', created_at: '2026-08-01T00:00:00.000Z' },
  { id: 'usr-3', username: 'perawat', nama: 'Ns. Perawat Jaga', role: 'Perawat', password: 'perawat', noWa: '089651512933', created_at: '2026-08-01T00:00:00.000Z' }
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
    } else {
      data.users.forEach(u => {
        if (!u.noWa) {
          if (u.username === 'dr.dylan') u.noWa = '081291868456';
          else if (u.username === 'dr.medika') u.noWa = '081234567890';
          else if (u.username === 'perawat') u.noWa = '089651512933';
          else u.noWa = '';
          modified = true;
        }
      });
    }
    if (!Array.isArray(data.tindakan) || data.tindakan.length === 0) {
      data.tindakan = [...DEFAULT_TINDAKAN];
      modified = true;
    }
    if (!Array.isArray(data.surat_sakit_luar)) {
      data.surat_sakit_luar = [];
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

    // Auto-enrich master 1,142 employees dataset (with rich Section, BirthPlace, GolDarah, SaldoObat, 5-digit NPK)
    const masterEmpFile = path.join(__dirname, 'employees_master.json');
    if (fs.existsSync(masterEmpFile)) {
      try {
        const masterEmps = JSON.parse(fs.readFileSync(masterEmpFile, 'utf8'));
        if (Array.isArray(masterEmps) && masterEmps.length > 0) {
          const empMap = new Map();
          masterEmps.forEach(m => {
            const k1 = String(m.nikPabrik || m.nik || '').trim().replace(/^0+/, '');
            const k2 = String(m.nama || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            if (k1) empMap.set(k1, m);
            if (k2) empMap.set(k2, m);
          });

          if (!Array.isArray(data.employees) || data.employees.length === 0) {
            data.employees = [...masterEmps];
            data.patients = [...masterEmps];
            modified = true;
          } else {
            data.employees.forEach(e => {
              const k1 = String(e.nikPabrik || e.nik || '').trim().replace(/^0+/, '');
              const k2 = String(e.nama || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
              const m = (k1 && empMap.get(k1)) || (k2 && empMap.get(k2));
              if (m) {
                if (m.nikPabrik && e.nikPabrik !== m.nikPabrik) { e.nikPabrik = m.nikPabrik; e.nik = m.nikPabrik; modified = true; }
                if (m.sectionName && e.sectionName !== m.sectionName) { e.sectionName = m.sectionName; modified = true; }
                if (m.birthPlace && e.birthPlace !== m.birthPlace) { e.birthPlace = m.birthPlace; modified = true; }
                if (m.golDarah && m.golDarah !== '-' && e.golDarah !== m.golDarah) { e.golDarah = m.golDarah; modified = true; }
                if (m.saldoObat && e.saldoObat !== m.saldoObat) { e.saldoObat = m.saldoObat; modified = true; }
                if (m.hp && e.hp !== m.hp) { e.hp = m.hp; e.no_hp = m.hp; modified = true; }
              }
            });
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
      if (typeof client.res.flush === 'function') client.res.flush();
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

function findMedicineInDb(medicines, searchName, searchId) {
  if (!Array.isArray(medicines)) return null;
  const cleanId = String(searchId || '').trim().toLowerCase();
  const cleanName = String(searchName || '').trim().toLowerCase();

  // 1. Match by ID if provided
  if (cleanId) {
    const byId = medicines.find(m => String(m.id || '').trim().toLowerCase() === cleanId);
    if (byId) return byId;
  }

  if (!cleanName) return null;

  // 2. Exact match (case-insensitive & trimmed)
  const exactMatch = medicines.find(m => String(m.nama || '').trim().toLowerCase() === cleanName);
  if (exactMatch) return exactMatch;

  // 3. Normalized match (remove non-alphanumeric differences e.g. extra spaces/dashes)
  const normClean = cleanName.replace(/[^a-z0-9]/g, '');
  if (normClean) {
    const normMatch = medicines.find(m => String(m.nama || '').toLowerCase().replace(/[^a-z0-9]/g, '') === normClean);
    if (normMatch) return normMatch;
  }

  return null;
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
  if (typeof res.flush === 'function') res.flush();
  
  const client = { id: Date.now() + Math.random(), res };
  sseClients.push(client);

  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (e) {
      clearInterval(pingInterval);
    }
  }, 5000);
  
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
  const { username, password, userId } = req.body;
  if ((!username && !userId) || !password) {
    return res.status(400).json({ success: false, error: 'Username / Akun dan Kata Sandi wajib diisi!' });
  }

  const db = readDB();
  const users = db.users || [];
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanPass = String(password).trim();
  const masterPass = db.settings?.gate_password || "231067";

  // 1. Cari user berdasarkan userId (paling presisi), username, atau nama lengkap
  let matchedUser = users.find(u => 
    (userId && u.id === userId) ||
    (cleanUser && u.username && u.username.toLowerCase() === cleanUser) ||
    (cleanUser && u.nama && u.nama.toLowerCase() === cleanUser) ||
    (cleanUser && u.nama && u.nama.toLowerCase().includes(cleanUser)) ||
    (cleanUser && u.username && u.username.toLowerCase().includes(cleanUser))
  );

  // 2. Jika menggunakan Master Password / PIN Klinik (231067)
  if (cleanPass === masterPass) {
    if (!matchedUser) {
      matchedUser = {
        id: 'usr-master',
        username: cleanUser || 'master',
        nama: cleanUser ? (cleanUser.startsWith('dr.') ? cleanUser : `dr. ${cleanUser}`) : 'Petugas Medis',
        role: 'Dokter',
        created_at: new Date().toISOString()
      };
    }
    const { password: _, ...safeUser } = matchedUser;
    return res.json({ success: true, status: 'SUCCESS', user: safeUser, message: 'Login berhasil (Master Key)' });
  }

  // 3. Jika user ditemukan
  if (matchedUser) {
    // Toleransi akun migrasi lama yang belum memiliki password tersimpan di db.json
    if (!matchedUser.password || String(matchedUser.password).trim() === '') {
      matchedUser.password = cleanPass;
      writeDB(db);
      notifyClients();
      const { password: _, ...safeUser } = matchedUser;
      return res.json({ success: true, status: 'SUCCESS', user: safeUser, message: 'Login berhasil (Kata sandi baru diaktifkan)' });
    }

    // Cek kesesuaian password normal
    if (String(matchedUser.password).trim() === cleanPass) {
      const { password: _, ...safeUser } = matchedUser;
      return res.json({ success: true, status: 'SUCCESS', user: safeUser, message: 'Login berhasil' });
    }

    return res.status(401).json({ success: false, error: 'Kata sandi salah! Masukkan password akun atau master key (231067).' });
  }

  return res.status(401).json({ success: false, error: 'Akun petugas tidak ditemukan!' });
});

// User Registration (Buat Akun Petugas Baru)
app.post('/api/auth/register', (req, res) => {
  const { nama, username, role, password, noWa, hp } = req.body;
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
    noWa: String(noWa || hp || '').trim(),
    password: String(password).trim(),
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDB(db);
  notifyClients();

  const { password: _, ...safeUser } = newUser;
  return res.status(201).json({ success: true, user: safeUser, message: 'Akun petugas berhasil dibuat!' });
});

// Change Password for Logged-In User
app.post('/api/auth/change-password', (req, res) => {
  const { username, currentPassword, newPassword, userId, nama, role, noWa, hp } = req.body;
  if (!username || !newPassword) {
    return res.status(400).json({ success: false, error: 'Username dan Kata Sandi baru wajib diisi!' });
  }
  if (String(newPassword).trim().length < 4) {
    return res.status(400).json({ success: false, error: 'Kata sandi baru minimal 4 karakter!' });
  }

  const db = readDB();
  if (!db.users) db.users = [];
  const cleanUser = String(username).trim().toLowerCase();
  const masterPass = db.settings?.gate_password || "231067";

  let userIdx = db.users.findIndex(u => 
    (userId && u.id === userId) ||
    (u.username && u.username.toLowerCase() === cleanUser) ||
    (u.nama && u.nama.toLowerCase() === cleanUser)
  );

  // If user is not yet in db.users, add as new record
  if (userIdx === -1) {
    const newUser = {
      id: userId || ('usr-' + Date.now()),
      nama: nama || username,
      username: cleanUser,
      role: role || 'Dokter',
      noWa: String(noWa || hp || '').trim(),
      password: String(newPassword).trim(),
      created_at: new Date().toISOString()
    };
    db.users.push(newUser);
    writeDB(db);
    notifyClients();
    const { password: _, ...safeUser } = newUser;
    return res.json({ success: true, message: 'Kata sandi baru berhasil disimpan!', user: safeUser });
  }

  const existingUser = db.users[userIdx];
  // Verify current password unless master password was entered
  if (currentPassword) {
    const cleanCurrent = String(currentPassword).trim();
    if (cleanCurrent !== masterPass && String(existingUser.password).trim() !== cleanCurrent) {
      return res.status(400).json({ success: false, error: 'Kata sandi lama salah!' });
    }
  }

  db.users[userIdx].password = String(newPassword).trim();
  if (nama && String(nama).trim() !== '') db.users[userIdx].nama = String(nama).trim();
  if (role && String(role).trim() !== '') db.users[userIdx].role = role;
  if (noWa !== undefined || hp !== undefined) db.users[userIdx].noWa = String(noWa || hp || '').trim();
  db.users[userIdx].updated_at = new Date().toISOString();
  writeDB(db);
  notifyClients();
  const { password: _, ...safeUser } = db.users[userIdx];
  return res.json({ success: true, message: 'Kata sandi dan profil berhasil diperbarui!', user: safeUser });
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
  const { nama, username, role, password, noWa, hp } = req.body;
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
    noWa: String(noWa || hp || '').trim(),
    password: password ? String(password).trim() : '123456',
    created_at: new Date().toISOString()
  };
  db.users.push(newUser);
  writeDB(db);
  notifyClients();
  const { password: _, ...safeUser } = newUser;
  res.status(201).json({ success: true, user: safeUser });
});

// Update User
app.put('/api/users/:id', (req, res) => {
  const db = readDB();
  if (!db.users) return res.status(404).json({ error: 'User tidak ditemukan' });
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User tidak ditemukan' });

  const { nama, username, role, password, noWa, hp } = req.body;
  if (nama) db.users[idx].nama = String(nama).trim();
  if (username) db.users[idx].username = String(username).trim().toLowerCase();
  if (role) db.users[idx].role = role;
  if (noWa !== undefined || hp !== undefined) db.users[idx].noWa = String(noWa || hp || '').trim();
  if (password && String(password).trim() !== '') {
    db.users[idx].password = String(password).trim();
  }
  writeDB(db);
  notifyClients();
  const { password: _, ...safeUser } = db.users[idx];
  res.json({ success: true, user: safeUser });
});

// Delete User
app.delete('/api/users/:id', (req, res) => {
  const db = readDB();
  if (!db.users) return res.status(404).json({ error: 'User tidak ditemukan' });
  db.users = db.users.filter(u => u.id !== req.params.id);
  writeDB(db);
  notifyClients();
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

// Helper: Kirim POST JSON ke Google Apps Script dengan penanganan otomatis Redirect HTTP 302/307
function postToGAS(targetUrl, payload) {
  return new Promise((resolve) => {
    try {
      const postData = JSON.stringify(payload);
      const urlObj = new URL(targetUrl);
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RekamMedisATI/1.0'
        }
      };

      const req = https.request(options, (res) => {
        // Jika GAS me-redirect (302/307), ikuti lokasi redirect dengan GET
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, (redirectRes) => {
            let body = '';
            redirectRes.on('data', chunk => body += chunk);
            redirectRes.on('end', () => {
              try {
                const parsed = JSON.parse(body);
                resolve({ success: true, data: parsed });
              } catch(e) {
                resolve({ success: true, raw: body });
              }
            });
          }).on('error', (err) => {
            resolve({ success: true, warning: err.message });
          });
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ success: true, data: parsed });
          } catch(e) {
            resolve({ success: true, raw: data });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      req.setTimeout(45000, () => {
        req.destroy();
        resolve({ success: false, error: 'Koneksi ke Google Sheets timeout (45s)' });
      });

      req.write(postData);
      req.end();
    } catch(err) {
      resolve({ success: false, error: err.message });
    }
  });
}

// Helper: Push seluruh data (ICD-10, Obat, Karyawan, Tindakan, Rekam Medis, Surat Jalan, Mutasi Stok, Surat Sakit) satu arah ke Google Sheets (One-Way)
async function pushAllDataToGSheet(db, gsheetUrl) {
  if (!gsheetUrl) return { success: false, error: 'URL Google Apps Script belum diatur di tab Pengaturan' };

  // 1. Master Diagnosis (ICD-10)
  const icd10 = (db.icd10 || []).map(i => ({
    code: String(i.code || '').trim(),
    description: String(i.description || '').trim()
  })).filter(x => x.code || x.description);

  // 2. Master Obat / Farmasi
  const medicines = (db.medicines || []).map(m => ({
    id: String(m.id || '').trim(),
    kode: String(m.kode || m.id || '').trim(),
    nama: String(m.nama || '').trim(),
    stok: parseSafeInt(m.stok, 0),
    satuan: String(m.satuan || 'strip').trim(),
    harga: parseSafeInt(m.harga, 0),
    kategori: String(m.kategori || 'Obat').trim()
  })).filter(x => x.nama);

  // 3. Master Karyawan
  const employees = (db.employees || []).map(e => ({
    nikPabrik: String(e.nikPabrik || e.nik || '').trim(),
    nama: String(e.nama || '').trim(),
    dept: String(e.dept || e.departemen || '').trim(),
    gender: String(e.gender || '').trim(),
    golDarah: String(e.golDarah || '-').trim(),
    tglLahir: String(e.tglLahir || e.tgl_lahir || '').trim(),
    birthPlace: String(e.birthPlace || '').trim(),
    hp: String(e.hp || e.no_hp || '').trim(),
    saldoObat: e.saldoObat !== undefined ? e.saldoObat : '',
    sectionName: String(e.sectionName || '').trim()
  })).filter(x => x.nikPabrik || x.nama);

  // 4. Master Tindakan
  const tindakan = (db.tindakan || []).map(t => ({
    id: String(t.id || '').trim(),
    nama: String(t.nama || '').trim(),
    tarif: parseSafeInt(t.tarif, 0),
    kategori: String(t.kategori || 'Tindakan Medis').trim()
  })).filter(x => x.nama);

  // 5. Kunjungan / Rekam Medis (diinput perawat/dokter saat kunjungan pasien)
  const records = (db.records || []).map(r => {
    let namaTindakan = '';
    if (Array.isArray(r.tindakan)) {
      namaTindakan = r.tindakan.map(t => typeof t === 'object' ? (t.nama || '') : t).filter(Boolean).join(', ');
    } else if (r.tindakan) {
      namaTindakan = String(r.tindakan);
    }
    return {
      id: String(r.id || '').trim(),
      tanggal: String(r.tanggal || '').trim(),
      jam: String(r.jam || '').trim(),
      nikPabrik: String(r.nikPabrik || '').trim(),
      namaPasien: String(r.namaPasien || '').trim(),
      dept: String(r.dept || '').trim(),
      noHp: String(r.noHp || '').trim(),
      keluhan: String(r.keluhan || '').trim(),
      objektif: String(r.objektif || '').trim(),
      asesmen: String(r.asesmen || '').trim(),
      tindakan: namaTindakan,
      plan: String(r.plan || '').trim(),
      biayaObat: parseSafeInt(r.biayaObat, 0),
      biayaTindakan: parseSafeInt(r.biayaTindakan, 0),
      totalBiaya: parseSafeInt(r.totalBiaya, 0),
      pemeriksa: String(r.pemeriksa || '').trim(),
      statusKontrol: r.isPantauan ? 'Pantauan/Kontrol' : (r.izinSakit ? 'Izin Sakit' : 'Selesai'),
      catatanKontrol: String(r.catatanKontrol || '').trim(),
      linkFoto: String(r.linkFoto || '').trim()
    };
  });

  // 6. Surat Jalan (diinput apotik saat mutasi/kirim obat)
  const suratJalan = [];
  (db.surat_jalan || []).forEach(sj => {
    const items = Array.isArray(sj.items) && sj.items.length > 0 ? sj.items : [null];
    items.forEach(it => {
      suratJalan.push({
        noSurat: String(sj.noSurat || sj.id || '').trim(),
        tanggal: String(sj.tanggal || '').trim(),
        sender: String(sj.sender || '').trim(),
        receiver: String(sj.receiver || '').trim(),
        namaObat: it ? String(it.name || it.nama || '').trim() : '-',
        qty: it ? parseSafeInt(it.qty, 0) : 0,
        satuan: it ? String(it.satuan || '').trim() : '-',
        stokAwal: it ? parseSafeInt(it.initial, 0) : 0,
        stokAkhir: it ? parseSafeInt(it.final, 0) : 0,
        createdAt: String(sj.created_at || '').trim()
      });
    });
  });

  // 7. Mutasi Stok Obat (semua riwayat obat keluar & masuk dari apotik & klinik)
  const stockMutations = (db.stock_mutations || []).map(m => ({
    id: String(m.id || '').trim(),
    tanggal: String(m.tanggal || '').trim(),
    createdAt: String(m.created_at || '').trim(),
    type: String(m.type || '').trim(),
    namaObat: String(m.namaObat || '').trim(),
    qty: parseSafeInt(m.qty, 0),
    satuan: String(m.satuan || '').trim(),
    stokSebelum: m.stokSebelum !== undefined ? parseSafeInt(m.stokSebelum, 0) : '',
    stokSesudah: m.stokSesudah !== undefined ? parseSafeInt(m.stokSesudah, 0) : '',
    refDoc: String(m.refDoc || m.refType || '').trim(),
    pasien: String(m.pasien || (m.nik ? (m.pasien + ' (' + m.nik + ')') : '')).trim(),
    petugas: String(m.petugas || '').trim(),
    keterangan: String(m.keterangan || '').trim()
  }));

  // 8. Surat Sakit Luar
  const suratSakitLuar = (db.surat_sakit_luar || []).map(s => ({
    id: String(s.id || '').trim(),
    tanggal: String(s.tanggal || '').trim(),
    nikPabrik: String(s.nikPabrik || '').trim(),
    nama: String(s.nama || '').trim(),
    dept: String(s.dept || '').trim(),
    faskes: String(s.faskes || '').trim(),
    dokter: String(s.dokter || '').trim(),
    diagnosis: String(s.diagnosis || '').trim(),
    lamaHari: parseSafeInt(s.lamaHari, 0),
    tglMulai: String(s.tglMulai || '').trim(),
    tglSelesai: String(s.tglSelesai || '').trim(),
    keterangan: String(s.keterangan || '').trim(),
    linkFoto: String(s.linkFoto || '').trim()
  }));

  const payload = {
    action: 'seedMaster',
    icd10,
    medicines,
    employees,
    tindakan,
    records,
    suratJalan,
    stockMutations,
    suratSakitLuar
  };

  const res = await postToGAS(gsheetUrl, payload);
  if (res.success) {
    return {
      success: true,
      message: `Semua data master (${icd10.length} Diagnosis, ${medicines.length} Obat, ${employees.length} Karyawan, ${tindakan.length} Tindakan), ` +
               `${suratJalan.length} Baris Surat Jalan, ${stockMutations.length} Mutasi Stok, ` +
               `${records.length} Kunjungan Pasien & ${suratSakitLuar.length} Surat Sakit berhasil diekspor satu arah ke Google Sheets!`
    };
  } else {
    return {
      success: false,
      error: res.error || 'Gagal mengirim data ke Google Sheets'
    };
  }
}

// Endpoint Sinkronisasi Manual: HANYA SATU ARAH (VPS Database -> Google Sheets)
// Menjamin TIDAK PERNAH menimpa atau mengosongkan data di VPS!
async function performGSheetSync(db, gsheetUrl) {
  return await pushAllDataToGSheet(db, gsheetUrl);
}

app.post('/api/gsheet/sync', async (req, res) => {
  const db = readDB();
  const gsheetUrl = req.body?.gsheetUrl || db.settings?.gsheet_url;
  
  if (!gsheetUrl) {
    return res.status(400).json({ error: 'URL Google Apps Script tidak ada. Konfigurasi di tab Pengaturan.' });
  }

  try {
    const result = await pushAllDataToGSheet(db, gsheetUrl);
    if (result.success) {
      if (!db.settings) db.settings = {};
      db.settings.last_sync = new Date().toISOString();
      writeDB(db);
      res.json({ 
        success: true, 
        message: result.message,
        lastSync: db.settings.last_sync
      });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    console.error('GSheet sync error:', err);
    res.status(500).json({ error: 'Gagal sinkronisasi: ' + err.message });
  }
});

// Backup Otomatis 1x 24 Jam ke Google Sheets (Satu Arah: Database VPS -> Google Sheets)
async function performDailyGSheetBackup() {
  try {
    const db = readDB();
    const gsheetUrl = db.settings?.gsheet_url;
    if (!gsheetUrl) return;

    console.log('⏰ [Backup 24 Jam - 03:00 WIB] Menjalankan backup otomatis ke Google Sheets...');
    const result = await pushAllDataToGSheet(db, gsheetUrl);
    if (result.success) {
      if (!db.settings) db.settings = {};
      db.settings.last_sync = new Date().toISOString();
      writeDB(db);
      console.log('✅ [Backup 24 Jam - 03:00 WIB] Berhasil:', result.message);
    } else {
      console.warn('⚠️ [Backup 24 Jam - 03:00 WIB] Gagal:', result.error);
    }
  } catch (err) {
    console.error('⚠️ [Backup 24 Jam - 03:00 WIB] Exception:', err.message);
  }
}

// Penjadwalan Otomatis: Tepat jam 03:00 Subuh WIB (Asia/Jakarta UTC+7) setiap 24 jam sekali
function scheduleDaily3AMBackup() {
  function getMsUntilNext3AM() {
    const now = new Date();
    // Konversi waktu sekarang ke WIB (UTC+7)
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const jakartaTime = new Date(utcTime + (7 * 3600000));
    
    const target = new Date(jakartaTime);
    target.setHours(3, 0, 0, 0); // 03:00:00.000 Subuh WIB
    
    // Jika sudah lewat jam 03:00 hari ini di Jakarta, jadwalkan besok subuh jam 03:00
    if (jakartaTime.getTime() >= target.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    
    return target.getTime() - jakartaTime.getTime();
  }

  const delayMs = getMsUntilNext3AM();
  const hoursUntil = (delayMs / (1000 * 60 * 60)).toFixed(2);
  console.log(`⏰ [Auto-Backup GSheet] Terjadwal pada pukul 03:00 Subuh WIB (dalam ${hoursUntil} jam lagi)`);

  setTimeout(async () => {
    try {
      await performDailyGSheetBackup();
    } catch (e) {
      console.error('Error saat auto-backup 03:00 Subuh:', e);
    }
    // Jadwalkan untuk hari berikutnya
    scheduleDaily3AMBackup();
  }, delayMs);
}

scheduleDaily3AMBackup();

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

// Push all master data & records to Google Sheets (One-Click On-Demand)
app.post('/api/gsheet/push-all-master', async (req, res) => {
  const db = readDB();
  const gsheetUrl = db.settings?.gsheet_url;
  
  if (!gsheetUrl) {
    return res.status(400).json({ error: 'URL Google Apps Script belum diatur di tab G-SHEET SYNC' });
  }

  const result = await pushAllDataToGSheet(db, gsheetUrl);
  if (result.success) {
    if (!db.settings) db.settings = {};
    db.settings.last_sync = new Date().toISOString();
    writeDB(db);
    return res.json({ success: true, message: result.message });
  } else {
    return res.status(500).json({ error: result.error });
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
    records: records
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
        res.json({ success: true, message: `Data rekam medis (${records.length} kunjungan) terkirim ke Google Sheets` });
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
  // Dinonaktifkan sesuai permintaan: sinkronisasi ke GSheet kini murni 1-arah On-Click & Backup 24 Jam
  return;
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
  const targetId = String(req.params.id).trim().toLowerCase();
  let idx = db.medicines.findIndex(m => String(m.id || '').trim().toLowerCase() === targetId);
  if (idx === -1 && req.body.nama) {
    const targetName = String(req.body.nama).trim().toLowerCase();
    idx = db.medicines.findIndex(m => String(m.nama || '').trim().toLowerCase() === targetName);
  }

  if (idx !== -1) {
    const oldMed = { ...db.medicines[idx] };
    const { nama, stok, harga, satuan, kategori, petugas, alasan, sendTelegram } = req.body;

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
      id: oldMed.id || req.params.id,
      nama: newNama,
      stok: newStok,
      harga: newHarga,
      satuan: newSatuan,
      kategori: newKategori
    };
    writeDB(db);
    autoPushMedicinesToGSheet(db);

    // Kirim Audit Log ke Telegram Bot hanya jika diminta secara eksplisit
    if (sendTelegram === true) {
      try {
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
      } catch (errTele) {
        console.error('Non-blocking telegram notif error:', errTele.message);
      }
    }

    return res.json({ success: true, medicine: db.medicines[idx] });
  }
  res.status(404).json({ error: 'Obat tidak ditemukan' });
});

app.delete('/api/medicines/:id', (req, res) => {
  const db = readDB();
  if (!db.medicines) return res.status(404).json({ error: 'Obat tidak ditemukan' });
  const targetId = String(req.params.id).trim().toLowerCase();
  db.medicines = db.medicines.filter(m => String(m.id || '').trim().toLowerCase() !== targetId);
  writeDB(db);
  autoPushMedicinesToGSheet(db);
  res.json({ success: true, message: 'Obat dihapus' });
});

// Bulk Import Master Obat (Excel/CSV)
app.post('/api/medicines/bulk-import', (req, res) => {
  const db = readDB();
  if (!Array.isArray(db.medicines)) db.medicines = [];

  const { medicines, mode } = req.body; // mode: 'update' (tambah stok) | 'overwrite' (timpa) | 'skip'
  if (!Array.isArray(medicines) || medicines.length === 0) {
    return res.status(400).json({ success: false, error: 'Daftar obat tidak boleh kosong.' });
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of medicines) {
    const nama = String(item.nama || item.namaObat || '').trim();
    if (!nama) continue;

    const stok = parseInt(item.stok) || 0;
    const satuan = String(item.satuan || 'tab').trim();
    const harga = parseFloat(item.harga) || 0;
    const kategori = String(item.kategori || 'Obat').trim();

    const existingIndex = db.medicines.findIndex(m => m.nama.toLowerCase() === nama.toLowerCase());

    if (existingIndex !== -1) {
      if (mode === 'overwrite') {
        db.medicines[existingIndex] = {
          ...db.medicines[existingIndex],
          stok,
          satuan,
          harga,
          kategori
        };
        updated++;
      } else if (mode === 'update') {
        db.medicines[existingIndex].stok = (parseInt(db.medicines[existingIndex].stok) || 0) + stok;
        if (satuan) db.medicines[existingIndex].satuan = satuan;
        if (harga > 0) db.medicines[existingIndex].harga = harga;
        if (kategori) db.medicines[existingIndex].kategori = kategori;
        updated++;
      } else {
        skipped++;
      }
    } else {
      db.medicines.push({
        id: 'MED-' + (Date.now() + Math.floor(Math.random() * 1000)),
        nama,
        stok,
        satuan,
        harga,
        kategori
      });
      added++;
    }
  }

  writeDB(db);
  autoPushMedicinesToGSheet(db);
  res.json({
    success: true,
    message: `Import obat selesai: ${added} baru, ${updated} diperbarui, ${skipped} dilewati.`,
    summary: { added, updated, skipped },
    totalMedicines: db.medicines.length,
    medicines: db.medicines
  });
});

// Reset Master Obat (PIN: 231067)
app.post('/api/medicines/reset', (req, res) => {
  const { pin } = req.body;
  const MASTER_PIN = '231067';
  if (pin !== MASTER_PIN) {
    return res.status(401).json({ success: false, error: 'Kunci Master PIN Salah!' });
  }

  const db = readDB();
  db.medicines = [];
  writeDB(db);
  res.json({ success: true, message: 'Seluruh master obat berhasil dikosongkan!' });
});

app.post('/api/medicines/transfer', (req, res) => {
  const db = readDB();
  if (!db.medicines) db.medicines = [];

  const { sender, receiver, items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Daftar obat kosong atau tidak valid' });
  }

  // 1. Idempotency Guard: Cegah double click / spam-klik dalam rentang 2 menit
  const nowMs = Date.now();
  const recentDuplicateSJ = (db.surat_jalan || []).find(sj => {
    const sjTime = sj.created_at ? new Date(sj.created_at).getTime() : 0;
    if (!sjTime || Math.abs(nowMs - sjTime) > 2 * 60 * 1000) return false;

    const sameSender = String(sj.sender || '').trim().toLowerCase() === String(sender || '').trim().toLowerCase();
    const sameReceiver = String(sj.receiver || '').trim().toLowerCase() === String(receiver || '').trim().toLowerCase();
    if (!sameSender || !sameReceiver) return false;

    if (!Array.isArray(sj.items) || sj.items.length !== items.length) return false;

    const allItemsMatch = items.every(it => {
      const itName = String(it.name || it.nama || '').trim().toLowerCase();
      const itQty = parseSafeInt(it.qty, 0);
      return sj.items.some(sji => 
        String(sji.name || sji.nama || '').trim().toLowerCase() === itName && 
        parseSafeInt(sji.qty, 0) === itQty
      );
    });

    return allItemsMatch;
  });

  if (recentDuplicateSJ) {
    console.log(`⚡ [IDEMPOTENCY] Mencegah pengiriman obat ganda dari ${sender} ke ${receiver} dalam 2 menit.`);
    return res.status(200).json({
      success: true,
      _isDuplicatePrevented: true,
      message: 'Pengiriman obat sudah berhasil tersimpan sebelumnya. Penambahan stok ganda dicegah.',
      suratJalan: recentDuplicateSJ,
      updated: []
    });
  }

  const updatedMedicines = [];
  const auditLogs = [];
  const noSurat = `SJ-${Date.now()}`;
  const nowIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

  for (const item of items) {
    const itemName = String(item.name || item.nama || '').trim().toLowerCase();
    const itemId = item.id ? String(item.id).trim().toLowerCase() : '';

    const idx = db.medicines.findIndex(m => {
      const mId = String(m.id || '').trim().toLowerCase();
      const mName = String(m.nama || '').trim().toLowerCase();
      return (itemId && mId === itemId) || (itemName && mName === itemName);
    });

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
        satuan: oldMed.satuan || item.satuan || 'tab',
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
    } else {
      const qtySent = parseSafeInt(item.qty, 0);
      auditLogs.push(`• ${item.name || item.nama || 'Obat'}: (+${qtySent} ${item.satuan || 'strip'})`);
    }
  }

  // Save Surat Jalan to database ALWAYS
  const newSuratJalan = {
    id: 'SJ-' + Date.now(),
    noSurat: noSurat,
    tanggal: nowIndo,
    created_at: new Date().toISOString(),
    sender: sender || 'Apotek Nafila',
    receiver: receiver || 'Perawat PT ATI',
    items: items.map(item => {
      const itemName = String(item.name || item.nama || '').trim().toLowerCase();
      const itemId = item.id ? String(item.id).trim().toLowerCase() : '';
      const matched = db.medicines.find(m => {
        const mId = String(m.id || '').trim().toLowerCase();
        const mName = String(m.nama || '').trim().toLowerCase();
        return (itemId && mId === itemId) || (itemName && mName === itemName);
      });

      const qty = parseSafeInt(item.qty, 0);
      const initial = item.initial !== undefined ? parseSafeInt(item.initial, 0) : (matched ? (matched.stok - qty) : 0);
      const final = item.final !== undefined ? parseSafeInt(item.final, 0) : (matched ? matched.stok : qty);

      return {
        id: item.id || (matched ? matched.id : ('MED-TEMP-' + Date.now())),
        name: item.name || item.nama || (matched ? matched.nama : 'Obat'),
        qty: qty,
        initial: initial,
        final: final,
        satuan: item.satuan || (matched ? matched.satuan : 'strip')
      };
    })
  };

  if (!db.surat_jalan) db.surat_jalan = [];
  db.surat_jalan.unshift(newSuratJalan);

  writeDB(db);
  autoPushMedicinesToGSheet(db);
  notifyClients();

  // Kirim Audit Log ke Telegram Bot (non-blocking)
  try {
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
  } catch (errTele) {
    console.error('Non-blocking telegram notif error:', errTele.message);
  }

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
  if (!db.surat_jalan) return res.json({ success: true, message: 'Tidak ada surat jalan' });

  const targetId = String(req.params.id || '').trim();
  const sjIndex = db.surat_jalan.findIndex(s => s.id === targetId || s.noSurat === targetId);
  if (sjIndex === -1) {
    return res.status(404).json({ success: false, error: 'Surat Jalan tidak ditemukan' });
  }

  const targetSJ = db.surat_jalan[sjIndex];
  const nowIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const noSurat = targetSJ.noSurat || targetSJ.id;
  const deletedBy = req.body?.petugas || req.query?.petugas || 'Petugas Apotek / Gudang';
  const rolledBackItems = [];

  // Rollback medicine stocks added by this Surat Jalan
  if (Array.isArray(targetSJ.items) && db.medicines) {
    targetSJ.items.forEach(item => {
      const itemName = String(item.name || item.nama || '').trim().toLowerCase();
      const itemId = item.id ? String(item.id).trim().toLowerCase() : '';
      const qtySent = parseSafeInt(item.qty || item.jumlah, 0);

      const medIdx = db.medicines.findIndex(m => {
        const mId = String(m.id || '').trim().toLowerCase();
        const mName = String(m.nama || '').trim().toLowerCase();
        return (itemId && mId === itemId) || (itemName && mName === itemName);
      });

      if (medIdx !== -1 && qtySent > 0) {
        const oldMed = { ...db.medicines[medIdx] };
        const prevStok = parseSafeInt(oldMed.stok, 0);
        const nextStok = Math.max(0, prevStok - qtySent);
        db.medicines[medIdx].stok = nextStok;

        logStockMutation(db, {
          tanggal: nowIndo,
          created_at: new Date().toISOString(),
          type: 'OUT',
          namaObat: oldMed.nama,
          satuan: oldMed.satuan || item.satuan || 'tab',
          qty: qtySent,
          delta: -qtySent,
          stokSebelum: prevStok,
          stokSesudah: nextStok,
          refType: 'BATAL_SURAT_JALAN',
          refId: noSurat,
          refDoc: noSurat,
          petugas: deletedBy,
          keterangan: `Pembatalan/Hapus Surat Jalan No: ${noSurat} (-${qtySent} ${oldMed.satuan || 'item'})`
        });

        rolledBackItems.push(`${oldMed.nama} (-${qtySent})`);
      }
    });
  }

  // Remove from database
  db.surat_jalan.splice(sjIndex, 1);
  writeDB(db);
  autoPushMedicinesToGSheet(db);
  notifyClients();

  res.json({ 
    success: true, 
    message: `Surat Jalan ${noSurat} berhasil dibatalkan dan stok dikembalikan!`,
    rolledBack: rolledBackItems 
  });
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

// Bulk Import Employees from Excel / CSV
app.post('/api/employees/bulk-import', (req, res) => {
  const { employees, mode } = req.body; // mode: 'skip' | 'overwrite'
  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ success: false, error: 'Data karyawan tidak ditemukan atau kosong' });
  }

  const db = readDB();
  if (!Array.isArray(db.employees)) db.employees = [];

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  employees.forEach((emp, index) => {
    const rawNik = String(emp.nikPabrik || emp.nik || emp.npk || '').trim();
    const nama = String(emp.nama || emp.namaKaryawan || '').trim();
    if (!rawNik || !nama) {
      skipped++;
      return;
    }

    const cleanNik = rawNik;
    const existingIdx = db.employees.findIndex(e => 
      String(e.nikPabrik || e.nik || '').trim().toLowerCase() === cleanNik.toLowerCase()
    );

    const empRecord = {
      id: existingIdx >= 0 ? db.employees[existingIdx].id : `EMP-${Date.now()}-${index}`,
      no: existingIdx >= 0 ? db.employees[existingIdx].no : String(db.employees.length + 1),
      nikPabrik: cleanNik,
      nik: cleanNik,
      nama: nama,
      dept: String(emp.dept || emp.departemen || 'Umum').trim(),
      departemen: String(emp.dept || emp.departemen || 'Umum').trim(),
      gender: String(emp.gender || emp.jenisKelamin || 'Pria').trim(),
      golDarah: String(emp.golDarah || emp.gol_darah || '-').trim(),
      tglLahir: String(emp.tglLahir || emp.tgl_lahir || '').trim(),
      tgl_lahir: String(emp.tglLahir || emp.tgl_lahir || '').trim(),
      hp: String(emp.hp || emp.noHp || emp.telepon || '').replace(/\D/g, ''),
      no_hp: String(emp.hp || emp.noHp || emp.telepon || '').replace(/\D/g, ''),
      saldoObat: parseInt(String(emp.saldoObat || '10000000').replace(/\./g, '')) || 10000000,
      sectionName: String(emp.sectionName || emp.section || emp.bagian || '').trim(),
      birthPlace: String(emp.birthPlace || emp.tempatLahir || '').trim(),
      alamat: String(emp.alamat || '').trim()
    };

    if (existingIdx >= 0) {
      if (mode === 'overwrite') {
        db.employees[existingIdx] = { ...db.employees[existingIdx], ...empRecord };
        updated++;
      } else {
        skipped++;
      }
    } else {
      db.employees.push(empRecord);
      inserted++;
    }
  });

  writeDB(db);
  res.json({
    success: true,
    total: employees.length,
    inserted,
    updated,
    skipped,
    message: `Berhasil import data karyawan: ${inserted} baru, ${updated} diperbarui, ${skipped} dilewati.`
  });
});

// Reset / Clear Employees (Master PIN Protected)
app.post('/api/employees/reset', (req, res) => {
  const { pin } = req.body;
  const db = readDB();
  const masterPass = db.settings?.gate_password || "231067";
  if (String(pin).trim() !== masterPass) {
    return res.status(401).json({ success: false, error: 'PIN Master Klinik salah!' });
  }

  const prevCount = (db.employees || []).length;
  db.employees = [];
  writeDB(db);
  res.json({ success: true, message: `Seluruh data karyawan (${prevCount} data) berhasil direset.` });
});

// ============================================================
// SURAT SAKIT LUAR (FASKES EKSTERNAL)
// ============================================================

app.get('/api/surat-luar', (req, res) => {
  const db = readDB();
  let list = db.surat_sakit_luar || [];
  const { nik, tglMulai, tglSelesai } = req.query;
  if (nik) {
    const qNik = nik.toLowerCase();
    list = list.filter(s => 
      (s.nikPabrik && s.nikPabrik.toLowerCase().includes(qNik)) || 
      (s.namaPasien && s.namaPasien.toLowerCase().includes(qNik))
    );
  }
  if (tglMulai) {
    list = list.filter(s => (s.tanggalMulai >= tglMulai || s.created_at >= tglMulai));
  }
  if (tglSelesai) {
    list = list.filter(s => (s.tanggalMulai <= tglSelesai || s.created_at <= tglSelesai));
  }
  list.sort((a, b) => new Date(b.created_at || b.tanggalMulai) - new Date(a.created_at || a.tanggalMulai));
  res.json(list);
});

app.post('/api/surat-luar', (req, res) => {
  const db = readDB();
  if (!Array.isArray(db.surat_sakit_luar)) db.surat_sakit_luar = [];

  const nikPabrik = req.body.nikPabrik || req.body.nik;
  const namaPasien = req.body.namaPasien || req.body.nama;
  const dept = req.body.dept || req.body.departemen || '-';
  const namaFaskes = req.body.namaFaskes || req.body.faskesLuar || req.body.faskes || 'RS/Klinik Luar';
  const namaDokterLuar = req.body.namaDokterLuar || '-';
  const tanggalMulai = req.body.tanggalMulai;
  const tanggalSelesai = req.body.tanggalSelesai || req.body.tanggalMulai;
  const durasiHari = parseInt(req.body.durasiHari) || 1;
  const diagnosa = req.body.diagnosa || req.body.diagnosis || '-';
  const linkFoto = req.body.linkFoto || req.body.fotoBukti || (Array.isArray(req.body.fotoList) && req.body.fotoList.length > 0 ? req.body.fotoList[0] : null);
  const fotoList = Array.isArray(req.body.fotoList) ? req.body.fotoList : (linkFoto ? [linkFoto] : []);
  const pemeriksaKlinik = req.body.pemeriksaKlinik || req.body.namaPerawat || 'Petugas Medis';
  const catatan = req.body.catatan || '';

  if (!nikPabrik || !namaPasien || !tanggalMulai) {
    return res.status(400).json({ success: false, error: 'NIK, Nama Pasien, dan Tanggal Mulai Istirahat wajib diisi!' });
  }

  const newSurat = {
    id: 'SSL-' + Date.now(),
    nikPabrik: String(nikPabrik).trim(),
    namaPasien: String(namaPasien).trim(),
    dept: String(dept).trim(),
    namaFaskes: String(namaFaskes).trim(),
    namaDokterLuar: String(namaDokterLuar).trim(),
    tanggalMulai: tanggalMulai,
    tanggalSelesai: tanggalSelesai,
    durasiHari: durasiHari,
    diagnosa: String(diagnosa).trim(),
    linkFoto: linkFoto,
    fotoList: fotoList,
    pemeriksaKlinik: String(pemeriksaKlinik).trim(),
    catatan: String(catatan).trim(),
    created_at: new Date().toISOString()
  };

  db.surat_sakit_luar.unshift(newSurat);
  writeDB(db);
  res.status(201).json({ success: true, data: newSurat, message: 'Surat Sakit Luar berhasil disimpan!' });
});

app.delete('/api/surat-luar/:id', (req, res) => {
  const db = readDB();
  if (!Array.isArray(db.surat_sakit_luar)) return res.status(404).json({ error: 'Data kosong' });
  const prevLen = db.surat_sakit_luar.length;
  db.surat_sakit_luar = db.surat_sakit_luar.filter(s => s.id !== req.params.id);
  if (db.surat_sakit_luar.length === prevLen) {
    return res.status(404).json({ error: 'Surat Sakit Luar tidak ditemukan' });
  }
  writeDB(db);
  res.json({ success: true, message: 'Surat Sakit Luar berhasil dihapus' });
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

// Bulk Import Riwayat Rekam Medis Pasien dari PT Sebelumnya
app.post('/api/records/bulk-import', (req, res) => {
  const db = readDB();
  if (!Array.isArray(db.records)) db.records = [];

  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ success: false, error: 'Daftar riwayat rekam medis tidak boleh kosong.' });
  }

  let added = 0;
  for (const item of records) {
    const namaPasien = String(item.namaPasien || item.nama || '').trim();
    if (!namaPasien) continue;

    const nikPabrik = String(item.nikPabrik || item.npk || item.nik || '-').trim();
    const dept = String(item.dept || item.departemen || '-').trim();
    const tanggal = String(item.tanggal || item.tanggalBerobat || new Date().toLocaleDateString('id-ID')).trim();
    const keluhan = String(item.keluhan || item.keluhanSubjektif || '-').trim();
    const objektif = String(item.objektif || item.pemeriksaanFisik || '-').trim();
    const asesmen = String(item.asesmen || item.diagnosa || '-').trim();
    const plan = String(item.plan || item.terapi || item.resep || '-').trim();
    const pemeriksa = String(item.pemeriksa || item.dokter || 'Dokter/Perawat').trim();

    db.records.unshift({
      id: 'REC-' + (Date.now() + Math.floor(Math.random() * 10000)),
      nikPabrik,
      namaPasien,
      dept,
      noHp: String(item.noHp || item.hp || '').trim(),
      tanggal,
      created_at: item.created_at || new Date().toISOString(),
      keluhan,
      objektif,
      asesmen,
      plan,
      tindakan: [],
      biayaTindakan: 0,
      resep: [],
      biayaObat: 0,
      totalBiaya: 0,
      pemeriksa,
      izinSakit: Boolean(item.izinSakit),
      isPantauan: Boolean(item.isPantauan),
      linkFoto: ''
    });
    added++;
  }

  writeDB(db);
  res.json({
    success: true,
    message: `Berhasil mengimpor ${added} riwayat rekam medis pasien.`,
    totalRecords: db.records.length,
    records: db.records
  });
});

// Reset Riwayat Rekam Medis (PIN: 231067)
app.post('/api/records/reset', (req, res) => {
  const { pin } = req.body;
  const MASTER_PIN = '231067';
  if (pin !== MASTER_PIN) {
    return res.status(401).json({ success: false, error: 'Kunci Master PIN Salah!' });
  }

  const db = readDB();
  db.records = [];
  writeDB(db);
  res.json({ success: true, message: 'Seluruh riwayat rekam medis berhasil dikosongkan!' });
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
    if (rTime <= 0 || Math.abs(nowMs - rTime) > DUPLICATE_WINDOW_MS) return false;

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
  if (!newRecord.jam) {
    const nowWIB = new Date();
    newRecord.jam = nowWIB.toLocaleTimeString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' });
  }
  
  // 2. Auto-Deduct Stock from resep list & Log Mutation
  const logObatTeks = [];
  if (Array.isArray(newRecord.resep)) {
    if (!db.medicines) db.medicines = [];
    newRecord.resep.forEach(item => {
      const namaObat = item.namaObat || item.obat || '';
      const qty = parseSafeInt(item.qty || item.jumlah, 1);
      if (namaObat) {
        const med = findMedicineInDb(db.medicines, namaObat, item.id);
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
  const empList = db.employees || db.patients || [];
  if (grandTotalBiaya > 0 && Array.isArray(empList)) {
    const pIdx = empList.findIndex(p => 
      (p.nikPabrik && newRecord.nikPabrik && String(p.nikPabrik).toLowerCase() === String(newRecord.nikPabrik).toLowerCase()) ||
      (p.nama && newRecord.namaPasien && p.nama.toLowerCase() === newRecord.namaPasien.toLowerCase())
    );
    if (pIdx !== -1) {
      const oldSaldo = parseInt(empList[pIdx].saldoObat) || 0;
      empList[pIdx].saldoObat = oldSaldo - grandTotalBiaya;
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

  // 4b. Auto-Integrasi Jadwal Kontrol Pasien (Berdasarkan NIK/NPK dari Poli)
  if (newRecord.tanggalKontrol) {
    try {
      let kontrolList = loadKontrolPasien();
      const cleanTgl = String(newRecord.tanggalKontrol).trim();
      if (cleanTgl) {
        let targetHp = newRecord.noHp || '';
        if (!targetHp && Array.isArray(empList)) {
          const emp = empList.find(p => 
            (p.nikPabrik && newRecord.nikPabrik && String(p.nikPabrik).toLowerCase() === String(newRecord.nikPabrik).toLowerCase()) ||
            (p.nama && newRecord.namaPasien && p.nama.toLowerCase() === newRecord.namaPasien.toLowerCase())
          );
          if (emp) targetHp = emp.hp || emp.noHp || emp.telepon || '';
        }

        const rawNotes = newRecord.catatanKontrol || (newRecord.izinSakit ? 'Evaluasi Akhir Istirahat Sakit (Surkes)' : (newRecord.isPantauan ? 'Evaluasi Berkala Pasien Pantauan K3' : 'Kontrol Lanjutan Pengobatan'));
        const rawDiag = newRecord.asesmen || 'Pemeriksaan Umum';
        const rawDept = newRecord.dept || '-';
        const rawNik = newRecord.nikPabrik || '';

        const ktrItem = {
          id: 'KTR-' + Date.now(),
          recordId: newRecord.id,
          nikPabrik: rawNik,
          npkPabrik: rawNik,
          namaPasien: newRecord.namaPasien || '',
          dept: rawDept,
          departemen: rawDept,
          noHp: targetHp,
          noHpPasien: targetHp,
          tanggalPeriksa: newRecord.tanggal || new Date().toLocaleDateString('id-ID'),
          tanggalKontrol: cleanTgl,
          catatanKontrol: rawNotes,
          catatan: rawNotes,
          asesmen: rawDiag,
          diagnosa: rawDiag,
          isIzinSakit: !!newRecord.izinSakit,
          isPantauan: !!newRecord.isPantauan,
          pemeriksa: newRecord.pemeriksa || 'Petugas Medis',
          status: 'MENUNGGU',
          created_at: new Date().toISOString()
        };

        const existIdx = kontrolList.findIndex(k => 
          k.status === 'MENUNGGU' && (
            (k.nikPabrik && newRecord.nikPabrik && k.nikPabrik === newRecord.nikPabrik) ||
            (k.namaPasien && newRecord.namaPasien && k.namaPasien.toLowerCase() === newRecord.namaPasien.toLowerCase())
          )
        );
        if (existIdx !== -1) {
          kontrolList[existIdx] = { ...kontrolList[existIdx], ...ktrItem, id: kontrolList[existIdx].id };
        } else {
          kontrolList.unshift(ktrItem);
        }
        saveKontrolPasien(kontrolList);
      }
    } catch (ktrErr) {
      console.error('Error auto-creating jadwal kontrol:', ktrErr);
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
        const med = findMedicineInDb(db.medicines, namaObat, item.id);
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
        const med = findMedicineInDb(db.medicines, name);
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
        const med = findMedicineInDb(db.medicines, namaObat, item.id);
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

  // 3. Update Saldo Obat Pasien Secara Atomik (Termasuk jika Karyawan Diganti)
  const oldTotalBiaya = Number(oldRecord.totalBiaya || 0);
  const newTotalBiaya = Number(updatedData.totalBiaya !== undefined ? updatedData.totalBiaya : oldTotalBiaya);

  if (Array.isArray(db.patients)) {
    const oldNik = String(oldRecord.nikPabrik || '').trim();
    const oldNama = String(oldRecord.namaPasien || '').trim().toLowerCase();
    const newNik = String(updatedData.nikPabrik || oldRecord.nikPabrik || '').trim();
    const newNama = String(updatedData.namaPasien || oldRecord.namaPasien || '').trim().toLowerCase();

    const isSamePatient = (oldNik && newNik && oldNik === newNik) || (oldNama && newNama && oldNama === newNama);

    if (isSamePatient) {
      // Pasien sama: sesuaikan selisih biaya
      const delta = oldTotalBiaya - newTotalBiaya;
      if (delta !== 0) {
        const pIdx = db.patients.findIndex(p => 
          (newNik && (p.nikPabrik === newNik || p.nik === newNik)) ||
          (newNama && p.nama && p.nama.toLowerCase() === newNama)
        );
        if (pIdx !== -1) {
          db.patients[pIdx].saldoObat = (parseInt(db.patients[pIdx].saldoObat) || 0) + delta;
        }
      }
    } else {
      // Pasien BERBEDA (karena koreksi salah pilih karyawan saat berobat):
      // 1) Kembalikan biaya lama ke pasien yang lama
      if (oldTotalBiaya > 0) {
        const oldPIdx = db.patients.findIndex(p => 
          (oldNik && (p.nikPabrik === oldNik || p.nik === oldNik)) ||
          (oldNama && p.nama && p.nama.toLowerCase() === oldNama)
        );
        if (oldPIdx !== -1) {
          db.patients[oldPIdx].saldoObat = (parseInt(db.patients[oldPIdx].saldoObat) || 0) + oldTotalBiaya;
        }
      }
      // 2) Potong biaya baru dari pasien yang baru
      if (newTotalBiaya > 0) {
        const newPIdx = db.patients.findIndex(p => 
          (newNik && (p.nikPabrik === newNik || p.nik === newNik)) ||
          (newNama && p.nama && p.nama.toLowerCase() === newNama)
        );
        if (newPIdx !== -1) {
          db.patients[newPIdx].saldoObat = (parseInt(db.patients[newPIdx].saldoObat) || 0) - newTotalBiaya;
        }
      }
    }
  }

  // 4. Update status Pantauan K3 jika ada perubahan
  if (updatedData.isPantauan !== undefined) {
    if (!db.pantauan) db.pantauan = [];
    const targetNik = updatedData.nikPabrik || oldRecord.nikPabrik;
    const targetNama = updatedData.namaPasien || oldRecord.namaPasien;
    const pIdx = db.pantauan.findIndex(p => 
      (p.nikPabrik && p.nikPabrik === targetNik) ||
      (p.namaPasien && p.namaPasien.toLowerCase() === targetNama.toLowerCase())
    );

    if (updatedData.isPantauan) {
      const item = {
        id: pIdx !== -1 ? db.pantauan[pIdx].id : ('PP-' + Date.now()),
        nikPabrik: targetNik || '',
        namaPasien: targetNama || '',
        dept: updatedData.dept || oldRecord.dept || '-',
        keluhan: updatedData.keluhan || oldRecord.keluhan || '-',
        asesmen: updatedData.asesmen || oldRecord.asesmen || '-',
        status: 'AKTIF',
        tanggal: updatedData.tanggal || oldRecord.tanggal || new Date().toLocaleDateString('id-ID')
      };
      if (pIdx !== -1) {
        db.pantauan[pIdx] = item;
      } else {
        db.pantauan.unshift(item);
      }
    }
  }

  db.records[idx] = { ...oldRecord, ...updatedData };
  writeDB(db);
  autoPushMedicinesToGSheet(db);
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
        const med = findMedicineInDb(db.medicines, namaObat, item.id);
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
        const med = findMedicineInDb(db.medicines, name);
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
// SHIFT REPORTS (WHATSAPP WEB - SISTEM MARUNDA)
// ============================================================

app.post('/api/shift/format1', async (req, res) => {
  const { tglMulai, tglSelesai, jamMulai, jamSelesai, dari, ke, targetWa, targetPhone } = req.body;
  const db = readDB();
  const records = db.records || [];
  const suratLuar = db.surat_sakit_luar || [];
  const kontrolList = loadKontrolPasien();
  const namaKlinik = db.settings?.nama_klinik || 'Klinik PT ATI & Nafila Medika';
  
  const start = new Date(`${tglMulai}T${jamMulai || '00:00'}:00`);
  const end = new Date(`${tglSelesai}T${jamSelesai || '23:59'}:59`);
  
  const filtered = records.filter(r => {
    const d = new Date(r.created_at || r.tanggal);
    return d >= start && d <= end;
  });

  const suratLuarFiltered = suratLuar.filter(s => {
    const d = new Date(s.created_at || s.tanggalMulai);
    return d >= start && d <= end;
  });

  const totalSurkes = filtered.filter(r => r.izinSakit === true).length;
  const rujukanCount = filtered.filter(r => r.rujukan === true || (r.resep && r.resep.some(o => o.nama && o.nama.toLowerCase().includes('rujuk')))).length;
  const observasiCount = filtered.filter(r => r.observasi === true || (r.diagnosa && r.diagnosa.toLowerCase().includes('observasi'))).length;

  let msg = 
    `*📋 LAPORAN OPER SHIFT KLINIK*\n` +
    `*🏥 ${namaKlinik.toUpperCase()}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 *Periode :* ${tglMulai} s/d ${tglSelesai}\n` +
    `⏰ *Waktu   :* ${jamMulai || '07:00'} - ${jamSelesai || '14:00'}\n` +
    `👥 *Serah Terima :* ${dari || 'Petugas Shift 1'} ➜ ${ke || 'Petugas Shift 2'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*📊 RINGKASAN PELAYANAN:*\n` +
    `• Total Pasien Berobat : *${filtered.length} Pasien*\n` +
    `• Surat Sakit Internal (Surkes) : *${totalSurkes} Pasien*\n` +
    `• Surat Sakit Luar Diterima : *${suratLuarFiltered.length} Berkas*\n` +
    `• Pasien Rujukan : *${rujukanCount} Pasien*\n` +
    `• Pasien Observasi : *${observasiCount} Pasien*\n\n`;

  if (filtered.length > 0) {
    msg += `*📝 RINCIAN PASIEN BEROBAT:*\n`;
    filtered.slice(0, 15).forEach((r, idx) => {
      const obat = (r.resep || []).map(o => o.nama).join(', ') || '-';
      msg += `${idx + 1}. *${r.namaPasien || '-'}* (${r.dept || '-'}) - _${r.asesmen || r.diagnosa || '-'}_ [${obat}]\n`;
    });
    if (filtered.length > 15) {
      msg += `_...dan ${filtered.length - 15} pasien lainnya_\n`;
    }
    msg += `\n`;
  } else {
    msg += `*📝 RINCIAN PASIEN:* Tidak ada kunjungan dalam shift ini.\n\n`;
  }

  if (suratLuarFiltered.length > 0) {
    msg += `*📑 SURAT SAKIT LUAR MASUK:*\n`;
    suratLuarFiltered.forEach((s, idx) => {
      msg += `• *${s.namaPasien}* (${s.dept}) - ${s.namaFaskes} (${s.durasiHari} Hari) [_${s.diagnosa}_]\n`;
    });
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━\n` +
    `_Laporan otomatis sistem rekam medis Nafila Medika_ 🩺`;

  // Resolusi nomor tujuan WA
  let destWa = String(targetWa || targetPhone || '').trim();
  if (!destWa) {
    const loggedUser = (db.users || []).find(u => u.nama === dari || u.username === dari);
    if (loggedUser && loggedUser.noWa) destWa = loggedUser.noWa;
  }
  if (!destWa && db.settings?.wa_contacts?.length > 0) {
    destWa = db.settings.wa_contacts[0].hp;
  }

  let waResult = { success: false };
  if (destWa) {
    try {
      waResult = await whatsappService.sendWhatsAppMessage('klinik', destWa, msg);
    } catch (e) {
      console.error('[Shift 1] WA send error:', e.message);
    }
  }

  // Telegram fallback jika ada konfigurasi
  try { sendTelegramNotif(msg.replace(/\*/g, '<b>').replace(/\_/g, '<i>')); } catch (e) {}

  res.json({
    success: true,
    destWa: destWa,
    waResult: waResult,
    message: destWa 
      ? `Laporan Oper Shift berhasil dikirim via WhatsApp ke ${destWa}!`
      : 'Laporan Oper Shift dibuat (Nomor WhatsApp petugas belum diset).'
  });
});

app.post('/api/shift/format2', async (req, res) => {
  const { tglMulai, tglSelesai, petugas1, petugas2, petugas3, targetWa, targetPhone } = req.body;
  const db = readDB();
  const records = db.records || [];
  const suratLuar = db.surat_sakit_luar || [];
  const kontrolList = loadKontrolPasien();
  const namaKlinik = db.settings?.nama_klinik || 'Klinik PT ATI & Nafila Medika';
  
  const start = new Date(`${tglMulai}T00:00:00`);
  const end = new Date(`${tglSelesai}T23:59:59`);
  
  const deptMap = {};
  let total = 0;
  let totalSurkes = 0;
  records.forEach(r => {
    const d = new Date(r.created_at || r.tanggal);
    if (d >= start && d <= end) {
      const dept = r.dept || 'Lain-lain';
      deptMap[dept] = (deptMap[dept] || 0) + 1;
      total++;
      if (r.izinSakit === true) totalSurkes++;
    }
  });

  const totalSuratLuar = suratLuar.filter(s => {
    const d = new Date(s.created_at || s.tanggalMulai);
    return d >= start && d <= end;
  }).length;

  const totalKontrol = kontrolList.filter(k => {
    const d = new Date(k.tanggalRencana || k.created_at);
    return d >= start && d <= end;
  }).length;

  const deptDetail = Object.keys(deptMap).map(d => `  • ${d} : *${deptMap[d]} Pasien*`).join('\n');

  const msg = 
    `*🌅 LAPORAN REKAPITULASI PELAYANAN 24 JAM*\n` +
    `*🏥 ${namaKlinik.toUpperCase()}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 *Periode :* ${tglMulai} s/d ${tglSelesai}\n` +
    `👨‍⚕️ *Petugas Jaga:*\n` +
    `  ☀️ Shift 1 : ${petugas1 || '-'}\n` +
    `  🌇 Shift 2 : ${petugas2 || '-'}\n` +
    `  🌙 Shift 3 : ${petugas3 || '-'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*📊 KUNJUNGAN PER DEPARTEMEN:*\n` +
    (deptDetail || '  • Tidak ada kunjungan\n') + `\n` +
    `*📈 TOTAL REKAPITULASI 24 JAM:*\n` +
    `• Total Kunjungan Poli : *${total} Pasien*\n` +
    `• Surat Sakit Internal (Surkes) : *${totalSurkes} Kasus*\n` +
    `• Surat Sakit Luar : *${totalSuratLuar} Berkas*\n` +
    `• Pasien Perlu Kontrol : *${totalKontrol} Pasien*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `_Tetap utamakan Keselamatan dan Kesehatan Kerja! ⛑️_`;

  // Resolusi nomor tujuan WA
  let destWa = String(targetWa || targetPhone || '').trim();
  if (!destWa && db.settings?.wa_contacts?.length > 0) {
    destWa = db.settings.wa_contacts[0].hp;
  }

  let waResult = { success: false };
  if (destWa) {
    try {
      waResult = await whatsappService.sendWhatsAppMessage('klinik', destWa, msg);
    } catch (e) {
      console.error('[Shift 2] WA send error:', e.message);
    }
  }

  // Telegram fallback jika ada konfigurasi
  try { sendTelegramNotif(msg.replace(/\*/g, '<b>').replace(/\_/g, '<i>')); } catch (e) {}

  res.json({
    success: true,
    destWa: destWa,
    waResult: waResult,
    message: destWa 
      ? `Rekap 24H berhasil dikirim via WhatsApp ke ${destWa}!`
      : 'Rekap 24H dibuat (Nomor WhatsApp petugas belum diset).'
  });
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
  if (!db.settings) db.settings = {};
  if (!db.settings.nama_pt) db.settings.nama_pt = 'PT ATI';
  if (!db.settings.nama_klinik) db.settings.nama_klinik = 'Mobile Klinik System';
  if (!db.settings.sub_title) db.settings.sub_title = 'Klinik Nafila Medika & ' + (db.settings.nama_pt || 'PT ATI');
  if (!db.settings.logo_pt) db.settings.logo_pt = 'ATI Logo.png';
  if (!db.settings.logo_nafila) db.settings.logo_nafila = 'Salinan Logo nafila.webp';
  res.json(db.settings);
});

app.post('/api/settings', (req, res) => {
  const db = readDB();
  if (!db.settings) db.settings = {};
  db.settings = { ...db.settings, ...req.body };
  writeDB(db);
  res.json({ success: true, settings: db.settings });
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

// ============================================================
// BATCH OFFLINE SYNC (SOLUSI SINYAL FLAKY / PUTUS-NYAMBUNG DI PABRIK)
// ============================================================
app.post('/api/records/offline-sync', (req, res) => {
  const db = readDB();
  const incomingRecords = req.body.records;

  if (!Array.isArray(incomingRecords) || incomingRecords.length === 0) {
    return res.status(400).json({ error: 'Tidak ada data antrean offline yang dikirim' });
  }

  if (!db.records) db.records = [];
  if (!db.medicines) db.medicines = [];
  const empList = db.employees || db.patients || [];
  let kontrolList = loadKontrolPasien();

  let processedCount = 0;
  let skippedDuplicates = 0;
  const syncedRecords = [];

  incomingRecords.forEach(rec => {
    if (!rec || !rec.namaPasien) return;

    // Idempotency / Duplicate Check
    const recId = rec.id || '';
    const existById = recId ? db.records.find(r => r.id === recId) : null;
    if (existById) {
      skippedDuplicates++;
      syncedRecords.push(existById);
      return;
    }

    const recTime = rec.created_at ? new Date(rec.created_at).getTime() : 0;
    const existByPatient = db.records.find(r => {
      const rTime = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (recTime && rTime && Math.abs(recTime - rTime) < 3 * 60 * 1000) {
        const isSame = (rec.nikPabrik && r.nikPabrik === rec.nikPabrik) ||
                       (rec.namaPasien && r.namaPasien.toLowerCase() === rec.namaPasien.toLowerCase());
        return isSame && (r.keluhan === rec.keluhan || r.asesmen === rec.asesmen);
      }
      return false;
    });

    if (existByPatient) {
      skippedDuplicates++;
      syncedRecords.push(existByPatient);
      return;
    }

    const recordToSave = {
      ...rec,
      id: rec.id || ('REC-' + Date.now() + '-' + Math.floor(Math.random() * 1000)),
      created_at: rec.created_at || new Date().toISOString(),
      synced_at: new Date().toISOString()
    };

    // 1. Potong stok obat
    if (Array.isArray(recordToSave.resep)) {
      recordToSave.resep.forEach(item => {
        const namaObat = item.namaObat || item.obat || '';
        const qty = parseSafeInt(item.qty || item.jumlah, 1);
        if (namaObat) {
          const med = findMedicineInDb(db.medicines, namaObat, item.id);
          if (med) {
            const prevStok = parseSafeInt(med.stok, 0);
            const nextStok = Math.max(0, prevStok - qty);
            med.stok = nextStok;
            logStockMutation(db, {
              tanggal: recordToSave.tanggal,
              created_at: recordToSave.created_at,
              type: 'OUT',
              namaObat: med.nama,
              satuan: med.satuan || 'tab',
              qty: qty,
              delta: -qty,
              stokSebelum: prevStok,
              stokSesudah: nextStok,
              refType: 'RESEP_POLI_OFFLINE',
              refId: recordToSave.id,
              refDoc: 'Kunjungan Offline Sync',
              pasien: recordToSave.namaPasien || '',
              nik: recordToSave.nikPabrik || '',
              petugas: recordToSave.pemeriksa || 'Petugas Medis',
              keterangan: `Sync Offline: ${recordToSave.namaPasien || ''} (${recordToSave.asesmen || 'Pemeriksaan'})`
            });
          }
        }
      });
    }

    // 2. Potong Saldo Obat Pasien
    const grandTotalBiaya = Number(recordToSave.totalBiaya || 0);
    if (grandTotalBiaya > 0 && Array.isArray(empList)) {
      const pIdx = empList.findIndex(p => 
        (p.nikPabrik && recordToSave.nikPabrik && String(p.nikPabrik).toLowerCase() === String(recordToSave.nikPabrik).toLowerCase()) ||
        (p.nama && recordToSave.namaPasien && p.nama.toLowerCase() === recordToSave.namaPasien.toLowerCase())
      );
      if (pIdx !== -1) {
        const oldSaldo = parseInt(empList[pIdx].saldoObat) || 0;
        empList[pIdx].saldoObat = oldSaldo - grandTotalBiaya;
      }
    }

    // 3. Mark as pantauan if flagged
    if (recordToSave.isPantauan) {
      if (!db.pantauan) db.pantauan = [];
      const existIdx = db.pantauan.findIndex(p => 
        (p.nikPabrik && p.nikPabrik === recordToSave.nikPabrik) || 
        (p.namaPasien && p.namaPasien.toLowerCase() === recordToSave.namaPasien.toLowerCase())
      );
      const pantauanItem = {
        id: existIdx !== -1 ? db.pantauan[existIdx].id : ('PP-' + Date.now()),
        nikPabrik: recordToSave.nikPabrik,
        namaPasien: recordToSave.namaPasien,
        dept: recordToSave.dept || '-',
        keluhan: recordToSave.keluhan,
        asesmen: recordToSave.asesmen,
        status: 'AKTIF',
        tanggal: recordToSave.tanggal || new Date().toLocaleDateString('id-ID')
      };
      if (existIdx !== -1) {
        db.pantauan[existIdx] = pantauanItem;
      } else {
        db.pantauan.unshift(pantauanItem);
      }
    }

    // 4. Jadwal Kontrol auto-integrasi
    if (recordToSave.tanggalKontrol) {
      const cleanTgl = String(recordToSave.tanggalKontrol).trim();
      if (cleanTgl) {
        let targetHp = recordToSave.noHp || '';
        if (!targetHp && Array.isArray(empList)) {
          const emp = empList.find(p => 
            (p.nikPabrik && recordToSave.nikPabrik && String(p.nikPabrik).toLowerCase() === String(recordToSave.nikPabrik).toLowerCase()) ||
            (p.nama && recordToSave.namaPasien && p.nama.toLowerCase() === recordToSave.namaPasien.toLowerCase())
          );
          if (emp) targetHp = emp.hp || emp.noHp || emp.telepon || '';
        }

        const ktrItem = {
          id: 'KTR-' + Date.now() + '-' + Math.floor(Math.random() * 100),
          recordId: recordToSave.id,
          nikPabrik: recordToSave.nikPabrik || '',
          namaPasien: recordToSave.namaPasien || '',
          dept: recordToSave.dept || '-',
          noHp: targetHp,
          tanggalPeriksa: recordToSave.tanggal || new Date().toLocaleDateString('id-ID'),
          tanggalKontrol: cleanTgl,
          catatanKontrol: recordToSave.catatanKontrol || (recordToSave.izinSakit ? 'Evaluasi Akhir Istirahat Sakit (Surkes)' : (recordToSave.isPantauan ? 'Evaluasi Berkala Pasien Pantauan K3' : 'Kontrol Lanjutan Pengobatan')),
          asesmen: recordToSave.asesmen || 'Pemeriksaan Umum',
          isIzinSakit: !!recordToSave.izinSakit,
          isPantauan: !!recordToSave.isPantauan,
          pemeriksa: recordToSave.pemeriksa || 'Petugas Medis',
          status: 'MENUNGGU',
          created_at: new Date().toISOString()
        };

        const existKtr = kontrolList.findIndex(k => 
          k.status === 'MENUNGGU' && (
            (k.nikPabrik && recordToSave.nikPabrik && k.nikPabrik === recordToSave.nikPabrik) ||
            (k.namaPasien && recordToSave.namaPasien && k.namaPasien.toLowerCase() === recordToSave.namaPasien.toLowerCase())
          )
        );
        if (existKtr !== -1) {
          kontrolList[existKtr] = { ...kontrolList[existKtr], ...ktrItem, id: kontrolList[existKtr].id };
        } else {
          kontrolList.unshift(ktrItem);
        }
      }
    }

    db.records.unshift(recordToSave);
    syncedRecords.push(recordToSave);
    processedCount++;
  });

  saveKontrolPasien(kontrolList);
  writeDB(db);

  console.log(`📡 [OFFLINE SYNC] Sukses memproses ${processedCount} data antrean offline (${skippedDuplicates} duplikat dicegah).`);
  res.json({
    success: true,
    processedCount,
    skippedDuplicates,
    total: incomingRecords.length,
    syncedRecords
  });
});

// ============================================================
// WHATSAPP WEB ENGINE ENDPOINTS (BAILEYS MULTI-DEVICE)
// ============================================================

app.get('/api/wa/sessions', (req, res) => {
  const result = {};
  Object.keys(whatsappService.sessions).forEach(k => {
    const s = whatsappService.sessions[k];
    result[k] = {
      id: s.id,
      deviceName: s.deviceName,
      number: s.number,
      status: s.status,
      battery: s.battery,
      qrDataUrl: s.qrDataUrl,
      lastSync: s.lastSync
    };
  });
  res.json(result);
});

app.get('/api/wa/qr', (req, res) => {
  const sessionType = req.query.sessionType || req.query.sessionName || 'klinik';
  const s = whatsappService.sessions[sessionType] || {};
  res.json({
    success: true,
    isConnected: s.status === 'CONNECTED',
    sessionName: sessionType,
    phone: s.number,
    qr: s.qrDataUrl,
    status: s.status
  });
});

app.post('/api/wa/qr', async (req, res) => {
  const sessionType = req.body.sessionType || req.body.sessionName || 'klinik';
  const s = whatsappService.sessions[sessionType] || {};

  // 1. Jika sudah connected, kirim status connected langsung
  if (s.status === 'CONNECTED') {
    return res.json({
      success: true,
      isConnected: true,
      sessionName: sessionType,
      phone: s.number
    });
  }

  // 2. Jika QR data URL sudah ada di memori, kirim seketika (instant, tanpa delay)!
  if (s.qrDataUrl) {
    return res.json({
      success: true,
      isConnected: false,
      sessionName: sessionType,
      qr: s.qrDataUrl
    });
  }

  // 3. Jika belum ada atau socket mati, inisialisasi session
  try {
    if (!s.sock || s.status === 'DISCONNECTED') {
      whatsappService.initSession(sessionType).catch(e => console.warn('Init WA session err:', e));
    }

    // Tunggu maksimal 4 detik sampai QR di-generate Baileys
    let waited = 0;
    while (waited < 4000 && !s.qrDataUrl && s.status !== 'CONNECTED') {
      await new Promise(r => setTimeout(r, 250));
      waited += 250;
    }

    res.json({
      success: true,
      isConnected: s.status === 'CONNECTED',
      sessionName: sessionType,
      phone: s.number,
      qr: s.qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/wa/chats', (req, res) => {
  const sessionType = req.query.sessionType || 'klinik';
  const chats = chatSessions.filter(c => !sessionType || c.sessionType === sessionType);
  res.json(chats);
});

app.post('/api/wa/send', async (req, res) => {
  const { sessionType = 'klinik', targetPhone, text, mediaBase64, mediaType, fileName } = req.body;
  if (!targetPhone || (!text && !mediaBase64)) {
    return res.status(400).json({ error: 'Nomor tujuan dan isi pesan / lampiran wajib diisi.' });
  }

  let options = {};
  let mediaUrl = null;
  if (mediaBase64) {
    try {
      const buffer = Buffer.from(mediaBase64.replace(/^data:.*?;base64,/, ''), 'base64');
      const cleanFileName = `out_${Date.now()}_${(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, cleanFileName), buffer);
      mediaUrl = `/uploads/${cleanFileName}`;
      options = {
        mediaBuffer: buffer,
        mediaType: mediaType || 'document',
        fileName: fileName || cleanFileName,
        mimetype: mediaType === 'image' ? 'image/jpeg' : 'application/pdf'
      };
    } catch (bErr) {
      console.error('Error saving media attachment:', bErr);
    }
  }

  const result = await whatsappService.sendWhatsAppMessage(sessionType, targetPhone, text, options);

  let formattedPhone = targetPhone.replace(/[^0-9]/g, '');
  if (formattedPhone.startsWith('62')) formattedPhone = '0' + formattedPhone.slice(2);

  const cleanDigits = (targetPhone || '').replace(/\D/g, '');
  const suffix8 = cleanDigits.length >= 8 ? cleanDigits.slice(-8) : cleanDigits;

  let session = chatSessions.find(s => {
    if (s.sessionType !== sessionType) return false;
    const sDigits = (s.patientPhone || '').replace(/\D/g, '');
    return (suffix8 && sDigits.endsWith(suffix8)) || s.patientPhone === formattedPhone || s.patientPhone === targetPhone;
  });

  const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

  const newMsg = {
    messageId: result.id || ('MSG-' + Date.now()),
    sender: 'staff',
    staffName: 'Petugas Medis',
    text: text || (mediaType === 'image' ? '[Foto]' : '[Dokumen]'),
    mediaUrl: mediaUrl,
    mediaType: mediaType || null,
    fileName: fileName || null,
    timestamp: timestamp,
    rawTime: Date.now()
  };

  if (!session) {
    session = {
      id: 'CHAT-' + Date.now(),
      patientId: 'PAS-' + Date.now().toString().slice(-4),
      patientName: req.body.patientName || ('Pasien ' + formattedPhone.slice(-4)),
      patientPhone: formattedPhone,
      sessionType: sessionType,
      updatedAt: Date.now(),
      unreadCount: 0,
      messages: [newMsg]
    };
    chatSessions.unshift(session);
  } else {
    session.updatedAt = Date.now();
    session.messages.push(newMsg);
    const sIdx = chatSessions.indexOf(session);
    if (sIdx > 0) {
      chatSessions.splice(sIdx, 1);
      chatSessions.unshift(session);
    }
  }

  saveChatSessions(chatSessions);

  io.emit('wa_new_message', {
    chatId: session.id,
    sessionType: sessionType,
    message: newMsg,
    chatSession: session
  });

  res.json({ success: true, result, message: newMsg, chatSession: session });
});

app.post('/api/wa/disconnect', async (req, res) => {
  const sessionType = req.body.sessionType || 'klinik';
  try {
    await whatsappService.logoutSession(sessionType);
    res.json({ success: true, message: `Sesi ${sessionType} berhasil diputuskan.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/wa/read', (req, res) => {
  const { chatId } = req.body;
  const session = chatSessions.find(s => s.id === chatId);
  if (session) {
    session.unreadCount = 0;
    saveChatSessions(chatSessions);
  }
  res.json({ success: true });
});

// ============================================================
// JADWAL KONTROL PASIEN ENDPOINTS (TERINTEGRASI POLI & DHSE)
// ============================================================

app.get('/api/kontrol', (req, res) => {
  const list = loadKontrolPasien();
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  let hariIniCount = 0;
  let besokCount = 0;
  let mendatangCount = 0;
  let izinSakitCount = 0;
  let pantauanCount = 0;

  list.forEach(k => {
    const tgl = k.tanggalKontrol || '';
    if (k.status === 'MENUNGGU') {
      if (tgl === todayStr) hariIniCount++;
      else if (tgl === tomorrowStr) besokCount++;
      else if (tgl > todayStr) mendatangCount++;
    }
    if (k.isIzinSakit) izinSakitCount++;
    if (k.isPantauan) pantauanCount++;
  });

  // Urutkan jadwal: Yang MENUNGGU lebih dulu, lalu terdekat berdasarkan tanggal
  list.sort((a, b) => {
    if (a.status === 'MENUNGGU' && b.status !== 'MENUNGGU') return -1;
    if (a.status !== 'MENUNGGU' && b.status === 'MENUNGGU') return 1;
    return (a.tanggalKontrol || '').localeCompare(b.tanggalKontrol || '');
  });

  res.json({
    list,
    stats: {
      hariIni: hariIniCount,
      besok: besokCount,
      mendatang: mendatangCount,
      totalMendatang: hariIniCount + besokCount + mendatangCount,
      izinSakit: izinSakitCount,
      pantauan: pantauanCount,
      totalSemua: list.length
    }
  });
});

app.post('/api/kontrol', (req, res) => {
  const nikVal = req.body.nikPabrik || req.body.npkPabrik || '';
  const namaVal = req.body.namaPasien || '';
  const deptVal = req.body.dept || req.body.departemen || '-';
  const hpVal = req.body.noHp || req.body.noHpPasien || '';
  const tglVal = req.body.tanggalKontrol || '';
  const notesVal = req.body.catatanKontrol || req.body.catatan || 'Kontrol rutin pengobatan';
  const diagVal = req.body.asesmen || req.body.diagnosa || 'Pemeriksaan Umum';

  if (!namaVal || !tglVal) {
    return res.status(400).json({ error: 'Nama pasien dan tanggal kontrol wajib diisi.' });
  }

  const list = loadKontrolPasien();
  const newKtr = {
    id: 'KTR-' + Date.now(),
    nikPabrik: nikVal,
    npkPabrik: nikVal,
    namaPasien: namaVal,
    dept: deptVal,
    departemen: deptVal,
    noHp: hpVal,
    noHpPasien: hpVal,
    tanggalPeriksa: req.body.tanggalPeriksa || new Date().toLocaleDateString('id-ID'),
    tanggalKontrol: String(tglVal).trim(),
    catatanKontrol: notesVal,
    catatan: notesVal,
    asesmen: diagVal,
    diagnosa: diagVal,
    isIzinSakit: !!(req.body.isIzinSakit || req.body.kategori === 'izinSakit'),
    isPantauan: !!(req.body.isPantauan || req.body.kategori === 'pantauan'),
    pemeriksa: req.body.pemeriksa || 'Petugas Medis',
    status: 'MENUNGGU',
    created_at: new Date().toISOString()
  };

  list.unshift(newKtr);
  saveKontrolPasien(list);
  res.status(201).json(newKtr);
});

app.put('/api/kontrol/:id', (req, res) => {
  const list = loadKontrolPasien();
  const idx = list.findIndex(k => k.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Jadwal kontrol tidak ditemukan.' });
  }

  list[idx] = { ...list[idx], ...req.body };
  saveKontrolPasien(list);
  res.json(list[idx]);
});

app.delete('/api/kontrol/:id', (req, res) => {
  let list = loadKontrolPasien();
  const initialLen = list.length;
  list = list.filter(k => k.id !== req.params.id);
  if (list.length === initialLen) {
    return res.status(404).json({ error: 'Jadwal kontrol tidak ditemukan.' });
  }
  saveKontrolPasien(list);
  res.json({ success: true, message: 'Jadwal kontrol berhasil dihapus.' });
});

// Laporan DHSE (Departemen K3/HSE PT ATI)
app.get('/api/kontrol/laporan-dhse', (req, res) => {
  const list = loadKontrolPasien();
  const { startDate, endDate, kategori, dept } = req.query;

  let filtered = list.filter(k => k.isIzinSakit || k.isPantauan);

  if (startDate) {
    filtered = filtered.filter(k => (k.tanggalKontrol || k.tanggalPeriksa) >= startDate);
  }
  if (endDate) {
    filtered = filtered.filter(k => (k.tanggalKontrol || k.tanggalPeriksa) <= endDate);
  }
  if (kategori === 'izinSakit') {
    filtered = filtered.filter(k => k.isIzinSakit);
  } else if (kategori === 'pantauan') {
    filtered = filtered.filter(k => k.isPantauan);
  }
  if (dept) {
    filtered = filtered.filter(k => (k.dept || '').toLowerCase().includes(dept.toLowerCase()));
  }

  res.json({
    total: filtered.length,
    izinSakitCount: filtered.filter(k => k.isIzinSakit).length,
    pantauanCount: filtered.filter(k => k.isPantauan).length,
    data: filtered
  });
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`Mobile Klinik System PT ATI running on port ${PORT}`);
  console.log(`- Akses Lokal:  http://localhost:${PORT}`);
  console.log(`- Akses Wi-Fi:  http://10.125.149.122:${PORT} (atau sesuaikan IP Wi-Fi Anda)`);
  console.log(`System status: READY & SECURE (Multi-Device WA & Offline Sync Active)`);
  console.log(`=================================================`);

  // Start WhatsApp Engine
  whatsappService.initEngine().catch(e => {
    console.error('[WhatsApp Engine] Inisialisasi awal error:', e.message);
  });
});
