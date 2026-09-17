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

const multer = require('multer');
const waUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const cleanBase = path.basename(file.originalname || 'file', ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `wa_${Date.now()}_${cleanBase}${ext}`);
  }
});
const waUpload = multer({
  storage: waUploadStorage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

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

// Helper ekstraksi dan pencocokan nama asli pasien WhatsApp
function resolvePatientInfo(phone, rawJid, text, fallbackName) {
  let db = {};
  try { db = readDB(); } catch (e) {}
  const pool = [...(db.employees || []), ...(db.patients || [])];
  const allRecords = db.records || [];

  const cleanDigits = (phone || '').replace(/\D/g, '');
  const suffix8 = cleanDigits.length >= 8 ? cleanDigits.slice(-8) : cleanDigits;

  // 1. Cek kecocokan nomor HP di data master karyawan / pasien
  if (suffix8 && suffix8.length >= 6) {
    const found = pool.find(p => {
      const pDigits = (p.hp || p.noHp || p.telepon || p.no_hp || '').replace(/\D/g, '');
      return pDigits && (pDigits.endsWith(suffix8) || suffix8.endsWith(pDigits));
    });
    if (found && found.nama) {
      return {
        nama: found.nama,
        nikPabrik: found.nikPabrik || found.nik || '',
        dept: found.dept || found.departemen || '-'
      };
    }

    // Cek di riwayat rekam medis
    const recFound = allRecords.find(r => {
      const rDigits = (r.noHp || r.telepon || '').replace(/\D/g, '');
      return rDigits && (rDigits.endsWith(suffix8) || suffix8.endsWith(rDigits));
    });
    if (recFound && recFound.namaPasien) {
      return {
        nama: recFound.namaPasien,
        nikPabrik: recFound.nikPabrik || '',
        dept: recFound.dept || '-'
      };
    }
  }

  // 2. Ekstraksi dari teks jika ada sapaan/nama dalam pesan
  if (text && typeof text === 'string') {
    const mGreeting = text.match(/(?:Halo rekan|Halo sdr\/i|Halo sdr|Halo pak\/bu|Halo)\s+([A-Za-z0-9\s.]+?)(?:\s*\(|,|\.|\n|$)/i);
    if (mGreeting && mGreeting[1] && mGreeting[1].trim().length >= 3 && !mGreeting[1].toLowerCase().includes('petugas')) {
      return {
        nama: mGreeting[1].trim(),
        nikPabrik: '',
        dept: '-'
      };
    }
    const cleanTextUpper = text.trim().toUpperCase();
    if (cleanTextUpper.length >= 3 && cleanTextUpper.length <= 35) {
      const matchEmp = pool.find(p => (p.nama || '').trim().toUpperCase() === cleanTextUpper);
      if (matchEmp) {
        return {
          nama: matchEmp.nama,
          nikPabrik: matchEmp.nikPabrik || matchEmp.nik || '',
          dept: matchEmp.dept || matchEmp.departemen || '-'
        };
      }
    }
  }

  // 3. Gunakan fallback name hanya jika bukan 'Petugas'
  if (fallbackName && !fallbackName.toLowerCase().startsWith('petugas') && !fallbackName.startsWith('Pasien Baru')) {
    return { nama: fallbackName, nikPabrik: '', dept: '-' };
  }

  const displayPhone = phone ? (phone.startsWith('62') ? '0' + phone.slice(2) : phone) : '';
  return {
    nama: displayPhone ? `Pasien (${displayPhone})` : 'Pasien',
    nikPabrik: '',
    dept: '-'
  };
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

  const resolved = resolvePatientInfo(formattedPhone || senderPhone, rawJid, text, (!isFromMe && senderName) ? senderName : '');

  if (!session) {
    session = {
      id: 'CHAT-' + Date.now(),
      patientId: resolved.nikPabrik || ('PAS-' + Date.now().toString().slice(-4)),
      patientName: resolved.nama,
      patientPhone: formattedPhone || senderPhone,
      nikPabrik: resolved.nikPabrik || '',
      dept: resolved.dept || '',
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
    // Perbaiki nama jika sebelumnya 'Petugas' atau default
    if (!session.patientName || session.patientName.toLowerCase().startsWith('petugas') || session.patientName.startsWith('Pasien ')) {
      if (resolved.nama && !resolved.nama.toLowerCase().startsWith('petugas')) {
        session.patientName = resolved.nama;
        if (resolved.nikPabrik) session.nikPabrik = resolved.nikPabrik;
        if (resolved.dept) session.dept = resolved.dept;
      }
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

let _dbCache = null;
let _dbLastMtime = 0;

function initDBOnce(data) {
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

  // Auto-enrich master WHO ICD-10 dataset
  const masterIcdFile = path.join(__dirname, 'icd10_master.json');
  if (fs.existsSync(masterIcdFile)) {
    try {
      const masterList = JSON.parse(fs.readFileSync(masterIcdFile, 'utf8'));
      if (Array.isArray(masterList) && masterList.length > 0) {
        if (!Array.isArray(data.icd10) || data.icd10.length < masterList.length) {
          const currentCodes = new Set((data.icd10 || []).map(i => (i.code || i.kode || '').trim().toUpperCase()));
          data.icd10 = data.icd10 || [];
          let addedCount = 0;
          masterList.forEach(m => {
            const code = (m.code || '').trim().toUpperCase();
            if (code && !currentCodes.has(code)) {
              data.icd10.push({ id: `ICD-${data.icd10.length}`, code: m.code, description: m.description });
              currentCodes.add(code);
              addedCount++;
            }
          });
          if (addedCount > 0) modified = true;
        }
      }
    } catch (e) {}
  }

  // Auto-enrich master 1,142 employees dataset
  const masterEmpFile = path.join(__dirname, 'employees_master.json');
  if (fs.existsSync(masterEmpFile)) {
    try {
      const masterEmps = JSON.parse(fs.readFileSync(masterEmpFile, 'utf8'));
      if (Array.isArray(masterEmps) && masterEmps.length > 0) {
        if (!Array.isArray(data.employees) || data.employees.length === 0) {
          data.employees = [...masterEmps];
          data.patients = [...masterEmps];
          modified = true;
        }
      }
    } catch (e) {}
  }

  // Optimize DB: Migrate embedded base64 images in records to physical files in uploads/
  if (Array.isArray(data.records)) {
    data.records.forEach((r, idx) => {
      if (r.linkFoto && typeof r.linkFoto === 'string' && r.linkFoto.startsWith('data:image')) {
        try {
          const matches = r.linkFoto.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
          if (matches) {
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            const fileName = `foto_rm_${r.id || idx}_${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);
            r.linkFoto = `/uploads/${fileName}`;
            modified = true;
            console.log(`📦 [DB Optimization] Migrated record ${r.id} base64 image to /uploads/${fileName}`);
          }
        } catch (imgErr) {
          console.warn('[DB Optimization] Failed to migrate image:', imgErr.message);
        }
      }
    });
  }

  return modified;
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    const stat = fs.statSync(DB_FILE);

    // Fast-path: return in-memory cache if valid and file hasn't changed on disk
    if (_dbCache && stat.mtimeMs <= _dbLastMtime) {
      return _dbCache;
    }

    const content = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(content);

    // Initial load / startup enrichment
    if (!_dbCache) {
      const wasModified = initDBOnce(data);
      if (wasModified) {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
        const newStat = fs.statSync(DB_FILE);
        _dbLastMtime = newStat.mtimeMs;
      } else {
        _dbLastMtime = stat.mtimeMs;
      }
    } else {
      _dbLastMtime = stat.mtimeMs;
    }

    _dbCache = data;
    return _dbCache;
  } catch (err) {
    console.error('Error reading DB:', err);
    return _dbCache || {};
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
    _dbCache = data;
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    const stat = fs.statSync(DB_FILE);
    _dbLastMtime = stat.mtimeMs;
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

// Upload foto/dokumen rekam medis ke Google Drive via Apps Script atau penyimpanan disk lokal
app.post('/api/upload-foto', async (req, res) => {
  const db = readDB();
  const gsheetUrl = db.settings?.gsheet_url;
  const { fileData, fileName, mimeType } = req.body;

  if (!fileData) {
    return res.status(400).json({ error: 'Data file tidak valid' });
  }

  // Helper untuk menyimpan base64 ke folder uploads/ lokal agar db.json tidak membengkak
  const saveToLocalUploads = () => {
    try {
      const matches = String(fileData).match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      const ext = matches ? (matches[1] === 'jpeg' ? 'jpg' : matches[1]) : (path.extname(fileName || '') || '.jpg').replace('.', '');
      const rawData = matches ? matches[2] : fileData;
      const buffer = Buffer.from(rawData, 'base64');
      const safeName = `foto_rm_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);
      return `/uploads/${safeName}`;
    } catch (e) {
      console.error('Error saving uploaded file locally:', e);
      return fileData;
    }
  };

  // Jika ada Google Apps Script URL, coba kirim ke Google Drive terlebih dahulu
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
          // Fallback lokal disk
          res.json({ success: true, fileUrl: saveToLocalUploads() });
        });
      });

      pushReq.on('error', (e) => {
        res.json({ success: true, fileUrl: saveToLocalUploads() });
      });

      pushReq.write(payload);
      pushReq.end();
      return;
    } catch(err) {
      console.error('Upload foto error:', err);
    }
  }

  // Fallback lokal jika GSheet tidak diatur
  res.json({ success: true, fileUrl: saveToLocalUploads() });
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

  // Default limit 200 items to prevent massive 600+ KB payloads on regular loads
  const limit = req.query.limit ? (req.query.limit === 'all' ? mutations.length : parseInt(req.query.limit)) : 200;
  res.json(mutations.slice(0, limit));
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
  const rawParam = req.params.id ? String(req.params.id) : '';
  const param = decodeURIComponent(rawParam).trim();
  const idx = db.employees.findIndex(e => 
    String(e.id || '').trim() === param || 
    String(e.nikPabrik || '').trim() === param || 
    String(e.nik || '').trim() === param ||
    (e.nama && String(e.nama).trim().toLowerCase() === param.toLowerCase())
  );
  if (idx !== -1) {
    const rawSaldo = req.body.saldoObat;
    const cleanSaldo = rawSaldo !== undefined && rawSaldo !== null
      ? parseInt(String(rawSaldo).replace(/[^\d-]/g, '')) || 0
      : (parseInt(String(db.employees[idx].saldoObat || db.employees[idx].sisaLimit || '0').replace(/[^\d-]/g, '')) || 0);

    db.employees[idx] = {
      ...db.employees[idx],
      ...req.body,
      nikPabrik: req.body.nikPabrik !== undefined ? String(req.body.nikPabrik).trim() : db.employees[idx].nikPabrik,
      nik: req.body.nikPabrik !== undefined ? String(req.body.nikPabrik).trim() : (db.employees[idx].nik || db.employees[idx].nikPabrik),
      nama: req.body.nama !== undefined ? String(req.body.nama).trim() : db.employees[idx].nama,
      dept: req.body.dept !== undefined ? String(req.body.dept).trim() : db.employees[idx].dept,
      departemen: req.body.dept !== undefined ? String(req.body.dept).trim() : (db.employees[idx].departemen || db.employees[idx].dept),
      gender: req.body.gender || db.employees[idx].gender,
      golDarah: req.body.golDarah || db.employees[idx].golDarah || '-',
      tglLahir: req.body.tglLahir !== undefined ? String(req.body.tglLahir).trim() : db.employees[idx].tglLahir,
      tgl_lahir: req.body.tglLahir !== undefined ? String(req.body.tglLahir).trim() : (db.employees[idx].tgl_lahir || db.employees[idx].tglLahir),
      hp: req.body.hp !== undefined ? String(req.body.hp).trim() : (db.employees[idx].hp || ''),
      no_hp: req.body.hp !== undefined ? String(req.body.hp).trim() : (db.employees[idx].no_hp || db.employees[idx].hp || ''),
      saldoObat: cleanSaldo,
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
  const rawParam = req.params.id ? String(req.params.id) : '';
  const param = decodeURIComponent(rawParam).trim();
  const initialLen = db.employees.length;
  db.employees = db.employees.filter(e => 
    String(e.id || '').trim() !== param && 
    String(e.nikPabrik || '').trim() !== param && 
    String(e.nik || '').trim() !== param &&
    (e.nama ? String(e.nama).trim().toLowerCase() !== param.toLowerCase() : true)
  );
  if (db.employees.length === initialLen) {
    return res.status(404).json({ error: 'Data pasien tidak ditemukan untuk dihapus' });
  }
  writeDB(db);
  res.json({ success: true, deleted: param });
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

  // 4. Mark as pantauan if flagged (Deduplicate per employee & record to db.pantauan_records)
  if (newRecord.isPantauan) {
    if (!db.pantauan) db.pantauan = [];
    if (!db.pantauan_records) db.pantauan_records = [];

    const existIdx = db.pantauan.findIndex(p => 
      (p.nikPabrik && p.nikPabrik === newRecord.nikPabrik) || 
      (p.namaPasien && p.namaPasien.toLowerCase() === newRecord.namaPasien.toLowerCase())
    );

    const bpMatch = String(newRecord.objektif || '').match(/(?:TD|Tensi|BP)?[\s:]*(\d{2,3})\s*[\/]\s*(\d{2,3})/i);
    const gdsMatch = String(newRecord.objektif || '').match(/(?:GDS|GDP|Gula)[\s:]*(\d{2,3})/i);
    const auMatch = String(newRecord.objektif || '').match(/(?:AU|Asam\s*Urat)[\s:]*([\d\.]+)/i);
    const kolMatch = String(newRecord.objektif || '').match(/(?:Kol|Kolesterol)[\s:]*(\d{2,3})/i);

    const curSis = bpMatch ? parseInt(bpMatch[1]) : null;
    const curDia = bpMatch ? parseInt(bpMatch[2]) : null;
    const curGds = gdsMatch ? parseInt(gdsMatch[1]) : null;
    const curAu = auMatch ? parseFloat(auMatch[1]) : null;
    const curKol = kolMatch ? parseInt(kolMatch[1]) : null;

    let statusTensi = 'Normal';
    if (curSis >= 160 || curDia >= 100) statusTensi = 'Hipertensi Tk 2';
    else if (curSis >= 140 || curDia >= 90) statusTensi = 'Hipertensi Tk 1';
    else if (curSis >= 130 || curDia >= 85) statusTensi = 'Pre-Hipertensi';
    else if (curSis && curSis < 90) statusTensi = 'Hipotensi';

    const tipeP = newRecord.tipePantauan || 'mingguan';
    const tglKontrol = newRecord.tanggalKontrol || '';

    const pntRecord = {
      id: 'PNT-' + Date.now(),
      nikPabrik: newRecord.nikPabrik || '',
      namaPasien: newRecord.namaPasien,
      dept: newRecord.dept || '-',
      noHp: newRecord.noHp || '',
      tanggal: newRecord.tanggal || new Date().toLocaleDateString('id-ID'),
      jam: newRecord.jam || new Date().toLocaleTimeString('id-ID'),
      rawTime: Date.now(),
      pemeriksa: newRecord.pemeriksa || 'Dokter Poli',
      keluhan: newRecord.keluhan || '-',
      mingguan: {
        tensiSistol: curSis,
        tensiDiastol: curDia,
        statusTensi,
        gulaDarah: curGds,
        tipeGula: 'GDS',
        asamUrat: curAu,
        kolesterol: curKol,
        jadwalBerikutnya: (tipeP === 'mingguan' ? tglKontrol : null)
      },
      obatBulanan: {
        ambilObat: (tipeP === 'obat') || (Array.isArray(newRecord.resep) && newRecord.resep.length > 0),
        daftarObat: Array.isArray(newRecord.resep) ? newRecord.resep.map(r => ({
          nama: r.namaObat || r.obat,
          jumlah: r.qty || 1,
          aturan: r.aturan || 'Sesuai resep'
        })) : [],
        catatanObat: tipeP === 'obat' ? (newRecord.catatanKontrol || 'Pengambilan obat rutin poli') : '',
        jadwalAmbilBerikutnya: (tipeP === 'obat' ? tglKontrol : null)
      },
      lab3Bulan: {
        adaCekLab: (tipeP === 'lab'),
        tanggalLab: newRecord.tanggal || new Date().toLocaleDateString('id-ID'),
        jadwalLabBerikutnya: (tipeP === 'lab' ? tglKontrol : null)
      },
      catatanDokter: newRecord.catatanKontrol || newRecord.plan || '',
      waSent: false,
      waSentAt: null
    };

    db.pantauan_records.unshift(pntRecord);

    const pantauanItem = {
      id: existIdx !== -1 ? db.pantauan[existIdx].id : ('PP-' + Date.now()),
      nikPabrik: newRecord.nikPabrik,
      namaPasien: newRecord.namaPasien,
      dept: newRecord.dept || '-',
      keluhan: newRecord.keluhan,
      asesmen: newRecord.asesmen,
      status: 'AKTIF',
      tanggal: newRecord.tanggal || new Date().toLocaleDateString('id-ID'),
      noHp: newRecord.noHp || (existIdx !== -1 ? db.pantauan[existIdx].noHp : ''),
      lastCheck: newRecord.tanggal || new Date().toLocaleDateString('id-ID'),
      jadwalMingguan: (tipeP === 'mingguan' && tglKontrol) ? tglKontrol : (existIdx !== -1 ? db.pantauan[existIdx].jadwalMingguan : null),
      jadwalObatBulanan: (tipeP === 'obat' && tglKontrol) ? tglKontrol : (existIdx !== -1 ? db.pantauan[existIdx].jadwalObatBulanan : null),
      jadwalLab3Bulan: (tipeP === 'lab' && tglKontrol) ? tglKontrol : (existIdx !== -1 ? db.pantauan[existIdx].jadwalLab3Bulan : null)
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

app.get(['/api/wa/sessions', '/api/wa/status'], (req, res) => {
  const result = {};
  Object.keys(whatsappService.sessions).forEach(k => {
    const s = whatsappService.sessions[k];
    result[k] = {
      id: s.id,
      sessionName: k,
      deviceName: s.deviceName,
      number: s.number,
      phone: s.number,
      status: s.status,
      isConnected: s.status === 'CONNECTED',
      battery: s.battery,
      qrDataUrl: s.qrDataUrl,
      lastSync: s.lastSync
    };
  });
  // Top-level helpers for backwards compatibility
  const defaultSession = result.klinik || { isConnected: false, status: 'DISCONNECTED' };
  result.isConnected = defaultSession.isConnected;
  result.phone = defaultSession.number || defaultSession.phone;
  result.status = defaultSession.status;
  result.sessionName = 'klinik';
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
  const sessionType = req.query.sessionType || req.query.sessionName || 'klinik';
  const chats = chatSessions.filter(c => !sessionType || c.sessionType === sessionType);
  let hasChanges = false;

  const formatted = chats.map(c => {
    const lastMsg = (c.messages && c.messages.length > 0) ? c.messages[c.messages.length - 1] : null;
    const phone = c.patientPhone || '';
    const cleanNum = phone.replace(/\D/g, '');
    const cleanPhoneForWA = cleanNum.startsWith('0') ? ('62' + cleanNum.slice(1)) : cleanNum;
    const jid = c.rawJid || (cleanPhoneForWA ? `${cleanPhoneForWA}@s.whatsapp.net` : `chat_${c.id}@s.whatsapp.net`);

    // Perbaiki jika nama masih 'Petugas' atau default
    if (!c.patientName || c.patientName.toLowerCase().startsWith('petugas') || c.patientName.startsWith('Pasien ')) {
      const allText = (c.messages || []).map(m => m.text || '').join(' ');
      const resolved = resolvePatientInfo(phone, c.rawJid, allText, c.patientName);
      if (resolved && resolved.nama && !resolved.nama.toLowerCase().startsWith('petugas')) {
        c.patientName = resolved.nama;
        if (resolved.nikPabrik && !c.nikPabrik) c.nikPabrik = resolved.nikPabrik;
        if (resolved.dept && (!c.dept || c.dept === '-')) c.dept = resolved.dept;
        hasChanges = true;
      }
    }

    let finalDisplayName = c.patientName;
    if (!finalDisplayName || finalDisplayName.toLowerCase().startsWith('petugas')) {
      finalDisplayName = phone ? `Pasien (${phone})` : (jid ? jid.split('@')[0] : 'Pasien');
    }

    return {
      ...c,
      id: c.id,
      jid: jid,
      name: finalDisplayName,
      phone: phone,
      lastMessage: lastMsg ? (lastMsg.text || (lastMsg.mediaType === 'image' ? '[Foto]' : '[Berkas Dokumen]')) : '',
      lastTimestamp: c.updatedAt || (lastMsg ? lastMsg.rawTime : Date.now()),
      unreadCount: c.unreadCount || 0,
      messages: (c.messages || []).map(m => ({
        ...m,
        fromMe: m.fromMe !== undefined ? m.fromMe : (m.sender === 'staff')
      }))
    };
  });

  if (hasChanges) {
    try { saveChatSessions(chatSessions); } catch (e) {}
  }

  res.json(formatted);
});

app.post('/api/wa/send', waUpload.single('file'), async (req, res) => {
  const sessionType = req.body.sessionType || req.body.sessionName || 'klinik';
  const text = req.body.text || req.body.message || '';
  let targetDest = req.body.targetPhone || req.body.phone || req.body.jid || '';

  if (!targetDest || (!text && !req.file && !req.body.mediaBase64)) {
    return res.status(400).json({ error: 'Nomor tujuan dan isi pesan / lampiran wajib diisi.' });
  }

  let options = {};
  let mediaUrl = null;
  let mediaType = req.body.mediaType || null;
  let fileName = req.body.fileName || null;

  if (req.file) {
    const isImage = (req.file.mimetype || '').startsWith('image/');
    mediaUrl = `/uploads/${req.file.filename}`;
    mediaType = isImage ? 'image' : 'document';
    fileName = req.file.originalname;
    options = {
      mediaBuffer: fs.readFileSync(req.file.path),
      mediaType: mediaType,
      fileName: fileName,
      mimetype: req.file.mimetype
    };
  } else if (req.body.mediaBase64) {
    try {
      const buffer = Buffer.from(req.body.mediaBase64.replace(/^data:.*?;base64,/, ''), 'base64');
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

  const result = await whatsappService.sendWhatsAppMessage(sessionType, targetDest, text, options);

  let cleanDigits = targetDest.replace(/\D/g, '');
  if (cleanDigits.startsWith('62')) cleanDigits = '0' + cleanDigits.slice(2);
  const suffix8 = cleanDigits.length >= 8 ? cleanDigits.slice(-8) : cleanDigits;

  let session = chatSessions.find(s => {
    if (s.sessionType !== sessionType) return false;
    if (s.rawJid && targetDest.includes('@') && s.rawJid === targetDest) return true;
    const sDigits = (s.patientPhone || '').replace(/\D/g, '');
    return (suffix8 && sDigits.endsWith(suffix8)) || s.patientPhone === cleanDigits || s.patientPhone === targetDest;
  });

  const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

  const newMsg = {
    messageId: result.id || ('MSG-' + Date.now()),
    sender: 'staff',
    fromMe: true,
    staffName: 'Petugas Medis',
    text: text || (mediaType === 'image' ? '[Foto]' : '[Dokumen]'),
    mediaUrl: mediaUrl,
    mediaType: mediaType || null,
    fileName: fileName || null,
    timestamp: timestamp,
    rawTime: Date.now()
  };

  const rawJid = targetDest.includes('@') ? targetDest : `${cleanDigits.replace(/^0/, '62')}@s.whatsapp.net`;

  if (!session) {
    const resolved = resolvePatientInfo(cleanDigits || targetDest, rawJid, text, req.body.patientName);
    session = {
      id: 'CHAT-' + Date.now(),
      patientId: resolved.nikPabrik || ('PAS-' + Date.now().toString().slice(-4)),
      patientName: req.body.patientName || resolved.nama,
      patientPhone: cleanDigits || targetDest,
      nikPabrik: resolved.nikPabrik || '',
      dept: resolved.dept || '',
      rawJid: rawJid,
      sessionType: sessionType,
      updatedAt: Date.now(),
      unreadCount: 0,
      messages: [newMsg]
    };
    chatSessions.unshift(session);
  } else {
    if (!session.rawJid || session.rawJid.includes('@lid')) {
      session.rawJid = rawJid;
    }
    if (req.body.patientName) {
      session.patientName = req.body.patientName;
    } else if (!session.patientName || session.patientName.toLowerCase().startsWith('petugas')) {
      const resolved = resolvePatientInfo(cleanDigits || targetDest, rawJid, text, session.patientName);
      if (resolved && resolved.nama && !resolved.nama.toLowerCase().startsWith('petugas')) {
        session.patientName = resolved.nama;
      }
    }
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
  const sessionType = req.body.sessionType || req.body.sessionName || 'klinik';
  try {
    await whatsappService.logoutSession(sessionType);
    res.json({ success: true, message: `Sesi ${sessionType} berhasil diputuskan.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/wa/read', (req, res) => {
  const { chatId, jid } = req.body;
  const cleanJidDigits = jid ? jid.replace(/\D/g, '') : '';
  const suffix8 = cleanJidDigits.length >= 8 ? cleanJidDigits.slice(-8) : cleanJidDigits;
  const session = chatSessions.find(s => {
    if (chatId && s.id === chatId) return true;
    if (jid && (s.rawJid === jid || (s.patientPhone && jid.includes(s.patientPhone)))) return true;
    if (suffix8 && s.patientPhone && s.patientPhone.replace(/\D/g, '').endsWith(suffix8)) return true;
    return false;
  });
  if (session) {
    session.unreadCount = 0;
    saveChatSessions(chatSessions);
  }
  res.json({ success: true });
});

app.post('/api/wa/read-all', (req, res) => {
  chatSessions.forEach(s => {
    s.unreadCount = 0;
  });
  saveChatSessions(chatSessions);
  res.json({ success: true, message: 'Semua obrolan ditandai sudah dibaca' });
});

app.post('/api/wa/test-send', async (req, res) => {
  const targetPhone = req.body.phone || '081291868456';
  const session = whatsappService.sessions?.klinik;
  const isConnected = session && session.sock && session.status === 'CONNECTED';

  if (!isConnected) {
    return res.json({
      success: false,
      isConnected: false,
      message: 'WhatsApp HP Klinik belum tertaut barcode. Silakan klik tombol "Tautkan HP" dan scan barcode QR terlebih dahulu untuk mengaktifkan koneksi.'
    });
  }

  const customText = req.body.message || `Halo dr. Dylan Fadhilah,\n\nIni adalah pesan pengujian otomatis dari Sistem Rekam Medis PT ATI & Klinik Nafila Medika.\n\nStatus Sesi: 🟢 TERHUBUNG (ONLINE)\nDomain Resmi: https://nafilamedika.my.id\nWaktu Kirim: ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB\n\nSistem WhatsApp siap digunakan untuk melayani pasien dan karyawan PT ATI.`;

  try {
    const result = await whatsappService.sendWhatsAppMessage('klinik', targetPhone, customText);
    return res.json({
      success: result.success,
      isConnected: true,
      realSent: result.realSent,
      target: targetPhone,
      message: result.success ? `Pesan tes berhasil dikirim ke ${targetPhone}!` : `Gagal mengirim pesan: ${result.error}`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// MODUL PEMANTAUAN JANGKA PANJANG HSE & PROLANIS (SS 2 & SS 3)
// Mingguan (Vital/Biometrik) - Bulanan (Obat) - 3 Bulan (Lab Dinamis)
// ============================================================

app.get('/api/pantauan/longterm', (req, res) => {
  const db = readDB();
  const pantauanList = db.pantauan || [];
  const records = db.pantauan_records || [];
  const employees = db.employees || [];
  const patients = db.patients || [];

  // Sinkronkan info HP dan Dept terbaru dari database karyawan/pasien
  const enrichedList = pantauanList.map(item => {
    const key = (item.nikPabrik || item.namaPasien || '').trim().toLowerCase();
    const emp = employees.find(e => (e.nikPabrik || e.nik || '').trim().toLowerCase() === key || (e.nama || '').trim().toLowerCase() === key)
      || patients.find(p => (p.nikPabrik || p.nik || '').trim().toLowerCase() === key || (p.nama || '').trim().toLowerCase() === key)
      || {};

    const patientRecords = records.filter(r => (r.nikPabrik && r.nikPabrik === item.nikPabrik) || (r.namaPasien && r.namaPasien.toLowerCase() === (item.namaPasien || '').toLowerCase()));
    patientRecords.sort((a, b) => (b.rawTime || 0) - (a.rawTime || 0));

    return {
      ...item,
      noHp: item.noHp || emp.hp || emp.noHp || emp.telepon || '',
      dept: item.dept || emp.dept || emp.departemen || '-',
      jabatan: emp.jabatan || '-',
      historyCount: patientRecords.length,
      latestRecord: patientRecords[0] || null
    };
  });

  res.json({
    success: true,
    pantauan: enrichedList,
    records: records
  });
});

app.post('/api/pantauan/record', async (req, res) => {
  try {
    const db = readDB();
    if (!Array.isArray(db.pantauan_records)) db.pantauan_records = [];
    if (!Array.isArray(db.pantauan)) db.pantauan = [];

    const {
      nikPabrik,
      namaPasien,
      dept,
      noHp,
      pemeriksa,
      keluhan,
      mingguan = {},
      obatBulanan = {},
      lab3Bulan = {},
      catatanDokter,
      sendWa = true
    } = req.body;

    if (!namaPasien) {
      return res.status(400).json({ success: false, error: 'Nama pasien wajib diisi.' });
    }

    const now = new Date();
    const tanggalStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const jamStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    const newRecord = {
      id: 'PNT-' + Date.now(),
      nikPabrik: nikPabrik || '',
      namaPasien: namaPasien,
      dept: dept || '-',
      noHp: noHp || '',
      tanggal: tanggalStr,
      jam: jamStr,
      rawTime: Date.now(),
      pemeriksa: pemeriksa || 'Tim Medis & HSE PT ATI',
      keluhan: keluhan || '-',
      mingguan: {
        tensiSistol: Number(mingguan.tensiSistol) || null,
        tensiDiastol: Number(mingguan.tensiDiastol) || null,
        statusTensi: mingguan.statusTensi || 'Normal',
        nadi: Number(mingguan.nadi) || null,
        gulaDarah: Number(mingguan.gulaDarah) || null,
        tipeGula: mingguan.tipeGula || 'GDS',
        asamUrat: Number(mingguan.asamUrat) || null,
        kolesterol: Number(mingguan.kolesterol) || null,
        beratBadan: Number(mingguan.beratBadan) || null,
        tinggiBadan: Number(mingguan.tinggiBadan) || null,
        bmi: mingguan.bmi || null,
        lingkarPerut: Number(mingguan.lingkarPerut) || null,
        jadwalBerikutnya: mingguan.jadwalBerikutnya || null
      },
      obatBulanan: {
        ambilObat: Boolean(obatBulanan.ambilObat),
        daftarObat: Array.isArray(obatBulanan.daftarObat) ? obatBulanan.daftarObat : [],
        catatanObat: obatBulanan.catatanObat || '',
        jadwalAmbilBerikutnya: obatBulanan.jadwalAmbilBerikutnya || null
      },
      lab3Bulan: {
        adaCekLab: Boolean(lab3Bulan.adaCekLab),
        tanggalLab: lab3Bulan.tanggalLab || tanggalStr,
        hba1c: Number(lab3Bulan.hba1c) || null,
        ureum: Number(lab3Bulan.ureum) || null,
        creatinin: Number(lab3Bulan.creatinin) || null,
        elektrolit: {
          natrium: Number(lab3Bulan.elektrolit?.natrium) || null,
          kalium: Number(lab3Bulan.elektrolit?.kalium) || null,
          klorida: Number(lab3Bulan.elektrolit?.klorida) || null
        },
        customLabs: Array.isArray(lab3Bulan.customLabs) ? lab3Bulan.customLabs : [],
        catatanLab: lab3Bulan.catatanLab || '',
        jadwalLabBerikutnya: lab3Bulan.jadwalLabBerikutnya || null
      },
      catatanDokter: catatanDokter || '',
      waSent: false,
      waSentAt: null
    };

    // Update Profil Pasien di db.pantauan
    let patientProfile = db.pantauan.find(p => (nikPabrik && p.nikPabrik === nikPabrik) || (p.namaPasien && p.namaPasien.toLowerCase() === namaPasien.toLowerCase()));
    if (!patientProfile) {
      patientProfile = {
        id: 'PP-' + Date.now(),
        nikPabrik: nikPabrik || '',
        namaPasien: namaPasien,
        dept: dept || '-',
        noHp: noHp || '',
        status: 'AKTIF',
        tanggal: tanggalStr
      };
      db.pantauan.push(patientProfile);
    }

    patientProfile.noHp = noHp || patientProfile.noHp || '';
    patientProfile.dept = dept || patientProfile.dept || '-';
    patientProfile.lastCheck = tanggalStr;
    patientProfile.jadwalMingguan = mingguan.jadwalBerikutnya || patientProfile.jadwalMingguan || null;
    patientProfile.jadwalObatBulanan = obatBulanan.jadwalAmbilBerikutnya || patientProfile.jadwalObatBulanan || null;
    patientProfile.jadwalLab3Bulan = lab3Bulan.jadwalLabBerikutnya || patientProfile.jadwalLab3Bulan || null;

    db.pantauan_records.unshift(newRecord);
    writeDB(db);

    // Kirim Notifikasi WhatsApp Otomatis ke Pasien jika No HP terisi
    let waResult = null;
    if (sendWa && (noHp || patientProfile.noHp)) {
      const destHp = noHp || patientProfile.noHp;
      const waMsg = buildPantauanWaMessage(newRecord);
      waResult = await whatsappService.sendWhatsAppMessage('klinik', destHp, waMsg);
      if (waResult && (waResult.success || waResult.realSent)) {
        newRecord.waSent = true;
        newRecord.waSentAt = new Date().toLocaleString('id-ID');
        writeDB(db);
      }
    }

    res.json({
      success: true,
      message: 'Data pemantauan jangka panjang berhasil disimpan.',
      record: newRecord,
      waResult
    });
  } catch (err) {
    console.error('Error saving pantauan record:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/pantauan/send-wa', async (req, res) => {
  const { recordId, customPhone } = req.body;
  const db = readDB();
  const records = db.pantauan_records || [];
  const rec = records.find(r => r.id === recordId);

  if (!rec) {
    return res.status(404).json({ success: false, error: 'Rekam pemantauan tidak ditemukan.' });
  }

  const destHp = customPhone || rec.noHp;
  if (!destHp) {
    return res.status(400).json({ success: false, error: 'Nomor WhatsApp pasien tidak tersedia.' });
  }

  const waMsg = buildPantauanWaMessage(rec);
  const waResult = await whatsappService.sendWhatsAppMessage('klinik', destHp, waMsg);

  if (waResult && (waResult.success || waResult.realSent)) {
    rec.waSent = true;
    rec.waSentAt = new Date().toLocaleString('id-ID');
    writeDB(db);
  }

  res.json({ success: true, waResult, message: 'Laporan pemantauan dikirim ke WhatsApp pasien.' });
});

// Helper: Format Pesan WhatsApp Rangkuman Pemantauan Jangka Panjang
function buildPantauanWaMessage(r) {
  const m = r.mingguan || {};
  const o = r.obatBulanan || {};
  const l = r.lab3Bulan || {};

  let text = `🏥 *EVALUASI PEMANTAUAN KESEHATAN KLINIK PT ATI*\n`;
  text += `_Program Pemantauan Jangka Panjang Tim HSE & Medis_\n\n`;
  text += `Halo Rekan *${r.namaPasien}* (${r.nikPabrik || '-'}),\n`;
  text += `Berikut rangkuman hasil pemeriksaan kesehatan berkala Anda:\n\n`;
  text += `🗓 *Tanggal:* ${r.tanggal} (${r.jam})\n`;
  text += `👨‍⚕️ *Pemeriksa:* ${r.pemeriksa}\n\n`;

  text += `📊 *HASIL PEMERIKSAAN MINGGUAN:*\n`;
  if (m.tensiSistol && m.tensiDiastol) {
    text += `• Tensi Darah: *${m.tensiSistol}/${m.tensiDiastol} mmHg* (${m.statusTensi || 'Terpantau'})\n`;
  }
  if (m.nadi) text += `• Nadi: ${m.nadi} x/menit\n`;
  if (m.gulaDarah) text += `• Gula Darah (${m.tipeGula || 'GDS'}): *${m.gulaDarah} mg/dL*\n`;
  if (m.asamUrat) text += `• Asam Urat: *${m.asamUrat} mg/dL*\n`;
  if (m.kolesterol) text += `• Kolesterol Total: *${m.kolesterol} mg/dL*\n`;
  if (m.beratBadan) text += `• Berat Badan: ${m.beratBadan} kg ${m.bmi ? `(BMI: ${m.bmi})` : ''}\n`;
  if (m.lingkarPerut) text += `• Lingkar Perut: ${m.lingkarPerut} cm\n`;

  if (o.ambilObat && Array.isArray(o.daftarObat) && o.daftarObat.length > 0) {
    text += `\n💊 *PENGAMBILAN OBAT RUTIN BULANAN:*\n`;
    o.daftarObat.forEach(med => {
      text += `• ${med.nama || med.namaObat} (${med.jumlah || med.qty || '-'} tab) - ${med.aturan || 'Sesuai resep'}\n`;
    });
    if (o.catatanObat) text += `  _Catatan: ${o.catatanObat}_\n`;
  }

  if (l.adaCekLab) {
    text += `\n🧪 *HASIL CEK LAB BERKALA (3 BULANAN):*\n`;
    if (l.hba1c) text += `• HbA1c: *${l.hba1c}%*\n`;
    if (l.ureum) text += `• Ureum: *${l.ureum} mg/dL*\n`;
    if (l.creatinin) text += `• Creatinin: *${l.creatinin} mg/dL*\n`;
    if (l.elektrolit && (l.elektrolit.natrium || l.elektrolit.kalium || l.elektrolit.klorida)) {
      text += `• Elektrolit: Na ${l.elektrolit.natrium || '-'} | K ${l.elektrolit.kalium || '-'} | Cl ${l.elektrolit.klorida || '-'} mmol/L\n`;
    }
    if (Array.isArray(l.customLabs) && l.customLabs.length > 0) {
      l.customLabs.forEach(cl => {
        text += `• ${cl.namaTes}: *${cl.hasil} ${cl.satuan || ''}* ${cl.rujukan ? `(Ref: ${cl.rujukan})` : ''}\n`;
      });
    }
    if (l.catatanLab) text += `  _Catatan Lab: ${l.catatanLab}_\n`;
  }

  if (r.catatanDokter) {
    text += `\n💡 *Anjuran / Saran Dokter:*\n_${r.catatanDokter}_\n`;
  }

  text += `\n📅 *JADWAL PEMANTAUAN BERIKUTNYA:*\n`;
  if (m.jadwalBerikutnya) text += `• Cek Rutin Mingguan: *${m.jadwalBerikutnya}*\n`;
  if (o.jadwalAmbilBerikutnya) text += `• Ambil Obat Rutin: *${o.jadwalAmbilBerikutnya}*\n`;
  if (l.jadwalLabBerikutnya) text += `• Cek Lab 3 Bulan: *${l.jadwalLabBerikutnya}*\n`;

  text += `\nTetap semangat menjaga pola hidup sehat! Apabila ada keluhan mendadak, segera kunjungi Tim Medis PT ATI.\n`;
  text += `_Salam Sehat, Tim Medis & HSE PT ATI_`;

  return text;
}

// ============================================================
// INTEGRASI VPS CLOUDFLARE & AUTO-REMINDER WA H-1 JADWAL KONTROL
// ============================================================
let VPS_CONFIG = {
  vps_url: "https://nafilamedika.my.id",
  mode: "auto"
};

function getVpsConfig() {
  try {
    const cfgPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed.vps_url) VPS_CONFIG.vps_url = parsed.vps_url.replace(/\/+$/, '');
      if (parsed.mode) VPS_CONFIG.mode = parsed.mode;
    }
  } catch (e) {}
  return VPS_CONFIG;
}

// Background Cron Scheduler: Pengingat Otomatis WhatsApp Pasien Kontrol & Pantauan
// Strictly sent 1 day before control (H-1) or day-of if morning (Jam 08:00 - 10:00 WIB)
let lastAutoReminderCheckTime = 0;
setInterval(async () => {
  try {
    const now = new Date();
    if (Date.now() - lastAutoReminderCheckTime < 15 * 60 * 1000) return;
    lastAutoReminderCheckTime = Date.now();

    const todayStr = now.toISOString().slice(0, 10);
    const besokDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const besokStr = besokDate.toISOString().slice(0, 10);

    const db = readDB();
    const empList = db.employees || db.patients || [];
    let kontrolList = loadKontrolPasien();
    let kontrolUpdated = false;

    // 1. Cek Jadwal Kontrol dari Pasien Poli & Surkes & Pantauan (kontrol_pasien.json)
    for (const k of kontrolList) {
      if (k.status !== 'MENUNGGU' || k.waReminderSent) continue;
      const tgl = String(k.tanggalKontrol || '').trim();
      if (!tgl) continue;

      const isHMinus1 = (tgl === besokStr);
      const isToday = (tgl === todayStr);

      if (isHMinus1 || isToday) {
        let destHp = k.noHp || k.noHpPasien || '';
        if (!destHp && Array.isArray(empList)) {
          const emp = empList.find(e => 
            (e.nikPabrik && k.nikPabrik && String(e.nikPabrik).toLowerCase() === String(k.nikPabrik).toLowerCase()) ||
            (e.nama && k.namaPasien && e.nama.toLowerCase() === k.namaPasien.toLowerCase())
          );
          if (emp) destHp = emp.hp || emp.noHp || emp.telepon || '';
        }

        if (destHp) {
          const waktuKet = isHMinus1 ? 'Besok' : 'Hari Ini';
          let reminderMsg = '';
          if (k.isIzinSakit) {
            reminderMsg = `🔔 *PENGINGAT KONTROL EVALUASI KERJA KLINIK PT ATI*\n\nHalo Rekan *${k.namaPasien}* (${k.nikPabrik || '-'}),\n\nMengingatkan jadwal kontrol evaluasi pasca istirahat sakit Anda di Klinik PT ATI adalah *${waktuKet}* (*${k.tanggalKontrol}*).\n📋 Catatan: ${k.catatanKontrol || 'Evaluasi kebugaran kerja'}\n\nSilakan datang ke klinik untuk pemeriksaan Fit to Work. Terima kasih!\n_Tim Medis & HSE PT ATI_`;
          } else if (k.isPantauan) {
            reminderMsg = `🔔 *PENGINGAT PEMANTAUAN KESEHATAN (K3) KLINIK PT ATI*\n\nHalo Rekan *${k.namaPasien}* (${k.nikPabrik || '-'}),\n\nMengingatkan jadwal pemeriksaan & pemantauan kesehatan rutin Anda di Klinik PT ATI adalah *${waktuKet}* (*${k.tanggalKontrol}*).\n📋 Evaluasi: ${k.catatanKontrol || 'Pemeriksaan tensi & evaluasi berkala'}\n\nMohon luangkan waktu singgah ke klinik. Terima kasih!\n_Tim Medis & HSE PT ATI_`;
          } else {
            reminderMsg = `🔔 *PENGINGAT JADWAL KONTROL BEROBAT KLINIK PT ATI*\n\nHalo Rekan *${k.namaPasien}* (${k.nikPabrik || '-'}),\n\nMengingatkan jadwal kontrol pengobatan Anda di Klinik PT ATI adalah *${waktuKet}* (*${k.tanggalKontrol}*).\n📋 Catatan: ${k.catatanKontrol || 'Evaluasi lanjutan pengobatan'}\n\nMohon hadir sesuai jadwal. Terima kasih!\n_Tim Medis & HSE PT ATI_`;
          }

          console.log(`📲 [Auto WA H-1] Mengirim pengingat kontrol ke ${k.namaPasien} (${destHp}) untuk tgl ${k.tanggalKontrol}...`);
          try {
            const sendRes = await whatsappService.sendWhatsAppMessage('klinik', destHp, reminderMsg);
            if (sendRes && (sendRes.success || sendRes.realSent)) {
              k.waReminderSent = true;
              k.waReminderSentAt = new Date().toISOString();
              kontrolUpdated = true;
            }
          } catch (waErr) {
            console.warn('[Auto WA H-1] Error sending:', waErr.message);
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (kontrolUpdated) {
      saveKontrolPasien(kontrolList);
    }

    // 2. Cek Jadwal dari db.pantauan (Mingguan / Obat / Lab)
    const pantauan = db.pantauan || [];
    let pantauanUpdated = false;
    for (const p of pantauan) {
      if (p.status !== 'AKTIF' || !p.noHp) continue;

      if ((p.jadwalMingguan === besokStr || p.jadwalMingguan === todayStr) && p.lastWaMingguanSent !== p.jadwalMingguan) {
        const reminderMsg = `🔔 *PENGINGAT CEK KESEHATAN MINGGUAN KLINIK PT ATI*\n\nHalo Rekan *${p.namaPasien}*,\nMengingatkan bahwa jadwal pemeriksaan tensi darah dan evaluasi rutin mingguan Anda di Klinik PT ATI adalah pada *${p.jadwalMingguan}*.\n\nMohon luangkan waktu untuk singgah ke klinik. Terima kasih!\n_Tim Medis & HSE PT ATI_`;
        const res = await whatsappService.sendWhatsAppMessage('klinik', p.noHp, reminderMsg);
        if (res && (res.success || res.realSent)) {
          p.lastWaMingguanSent = p.jadwalMingguan;
          pantauanUpdated = true;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if ((p.jadwalObatBulanan === besokStr || p.jadwalObatBulanan === todayStr) && p.lastWaObatSent !== p.jadwalObatBulanan) {
        const medMsg = `💊 *PENGINGAT AMBIL OBAT RUTIN KLINIK PT ATI*\n\nHalo Rekan *${p.namaPasien}*,\nJadwal pengambilan obat rutin bulanan Anda jatuh tempo pada *${p.jadwalObatBulanan}*.\n\nSilakan ambil resep obat rutin Anda di Klinik PT ATI agar terapi tetap berkesinambungan.\n_Tim Medis & HSE PT ATI_`;
        const res = await whatsappService.sendWhatsAppMessage('klinik', p.noHp, medMsg);
        if (res && (res.success || res.realSent)) {
          p.lastWaObatSent = p.jadwalObatBulanan;
          pantauanUpdated = true;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if ((p.jadwalLab3Bulan === besokStr || p.jadwalLab3Bulan === todayStr) && p.lastWaLabSent !== p.jadwalLab3Bulan) {
        const labMsg = `🧪 *PENGINGAT EVALUASI LAB 3 BULANAN KLINIK PT ATI*\n\nHalo Rekan *${p.namaPasien}*,\nMengingatkan jadwal cek laboratorium berkala 3 bulanan Anda (HbA1c / Fungsi Ginjal / Elektrolit) pada *${p.jadwalLab3Bulan}*.\n\nSilakan koordinasikan dengan Tim Medis Klinik PT ATI. Terima kasih!\n_Tim Medis & HSE PT ATI_`;
        const res = await whatsappService.sendWhatsAppMessage('klinik', p.noHp, labMsg);
        if (res && (res.success || res.realSent)) {
          p.lastWaLabSent = p.jadwalLab3Bulan;
          pantauanUpdated = true;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (pantauanUpdated) {
      writeDB(db);
    }
  } catch (autoErr) {
    console.warn('[Auto Reminder WA] Error in scheduler:', autoErr.message);
  }
}, 15 * 60 * 1000); // Check every 15 minutes

// ============================================================
// VPS CLOUDFLARE SYNC ENDPOINTS
// ============================================================
app.get('/api/vps/status', async (req, res) => {
  const cfg = getVpsConfig();
  let vpsOnline = false;
  let latencyMs = 0;
  try {
    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`${cfg.vps_url}/api/kontrol`, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      vpsOnline = true;
      latencyMs = Date.now() - t0;
    }
  } catch (e) {
    vpsOnline = false;
  }
  res.json({
    configuredUrl: cfg.vps_url,
    mode: cfg.mode,
    online: vpsOnline,
    latencyMs
  });
});

app.post('/api/vps/sync', async (req, res) => {
  const cfg = getVpsConfig();
  const db = readDB();
  const localRecords = db.records || [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    // 1. Push local records ke VPS
    const pushRes = await fetch(`${cfg.vps_url}/api/records/offline-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: localRecords.slice(0, 100) }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    let pushData = {};
    if (pushRes.ok) {
      pushData = await pushRes.json();
    }

    // 2. Tarik master data terbaru dari VPS jika perlu
    let pulledCount = 0;
    try {
      const getRes = await fetch(`${cfg.vps_url}/api/records?limit=100`, { cache: 'no-store' });
      if (getRes.ok) {
        const vpsRecords = await getRes.json();
        const vpsList = Array.isArray(vpsRecords) ? vpsRecords : (vpsRecords.records || []);
        vpsList.forEach(vr => {
          if (!vr || !vr.id) return;
          const exist = db.records.find(lr => lr.id === vr.id);
          if (!exist) {
            db.records.push(vr);
            pulledCount++;
          }
        });
        if (pulledCount > 0) {
          writeDB(db);
        }
      }
    } catch (pullErr) {
      console.warn('[VPS Sync] Pull warning:', pullErr.message);
    }

    res.json({
      success: true,
      vpsUrl: cfg.vps_url,
      pushedCount: pushData.savedCount || 0,
      pulledCount,
      message: 'Sinkronisasi offline dengan Cloud VPS berhasil'
    });
  } catch (syncErr) {
    console.warn('[VPS Sync] Error:', syncErr.message);
    res.status(502).json({
      success: false,
      error: 'Tidak dapat terhubung ke VPS: ' + syncErr.message,
      vpsUrl: cfg.vps_url
    });
  }
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
