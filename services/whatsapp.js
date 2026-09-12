/**
 * WhatsApp Multi-Device Engine (Baileys) untuk Rekam Medis PT ATI & Nafila Medika
 * Mode: Percakapan Tim Medis & Pasien (Tanpa AI Chatbot)
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch(e) {}

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage;
try {
  const baileys = require('@whiskeysockets/baileys');
  makeWASocket = baileys.default || baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  Browsers = baileys.Browsers;
  downloadMediaMessage = baileys.downloadMediaMessage;
} catch (e) {
  console.error('[WhatsApp Engine] Baileys module load error:', e.message);
}

class WhatsAppService {
  constructor() {
    this.io = null;
    this.onMessageReceivedCallback = null;

    this.sessions = {
      klinik: {
        id: 'klinik',
        deviceName: 'HP Klinik PT ATI & Nafila',
        number: '',
        status: 'DISCONNECTED', // 'DISCONNECTED' | 'CONNECTING' | 'SCAN_QR' | 'CONNECTED'
        battery: '100%',
        qrDataUrl: null,
        rawQr: null,
        lastSync: new Date().toLocaleTimeString('id-ID'),
        sock: null
      }
    };
  }

  setSocketIO(io) {
    this.io = io;
  }

  setOnMessageReceived(cb) {
    this.onMessageReceivedCallback = cb;
  }

  notifyStatusUpdate(sessionType = 'klinik') {
    if (!this.io) return;
    const s = this.sessions[sessionType];
    if (!s) return;
    this.io.emit('wa_session_status', {
      sessionType: sessionType,
      status: s.status,
      number: s.number,
      deviceName: s.deviceName,
      battery: s.battery,
      qrDataUrl: s.qrDataUrl,
      lastSync: s.lastSync
    });
  }

  async initEngine() {
    if (!makeWASocket) {
      console.warn('[WhatsApp Engine] Library Baileys belum terpasang. Mode simulasi aktif.');
      return;
    }

    console.log('[WhatsApp Engine] Menginisialisasi 1 Sesi WhatsApp HP Klinik PT ATI (Ringan & Cepat)...');
    await this.initSession('klinik');
  }

  async initSession(sessionType) {
    if (!makeWASocket || !useMultiFileAuthState) return;

    if (this.sessions[sessionType].sock) {
      try {
        this.sessions[sessionType].sock.ev.removeAllListeners();
        this.sessions[sessionType].sock.end();
      } catch (e) {}
      this.sessions[sessionType].sock = null;
    }

    const authFolder = path.join(__dirname, '..', 'auth_baileys', sessionType);
    if (!fs.existsSync(authFolder)) {
      fs.mkdirSync(authFolder, { recursive: true });
    }

    this.sessions[sessionType].status = 'CONNECTING';
    this.notifyStatusUpdate(sessionType);

    try {
      const { state, saveCreds } = await useMultiFileAuthState(authFolder);

      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
      });

      this.sessions[sessionType].sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log(`[WA ${sessionType.toUpperCase()}] Barcode QR baru diterima dari WhatsApp. Siap di-scan.`);
          try {
            const dataUrl = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
            this.sessions[sessionType].status = 'SCAN_QR';
            this.sessions[sessionType].qrDataUrl = dataUrl;
            this.sessions[sessionType].rawQr = qr;
            this.notifyStatusUpdate(sessionType);
            if (this.io) {
              this.io.emit('wa_qr', { sessionName: sessionType, qr: dataUrl });
              this.io.emit('wa_status', { sessionName: sessionType, isConnected: false, status: 'SCAN_QR' });
            }
          } catch (qrErr) {
            console.error(`[WA ${sessionType}] Gagal render barcode QR:`, qrErr);
          }
        }

        if (connection === 'open') {
          console.log(`[WA ${sessionType.toUpperCase()}] BERHASIL TERHUBUNG DENGAN WHATSAPP HP!`);
          this.sessions[sessionType].status = 'CONNECTED';
          this.sessions[sessionType].qrDataUrl = null;
          this.sessions[sessionType].rawQr = null;

          const rawId = sock.user?.id || '';
          const cleanNum = rawId.split(':')[0].split('@')[0];
          this.sessions[sessionType].number = '+' + cleanNum;
          this.sessions[sessionType].deviceName = sock.user?.name || 'HP Klinik PT ATI';
          this.sessions[sessionType].lastSync = new Date().toLocaleTimeString('id-ID');

          this.notifyStatusUpdate(sessionType);
          if (this.io) {
            this.io.emit('wa_status', { sessionName: sessionType, isConnected: true, status: 'CONNECTED', phone: this.sessions[sessionType].number });
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          console.log(`[WA ${sessionType.toUpperCase()}] Koneksi terputus (Status code: ${statusCode}). Logged out: ${isLoggedOut}`);

          if (isLoggedOut) {
            this.sessions[sessionType].status = 'DISCONNECTED';
            this.sessions[sessionType].qrDataUrl = null;
            this.sessions[sessionType].number = sessionType === 'klinik' ? '+62 813-9816-9819' : '+62 822-APOTEK';
            try {
              fs.rmSync(authFolder, { recursive: true, force: true });
            } catch (e) {}
            this.notifyStatusUpdate(sessionType);
            setTimeout(() => this.initSession(sessionType), 3000);
          } else {
            if (this.sessions[sessionType].status !== 'CONNECTED' && !this.sessions[sessionType].qrDataUrl) {
              this.sessions[sessionType].status = 'CONNECTING';
              this.notifyStatusUpdate(sessionType);
            }
            setTimeout(() => this.initSession(sessionType), 4000);
          }
        }
      });

      // Menerima pesan masuk dari pasien ATAU balasan petugas langsung dari HP fisik
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const m of messages) {
          if (!m.message) continue;
          if (m.key.remoteJid === 'status@broadcast') continue;
          if (m.key.remoteJid && m.key.remoteJid.endsWith('@g.us')) continue; // Abaikan pesan grup untuk privasi medis

          const isFromMe = !!m.key.fromMe;
          const remoteJid = m.key.remoteJid || '';
          const participant = m.key.participant || m.participant || '';
          const messageId = m.key.id;

          let senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '');
          let senderName = isFromMe ? 'Petugas' : (m.pushName || ('Pasien ' + senderPhone.slice(-4)));

          const actualMsg = m.message.ephemeralMessage?.message ||
                            m.message.viewOnceMessage?.message ||
                            m.message.viewOnceMessageV2?.message ||
                            m.message.documentWithCaptionMessage?.message ||
                            m.message;

          let text = actualMsg.conversation ||
                     actualMsg.extendedTextMessage?.text ||
                     actualMsg.imageMessage?.caption ||
                     actualMsg.documentMessage?.caption ||
                     '';

          let mediaUrl = null;
          let mediaType = null;
          let fileName = null;

          const uploadsDir = path.join(__dirname, '..', 'uploads');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

          // Tangani Foto / Gambar Masuk atau Keluar dari WhatsApp HP
          if (actualMsg.imageMessage) {
            mediaType = 'image';
            try {
              if (downloadMediaMessage) {
                const buffer = await downloadMediaMessage(m, 'buffer', {}, {
                  logger: pino({ level: 'silent' }),
                  reuploadRequest: sock.updateMediaMessage
                });
                const imgFileName = `wa_img_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
                fs.writeFileSync(path.join(uploadsDir, imgFileName), buffer);
                mediaUrl = `/uploads/${imgFileName}`;
                fileName = imgFileName;
                if (!text) text = isFromMe ? '[Foto Terkirim via HP]' : '[Foto WhatsApp Diterima]';
              }
            } catch (dlErr) {
              console.error(`[WA ${sessionType}] Gagal unduh foto:`, dlErr.message);
              if (!text) text = '[Foto WhatsApp]';
            }
          }

          // Tangani File Dokumen / PDF Masuk atau Keluar dari WhatsApp HP
          if (actualMsg.documentMessage) {
            mediaType = 'document';
            fileName = actualMsg.documentMessage.fileName || `dokumen_${Date.now()}.pdf`;
            try {
              if (downloadMediaMessage) {
                const buffer = await downloadMediaMessage(m, 'buffer', {}, {
                  logger: pino({ level: 'silent' }),
                  reuploadRequest: sock.updateMediaMessage
                });
                const cleanDocName = `wa_doc_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                fs.writeFileSync(path.join(uploadsDir, cleanDocName), buffer);
                mediaUrl = `/uploads/${cleanDocName}`;
                if (!text) text = `[Dokumen: ${fileName}]`;
              }
            } catch (dlErr) {
              console.error(`[WA ${sessionType}] Gagal unduh dokumen:`, dlErr.message);
              if (!text) text = `[Dokumen: ${fileName}]`;
            }
          }

          if (!text && !mediaUrl) continue;

          console.log(`[WA ${sessionType.toUpperCase()}] [${type}] ${isFromMe ? 'Balasan via HP ke' : 'Pesan dari'} ${senderName} (${remoteJid}): ${text}`);

          if (this.onMessageReceivedCallback) {
            this.onMessageReceivedCallback(sessionType, {
              senderPhone,
              senderName,
              text,
              rawJid: remoteJid,
              participant,
              mediaUrl,
              mediaType,
              fileName,
              isFromMe,
              messageId
            });
          }
        }
      });

    } catch (err) {
      console.error(`[WA ${sessionType}] Error saat inisialisasi sesi:`, err);
      this.sessions[sessionType].status = 'DISCONNECTED';
      this.notifyStatusUpdate(sessionType);
    }
  }

  // Kirim Pesan Real ke Nomor / JID WhatsApp Pasien (Mendukung Teks, Gambar, dan File Dokumen/PDF)
  async sendWhatsAppMessage(sessionType, targetDest, messageText, options = {}) {
    const session = this.sessions[sessionType] || this.sessions.klinik;
    const targetStr = (targetDest || '').toString().trim();
    if (!targetStr) return { success: false, error: 'Nomor/JID tujuan kosong' };

    let jid = targetStr;
    if (!jid.includes('@')) {
      let cleanPhone = jid.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('0')) {
        cleanPhone = '62' + cleanPhone.slice(1);
      }
      jid = `${cleanPhone}@s.whatsapp.net`;
    }

    if (session && session.sock && session.status === 'CONNECTED') {
      try {
        let sentRes;
        if (options.mediaBuffer && options.mediaType === 'image') {
          sentRes = await session.sock.sendMessage(jid, {
            image: options.mediaBuffer,
            caption: messageText || ''
          });
        } else if (options.mediaBuffer && (options.mediaType === 'document' || options.fileName)) {
          sentRes = await session.sock.sendMessage(jid, {
            document: options.mediaBuffer,
            mimetype: options.mimetype || 'application/pdf',
            fileName: options.fileName || 'dokumen.pdf',
            caption: messageText || ''
          });
        } else {
          sentRes = await session.sock.sendMessage(jid, { text: messageText });
        }

        console.log(`[WA ${sessionType.toUpperCase()}] Pesan terkirim ke JID: ${jid} (ID: ${sentRes?.key?.id})`);
        return { success: true, realSent: true, jid: jid, id: sentRes?.key?.id };
      } catch (err) {
        console.error(`[WA ${sessionType.toUpperCase()}] Gagal mengirim pesan ke JID ${jid}:`, err.message);
        return { success: false, realSent: false, error: err.message };
      }
    }

    console.log(`[WA ${sessionType.toUpperCase()} - MODE SIMULASI] Pesan tercatat untuk ${jid}: ${(messageText || '').slice(0, 60)}...`);
    return { success: true, realSent: false, simulated: true };
  }

  // Putuskan Tautan / Hubungkan Ulang
  async logoutSession(sessionType) {
    const session = this.sessions[sessionType];
    if (!session) return;

    const authFolder = path.join(__dirname, '..', 'auth_baileys', sessionType);

    try {
      if (session.sock) {
        await session.sock.logout().catch(() => {});
        session.sock = null;
      }
    } catch (e) {}

    try {
      fs.rmSync(authFolder, { recursive: true, force: true });
    } catch (e) {}

    session.status = 'DISCONNECTED';
    session.qrDataUrl = null;
    session.rawQr = null;
    session.number = sessionType === 'klinik' ? '+62 813-9816-9819' : '+62 822-APOTEK';
    this.notifyStatusUpdate(sessionType);

    setTimeout(() => this.initSession(sessionType), 2000);
  }
}

module.exports = new WhatsAppService();
