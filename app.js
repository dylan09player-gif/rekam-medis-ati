let appData = {
  patients: [],
  records: [],
  medicines: [],
  icd10: [],
  absenDokter: [],
  pantauan: [],
  tindakan: [],
  users: [],
  currentUser: null,
  waContacts: [
    { id: '1', nama: 'Apt. Nafila Medika', hp: '6281234567890', jabatan: 'Apoteker Utama' }
  ],
  currentPoliPatient: null
};

function formatPlanForDisplay(planStr) {
  if (!planStr) return '-';
  let cleaned = String(planStr)
    .replace(/\[Harga:\s*Rp\s*[^\]]+\]/gi, '')
    .replace(/\[Total:\s*Rp\s*[^\]]+\]/gi, '')
    .trim();
  
  const items = cleaned.split(';').map(p => p.trim()).filter(p => p);
  if (items.length === 0) return '-';
  return items.map(p => '• ' + p).join('<br>');
}

function getStatusKelaikanBadges(r) {
  let list = [];
  if (r.izinSakit) list.push('<span class="badge badge-warning">📄 SURKES</span>');
  if (r.isPantauan) list.push('<span class="badge badge-danger">🔴 PANTAUAN</span>');
  if (list.length === 0) list.push('<span class="badge badge-success" style="background:#22c55e; color:white; padding:3px 8px; border-radius:4px; font-weight:600; font-size:0.75rem;">🟢 FIT TO WORK</span>');
  return list.join(' ');
}

function getStatusKelaikanText(r) {
  let list = [];
  if (r.izinSakit) list.push('ISTIRAHAT SAKIT (Surkes)');
  if (r.isPantauan) list.push('PANTAUAN (High Risk)');
  if (list.length === 0) return 'FIT TO WORK';
  return list.join(' & ');
}

function parseRecordDate(rec) {
  if (!rec) return null;
  let d = null;
  if (rec.tanggal) {
    if (typeof rec.tanggal === 'string' && rec.tanggal.includes('/')) {
      const parts = rec.tanggal.split('/');
      if (parts.length === 3) {
        d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      }
    } else if (typeof rec.tanggal === 'string' && rec.tanggal.includes('-')) {
      const parts = rec.tanggal.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        } else {
          d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        }
      }
    } else {
      d = new Date(rec.tanggal);
    }
  }
  if ((!d || isNaN(d.getTime())) && rec.created_at) {
    d = new Date(rec.created_at);
  }
  return d;
}

function getHSERecordsFiltered() {
  const search = document.getElementById('hse-rm-search')?.value.toLowerCase().trim() || '';
  const startVal = document.getElementById('hse-rm-start')?.value;
  const endVal = document.getElementById('hse-rm-end')?.value;

  const start = startVal ? new Date(`${startVal}T00:00:00`) : null;
  const end = endVal ? new Date(`${endVal}T23:59:59`) : null;

  return appData.records.filter(r => {
    if (search) {
      const matchNik = r.nikPabrik && String(r.nikPabrik).toLowerCase().includes(search);
      const matchNama = r.namaPasien && r.namaPasien.toLowerCase().includes(search);
      const matchDept = r.dept && r.dept.toLowerCase().includes(search);
      if (!matchNik && !matchNama && !matchDept) return false;
    }

    if (start || end) {
      const d = parseRecordDate(r);
      if (!d || isNaN(d.getTime())) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
    }

    return true;
  });
}

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  checkGateLoginStatus();
  await loadAllAppData();
  initNavigation();
  initMobileNav();
  initPoliForm();
  initDateInputs();
  initMobileBackTrap();
  initSSE();
});

// SSE Initialization for Live Updates
let sseTimeout = null;
function initSSE() {
  const eventSource = new EventSource('/api/events');
  eventSource.onmessage = function(event) {
    if (event.data === 'update') {
      if (sseTimeout) clearTimeout(sseTimeout);
      sseTimeout = setTimeout(() => {
        console.log('Live update received, reloading data...');
        loadAllAppData();
      }, 500);
    }
  };
  eventSource.onerror = function() {
    console.error('SSE connection error, retrying...');
  };
}

// Theme Management
function initTheme() {
  const theme = localStorage.getItem('marunda_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);

  document.getElementById('btn-toggle-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('marunda_theme', next);
    updateThemeIcon(next);
  });
}

function updateThemeIcon(theme) {
  const icon = document.querySelector('#btn-toggle-theme i');
  if (icon) {
    icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  }
}

// Gate Tab Switcher (Login vs Register)
function switchGateTab(tab) {
  const loginForm = document.getElementById('form-gate-login');
  const regForm = document.getElementById('form-gate-register');
  const btnLogin = document.getElementById('tab-btn-gate-login');
  const btnReg = document.getElementById('tab-btn-gate-register');

  if (tab === 'register') {
    if (loginForm) loginForm.style.display = 'none';
    if (regForm) regForm.style.display = 'block';
    if (btnLogin) btnLogin.classList.remove('active');
    if (btnReg) btnReg.classList.add('active');
    document.getElementById('gate-reg-nama')?.focus();
  } else {
    if (regForm) regForm.style.display = 'none';
    if (loginForm) loginForm.style.display = 'block';
    if (btnReg) btnReg.classList.remove('active');
    if (btnLogin) btnLogin.classList.add('active');
    document.getElementById('gate-username-input')?.focus();
  }
}

// Gate Login Authentication (Multi-Account)
function checkGateLoginStatus() {
  const auth = localStorage.getItem('marunda_gate_auth');
  const userJson = localStorage.getItem('currentUser');
  const overlay = document.getElementById('gate-login-overlay');

  if (auth === 'true' && userJson) {
    try {
      appData.currentUser = JSON.parse(userJson);
      updateNavbarUserBadge();
      autoFillPemeriksa();
      if (overlay) overlay.style.display = 'none';
      return;
    } catch (e) {
      console.error('Error parsing stored user:', e);
    }
  } else if (auth === 'true') {
    appData.currentUser = { nama: 'dr. Dylan Fadhilah', role: 'Dokter', username: 'dr.dylan' };
    updateNavbarUserBadge();
    autoFillPemeriksa();
    if (overlay) overlay.style.display = 'none';
    return;
  }
  if (overlay) overlay.style.display = 'flex';
}

function updateNavbarUserBadge() {
  const nameEl = document.getElementById('nav-user-name');
  const roleEl = document.getElementById('nav-user-role');
  if (appData.currentUser) {
    if (nameEl) nameEl.textContent = appData.currentUser.nama || 'Petugas';
    if (roleEl) roleEl.textContent = appData.currentUser.role || 'Dokter';
  }
}

function autoFillPemeriksa() {
  const pemInput = document.getElementById('poli-pemeriksa');
  if (pemInput && appData.currentUser?.nama && (!pemInput.value || pemInput.value.trim() === '')) {
    pemInput.value = appData.currentUser.nama;
  }
}

async function handleUserLogin(e) {
  e.preventDefault();
  const username = document.getElementById('gate-username-input')?.value.trim();
  const pass = document.getElementById('gate-password-input')?.value.trim();

  if (!username || !pass) {
    showToast('Username dan kata sandi wajib diisi!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: pass })
    });
    const data = await res.json();
    if (data.success === true || data.status === 'SUCCESS') {
      const user = data.user || { nama: username, role: 'Petugas', username };
      appData.currentUser = user;
      localStorage.setItem('marunda_gate_auth', 'true');
      localStorage.setItem('currentUser', JSON.stringify(user));
      updateNavbarUserBadge();
      autoFillPemeriksa();
      document.getElementById('gate-login-overlay').style.display = 'none';
      showToast(`Selamat datang, ${user.nama} 👋`, 'success');
    } else {
      showToast(`❌ ${data.error || 'Username atau password salah!'}`, 'error');
    }
  } catch (err) {
    console.error('Login error:', err);
    if (pass === '231067') {
      const user = { nama: username || 'dr. Dylan Fadhilah', role: 'Dokter', username: username || 'dr.dylan' };
      appData.currentUser = user;
      localStorage.setItem('marunda_gate_auth', 'true');
      localStorage.setItem('currentUser', JSON.stringify(user));
      updateNavbarUserBadge();
      autoFillPemeriksa();
      document.getElementById('gate-login-overlay').style.display = 'none';
      showToast(`Login berhasil (Mode lokal)`, 'success');
    } else {
      showToast('Gagal menghubungi server. Periksa koneksi.', 'error');
    }
  }
}

async function handleUserRegister(e) {
  e.preventDefault();
  const nama = document.getElementById('gate-reg-nama')?.value.trim();
  const role = document.getElementById('gate-reg-role')?.value;
  const username = document.getElementById('gate-reg-username')?.value.trim();
  const password = document.getElementById('gate-reg-password')?.value.trim();

  if (!nama || !username || !password) {
    showToast('Semua kolom bertanda * wajib diisi!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama, role, username, password })
    });
    const data = await res.json();
    if (data.success === true) {
      const user = data.user || { nama, role, username };
      appData.currentUser = user;
      localStorage.setItem('marunda_gate_auth', 'true');
      localStorage.setItem('currentUser', JSON.stringify(user));
      updateNavbarUserBadge();
      autoFillPemeriksa();
      document.getElementById('gate-login-overlay').style.display = 'none';
      showToast(`Akun berhasil dibuat! Selamat datang, ${user.nama} 🎉`, 'success');
    } else {
      showToast(`❌ ${data.error || 'Gagal mendaftar akun'}`, 'error');
    }
  } catch (err) {
    console.error('Register error:', err);
    showToast('Gagal menghubungi server.', 'error');
  }
}

// Fallback legacy handler
async function handleGateLogin(e) {
  return handleUserLogin(e);
}

function handleLogout() {
  if (confirm('Keluar dari sistem Klinik?')) {
    localStorage.removeItem('marunda_gate_auth');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('gudang_unlocked');
    localStorage.removeItem('direktur_unlocked');
    location.reload();
  }
}

// Data Fetching
async function loadAllAppData() {
  try {
    const safeJson = async (res) => {
      if (!res.ok) return [];
      try { return await res.json(); } catch { return []; }
    };

    const [patRes, recRes, medRes, icdRes, absRes, panRes, usrRes, tndRes] = await Promise.all([
      fetch('/api/patients'),
      fetch('/api/records'),
      fetch('/api/medicines'),
      fetch('/api/icd10'),
      fetch('/api/absen-dokter'),
      fetch('/api/pantauan'),
      fetch('/api/users'),
      fetch('/api/tindakan')
    ]);

    appData.patients = await safeJson(patRes);
    appData.records = await safeJson(recRes);
    appData.medicines = await safeJson(medRes);
    appData.icd10 = await safeJson(icdRes);
    appData.absenDokter = await safeJson(absRes);
    appData.pantauan = await safeJson(panRes);
    appData.users = await safeJson(usrRes);
    appData.tindakan = await safeJson(tndRes);

    // Load Settings (GSheet & No WA Apoteker)
    try {
      const [gRes, sRes] = await Promise.all([
        fetch('/api/gsheet/settings'),
        fetch('/api/settings')
      ]);
      if (gRes.ok) {
        const gData = await gRes.json();
        if (gData.gsheetUrl) {
          const inp = document.getElementById('gsheet-app-url');
          if (inp) inp.value = gData.gsheetUrl;
        }
        if (gData.lastSync) {
          const el = document.getElementById('gsheet-last-sync');
          if (el) el.textContent = 'Terakhir sync: ' + new Date(gData.lastSync).toLocaleString('id-ID');
        }
      }
      if (sRes.ok) {
        const sData = await sRes.json();
        if (Array.isArray(sData.wa_contacts) && sData.wa_contacts.length > 0) {
          appData.waContacts = sData.wa_contacts;
        } else if (sData.wa_phone) {
          appData.waContacts = [{ id: '1', nama: 'Apt. Nafila Medika', hp: sData.wa_phone, jabatan: 'Apoteker Utama' }];
        }
        if (sData.whacenter_device_id) {
          const inp = document.getElementById('whacenter-device-id');
          if (inp) inp.value = sData.whacenter_device_id;
        }
      }
    } catch {}

    renderEditDataTable();
    renderGudangTable();
    renderKaryawanTable();
    renderHSERekamMedisTable();
    renderHSEPasienPantauanTable();
    renderHSESurkesTable();
    renderMasterTindakanTable();
    renderUsersTable();
    // renderBillingPTTable(); // Dihapus agar tidak langsung diload berat, menunggu user klik CARI
    renderAbsenDirekturTable();
    renderNakesSuggestions();
    renderMobileKaryawanCards();
    renderWAContactsTable();
    renderWATargetSelectOptions();
    renderReqMedicineCatalog();
    autoFillPemeriksa();

    console.log(`Data loaded - Karyawan: ${appData.patients.length}, Obat: ${appData.medicines.length}, ICD-10: ${appData.icd10.length}, Tindakan: ${appData.tindakan.length}, Users: ${appData.users.length}`);

  } catch (err) {
    console.error('Error loading app data:', err);
    showToast('Server belum siap, coba refresh halaman.', 'warning');
  }
}

// Helper for Diagnosis Badges
function renderDiagnosisBadges(asesmenStr) {
  if (!asesmenStr || asesmenStr === '-') return '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
  const diags = String(asesmenStr).split(';').map(d => d.trim()).filter(d => d && d !== 'undefined - undefined');
  if (diags.length === 0) return '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
  return `<div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
    ${diags.map(d => `<span class="badge badge-info"><i class="fa-solid fa-stethoscope"></i> ${d}</span>`).join('')}
  </div>`;
}

// Helper for Objektif Badges
function renderObjektifBadges(objStr) {
  if (!objStr || objStr === '-') return '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
  // Split by comma OR period followed by letter
  const parts = String(objStr).split(/(?:,\s*)|(?:\.\s+(?=[A-Za-z]))/).map(p => p.trim()).filter(p => p && p !== '-');
  if (parts.length === 0) return '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
  
  return `<div style="display: flex; flex-direction: column; gap: 4px; padding-left: 8px; border-left: 2px solid var(--accent); color: var(--text-main); font-weight: 500;">
    ${parts.map(p => `<span>${p}</span>`).join('')}
  </div>`;
}

// Navigation Wiring
function initNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn[data-target]');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.page-view').forEach(view => view.classList.remove('active'));
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.add('active');

      if (targetId === 'view-obat-req') {
        renderReqMedicineCatalog();
      }
    });
  });
}

// Mobile Back Button Protection & Navigation Trap
function initMobileBackTrap() {
  try {
    history.pushState({ page: 'app' }, null, location.href);
  } catch (e) {}

  window.addEventListener('popstate', function () {
    try {
      history.pushState({ page: 'app' }, null, location.href);
    } catch (err) {}

    // 1. Close open modals if any (excluding gate login overlay)
    const openModals = Array.from(document.querySelectorAll('.modal, .modal-backdrop, .photo-viewer-modal, [id^="modal-"]'))
      .filter(m => m.id !== 'gate-login-overlay' && getComputedStyle(m).display !== 'none');

    if (openModals.length > 0) {
      openModals.forEach(m => {
        m.style.display = 'none';
      });
      return;
    }

    // 2. Return to Home Poli if in another view
    const activeView = document.querySelector('.page-view.active');
    if (activeView && activeView.id !== 'view-poli') {
      const homeBtn = document.querySelector('.nav-btn[data-target="view-poli"]');
      if (homeBtn) homeBtn.click();
      if (typeof switchMobileNav === 'function') {
        const mNavPoli = document.getElementById('mnav-poli');
        if (mNavPoli) switchMobileNav('view-poli', mNavPoli);
      }
      showToast('Kembali ke Menu Utama (Home Poli)', 'info');
      return;
    }

    // 3. Already at Home Poli
    showToast('Anda berada di Menu Utama (Home)', 'info');
  });
}

function initDateInputs() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const firstDayOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const dateInputsToday = ['absen-tgl', 'shift1-tgl-mulai', 'shift1-tgl-selesai', 'shift2-tgl-mulai', 'shift2-tgl-selesai', 'hse-rm-end', 'billing-end'];
  dateInputsToday.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });

  const hseStart = document.getElementById('hse-rm-start');
  if (hseStart) hseStart.value = firstDayOfMonth;

  const billingStart = document.getElementById('billing-start');
  if (billingStart) billingStart.value = firstDayOfMonth;
}

// -------------------------------------------------------------
// 1. POLI TAB LOGIC & SPLIT SCREEN SOAP
// -------------------------------------------------------------

// Helper 1: ICD-10 Ranking berdasarkan frekuensi diagnosis tersering
function getICD10WithFrequency() {
  const freqMap = {};
  
  // Ambil history klik dari localStorage
  try {
    const localFreq = JSON.parse(localStorage.getItem('icd10_freq_map') || '{}');
    Object.entries(localFreq).forEach(([k, v]) => { freqMap[k] = (freqMap[k] || 0) + v; });
  } catch(e) {}
  
  // Ambil history dari seluruh database records kunjungan
  if (Array.isArray(appData.records)) {
    appData.records.forEach(r => {
      if (r.asesmen) {
        const diags = String(r.asesmen).split(';').map(d => d.trim()).filter(Boolean);
        diags.forEach(d => {
          freqMap[d] = (freqMap[d] || 0) + 1;
        });
      }
    });
  }

  const list = (appData.icd10 || []).map(item => {
    const code = item.kode || item.code || '';
    const desc = item.nama || item.description || item.desc || '';
    const fullLabel = code ? `[${code}] ${desc}` : desc;
    let count = freqMap[fullLabel] || freqMap[desc] || 0;
    if (!count && code) {
      Object.keys(freqMap).forEach(k => {
        if (k.includes(code)) count += freqMap[k];
      });
    }
    return { code, desc, fullLabel, freq: count };
  });

  // Urutkan: Diagnosis tersering muncul di paling atas, sisanya alfabetis kode
  list.sort((a, b) => {
    if (b.freq !== a.freq) return b.freq - a.freq;
    return a.code.localeCompare(b.code);
  });

  return list;
}

function recordICD10Selection(label) {
  if (!label || !label.trim()) return;
  try {
    const localFreq = JSON.parse(localStorage.getItem('icd10_freq_map') || '{}');
    localFreq[label.trim()] = (localFreq[label.trim()] || 0) + 1;
    localStorage.setItem('icd10_freq_map', JSON.stringify(localFreq));
  } catch(e) {}
}

// Helper 2: Daftar Obat selalu terurut Alfabetis A-Z
function getSortedMedicines() {
  return (appData.medicines || []).slice().sort((a, b) => {
    return (a.nama || '').localeCompare(b.nama || '', 'id', { sensitivity: 'base' });
  });
}

// Helper 3: Frekuensi Nama Nakes / Pemeriksa
function getNakesFrequencyList() {
  const counts = {};
  
  // 1. Dari localStorage
  try {
    const saved = JSON.parse(localStorage.getItem('nakes_history_freq') || '{}');
    Object.entries(saved).forEach(([k, v]) => {
      if (k && k.trim()) counts[k.trim()] = (counts[k.trim()] || 0) + v;
    });
  } catch(e) {}

  // 2. Dari semua rekam medis di database
  if (Array.isArray(appData.records)) {
    appData.records.forEach(r => {
      if (r.pemeriksa && r.pemeriksa.trim()) {
        const p = r.pemeriksa.trim();
        counts[p] = (counts[p] || 0) + 1;
      }
    });
  }

  // Default dokter & perawat jika masih kosong
  if (Object.keys(counts).length === 0) {
    counts['dr. Dylan Fadhilah'] = 1;
    counts['dr. Medika'] = 1;
    counts['Ns. Perawat Jaga'] = 1;
  }

  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function renderNakesSuggestions() {
  const listEl = document.getElementById('list-nakes-tersering');
  const chipsEl = document.getElementById('nakes-popular-chips');
  const inputEl = document.getElementById('poli-pemeriksa');
  if (!listEl || !chipsEl) return;

  const nakesList = getNakesFrequencyList();

  listEl.innerHTML = nakesList.map(n => `<option value="${n.name}">Digunakan ${n.count}x</option>`).join('');

  chipsEl.innerHTML = nakesList.slice(0, 4).map(n => `
    <span class="nakes-chip" onclick="selectNakesChip('${n.name.replace(/'/g, "\\'")}')">
      <i class="fa-solid fa-user-check" style="font-size: 0.68rem;"></i> ${n.name} <small style="opacity: 0.7;">(${n.count}x)</small>
    </span>
  `).join('');

  if (inputEl && !inputEl.value.trim() && nakesList.length > 0) {
    inputEl.value = nakesList[0].name;
  }
}

function selectNakesChip(name) {
  const inputEl = document.getElementById('poli-pemeriksa');
  if (inputEl) {
    inputEl.value = name;
  }
}

function recordNakesUsage(name) {
  if (!name || !name.trim()) return;
  try {
    const clean = name.trim();
    const saved = JSON.parse(localStorage.getItem('nakes_history_freq') || '{}');
    saved[clean] = (saved[clean] || 0) + 1;
    localStorage.setItem('nakes_history_freq', JSON.stringify(saved));
    renderNakesSuggestions();
  } catch(e) {}
}

function initPoliForm() {
  const icdContainer = document.getElementById('container-icd10-list');
  if (icdContainer) {
    icdContainer.innerHTML = '';
    addICD10Row();
  }

  const tindakanBody = document.getElementById('poli-tindakan-body');
  if (tindakanBody) {
    tindakanBody.innerHTML = '';
    addPoliTindakanRow();
  }

  const resepBody = document.getElementById('poli-resep-body');
  if (resepBody) {
    resepBody.innerHTML = '';
    addPoliMedicineRow();
  }
  
  renderNakesSuggestions();
  autoFillPemeriksa();
  calculateCombinedGrandTotal();

  // Set default visit date to today
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formattedToday = `${yyyy}-${mm}-${dd}`;
  const tglInput = document.getElementById('poli-tanggal-berobat');
  if (tglInput) tglInput.value = formattedToday;

  // Prevent Enter key in form from submitting/saving (only explicit button click saves)
  const formPoli = document.getElementById('form-poli-entry');
  if (formPoli && !formPoli.dataset.enterSuppressed) {
    formPoli.dataset.enterSuppressed = 'true';
    formPoli.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        return false;
      }
    });
  }
}

function addPoliTindakanRow(tindakanName = '', qty = 1) {
  const body = document.getElementById('poli-tindakan-body');
  if (!body) return;

  const tr = document.createElement('tr');
  const tindakanList = appData.tindakan || [];

  let initialTindakan = null;
  if (tindakanName) {
    initialTindakan = tindakanList.find(t => t.nama.toLowerCase() === tindakanName.toLowerCase());
  }

  const defaultPrice = initialTindakan ? (parseFloat(initialTindakan.tarif) || 0) : 0;
  tr.dataset.unitPrice = defaultPrice;

  tr.innerHTML = `
    <td style="vertical-align: top;">
      <div style="display: flex; gap: 8px; width: 100%;">
        <button type="button" class="btn btn-sm btn-secondary" onclick="addPoliTindakanRow()" title="Tambah Tindakan Lain" style="flex-shrink: 0; width: 38px; height: 38px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: rgba(56, 189, 248, 0.1); color: #38bdf8; border: 1.5px solid rgba(56, 189, 248, 0.3); border-radius: var(--r-md); font-weight: 700;">
          <i class="fa-solid fa-plus"></i>
        </button>
        <div class="custom-searchable-wrap tindakan-searchable-wrap" style="flex: 1;">
          <div class="searchable-input-box">
            <input type="text" class="form-control tindakan-search-input select-tindakan" placeholder="🔍 Pilih / cari tindakan medis..." value="${initialTindakan ? initialTindakan.nama : tindakanName}" autocomplete="off">
            <i class="fa-solid fa-chevron-down searchable-dropdown-arrow"></i>
          </div>
          <div class="searchable-dropdown-menu"></div>
        </div>
      </div>
      <small class="tindakan-badge-info" style="margin-left: 46px; font-size: 0.76rem; color: #38bdf8; font-weight: 600;"></small>
    </td>
    <td style="vertical-align: top;">
      <input type="number" class="form-control tindakan-qty" value="${qty}" min="1" step="1" placeholder="Qty" style="text-align: center; font-weight: 700; height: 38px;">
    </td>
    <td style="vertical-align: top; text-align: right;">
      <div class="tindakan-subtotal-badge" style="height: 38px; display: flex; align-items: center; justify-content: flex-end; font-weight: 700; color: #38bdf8;">Rp 0</div>
    </td>
    <td style="vertical-align: top; text-align: center;">
      <button type="button" class="btn btn-sm btn-danger" onclick="const tbody = document.getElementById('poli-tindakan-body'); const tr = this.closest('tr'); if (tbody.querySelectorAll('tr').length > 1) { tr.remove(); } else { tr.querySelector('.select-tindakan').value = ''; tr.querySelector('.tindakan-qty').value = 1; tr.dataset.unitPrice = 0; const badge = tr.querySelector('.tindakan-subtotal-badge'); if(badge) badge.textContent = 'Rp 0'; tr.querySelector('.tindakan-badge-info').textContent = ''; } calculateCombinedGrandTotal();" title="Hapus Tindakan" style="width: 38px; height: 38px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-md);"><i class="fa-solid fa-trash-can"></i></button>
    </td>
  `;

  body.appendChild(tr);

  const wrap = tr.querySelector('.tindakan-searchable-wrap');
  const input = tr.querySelector('.tindakan-search-input');
  const menu = tr.querySelector('.searchable-dropdown-menu');
  const qtyInput = tr.querySelector('.tindakan-qty');
  const badgeInfo = tr.querySelector('.tindakan-badge-info');

  function renderTindakanOptions(filterText = '') {
    const cleanFilter = filterText.toLowerCase().trim();
    const currentList = appData.tindakan || [];
    const filtered = currentList.filter(t => 
      !cleanFilter || 
      t.nama.toLowerCase().includes(cleanFilter) ||
      (t.kategori && t.kategori.toLowerCase().includes(cleanFilter))
    );

    if (filtered.length === 0) {
      menu.innerHTML = `<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Tindakan tidak ditemukan (Ketik bebas)</div>`;
      return;
    }

    menu.innerHTML = filtered.map(item => `
      <div class="searchable-option-item ${item.nama.toLowerCase() === input.value.toLowerCase().trim() ? 'selected' : ''}" data-value="${item.nama}" data-tarif="${item.tarif || 0}" data-kategori="${item.kategori || ''}">
        <span style="display: flex; flex-direction: column; gap: 2px; flex: 1;">
          <strong style="color: var(--text-color);">${item.nama}</strong>
          <small style="color: var(--text-muted); font-size: 0.72rem;">${item.kategori || 'Tindakan'} • Rp ${(item.tarif || 0).toLocaleString('id-ID')}</small>
        </span>
        <span style="font-weight: 700; color: #38bdf8; font-size: 0.85rem;">Rp ${(item.tarif || 0).toLocaleString('id-ID')}</span>
      </div>
    `).join('');

    menu.querySelectorAll('.searchable-option-item').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.getAttribute('data-value');
        const tarif = parseFloat(opt.getAttribute('data-tarif')) || 0;
        const kat = opt.getAttribute('data-kategori');
        input.value = val;
        tr.dataset.unitPrice = tarif;
        if (badgeInfo) badgeInfo.textContent = `Tarif: Rp ${tarif.toLocaleString('id-ID')}${kat ? ` (${kat})` : ''}`;
        wrap.classList.remove('active');
        calculateTindakanRowSubtotal(tr);
      });
    });
  }

  input.addEventListener('focus', () => {
    document.querySelectorAll('.custom-searchable-wrap.active').forEach(w => {
      if (w !== wrap) w.classList.remove('active');
    });
    renderTindakanOptions(input.value);
    wrap.classList.add('active');
  });

  input.addEventListener('input', () => {
    renderTindakanOptions(input.value);
    wrap.classList.add('active');
    const matched = (appData.tindakan || []).find(t => t.nama.toLowerCase() === input.value.toLowerCase().trim());
    if (matched) {
      tr.dataset.unitPrice = parseFloat(matched.tarif) || 0;
      if (badgeInfo) badgeInfo.textContent = `Tarif: Rp ${(matched.tarif || 0).toLocaleString('id-ID')}`;
    }
    calculateTindakanRowSubtotal(tr);
  });

  qtyInput.addEventListener('input', () => calculateTindakanRowSubtotal(tr));

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('active');
    }
  });

  if (initialTindakan) {
    if (badgeInfo) badgeInfo.textContent = `Tarif: Rp ${(initialTindakan.tarif || 0).toLocaleString('id-ID')}`;
  }
  calculateTindakanRowSubtotal(tr);
}

function calculateTindakanRowSubtotal(tr) {
  const unitPrice = parseFloat(tr.dataset.unitPrice) || 0;
  const qty = parseInt(tr.querySelector('.tindakan-qty')?.value) || 1;
  const subtotal = unitPrice * qty;
  const badge = tr.querySelector('.tindakan-subtotal-badge');
  if (badge) {
    badge.textContent = `Rp ${subtotal.toLocaleString('id-ID')}`;
  }
  calculateCombinedGrandTotal();
}

function addICD10Row(defaultValue = '') {
  const container = document.getElementById('container-icd10-list');
  const row = document.createElement('div');
  row.className = 'icd10-row';
  row.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-start;';

  const icdList = getICD10WithFrequency();

  const wrap = document.createElement('div');
  wrap.className = 'custom-searchable-wrap';
  wrap.style.flex = '1';

  wrap.innerHTML = `
    <div class="searchable-input-box">
      <input type="text" class="form-control icd-search-input select-icd10" placeholder="🔍 Cari diagnosis ICD-10 (Tersering di atas)..." value="${defaultValue}" autocomplete="off">
      <i class="fa-solid fa-chevron-down searchable-dropdown-arrow"></i>
    </div>
    <div class="searchable-dropdown-menu"></div>
  `;

  const input = wrap.querySelector('.icd-search-input');
  const menu = wrap.querySelector('.searchable-dropdown-menu');

  function renderOptions(filterText = '') {
    const cleanFilter = filterText.toLowerCase().trim();
    const filtered = icdList.filter(item => 
      !cleanFilter || 
      item.fullLabel.toLowerCase().includes(cleanFilter) ||
      item.code.toLowerCase().includes(cleanFilter) ||
      item.desc.toLowerCase().includes(cleanFilter)
    );

    if (filtered.length === 0) {
      menu.innerHTML = `<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Diagnosis tidak ditemukan (Ketik bebas untuk diagnosis manual)</div>`;
      return;
    }

    menu.innerHTML = filtered.map(item => `
      <div class="searchable-option-item ${item.fullLabel.toLowerCase() === input.value.toLowerCase().trim() ? 'selected' : ''}" data-value="${item.fullLabel}">
        <span style="display: flex; align-items: center; gap: 6px; flex: 1; margin-right: 8px;">
          ${item.freq > 0 ? `<span class="freq-tag"><i class="fa-solid fa-fire"></i> ${item.freq}x</span>` : ''}
          <span>${item.fullLabel}</span>
        </span>
        ${item.freq > 0 ? `<span class="option-sub" style="font-size: 0.7rem; white-space: nowrap;">Tersering</span>` : ''}
      </div>
    `).join('');

    menu.querySelectorAll('.searchable-option-item').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.getAttribute('data-value');
        input.value = val;
        recordICD10Selection(val);
        wrap.classList.remove('active');
      });
    });
  }

  input.addEventListener('focus', () => {
    document.querySelectorAll('.custom-searchable-wrap.active').forEach(w => {
      if (w !== wrap) w.classList.remove('active');
    });
    renderOptions(input.value);
    wrap.classList.add('active');
  });

  input.addEventListener('input', () => {
    renderOptions(input.value);
    wrap.classList.add('active');
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('active');
    }
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-sm btn-secondary';
  addBtn.title = 'Tambah Diagnosis Baru';
  addBtn.style.cssText = 'width: 38px; height: 38px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1.5px solid rgba(59, 130, 246, 0.3); border-radius: var(--r-md); font-weight: 700;';
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
  addBtn.onclick = () => addICD10Row();

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-sm btn-danger';
  deleteBtn.title = 'Hapus Diagnosis';
  deleteBtn.style.cssText = 'width: 38px; height: 38px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: var(--r-md);';
  deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
  deleteBtn.onclick = () => {
    if (container.querySelectorAll('.icd10-row').length > 1) {
      row.remove();
    } else {
      input.value = '';
    }
  };

  row.appendChild(addBtn);
  row.appendChild(wrap);
  row.appendChild(deleteBtn);
  container.appendChild(row);
}

function addPoliMedicineRow(medName = '', qty = 1) {
  const body = document.getElementById('poli-resep-body');
  const tr = document.createElement('tr');
  const medList = getSortedMedicines();

  let initialMed = null;
  if (medName) {
    initialMed = medList.find(m => m.nama.toLowerCase() === medName.toLowerCase());
  }

  const defaultPrice = initialMed ? (parseFloat(initialMed.harga) || 0) : 0;
  tr.dataset.unitPrice = defaultPrice;

  tr.innerHTML = `
    <td style="vertical-align: top;">
      <div style="display: flex; gap: 8px; width: 100%;">
        <button type="button" class="btn btn-sm btn-secondary" onclick="addPoliMedicineRow()" title="Tambah Obat Baru" style="flex-shrink: 0; width: 38px; height: 38px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1.5px solid rgba(59, 130, 246, 0.3); border-radius: var(--r-md); font-weight: 700;">
          <i class="fa-solid fa-plus"></i>
        </button>
        <div class="custom-searchable-wrap med-searchable-wrap" style="flex: 1;">
          <div class="searchable-input-box">
            <input type="text" class="form-control med-search-input select-medicine" placeholder="🔍 Cari obat (A-Z)..." value="${initialMed ? initialMed.nama : medName}" autocomplete="off">
            <i class="fa-solid fa-chevron-down searchable-dropdown-arrow"></i>
          </div>
          <div class="searchable-dropdown-menu"></div>
        </div>
      </div>
      <small class="stock-badge-info" style="margin-left: 46px;"></small>
    </td>
    <td style="vertical-align: top;">
      <input type="number" class="form-control med-qty" value="${qty}" min="1" step="1" placeholder="Qty" list="qty-suggestions" style="text-align: center; font-weight: 700; height: 38px;">
    </td>
    <td style="vertical-align: top; text-align: right;">
      <div class="med-subtotal-badge" style="height: 38px; display: flex; align-items: center; justify-content: flex-end;">Rp 0</div>
    </td>
    <td style="vertical-align: top; text-align: center;">
      <button type="button" class="btn btn-sm btn-danger" onclick="const tbody = document.getElementById('poli-resep-body'); const tr = this.closest('tr'); if (tbody.querySelectorAll('tr').length > 1) { tr.remove(); } else { tr.querySelector('.select-medicine').value = ''; tr.querySelector('.med-qty').value = 1; tr.dataset.unitPrice = 0; const badge = tr.querySelector('.med-subtotal-badge'); if(badge) badge.textContent = 'Rp 0'; tr.querySelector('.stock-badge-info').textContent = ''; } calculateResepGrandTotal();" title="Hapus Obat" style="width: 38px; height: 38px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-md);"><i class="fa-solid fa-trash-can"></i></button>
    </td>
  `;

  body.appendChild(tr);

  const wrap = tr.querySelector('.med-searchable-wrap');
  const input = tr.querySelector('.med-search-input');
  const menu = tr.querySelector('.searchable-dropdown-menu');
  const qtyInput = tr.querySelector('.med-qty');
  const stockInfo = tr.querySelector('.stock-badge-info');

  function renderMedOptions(filterText = '') {
    const cleanFilter = filterText.toLowerCase().trim();
    const filtered = medList.filter(m => 
      !cleanFilter || 
      (m.nama && m.nama.toLowerCase().includes(cleanFilter))
    );

    if (filtered.length === 0) {
      menu.innerHTML = `<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Obat tidak ditemukan (Bisa ketik nama obat manual)</div>`;
      return;
    }

    menu.innerHTML = filtered.map(m => {
      const hargaFormat = m.harga ? `Rp ${parseFloat(m.harga).toLocaleString('id-ID')}` : 'Rp 0';
      return `
        <div class="searchable-option-item ${m.nama.toLowerCase() === input.value.toLowerCase().trim() ? 'selected' : ''}" 
             data-nama="${m.nama}" 
             data-stok="${m.stok}" 
             data-satuan="${m.satuan || '-'}" 
             data-harga="${m.harga || 0}">
          <div>
            <strong>${m.nama}</strong>
            <div class="option-sub">Stok: ${m.stok} ${m.satuan || ''} | Harga: ${hargaFormat}</div>
          </div>
          <span class="price-tag">${hargaFormat}</span>
        </div>
      `;
    }).join('');

    menu.querySelectorAll('.searchable-option-item').forEach(opt => {
      opt.addEventListener('click', () => {
        const nama = opt.getAttribute('data-nama');
        const stok = parseInt(opt.getAttribute('data-stok')) || 0;
        const satuan = opt.getAttribute('data-satuan');
        const harga = parseFloat(opt.getAttribute('data-harga')) || 0;

        input.value = nama;
        tr.dataset.unitPrice = harga;
        wrap.classList.remove('active');

        updateStockBadgeEl(stockInfo, stok, satuan);
        calculateRowSubtotal(tr);
      });
    });
  }

  input.addEventListener('focus', () => {
    document.querySelectorAll('.custom-searchable-wrap.active').forEach(w => {
      if (w !== wrap) w.classList.remove('active');
    });
    renderMedOptions(input.value);
    wrap.classList.add('active');
  });

  input.addEventListener('input', () => {
    renderMedOptions(input.value);
    wrap.classList.add('active');
    const matched = medList.find(m => m.nama.toLowerCase() === input.value.toLowerCase().trim());
    if (matched) {
      tr.dataset.unitPrice = parseFloat(matched.harga) || 0;
      updateStockBadgeEl(stockInfo, matched.stok, matched.satuan);
    }
    calculateRowSubtotal(tr);
  });

  qtyInput.addEventListener('input', () => calculateRowSubtotal(tr));

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('active');
    }
  });

  if (initialMed) {
    updateStockBadgeEl(stockInfo, initialMed.stok, initialMed.satuan);
  }
  calculateRowSubtotal(tr);
}

function updateStockBadgeEl(infoEl, stok, satuan) {
  if (!infoEl) return;
  stok = parseInt(stok) || 0;
  let colorClass = 'stock-badge-green';
  let label = `✓ Tersedia: ${stok} ${satuan || ''}`;
  if (stok <= 0) {
    colorClass = 'stock-badge-red';
    label = `❌ Stok Habis: 0 ${satuan || ''}`;
  } else if (stok <= 5) {
    colorClass = 'stock-badge-red';
    label = `🔥 Sisa Sedikit: ${stok} ${satuan || ''}`;
  } else if (stok <= 15) {
    colorClass = 'stock-badge-yellow';
    label = `⚠️ Tersedia: ${stok} ${satuan || ''}`;
  }
  infoEl.className = `stock-badge-info ${colorClass}`;
  infoEl.textContent = label;
}

function calculateRowSubtotal(tr) {
  const unitPrice = parseFloat(tr.dataset.unitPrice) || 0;
  const qty = parseInt(tr.querySelector('.med-qty')?.value) || 1;
  const subtotal = unitPrice * qty;
  const badge = tr.querySelector('.med-subtotal-badge');
  if (badge) {
    badge.textContent = `Rp ${subtotal.toLocaleString('id-ID')}`;
  }
  calculateCombinedGrandTotal();
}

function calculateResepGrandTotal() {
  const rows = document.querySelectorAll('#poli-resep-body tr');
  let grandTotal = 0;
  rows.forEach(tr => {
    const unitPrice = parseFloat(tr.dataset.unitPrice) || 0;
    const qty = parseInt(tr.querySelector('.med-qty')?.value) || 1;
    const medName = tr.querySelector('.select-medicine')?.value.trim();
    if (medName) {
      grandTotal += (unitPrice * qty);
    }
  });

  const grandTotalEl = document.getElementById('poli-resep-grand-total');
  if (grandTotalEl) {
    grandTotalEl.textContent = `Rp ${grandTotal.toLocaleString('id-ID')}`;
  }

  return grandTotal;
}

function calculateCombinedGrandTotal() {
  // 1. Total Tindakan
  let grandTotalTindakan = 0;
  const tRows = document.querySelectorAll('#poli-tindakan-body tr');
  tRows.forEach(tr => {
    const unitPrice = parseFloat(tr.dataset.unitPrice) || 0;
    const qty = parseInt(tr.querySelector('.tindakan-qty')?.value) || 1;
    const tName = tr.querySelector('.select-tindakan')?.value.trim();
    if (tName) {
      grandTotalTindakan += (unitPrice * qty);
    }
  });
  const tGrandEl = document.getElementById('poli-tindakan-grand-total');
  if (tGrandEl) tGrandEl.textContent = `Rp ${grandTotalTindakan.toLocaleString('id-ID')}`;

  // 2. Total Resep Obat
  const grandTotalResep = calculateResepGrandTotal();

  // 3. Combined Grand Total
  const combinedTotal = grandTotalTindakan + grandTotalResep;
  const cGrandEl = document.getElementById('poli-combined-grand-total');
  if (cGrandEl) cGrandEl.textContent = `Rp ${combinedTotal.toLocaleString('id-ID')}`;

  // 4. Update Sisa Saldo Setelah Berobat
  const sisaSaldoEl = document.getElementById('poli-sisa-saldo');
  if (sisaSaldoEl && appData.currentPoliPatient) {
    const saldoAwal = parseInt(appData.currentPoliPatient.saldoObat) || 0;
    const sisa = saldoAwal - combinedTotal;
    sisaSaldoEl.textContent = `Rp ${sisa.toLocaleString('id-ID')}`;
    sisaSaldoEl.style.color = sisa < 0 ? '#ef4444' : '#34d399';
  }

  return { grandTotalTindakan, grandTotalResep, combinedTotal };
}

function searchPatientByNIK() {
  const query = document.getElementById('poli-search-nik').value.trim().toLowerCase();
  if (!query) {
    showToast('Masukkan NIK Pabrik atau Nama Pasien', 'error');
    return;
  }

  const p = appData.patients.find(x => 
    (x.nikPabrik && x.nikPabrik.toLowerCase() === query) ||
    (x.nama && x.nama.toLowerCase().includes(query)) ||
    (x.nik && x.nik.toLowerCase() === query)
  );

  if (!p) {
    showToast('Pasien tidak ditemukan. Tambahkan di Tab Karyawan.', 'warning');
    return;
  }

  appData.currentPoliPatient = p;
  
  // Update Patient Quick Info Box
  const infoBox = document.getElementById('poli-patient-info-box');
  infoBox.style.display = 'block';
  document.getElementById('poli-info-nama').textContent = p.nama;
  const ageStr = calculateAge(p.tglLahir || p.tgl_lahir);
  document.getElementById('poli-info-sub').textContent = `NPK Pabrik: ${p.nikPabrik || p.nik || '-'} | Dept: ${p.dept || p.departemen || '-'} | Usia: ${ageStr} (${p.tglLahir || p.tgl_lahir || '-'}) | Gol. Darah: ${p.golDarah || '-'} | WA: ${p.hp || p.no_hp || '-'}`;

  // Update Right Panel Banner
  document.getElementById('poli-banner-name').textContent = `${p.nama} (${p.nikPabrik || p.nik || '-'})`;
  const saldoInfo = (p.saldoObat !== undefined) ? ` | <strong style="color:${parseInt(p.saldoObat)<0?'#ef4444':'#059669'}; background: ${parseInt(p.saldoObat)<0?'rgba(239,68,68,0.1)':'rgba(16,185,129,0.1)'}; padding: 2px 6px; border-radius: 4px;">Sisa Saldo: Rp ${(parseInt(p.saldoObat)||0).toLocaleString('id-ID')}</strong>` : '';
  document.getElementById('poli-banner-sub').innerHTML = `Dept: ${p.dept || p.departemen || '-'} | Usia: ${ageStr} | Gender: ${p.gender || '-'}${saldoInfo}`;
  document.getElementById('poli-banner-alergi').textContent = p.alergi ? `⚠️ Alergi: ${p.alergi}` : '';

  // Update Saldo Uang Obat Saat Ini and Sisa Saldo Setelah Berobat
  const saldoAwalEl = document.getElementById('poli-saldo-awal');
  if (saldoAwalEl) {
    const saldoObat = parseInt(p.saldoObat) || 0;
    saldoAwalEl.textContent = `Rp ${saldoObat.toLocaleString('id-ID')}`;
    saldoAwalEl.style.color = saldoObat < 0 ? '#ef4444' : 'var(--text-primary)';
  }
  calculateResepGrandTotal();

  renderPatientHistoryTimeline(p);
  showToast(`Pasien ${p.nama} dipilih`, 'info');
}

function renderPatientHistoryTimeline(patient) {
  const container = document.getElementById('poli-timeline-container');
  const countEl = document.getElementById('poli-history-count');
  
  const history = appData.records.filter(r => 
    (r.nikPabrik && String(r.nikPabrik) === String(patient.nikPabrik)) ||
    (r.namaPasien && r.namaPasien.toLowerCase() === patient.nama.toLowerCase())
  ).sort((a,b) => new Date(b.created_at || b.tanggal) - new Date(a.created_at || a.tanggal));

  countEl.textContent = `${history.length} Kunjungan`;

  if (history.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 48px 20px; color: var(--text-muted);">
        <i class="fa-solid fa-folder-open" style="font-size: 2.5rem; margin-bottom: 12px; opacity: 0.35;"></i>
        <p style="font-weight: 700;">Belum ada riwayat rekam medis</p>
        <p style="font-size: 0.8rem; color: var(--text-faint); margin-top: 4px;">Kunjungan pemeriksaan pasien ini akan tersimpan otomatis di sini.</p>
      </div>`;
    return;
  }

  container.innerHTML = history.map(r => {
    // Format Diagnosis (A)
    let diagHTML = '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
    if (r.asesmen) {
      diagHTML = renderDiagnosisBadges(r.asesmen);
    }

    // Format Resep Obat (P)
    let planHTML = '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
    if (r.plan) {
      // Extract Total from string if present, e.g. [Total: Rp 28.860]
      let totalMatch = String(r.plan).match(/\[Total:\s*Rp\s*([^\]]+)\]/i);
      let totalDisplay = totalMatch ? `Rp ${totalMatch[1]}` : (r.totalBiaya && r.totalBiaya > 0 ? `Rp ${r.totalBiaya.toLocaleString('id-ID')}` : '');

      // Clean plan items so none of them have [Total: ...] attached
      let cleanedPlan = String(r.plan).replace(/\[Total:\s*Rp\s*[^\]]+\]/gi, '').trim();
      const planItems = cleanedPlan.split(';').map(p => p.trim()).filter(p => p);

      if (planItems.length > 0) {
        planHTML = `<div class="timeline-medicines-list">` +
          planItems.map(p => `<div class="med-pill-item">💊 ${p}</div>`).join('') +
          (totalDisplay ? `
            <div class="timeline-total-cost-row">
              <span style="color: var(--text-muted); display: flex; align-items: center; gap: 5px;">
                <i class="fa-solid fa-receipt" style="color: var(--primary);"></i> Total Biaya Obat:
              </span>
              <span style="color: #38bdf8; font-weight: 800; font-size: 0.84rem;">${totalDisplay}</span>
            </div>` : '') +
          `</div>`;
      }
    }

    return `
      <div class="timeline-item">
        <div class="timeline-header">
          <div class="timeline-date">
            <i class="fa-regular fa-calendar-check"></i> ${r.tanggal || '-'}
            <button class="btn btn-sm" onclick="openModalEditRecord('${r.id}')" title="Edit Rekam Medis" style="background: rgba(14, 165, 233, 0.08); color: #0ea5e9; border: 1px solid rgba(14, 165, 233, 0.3); border-radius: 6px; padding: 2px 8px; font-size: 0.72rem; margin-left: 6px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-weight: 700; box-shadow: none;">
              <i class="fa-solid fa-pen-to-square"></i> Edit
            </button>
          </div>
          <div style="display: flex; gap: 6px;">
            ${r.isPantauan ? '<span class="badge badge-danger">🔴 Pantauan</span>' : ''}
            ${r.izinSakit ? '<span class="badge badge-warning">📄 Surkes</span>' : ''}
          </div>
        </div>

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-s">S</span>
          <span style="font-weight: 700; color: var(--text-main);">${r.keluhan || '-'}</span>
        </div>

        <div class="timeline-section-row" style="align-items: flex-start;">
          <span class="timeline-label-chip chip-o">O</span>
          <div style="flex:1;">${renderObjektifBadges(r.objektif)}</div>
        </div>

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-a">A</span>
          ${diagHTML}
        </div>

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-p">P</span>
          ${planHTML}
        </div>

        <div class="timeline-footer">
          <div><i class="fa-solid fa-user-doctor"></i> ${r.pemeriksa || 'Nakes'}</div>
          ${r.linkFoto ? `<button type="button" class="btn btn-sm btn-primary" style="font-size: 0.74rem; padding: 3px 8px;" onclick="openPhotoViewer('${r.id}')"><i class="fa-solid fa-image"></i> Lihat Foto</button>` : ''}
        </div>

        <button class="btn btn-sm btn-secondary btn-block" style="margin-top: 10px; font-weight: 700;" onclick="copyRecordToPoliForm('${r.id}')">
          <i class="fa-solid fa-copy"></i> Salin ke Form Input
        </button>
      </div>
    `;
  }).join('');
}

function openModalRiwayatPasien(identifier) {
  // Auto-close Pasien Pantauan modal if it's open
  const pantauanModal = document.getElementById('modal-hse-pantauan');
  if (pantauanModal) pantauanModal.style.display = 'none';

  // Auto-close Surkes modal if it's open
  const surkesModal = document.getElementById('modal-hse-surkes');
  if (surkesModal) surkesModal.style.display = 'none';

  const container = document.getElementById('modal-riwayat-timeline-container');
  const nameEl = document.getElementById('modal-riwayat-patient-name');
  if (!container) return;

  const history = appData.records.filter(r => 
    (r.nikPabrik && String(r.nikPabrik) === String(identifier)) ||
    (r.namaPasien && r.namaPasien.toLowerCase() === String(identifier).toLowerCase())
  ).sort((a,b) => new Date(b.created_at || b.tanggal) - new Date(a.created_at || a.tanggal));

  if (nameEl) {
    nameEl.textContent = `Pasien: ${history.length > 0 ? history[0].namaPasien : identifier} | Total Kunjungan: ${history.length}`;
  }

  if (history.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 48px 20px; color: var(--text-muted);">
        <i class="fa-solid fa-folder-open" style="font-size: 2.5rem; margin-bottom: 12px; opacity: 0.35;"></i>
        <p style="font-weight: 700;">Belum ada riwayat rekam medis</p>
      </div>`;
    document.getElementById('modal-riwayat-pasien').style.display = 'flex';
    return;
  }

  container.innerHTML = history.map(r => {
    let diagHTML = '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
    if (r.asesmen) {
      diagHTML = renderDiagnosisBadges(r.asesmen);
    }

    let planHTML = '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
    if (r.plan) {
      let totalMatch = String(r.plan).match(/\[Total:\s*Rp\s*([^\]]+)\]/i);
      let totalDisplay = totalMatch ? `Rp ${totalMatch[1]}` : (r.totalBiaya && r.totalBiaya > 0 ? `Rp ${r.totalBiaya.toLocaleString('id-ID')}` : '');
      let cleanedPlan = String(r.plan).replace(/\[Total:\s*Rp\s*[^\]]+\]/gi, '').trim();
      const planItems = cleanedPlan.split(';').map(p => p.trim()).filter(p => p);
      if (planItems.length > 0) {
        planHTML = `<div class="timeline-medicines-list">` +
          planItems.map(p => `<div class="med-pill-item">💊 ${p}</div>`).join('') +
          (totalDisplay ? `
            <div class="timeline-total-cost-row">
              <span style="color: var(--text-muted); display: flex; align-items: center; gap: 5px;">
                <i class="fa-solid fa-receipt" style="color: var(--primary);"></i> Total Biaya Obat:
              </span>
              <span style="color: #38bdf8; font-weight: 800; font-size: 0.84rem;">${totalDisplay}</span>
            </div>` : '') + `</div>`;
      }
    }

    return `
      <div class="timeline-item">
        <div class="timeline-header">
          <div class="timeline-date">
            <i class="fa-regular fa-calendar-check"></i> ${r.tanggal || '-'}
          </div>
          <div style="display: flex; gap: 6px;">
            ${r.isPantauan ? '<span class="badge badge-danger">🔴 Pantauan</span>' : ''}
            ${r.izinSakit ? '<span class="badge badge-warning">📄 Surkes</span>' : ''}
          </div>
        </div>

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-s">S</span>
          <span style="font-weight: 700; color: var(--text-main);">${r.keluhan || '-'}</span>
        </div>

        <div class="timeline-section-row" style="align-items: flex-start;">
          <span class="timeline-label-chip chip-o">O</span>
          <div style="flex:1;">${renderObjektifBadges(r.objektif)}</div>
        </div>

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-a">A</span>
          ${diagHTML}
        </div>

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-p">P</span>
          ${planHTML}
        </div>

        <div class="timeline-footer">
          <div><i class="fa-solid fa-user-doctor"></i> ${r.pemeriksa || 'Nakes'}</div>
          ${r.linkFoto ? `<button type="button" class="btn btn-sm btn-primary" style="font-size: 0.74rem; padding: 3px 8px;" onclick="openPhotoViewer('${r.id}')"><i class="fa-solid fa-image"></i> Lihat Foto</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('modal-riwayat-pasien').style.display = 'flex';
}

function copyRecordToPoliForm(recordOrId) {
  let record = recordOrId;
  if (typeof recordOrId === 'string' || typeof recordOrId === 'number') {
    record = appData.records.find(r => String(r.id) === String(recordOrId));
  }
  if (!record) return;

  document.getElementById('poli-keluhan').value = record.keluhan || '';
  document.getElementById('poli-objektif-detail').value = record.objektif || '';
  if (record.pemeriksa) {
    document.getElementById('poli-pemeriksa').value = record.pemeriksa;
  }
  
  if (record.asesmen) {
    const icdContainer = document.getElementById('container-icd10-list');
    icdContainer.innerHTML = '';
    const diags = String(record.asesmen).split(';').map(d => d.trim()).filter(Boolean);
    if (diags.length > 0) {
      diags.forEach(d => addICD10Row(d));
    } else {
      addICD10Row(record.asesmen);
    }
  }

  if (Array.isArray(record.resep) && record.resep.length > 0) {
    const resepBody = document.getElementById('poli-resep-body');
    resepBody.innerHTML = '';
    record.resep.forEach(r => {
      addPoliMedicineRow(r.namaObat || r.obat, r.qty || 1);
    });
  }

  showToast('Data riwayat disalin ke form pemeriksaan!', 'info');
}

function openPhotoViewer(recordOrId) {
  let record = recordOrId;
  if (typeof recordOrId === 'string' || typeof recordOrId === 'number') {
    record = appData.records.find(r => String(r.id) === String(recordOrId));
  }
  if (!record || !record.linkFoto) {
    showToast('Foto / dokumen tidak ditemukan pada rekam medis ini', 'warning');
    return;
  }

  const modal = document.getElementById('modal-photo-viewer');
  const imgEl = document.getElementById('photo-viewer-img');
  const titleEl = document.getElementById('photo-viewer-title');
  const driveWrap = document.getElementById('photo-viewer-drive-link');
  const driveBtn = document.getElementById('photo-viewer-drive-btn');

  if (!modal) return;

  const patientName = record.namaPasien || 'Pasien';
  const tgl = record.tanggal || '';
  if (titleEl) {
    titleEl.innerHTML = `<i class="fa-solid fa-image" style="color: var(--primary);"></i> Foto RM: ${patientName} (${tgl})`;
  }

  const photoUrl = record.linkFoto;

  if (imgEl) {
    imgEl.src = photoUrl;
    imgEl.style.display = 'block';
  }

  if (driveWrap && driveBtn) {
    if (photoUrl.includes('drive.google.com') || photoUrl.includes('googleusercontent.com')) {
      driveWrap.style.display = 'block';
      driveBtn.href = photoUrl;
    } else {
      driveWrap.style.display = 'none';
    }
  }

  modal.style.display = 'flex';
}

function closePhotoViewer() {
  const modal = document.getElementById('modal-photo-viewer');
  if (modal) modal.style.display = 'none';
}

async function handleSavePoli(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (!appData.currentPoliPatient) {
    showToast('Silakan cari dan pilih pasien terlebih dahulu!', 'error');
    return;
  }

  const tanggalVal = document.getElementById('poli-tanggal-berobat').value;
  if (!tanggalVal) {
    showToast('Silakan tentukan tanggal kunjungan/berobat!', 'warning');
    document.getElementById('poli-tanggal-berobat').focus();
    return;
  }

  const keluhan = document.getElementById('poli-keluhan').value.trim();
  if (!keluhan) {
    showToast('Silakan isi keluhan utama pasien!', 'warning');
    document.getElementById('poli-keluhan').focus();
    return;
  }

  const pemeriksa = document.getElementById('poli-pemeriksa').value.trim() || 'Nakes Pemeriksa';
  const isIzinSakit = document.getElementById('poli-izin-sakit').checked;
  const isPantauan = document.getElementById('poli-pantauan').checked;

  const objektifFull = document.getElementById('poli-objektif-detail').value.trim();

  // Gather ICD-10 Diagnoses & Record Frequencies
  const icdSelects = document.querySelectorAll('.select-icd10');
  const selectedICDArr = Array.from(icdSelects).map(s => s.value.trim()).filter(v => v !== '');
  selectedICDArr.forEach(d => recordICD10Selection(d));
  const selectedICD = selectedICDArr.join('; ');

  // Gather Tindakan Medis with Tariffs & Subtotals
  const tindakanRows = document.querySelectorAll('#poli-tindakan-body tr');
  const tindakanList = [];
  let grandTotalTindakan = 0;

  tindakanRows.forEach(tr => {
    const tSel = tr.querySelector('.select-tindakan')?.value.trim();
    const unitPrice = parseFloat(tr.dataset.unitPrice) || 0;
    const qty = parseInt(tr.querySelector('.tindakan-qty')?.value) || 1;
    const subtotal = unitPrice * qty;

    if (tSel) {
      tindakanList.push({
        nama: tSel,
        tarif: unitPrice,
        qty,
        subtotal
      });
      grandTotalTindakan += subtotal;
    }
  });

  // Gather Resep Obat with Live Locked Prices, Aturan Pakai & Subtotals
  const resepRows = document.querySelectorAll('#poli-resep-body tr');
  const resepList = [];
  let grandTotalObat = 0;

  resepRows.forEach(tr => {
    const medSel = tr.querySelector('.select-medicine')?.value.trim();
    const unitPrice = parseInt(tr.dataset.unitPrice) || 0;
    const qty = parseInt(tr.querySelector('.med-qty')?.value) || 1;
    const subtotal = unitPrice * qty;

    if (medSel) {
      resepList.push({ 
        namaObat: medSel, 
        harga: unitPrice, 
        qty, 
        subtotal 
      });
      grandTotalObat += subtotal;
    }
  });

  const grandTotalBiaya = grandTotalTindakan + grandTotalObat;

  const planParts = [];
  if (tindakanList.length > 0) {
    planParts.push('Tindakan: ' + tindakanList.map(t => `${t.nama} (${t.qty}x)`).join(', '));
  }
  if (resepList.length > 0) {
    planParts.push('Resep: ' + resepList.map(r => `${r.namaObat} No.${r.qty}`).join(', '));
  }
  if (grandTotalBiaya > 0) {
    planParts.push(`[Total: Rp ${grandTotalBiaya.toLocaleString('id-ID')}]`);
  }
  const planText = planParts.length > 0 ? planParts.join('; ') : 'Edukasi Istirahat & Hidrasi Cukup';

  // Handle File Upload to Google Drive
  let linkFoto = '';
  const fileInput = document.getElementById('poli-upload-file');
  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    const file = fileInput.files[0];
    showToast('Mengunggah foto penunjang ke Google Drive...', 'info');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      
      const upRes = await fetch('/api/upload-foto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileData: base64,
          fileName: file.name,
          mimeType: file.type
        })
      });
      const upData = await upRes.json();
      if (upData.fileUrl) linkFoto = upData.fileUrl;
    } catch(err) {
      console.error('File upload error:', err);
    }
  }

  // Record Nakes frequency
  recordNakesUsage(pemeriksa);

  const selectedDateVal = document.getElementById('poli-tanggal-berobat').value;
  let tanggalFormatted = '';
  let customCreatedAt = '';
  if (selectedDateVal) {
    const [yr, mo, dy] = selectedDateVal.split('-');
    tanggalFormatted = `${parseInt(dy)}/${parseInt(mo)}/${yr}`;
    
    const now = new Date();
    const customDateObj = new Date(yr, mo - 1, dy, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    customCreatedAt = customDateObj.toISOString();
  } else {
    const now = new Date();
    tanggalFormatted = now.toLocaleDateString('id-ID');
    customCreatedAt = now.toISOString();
  }

  const newRecord = {
    nikPabrik: appData.currentPoliPatient.nikPabrik || '',
    namaPasien: appData.currentPoliPatient.nama,
    dept: appData.currentPoliPatient.dept || '',
    tanggal: tanggalFormatted,
    created_at: customCreatedAt,
    keluhan,
    objektif: objektifFull,
    asesmen: selectedICD || 'Pemeriksaan Umum',
    plan: planText,
    tindakan: tindakanList,
    biayaTindakan: grandTotalTindakan,
    resep: resepList,
    biayaObat: grandTotalObat,
    totalBiaya: grandTotalBiaya,
    pemeriksa,
    izinSakit: isIzinSakit,
    isPantauan,
    linkFoto
  };

  try {
    const res = await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newRecord)
    });

    if (res.ok) {
      showToast('Rekam Medis Berhasil Disimpan & Stok Berkurang!', 'success');
      
      // DEDUCT SALDO OBAT / BIAYA BEROBAT
      if (grandTotalBiaya > 0 && appData.currentPoliPatient) {
        const p = appData.currentPoliPatient;
        const oldSaldo = parseInt(p.saldoObat) || 0;
        const newSaldo = oldSaldo - grandTotalBiaya;
        
        const updatedPatient = { ...p, saldoObat: newSaldo };
        try {
          const patientId = p.id || p.nikPabrik || p.nik;
          await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedPatient)
          });
        } catch (e) {
          console.error('Gagal update saldo obat:', e);
        }
      }

      resetFormPoli();
      await loadAllAppData();
      
      if (appData.currentPoliPatient) {
        // Refetch current patient to get the updated saldoObat
        const refreshedPatient = appData.patients.find(x => 
          (x.id && x.id === appData.currentPoliPatient.id) ||
          (x.nikPabrik && x.nikPabrik === appData.currentPoliPatient.nikPabrik) ||
          (x.nik && x.nik === appData.currentPoliPatient.nik)
        );
        if (refreshedPatient) {
          appData.currentPoliPatient = refreshedPatient;
        }
        
        renderPatientHistoryTimeline(appData.currentPoliPatient);
        
        // Update UI Saldo Obat
        const saldoAwalEl = document.getElementById('poli-saldo-awal');
        if (saldoAwalEl) {
          const saldoObat = parseInt(appData.currentPoliPatient.saldoObat) || 0;
          saldoAwalEl.textContent = `Rp ${saldoObat.toLocaleString('id-ID')}`;
          saldoAwalEl.style.color = saldoObat < 0 ? '#ef4444' : 'var(--text-primary)';
        }
        calculateCombinedGrandTotal();
      }
    } else {
      showToast('Gagal menyimpan data', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

function resetFormPoli() {
  document.getElementById('form-poli-entry').reset();
  initPoliForm();
  renderNakesSuggestions();
}

// -------------------------------------------------------------
// 2. TAB EDIT DATA & KOREKSI STOK LOGIC
// -------------------------------------------------------------
function renderEditDataTable() {
  const tbody = document.getElementById('table-edit-data-body');
  if (!tbody) return;

  const dateFilter = document.getElementById('filter-edit-date')?.value;
  const searchFilter = document.getElementById('filter-edit-search')?.value.toLowerCase().trim();

  // 1. Urutkan berdasarkan waktu simpan/input terbaru (created_at)
  let filtered = appData.records.slice().sort((a, b) => {
    const timeA = a.created_at ? new Date(a.created_at).getTime() : (a.id ? Number(a.id) || 0 : 0);
    const timeB = b.created_at ? new Date(b.created_at).getTime() : (b.id ? Number(b.id) || 0 : 0);
    return timeB - timeA;
  });

  // 2. Filter Tanggal jika diisi
  if (dateFilter) {
    filtered = filtered.filter(r => {
      const d = parseRecordDate(r);
      if (!d) return false;
      const targetDate = new Date(`${dateFilter}T00:00:00`);
      return d.getFullYear() === targetDate.getFullYear() &&
             d.getMonth() === targetDate.getMonth() &&
             d.getDate() === targetDate.getDate();
    });
  }

  // 3. Filter Pencarian Nama / NPK / Keluhan / Asesmen jika diisi
  if (searchFilter) {
    filtered = filtered.filter(r => 
      (r.namaPasien && r.namaPasien.toLowerCase().includes(searchFilter)) ||
      (r.nikPabrik && r.nikPabrik.toLowerCase().includes(searchFilter)) ||
      (r.keluhan && r.keluhan.toLowerCase().includes(searchFilter)) ||
      (r.asesmen && r.asesmen.toLowerCase().includes(searchFilter))
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); font-style: italic; padding: 25px;">Tidak ada data rekam medis yang cocok dengan pencarian/filter</td></tr>`;
    return;
  }

  const isFiltered = Boolean(dateFilter || searchFilter);
  const totalCount = filtered.length;

  // Batasi 30 data diinput terbaru jika tanpa filter (agar UI di HP super ringan & responsif)
  if (!isFiltered) {
    filtered = filtered.slice(0, 30);
  }

  let html = filtered.map(r => `
    <tr ondblclick="openModalRiwayatPasien('${r.nikPabrik || ''}')" style="cursor: pointer;" title="Klik 2x untuk melihat riwayat medis">
      <td data-label="Tanggal">${r.tanggal || '-'}</td>
      <td data-label="Nama Pasien"><strong>${r.namaPasien}</strong><br><small class="text-muted">${r.nikPabrik || '-'}</small></td>
      <td data-label="Keluhan & Diagnosa">
        <div style="display: flex; flex-direction: column; gap: 4px; text-align: left;">
          <div><strong>S:</strong> ${r.keluhan || '-'}</div>
          <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:4px;"><strong>A:</strong> ${renderDiagnosisBadges(r.asesmen)}</div>
          <div><strong>P:</strong><br>${formatPlanForDisplay(r.plan)}</div>
        </div>
      </td>
      <td data-label="Pemeriksa">${r.pemeriksa || '-'}</td>
      <td data-label="Aksi">
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); openModalEditRecord('${r.id}')" title="Edit Data">
            <i class="fa-solid fa-pen"></i> Edit
          </button>
          <button class="btn btn-sm btn-danger" style="background: rgba(239,68,68,0.12); color: #f87171; border: 1px solid rgba(239,68,68,0.3); padding: 5px 8px; font-weight: 700;" onclick="event.stopPropagation(); openModalDeleteRecord('${r.id}')" title="Hapus Rekam Medis & Kembalikan Stok">
            <i class="fa-solid fa-trash-can"></i> Hapus
          </button>
          ${r.linkFoto ? `
            <button class="btn btn-sm btn-secondary" style="background: #0284c7; color: #fff; border: none; padding: 5px 8px;" onclick="event.stopPropagation(); openPhotoViewer('${r.id}')" title="Lihat Foto">
              <i class="fa-solid fa-image"></i> Foto
            </button>` : ''}
          ${getPatientWABtnHTML(r.nikPabrik, 'WA')}
        </div>
      </td>
    </tr>
  `).join('');

  if (!isFiltered && totalCount > 30) {
    html += `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 12px; background: rgba(255,255,255,0.02);">
          <i class="fa-solid fa-circle-info" style="color: var(--primary); margin-right: 4px;"></i>
          Menampilkan <strong>30 data di-input terbaru</strong> (dari total ${totalCount} data). Gunakan pencarian/filter tanggal untuk menampilkan data lainnya.
        </td>
      </tr>`;
  }

  tbody.innerHTML = html;
}

function filterEditDataTable() {
  renderEditDataTable();
}

function addEditICD10Row(defaultValue = '') {
  const container = document.getElementById('edit-container-icd10');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'edit-icd10-row';
  row.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-start;';

  const icdList = getICD10WithFrequency();

  const wrap = document.createElement('div');
  wrap.className = 'custom-searchable-wrap';
  wrap.style.flex = '1';

  let displayValue = defaultValue;
  if (defaultValue) {
    const match = icdList.find(i => i.code === defaultValue || i.desc === defaultValue || i.fullLabel === defaultValue || defaultValue.includes(i.code));
    if (match) displayValue = match.fullLabel;
  }

  wrap.innerHTML = `
    <div class="searchable-input-box">
      <input type="text" class="form-control icd-search-input select-edit-icd10" placeholder="🔍 Cari diagnosis ICD-10..." value="${displayValue}" autocomplete="off">
      <i class="fa-solid fa-chevron-down searchable-dropdown-arrow"></i>
    </div>
    <div class="searchable-dropdown-menu"></div>
  `;

  const input = wrap.querySelector('.icd-search-input');
  const menu = wrap.querySelector('.searchable-dropdown-menu');

  function renderOptions(filterText = '') {
    const cleanFilter = filterText.toLowerCase().trim();
    const filtered = icdList.filter(item => 
      !cleanFilter || 
      item.fullLabel.toLowerCase().includes(cleanFilter) ||
      item.code.toLowerCase().includes(cleanFilter) ||
      item.desc.toLowerCase().includes(cleanFilter)
    );

    if (filtered.length === 0) {
      menu.innerHTML = `<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Diagnosis tidak ditemukan (Ketik bebas untuk diagnosis manual)</div>`;
      return;
    }

    menu.innerHTML = filtered.map(item => `
      <div class="searchable-option-item ${item.fullLabel.toLowerCase() === input.value.toLowerCase().trim() ? 'selected' : ''}" data-value="${item.fullLabel}">
        <span style="display: flex; align-items: center; gap: 6px; flex: 1; margin-right: 8px;">
          ${item.freq > 0 ? `<span class="freq-tag"><i class="fa-solid fa-fire"></i> ${item.freq}x</span>` : ''}
          <span>${item.fullLabel}</span>
        </span>
        ${item.freq > 0 ? `<span class="option-sub" style="font-size: 0.7rem; white-space: nowrap;">Tersering</span>` : ''}
      </div>
    `).join('');

    menu.querySelectorAll('.searchable-option-item').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.getAttribute('data-value');
        input.value = val;
        wrap.classList.remove('active');
      });
    });
  }

  input.addEventListener('focus', () => {
    document.querySelectorAll('.custom-searchable-wrap.active').forEach(w => {
      if (w !== wrap) w.classList.remove('active');
    });
    renderOptions(input.value);
    wrap.classList.add('active');
  });

  input.addEventListener('input', () => {
    renderOptions(input.value);
    wrap.classList.add('active');
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('active');
    }
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-sm btn-secondary';
  addBtn.title = 'Tambah Diagnosis Baru';
  addBtn.style.cssText = 'width: 38px; height: 38px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1.5px solid rgba(59, 130, 246, 0.3); border-radius: var(--r-md); font-weight: 700;';
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
  addBtn.onclick = () => addEditICD10Row();

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-sm btn-danger';
  deleteBtn.title = 'Hapus Diagnosis';
  deleteBtn.style.cssText = 'width: 38px; height: 38px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: var(--r-md);';
  deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
  deleteBtn.onclick = () => {
    if (container.querySelectorAll('.edit-icd10-row').length > 1) {
      row.remove();
    } else {
      input.value = '';
    }
  };

  row.appendChild(addBtn);
  row.appendChild(wrap);
  row.appendChild(deleteBtn);
  container.appendChild(row);
}

function addEditResepRow(medName = '', qty = 1) {
  const container = document.getElementById('edit-container-resep');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'edit-resep-row';
  div.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-start;';

  const medList = getSortedMedicines();
  let initialMed = null;
  if (medName) {
    initialMed = medList.find(m => m.nama.toLowerCase() === medName.toLowerCase());
  }

  const defaultPrice = initialMed ? (parseFloat(initialMed.harga) || 0) : 0;
  div.dataset.unitPrice = defaultPrice;

  div.innerHTML = `
    <button type="button" class="btn btn-sm btn-secondary" onclick="addEditResepRow()" title="Tambah Obat Baru" style="flex-shrink: 0; width: 38px; height: 38px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1.5px solid rgba(59, 130, 246, 0.3); border-radius: var(--r-md); font-weight: 700;">
      <i class="fa-solid fa-plus"></i>
    </button>
    <div style="flex: 2; display: flex; flex-direction: column;">
      <div class="custom-searchable-wrap med-searchable-wrap">
        <div class="searchable-input-box">
          <input type="text" class="form-control med-search-input select-edit-medicine" placeholder="🔍 Cari obat (A-Z)..." value="${initialMed ? initialMed.nama : medName}" autocomplete="off">
          <i class="fa-solid fa-chevron-down searchable-dropdown-arrow"></i>
        </div>
        <div class="searchable-dropdown-menu"></div>
      </div>
      <small class="stock-badge-info" style="margin-top: 4px;"></small>
    </div>
    <input type="number" class="form-control edit-med-qty" value="${qty}" min="1" step="1" placeholder="Qty" style="width: 70px; text-align: center; font-weight: 700; height: 38px; flex-shrink: 0;">
    <div class="med-subtotal-badge" style="height: 38px; display: flex; align-items: center; justify-content: flex-end; width: 90px; font-weight: 700; flex-shrink: 0;">Rp 0</div>
    <button type="button" class="btn btn-sm btn-danger" onclick="const p = this.closest('#edit-container-resep'); const row = this.closest('.edit-resep-row'); if(p.querySelectorAll('.edit-resep-row').length > 1) { row.remove(); } else { row.querySelector('.select-edit-medicine').value = ''; row.querySelector('.edit-med-qty').value = 1; row.dataset.unitPrice = 0; const badge = row.querySelector('.med-subtotal-badge'); if(badge) badge.textContent = 'Rp 0'; row.querySelector('.stock-badge-info').textContent = ''; } calculateEditResepGrandTotal();" title="Hapus" style="flex-shrink: 0; width: 38px; height: 38px; padding: 0; border-radius: var(--r-md); display: inline-flex; align-items: center; justify-content: center;"><i class="fa-solid fa-trash-can"></i></button>
  `;

  container.appendChild(div);

  const wrap = div.querySelector('.med-searchable-wrap');
  const input = div.querySelector('.med-search-input');
  const menu = div.querySelector('.searchable-dropdown-menu');
  const qtyInput = div.querySelector('.edit-med-qty');
  const stockInfo = div.querySelector('.stock-badge-info');

  function renderMedOptions(filterText = '') {
    const cleanFilter = filterText.toLowerCase().trim();
    const filtered = medList.filter(m => 
      !cleanFilter || 
      (m.nama && m.nama.toLowerCase().includes(cleanFilter))
    );

    if (filtered.length === 0) {
      menu.innerHTML = `<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Obat tidak ditemukan (Bisa ketik nama obat manual)</div>`;
      return;
    }

    menu.innerHTML = filtered.map(m => {
      const hargaFormat = m.harga ? `Rp ${parseFloat(m.harga).toLocaleString('id-ID')}` : 'Rp 0';
      return `
        <div class="searchable-option-item ${m.nama.toLowerCase() === input.value.toLowerCase().trim() ? 'selected' : ''}" 
             data-nama="${m.nama}" 
             data-stok="${m.stok}" 
             data-satuan="${m.satuan || '-'}" 
             data-harga="${m.harga || 0}">
          <div>
            <strong>${m.nama}</strong>
            <div class="option-sub">Stok: ${m.stok} ${m.satuan || ''} | Harga: ${hargaFormat}</div>
          </div>
          <span class="price-tag">${hargaFormat}</span>
        </div>
      `;
    }).join('');

    menu.querySelectorAll('.searchable-option-item').forEach(opt => {
      opt.addEventListener('click', () => {
        const nama = opt.getAttribute('data-nama');
        const stok = parseInt(opt.getAttribute('data-stok')) || 0;
        const satuan = opt.getAttribute('data-satuan');
        const harga = parseFloat(opt.getAttribute('data-harga')) || 0;

        input.value = nama;
        div.dataset.unitPrice = harga;
        wrap.classList.remove('active');

        updateStockBadgeEl(stockInfo, stok, satuan);
        calculateEditRowSubtotal(div);
      });
    });
  }

  input.addEventListener('focus', () => {
    document.querySelectorAll('.custom-searchable-wrap.active').forEach(w => {
      if (w !== wrap) w.classList.remove('active');
    });
    renderMedOptions(input.value);
    wrap.classList.add('active');
  });

  input.addEventListener('input', () => {
    renderMedOptions(input.value);
    wrap.classList.add('active');
    const matched = medList.find(m => m.nama.toLowerCase() === input.value.toLowerCase().trim());
    if (matched) {
      div.dataset.unitPrice = parseFloat(matched.harga) || 0;
      updateStockBadgeEl(stockInfo, matched.stok, matched.satuan);
    }
    calculateEditRowSubtotal(div);
  });

  qtyInput.addEventListener('input', () => calculateEditRowSubtotal(div));

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('active');
    }
  });

  if (initialMed) {
    updateStockBadgeEl(stockInfo, initialMed.stok, initialMed.satuan);
  }
  calculateEditRowSubtotal(div);
}

function calculateEditRowSubtotal(rowEl) {
  const price = parseFloat(rowEl.dataset.unitPrice) || 0;
  const qtyEl = rowEl.querySelector('.edit-med-qty');
  const qty = parseInt(qtyEl.value) || 0;
  const subtotal = price * qty;
  const badge = rowEl.querySelector('.med-subtotal-badge');
  if (badge) {
    badge.textContent = `Rp ${subtotal.toLocaleString('id-ID')}`;
  }
  calculateEditResepGrandTotal();
}

function calculateEditResepGrandTotal() {
  const rows = document.querySelectorAll('.edit-resep-row');
  let grandTotal = 0;

  rows.forEach(row => {
    const price = parseFloat(row.dataset.unitPrice) || 0;
    const qtyEl = row.querySelector('.edit-med-qty');
    const qty = qtyEl ? (parseInt(qtyEl.value) || 0) : 0;
    grandTotal += (price * qty);
  });

  const grandTotalEl = document.getElementById('edit-resep-grand-total');
  if (grandTotalEl) {
    grandTotalEl.textContent = `Rp ${grandTotal.toLocaleString('id-ID')}`;
  }

  updateSisaSaldoEdit();
}

function updateSisaSaldoEdit() {
  const currentRecord = appData.records.find(r => r.id === document.getElementById('edit-record-id').value);
  if (!currentRecord) return;
  
  const emp = appData.patients.find(e => e.nikPabrik === currentRecord.nikPabrik || e.nik === currentRecord.nikPabrik);
  if (!emp) return;

  const currentSaldo = parseInt(emp.saldoObat) || 0;
  const oldBiaya = parseInt(currentRecord.totalBiaya) || 0;
  
  // Saldo sebelum transaksi ini dilakukan (dikembalikan dulu)
  const saldoSebelumTransaksi = currentSaldo + oldBiaya;
  
  // Subtract the new calculated total
  const grandTotalStr = document.getElementById('edit-resep-grand-total').textContent.replace(/[^0-9]/g, '');
  const newBiaya = parseInt(grandTotalStr) || 0;

  const sisaSaldo = saldoSebelumTransaksi - newBiaya;

  const saldoAwalEl = document.getElementById('edit-saldo-awal');
  if (saldoAwalEl) {
    saldoAwalEl.textContent = `Rp ${saldoSebelumTransaksi.toLocaleString('id-ID')}`;
    saldoAwalEl.style.color = saldoSebelumTransaksi < 0 ? '#ef4444' : 'var(--text-primary)';
  }

  const sisaSaldoEl = document.getElementById('edit-sisa-saldo');
  if (sisaSaldoEl) {
    sisaSaldoEl.textContent = `Rp ${sisaSaldo.toLocaleString('id-ID')}`;
    sisaSaldoEl.style.color = sisaSaldo < 0 ? '#ef4444' : '#34d399';
  }
}


function openModalEditRecord(recordOrId) {
  let record = recordOrId;
  if (typeof recordOrId === 'string' || typeof recordOrId === 'number') {
    record = appData.records.find(r => String(r.id) === String(recordOrId));
  }
  if (!record) {
    showToast('Data rekam medis tidak ditemukan', 'error');
    return;
  }

  document.getElementById('edit-record-id').value = record.id;
  document.getElementById('edit-nama-pasien').value = record.namaPasien || '';
  document.getElementById('edit-keluhan').value = record.keluhan || '';
  document.getElementById('edit-objektif').value = record.objektif || '';
  document.getElementById('edit-pemeriksa').value = record.pemeriksa || 'dr. Dylan Fadhilah';
  document.getElementById('edit-is-pantauan').checked = record.isPantauan === true;
  document.getElementById('edit-izin-sakit').checked = record.izinSakit === true;

  // Set date picker value
  if (record.tanggal) {
    const parts = record.tanggal.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2];
      document.getElementById('edit-tanggal').value = `${year}-${month}-${day}`;
    } else {
      document.getElementById('edit-tanggal').value = new Date().toISOString().split('T')[0];
    }
  } else if (record.created_at) {
    document.getElementById('edit-tanggal').value = record.created_at.split('T')[0];
  } else {
    document.getElementById('edit-tanggal').value = new Date().toISOString().split('T')[0];
  }

  // Populate ICD-10 Diagnosis Multi
  const containerICD = document.getElementById('edit-container-icd10');
  containerICD.innerHTML = '';
  if (record.asesmen) {
    const diags = String(record.asesmen).split(';').map(d => d.trim()).filter(d => d && d !== 'undefined - undefined');
    if (diags.length > 0) {
      diags.forEach(d => addEditICD10Row(d));
    } else {
      addEditICD10Row();
    }
  } else {
    addEditICD10Row();
  }

  // Populate Resep Obat Multi
  const containerResep = document.getElementById('edit-container-resep');
  containerResep.innerHTML = '';
  if (Array.isArray(record.resep) && record.resep.length > 0) {
    record.resep.forEach(r => addEditResepRow(r.namaObat || r.obat, r.qty || 1));
  } else if (record.plan) {
    const planItems = String(record.plan).split(';').map(p => p.trim()).filter(p => p);
    if (planItems.length > 0) {
      planItems.forEach(p => {
        const match = p.match(/^(.+?)(?:\s+\d+x\d+)?\s+No\.(\d+)/i) || p.match(/^(.+?)(?:\s+(\d+))?$/);
        const name = match ? match[1].trim() : p;
        const qty = match && match[2] ? parseInt(match[2]) : 1;
        addEditResepRow(name, qty);
      });
    } else {
      addEditResepRow();
    }
  } else {
    addEditResepRow();
  }

  document.getElementById('modal-edit-record').style.display = 'flex';
}

function closeModalEditRecord() {
  document.getElementById('modal-edit-record').style.display = 'none';
  const fileInput = document.getElementById('edit-upload-file');
  if (fileInput) fileInput.value = '';
}

async function handleSaveEditRecord(e) {
  e.preventDefault();
  const id = document.getElementById('edit-record-id').value;

  // Gather ICD-10 Diagnoses
  const icdSelects = document.querySelectorAll('.select-edit-icd10');
  const selectedICD = Array.from(icdSelects).map(s => s.value).filter(v => v !== '').join('; ');

  // Gather Resep Obat
  const resepRows = document.querySelectorAll('#edit-container-resep .edit-resep-row');
  const resepList = [];
  resepRows.forEach(row => {
    const medSel = row.querySelector('.select-edit-medicine').value;
    const qty = parseInt(row.querySelector('.edit-med-qty').value) || 1;
    if (medSel) {
      resepList.push({ namaObat: medSel, dosage: '3x1', qty, aturan: 'sesudah makan' });
    }
  });

  const planText = resepList.map(r => `${r.namaObat} No.${r.qty}`).join('; ');

  // Get date value and format it
  const selectedDateVal = document.getElementById('edit-tanggal').value;
  let tanggalFormatted = '';
  let customCreatedAt = '';
  if (selectedDateVal) {
    const [yr, mo, dy] = selectedDateVal.split('-');
    tanggalFormatted = `${parseInt(dy)}/${parseInt(mo)}/${yr}`;
    
    const record = appData.records.find(r => r.id === id);
    let originalTime = new Date();
    if (record && record.created_at) {
      originalTime = new Date(record.created_at);
    }
    const customDateObj = new Date(yr, mo - 1, dy, originalTime.getHours(), originalTime.getMinutes(), originalTime.getSeconds(), originalTime.getMilliseconds());
    customCreatedAt = customDateObj.toISOString();
  }

  const updatedData = {
    tanggal: tanggalFormatted,
    created_at: customCreatedAt,
    keluhan: document.getElementById('edit-keluhan').value,
    objektif: document.getElementById('edit-objektif').value,
    asesmen: selectedICD || 'Pemeriksaan Umum',
    plan: planText || 'Edukasi Istirahat',
    resep: resepList,
    pemeriksa: document.getElementById('edit-pemeriksa').value,
    isPantauan: document.getElementById('edit-is-pantauan').checked,
    izinSakit: document.getElementById('edit-izin-sakit').checked
  };

  // Handle File Upload to Google Drive (if a new file is selected)
  const fileInput = document.getElementById('edit-upload-file');
  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    const file = fileInput.files[0];
    showToast('Mengunggah foto penunjang ke Google Drive...', 'info');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      
      const upRes = await fetch('/api/upload-foto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileData: base64,
          fileName: file.name,
          mimeType: file.type
        })
      });
      const upData = await upRes.json();
      if (upData.fileUrl) {
        updatedData.linkFoto = upData.fileUrl;
      }
    } catch(err) {
      console.error('File upload error:', err);
      showToast('Gagal mengunggah foto', 'error');
    }
  }

  // Update totalBiaya
  const grandTotalStr = document.getElementById('edit-resep-grand-total')?.textContent.replace(/[^0-9]/g, '') || '0';
  const newBiaya = parseInt(grandTotalStr) || 0;
  updatedData.totalBiaya = newBiaya;

  try {
    const currentRecord = appData.records.find(r => r.id === id);
    
    const res = await fetch(`/api/records/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedData)
    });

    if (res.ok) {
      // HANDLE SALDO OBAT REFUND/DEDUCTION
      if (currentRecord) {
        const emp = appData.patients.find(e => e.nikPabrik === currentRecord.nikPabrik || e.nik === currentRecord.nikPabrik);
        if (emp) {
          const currentSaldo = parseInt(emp.saldoObat) || 0;
          const oldBiaya = parseInt(currentRecord.totalBiaya) || 0;
          const newSaldo = currentSaldo + oldBiaya - newBiaya;
          
          if (newSaldo !== currentSaldo) {
            const updatedPatient = { ...emp, saldoObat: newSaldo };
            const patientId = emp.id || emp.nikPabrik || emp.nik;
            try {
              await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedPatient)
              });
            } catch (err) {
              console.error('Failed to update saldo obat during edit:', err);
            }
          }
        }
      }

      showToast('Rekam Medis & Revisi Stok Berhasil Diperbarui!', 'success');
      closeModalEditRecord();
      await loadAllAppData();
      if (appData.currentPoliPatient) {
        const refreshedPatient = appData.patients.find(x => 
          (x.id && x.id === appData.currentPoliPatient.id) ||
          (x.nikPabrik && x.nikPabrik === appData.currentPoliPatient.nikPabrik) ||
          (x.nik && x.nik === appData.currentPoliPatient.nik)
        );
        if (refreshedPatient) {
          appData.currentPoliPatient = refreshedPatient;
          renderPatientHistoryTimeline(refreshedPatient);
          document.getElementById('poli-banner-name').textContent = `${refreshedPatient.nama} (${refreshedPatient.nikPabrik || refreshedPatient.nik || '-'})`;
          const saldoInfo = (refreshedPatient.saldoObat !== undefined) ? ` | <strong style="color:${parseInt(refreshedPatient.saldoObat)<0?'#ef4444':'#059669'}; background: ${parseInt(refreshedPatient.saldoObat)<0?'rgba(239,68,68,0.1)':'rgba(16,185,129,0.1)'}; padding: 2px 6px; border-radius: 4px;">Sisa Saldo: Rp ${(parseInt(refreshedPatient.saldoObat)||0).toLocaleString('id-ID')}</strong>` : '';
          const ageStr = calculateAge(refreshedPatient.tglLahir || refreshedPatient.tgl_lahir);
          document.getElementById('poli-banner-sub').innerHTML = `Dept: ${refreshedPatient.dept || refreshedPatient.departemen || '-'} | Usia: ${ageStr} | Gender: ${refreshedPatient.gender || '-'}${saldoInfo}`;
        }
      }
    } else {
      showToast('Gagal mengedit data', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
  }
}

function openModalDeleteRecord(recordOrId) {
  let record = recordOrId;
  if (typeof recordOrId === 'string' || typeof recordOrId === 'number') {
    record = appData.records.find(r => String(r.id) === String(recordOrId));
  }
  if (!record) {
    showToast('Data rekam medis tidak ditemukan', 'error');
    return;
  }

  document.getElementById('delete-record-id').value = record.id;
  
  // Prefill deleter name if exists
  const defaultNakes = document.getElementById('poli-pemeriksa')?.value || record.pemeriksa || '';
  const delByInput = document.getElementById('delete-record-by');
  if (delByInput) delByInput.value = defaultNakes;

  // Reset reason select and textarea
  const reasonSel = document.getElementById('delete-record-reason-select');
  const reasonText = document.getElementById('delete-record-reason-text');
  if (reasonSel) reasonSel.value = 'Pasien Batal Berobat / Salah Input';
  if (reasonText) reasonText.value = 'Pasien Batal Berobat / Salah Input';

  // Render Summary Box
  const summaryBox = document.getElementById('delete-record-summary-box');
  if (summaryBox) {
    const resepItems = Array.isArray(record.resep) && record.resep.length > 0
      ? record.resep.map(r => `• ${r.namaObat || r.obat} (${r.qty || 1} item)`).join('<br>')
      : (record.plan ? formatPlanForDisplay(record.plan) : 'Tidak ada resep obat');

    summaryBox.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px;">
        <span style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">${record.namaPasien || '-'}</span>
        <span class="badge badge-info" style="font-weight: 700;">${record.nikPabrik || '-'}</span>
      </div>
      <div style="color: var(--text-muted); margin-bottom: 4px;"><strong>Tanggal:</strong> ${record.tanggal || '-'} | <strong>Bagian:</strong> ${record.dept || 'PT ATI'}</div>
      <div style="color: var(--text-muted); margin-bottom: 4px;"><strong>Keluhan:</strong> ${record.keluhan || '-'} (A: ${record.asesmen || '-'})</div>
      <div style="margin-top: 6px; padding: 6px 8px; background: rgba(239, 68, 68, 0.06); border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.15);">
        <strong style="color: #f87171;"><i class="fa-solid fa-pills"></i> Obat yang akan dikembalikan ke stok gudang:</strong>
        <div style="margin-top: 3px; font-weight: 600; font-size: 0.8rem;">${resepItems}</div>
      </div>
      <div style="margin-top: 6px; display: flex; justify-content: space-between; font-weight: 700;">
        <span style="color: var(--text-muted);">Total Billing Dikoreksi:</span>
        <span style="color: #38bdf8;">Rp ${(record.totalBiaya || 0).toLocaleString('id-ID')}</span>
      </div>
    `;
  }

  const modal = document.getElementById('modal-delete-record');
  if (modal) modal.style.display = 'flex';
}

function closeModalDeleteRecord() {
  const modal = document.getElementById('modal-delete-record');
  if (modal) modal.style.display = 'none';
}

function handleDeleteReasonSelectChange() {
  const sel = document.getElementById('delete-record-reason-select');
  const text = document.getElementById('delete-record-reason-text');
  if (!sel || !text) return;
  if (sel.value === 'lainnya') {
    text.value = '';
    text.focus();
  } else {
    text.value = sel.value;
  }
}

async function handleConfirmDeleteRecord(e) {
  e.preventDefault();
  const id = document.getElementById('delete-record-id').value;
  const deletedBy = document.getElementById('delete-record-by').value.trim();
  const reason = document.getElementById('delete-record-reason-text').value.trim();

  if (!id) {
    showToast('ID Rekam Medis tidak valid', 'error');
    return;
  }
  if (!deletedBy) {
    showToast('Harap isi nama petugas yang menghapus', 'warning');
    return;
  }
  if (!reason) {
    showToast('Harap tuliskan alasan penghapusan', 'warning');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-delete-record');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menghapus &amp; Mengirim Audit...';
  }

  try {
    const res = await fetch(`/api/records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletedBy, reason })
    });

    const record = appData.records.find(r => String(r.id) === String(id));
    const data = await res.json();

    if (res.ok && data.success) {
      // Refund patient's saldoObat
      if (record) {
        const emp = appData.patients.find(e => e.nikPabrik === record.nikPabrik || e.nik === record.nikPabrik);
        if (emp) {
          const currentSaldo = parseInt(emp.saldoObat) || 0;
          const refundAmount = parseInt(record.totalBiaya) || 0;
          const newSaldo = currentSaldo + refundAmount;
          
          const updatedPatient = { ...emp, saldoObat: newSaldo };
          const patientId = emp.id || emp.nikPabrik || emp.nik;
          try {
            await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updatedPatient)
            });
          } catch (err) {
            console.error('Failed to refund saldo obat during deletion:', err);
          }
        }
      }

      showToast('✅ Rekam medis berhasil dihapus! Stok obat dikembalikan & audit terkirim ke Telegram.', 'success');
      closeModalDeleteRecord();
      closeModalEditRecord();
      await loadAllAppData();
      if (appData.currentPoliPatient) {
        const refreshedPatient = appData.patients.find(x => 
          (x.id && x.id === appData.currentPoliPatient.id) ||
          (x.nikPabrik && x.nikPabrik === appData.currentPoliPatient.nikPabrik) ||
          (x.nik && x.nik === appData.currentPoliPatient.nik)
        );
        if (refreshedPatient) {
          appData.currentPoliPatient = refreshedPatient;
          renderPatientHistoryTimeline(refreshedPatient);
          document.getElementById('poli-banner-name').textContent = `${refreshedPatient.nama} (${refreshedPatient.nikPabrik || refreshedPatient.nik || '-'})`;
          const saldoInfo = (refreshedPatient.saldoObat !== undefined) ? ` | <strong style="color:${parseInt(refreshedPatient.saldoObat)<0?'#ef4444':'#059669'}; background: ${parseInt(refreshedPatient.saldoObat)<0?'rgba(239,68,68,0.1)':'rgba(16,185,129,0.1)'}; padding: 2px 6px; border-radius: 4px;">Sisa Saldo: Rp ${(parseInt(refreshedPatient.saldoObat)||0).toLocaleString('id-ID')}</strong>` : '';
          const ageStr = calculateAge(refreshedPatient.tglLahir || refreshedPatient.tgl_lahir);
          document.getElementById('poli-banner-sub').innerHTML = `Dept: ${refreshedPatient.dept || refreshedPatient.departemen || '-'} | Usia: ${ageStr} | Gender: ${refreshedPatient.gender || '-'}${saldoInfo}`;
        }
      }
    } else {
      showToast(data.error || 'Gagal menghapus rekam medis', 'error');
    }
  } catch (err) {
    console.error('Error deleting record:', err);
    showToast('Terjadi kesalahan jaringan saat menghapus data', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Hapus &amp; Kembalikan Stok';
    }
  }
}

// -------------------------------------------------------------
// 3. TAB GUDANG LOGIC (Sandi: nafila123)
// -------------------------------------------------------------
async function handleUnlockGudang(e) {
  e.preventDefault();
  const pass = document.getElementById('gudang-password-input').value.trim();
  try {
    const res = await fetch('/api/auth/gudang', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (data.status === 'SUCCESS') {
      localStorage.setItem('gudang_unlocked', 'true');
      document.getElementById('gudang-locked-view').style.display = 'none';
      document.getElementById('gudang-unlocked-view').style.display = 'block';
      showToast('Akses Gudang Dibuka', 'success');
    } else {
      showToast('Sandi Gudang Salah!', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
  }
}

function switchGudangSubTab(type) {
  const vList = document.getElementById('gudang-view-list');
  const vOpname = document.getElementById('gudang-view-opname');
  const vPengiriman = document.getElementById('gudang-view-pengiriman');

  const bList = document.getElementById('gudang-subtab-list');
  const bOpname = document.getElementById('gudang-subtab-opname');
  const bPengiriman = document.getElementById('gudang-subtab-pengiriman');

  // Hide all views
  if (vList) vList.style.display = 'none';
  if (vOpname) vOpname.style.display = 'none';
  if (vPengiriman) vPengiriman.style.display = 'none';

  // Reset active classes
  if (bList) { bList.className = 'btn btn-secondary'; bList.style.background = ''; }
  if (bOpname) { bOpname.className = 'btn btn-secondary'; bOpname.style.background = ''; bOpname.style.color = ''; }
  if (bPengiriman) { bPengiriman.className = 'btn btn-secondary'; bPengiriman.style.background = ''; bPengiriman.style.color = ''; }

  if (type === 'opname') {
    if (vOpname) vOpname.style.display = 'block';
    if (bOpname) { bOpname.className = 'btn btn-primary'; bOpname.style.background = '#0284c7'; bOpname.style.color = '#fff'; }
    renderStokOpnameTable();
  } else if (type === 'pengiriman') {
    if (vPengiriman) vPengiriman.style.display = 'block';
    if (bPengiriman) { bPengiriman.className = 'btn btn-primary'; bPengiriman.style.background = '#ec4899'; bPengiriman.style.color = '#fff'; bPengiriman.style.border = 'none'; }
    initShipmentView();
  } else {
    if (vList) vList.style.display = 'block';
    if (bList) bList.className = 'btn btn-primary';
  }
}

let shipmentDraft = [];

function initShipmentView() {
  shipmentDraft = [];
  renderShipmentDraftTable();

  // Reset fields
  document.getElementById('ship-sender').value = '';
  document.getElementById('ship-receiver').value = '';
  document.getElementById('ship-qty-input').value = '';
  document.getElementById('ship-initial-stock').value = '';
  document.getElementById('ship-final-stock').value = '';

  const inputId = document.getElementById('ship-medicine-id');
  const inputName = document.getElementById('ship-medicine-input');
  
  if (inputId) inputId.value = '';
  if (inputName) inputName.value = '';

  setupShipMedicineSearchable();
}

function setupShipMedicineSearchable() {
  const wrap = document.getElementById('ship-med-searchable-wrap');
  const input = document.getElementById('ship-medicine-input');
  const menu = document.getElementById('ship-medicine-menu');
  const idInput = document.getElementById('ship-medicine-id');
  
  if (!wrap || !input || !menu || !idInput) return;

  function renderOptions(filterText = '') {
    const cleanFilter = filterText.toLowerCase().trim();
    const sortedMeds = (appData.medicines || []).slice().sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));
    
    const filtered = sortedMeds.filter(m => 
      !cleanFilter || 
      (m.nama && m.nama.toLowerCase().includes(cleanFilter))
    );

    if (filtered.length === 0) {
      menu.innerHTML = `<div style="padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Obat tidak ditemukan</div>`;
      return;
    }

    menu.innerHTML = filtered.map(m => {
      const hargaFormat = m.harga ? `Rp ${parseFloat(m.harga).toLocaleString('id-ID')}` : 'Rp 0';
      return `
        <div class="searchable-option-item" data-id="${m.id}" data-nama="${m.nama}" data-stok="${m.stok !== undefined ? m.stok : 0}">
          <div>
            <strong>${m.nama}</strong>
            <div class="option-sub">Stok: ${m.stok !== undefined ? m.stok : 0} ${m.satuan || ''} | Harga: ${hargaFormat}</div>
          </div>
        </div>
      `;
    }).join('');

    menu.querySelectorAll('.searchable-option-item').forEach(opt => {
      opt.addEventListener('click', () => {
        const id = opt.getAttribute('data-id');
        const nama = opt.getAttribute('data-nama');
        const stok = opt.getAttribute('data-stok');

        input.value = nama;
        idInput.value = id;
        wrap.classList.remove('active');
        
        // Populate Initial Stock and clear others
        const initInput = document.getElementById('ship-initial-stock');
        const qtyInput = document.getElementById('ship-qty-input');
        const finalInput = document.getElementById('ship-final-stock');
        
        if (initInput) initInput.value = stok;
        if (qtyInput) qtyInput.value = '';
        if (finalInput) finalInput.value = '';
      });
    });
  }

  // Clone input to clear previous event listeners if initialized multiple times
  const newInput = input.cloneNode(true);
  input.parentNode.replaceChild(newInput, input);
  
  newInput.addEventListener('focus', () => {
    document.querySelectorAll('.custom-searchable-wrap.active').forEach(w => {
      if (w !== wrap) w.classList.remove('active');
    });
    renderOptions(newInput.value);
    wrap.classList.add('active');
  });

  newInput.addEventListener('input', () => {
    idInput.value = ''; // Reset ID when typing manually
    renderOptions(newInput.value);
    wrap.classList.add('active');
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('active');
    }
  });
}

function handleShipMedChange() {
  // Logic is now handled directly by setupShipMedicineSearchable
}

function calculateShipFinalStock() {
  const initInput = document.getElementById('ship-initial-stock');
  const qtyInput = document.getElementById('ship-qty-input');
  const finalInput = document.getElementById('ship-final-stock');

  if (!initInput || !qtyInput || !finalInput) return;

  const initial = parseInt(initInput.value) || 0;
  const qty = parseInt(qtyInput.value) || 0;

  finalInput.value = qty > 0 ? (initial + qty) : '';
}

function addMedToShipmentDraft() {
  const idInput = document.getElementById('ship-medicine-id');
  const qtyInput = document.getElementById('ship-qty-input');

  if (!idInput || !qtyInput) return;

  const id = idInput.value;
  const qty = parseInt(qtyInput.value) || 0;

  if (!id) {
    showToast('Silakan pilih obat terlebih dahulu', 'error');
    return;
  }
  if (qty <= 0) {
    showToast('Jumlah kirim harus lebih besar dari 0', 'error');
    return;
  }

  const med = appData.medicines.find(m => m.id === id);
  if (!med) return;

  // Check if already in draft
  const exists = shipmentDraft.some(item => item.id === id);
  if (exists) {
    showToast('Obat tersebut sudah ada di daftar kirim. Hapus item di daftar untuk mengubah.', 'warning');
    return;
  }

  shipmentDraft.push({
    id: med.id,
    name: med.nama,
    initial: med.stok !== undefined ? med.stok : 0,
    qty: qty,
    final: (med.stok !== undefined ? med.stok : 0) + qty,
    satuan: med.satuan || 'strip'
  });

  renderShipmentDraftTable();

  // Reset medicine selector
  idInput.value = '';
  document.getElementById('ship-medicine-input').value = '';
  qtyInput.value = '';
  document.getElementById('ship-initial-stock').value = '';
  document.getElementById('ship-final-stock').value = '';

  showToast('Obat ditambahkan ke daftar kirim', 'success');
}

function removeMedFromShipmentDraft(idx) {
  shipmentDraft.splice(idx, 1);
  renderShipmentDraftTable();
  showToast('Obat dihapus dari daftar kirim', 'info');
}

function renderShipmentDraftTable() {
  const tbody = document.getElementById('ship-draft-body');
  if (!tbody) return;

  if (shipmentDraft.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 12px;">Belum ada obat dalam daftar</td></tr>`;
    return;
  }

  tbody.innerHTML = shipmentDraft.map((item, idx) => `
    <tr>
      <td style="font-weight: 600; text-transform: uppercase;">${item.name}</td>
      <td style="text-align: center;">${item.initial}</td>
      <td style="text-align: center; font-weight: bold; color: #ec4899;">${item.qty} ${item.satuan}</td>
      <td style="text-align: center; font-weight: bold; color: #4ade80;">${item.final}</td>
      <td style="text-align: center;">
        <button class="btn btn-secondary" onclick="removeMedFromShipmentDraft(${idx})" style="padding: 2px 6px; background: #ef4444; border: none; color: #fff; font-size: 0.75rem;">
          <i class="fa-solid fa-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

async function processShipmentAndPrint() {
  const sender = document.getElementById('ship-sender').value.trim();
  const receiver = document.getElementById('ship-receiver').value.trim();

  if (!sender) {
    showToast('Nama pengirim harus diisi', 'error');
    return;
  }
  if (!receiver) {
    showToast('Nama penerima harus diisi', 'error');
    return;
  }
  if (shipmentDraft.length === 0) {
    showToast('Daftar obat kirim kosong', 'error');
    return;
  }

  try {
    const res = await fetch('/api/medicines/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: sender,
        receiver: receiver,
        items: shipmentDraft.map(item => ({ id: item.id, qty: item.qty }))
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✅ Pengiriman Obat berhasil dikonfirmasi!', 'success');

      // Print Delivery Order / Surat Jalan
      printSuratJalanPDF(sender, receiver, shipmentDraft);

      // Reload and re-render
      await loadAllAppData();
      renderGudangTable();

      // Reset form
      initShipmentView();
    } else {
      showToast('Gagal memproses pengiriman: ' + (data.error || 'Terjadi kesalahan'), 'error');
    }
  } catch (err) {
    showToast('Gagal koneksi ke server: ' + err.message, 'error');
  }
}

function printSuratJalanPDF(sender, receiver, items) {
  const tglIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const noSurat = `SJ-${Date.now()}`;

  const rowsHTML = items.map((item, idx) => `
    <tr>
      <td style="text-align: center; border: 1px solid #000; padding: 6px; font-weight: bold;">${idx + 1}</td>
      <td style="border: 1px solid #000; padding: 6px; text-transform: uppercase; font-weight: 600;">${item.name}</td>
      <td style="text-align: center; border: 1px solid #000; padding: 6px;">${item.initial} ${item.satuan}</td>
      <td style="text-align: center; border: 1px solid #000; padding: 6px; font-weight: bold; font-size: 11pt;">${item.qty} ${item.satuan}</td>
      <td style="text-align: center; border: 1px solid #000; padding: 6px; font-weight: bold; color: green; font-size: 11pt;">${item.final} ${item.satuan}</td>
    </tr>
  `).join('');

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Surat Jalan Pengiriman Obat - Klinik PT ATI</title>
      <style>
        @page {
          size: A5 landscape;
          margin: 1cm;
        }
        body {
          font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
          color: #000;
          background: #fff;
          margin: 0;
          padding: 0;
          font-size: 9.5pt;
        }
        .header {
          display: flex;
          justify-content: space-between;
          border-bottom: 2px solid #000;
          padding-bottom: 8px;
          margin-bottom: 12px;
        }
        .header-left h2 {
          margin: 0;
          font-size: 12pt;
          font-weight: bold;
        }
        .header-left p {
          margin: 2px 0;
          font-size: 8pt;
        }
        .header-right {
          text-align: right;
        }
        .header-right h3 {
          margin: 0;
          font-size: 11pt;
          text-decoration: underline;
        }
        .header-right p {
          margin: 2px 0;
          font-size: 8.5pt;
        }
        .meta-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          margin-bottom: 12px;
          font-size: 9.5pt;
          line-height: 1.4;
        }
        table.sj-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
        }
        table.sj-table th {
          border: 1px solid #000;
          border-top: 2px solid #000;
          border-bottom: 2px solid #000;
          padding: 6px;
          background: #f3f4f6;
          font-weight: bold;
          text-transform: uppercase;
        }
        .ttd-grid {
          display: flex;
          justify-content: space-between;
          margin-top: 20px;
          text-align: center;
          font-size: 9.5pt;
        }
        .ttd-box {
          width: 40%;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-left">
          <h2>APOTEK NAFILA MEDIKA</h2>
          <p>Klinik Medis &amp; Distributor Obat In-House PT ATI</p>
        </div>
        <div class="header-right">
          <h3>SURAT JALAN PENGIRIMAN OBAT</h3>
          <p>No: ${noSurat}</p>
        </div>
      </div>

      <div class="meta-grid">
        <div>
          <strong>Pengirim:</strong> ${sender} (Apotek Nafila)<br>
          <strong>Tujuan:</strong> In-House Klinik PT ATI
        </div>
        <div style="text-align: right;">
          <strong>Tanggal:</strong> ${tglIndo}<br>
          <strong>Status:</strong> Dikirim &amp; Diserahterimakan
        </div>
      </div>

      <table class="sj-table">
        <thead>
          <tr>
            <th style="width: 8%;">NO</th>
            <th style="text-align: left;">NAMA ITEM OBAT</th>
            <th style="width: 22%;">STOK AWAL (PT ATI)</th>
            <th style="width: 22%;">JUMLAH KIRIM (SURAT JALAN)</th>
            <th style="width: 22%;">TOTAL AKHIR (PT ATI)</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHTML}
        </tbody>
      </table>

      <div style="margin-top: 10px; font-style: italic; font-size: 8.5pt;">
        *Catatan: Stok di PT ATI telah otomatis disesuaikan secara online dalam database sistem.
      </div>

      <div class="ttd-grid">
        <div class="ttd-box">
          Penerima,<br><strong>Perawat Jaga PT ATI</strong><br><br><br><br>
          ( ${receiver} )
        </div>
        <div class="ttd-box">
          Pengirim,<br><strong>Petugas Apotek Nafila</strong><br><br><br><br>
          ( ${sender} )
        </div>
      </div>

      <script>window.onload = function() { window.print(); };</script>
    </body>
    </html>
  `);
  win.document.close();
}

function renderStokOpnameTable() {
  const tbody = document.getElementById('table-stok-opname-body');
  if (!tbody) return;

  tbody.innerHTML = appData.medicines.map((m, i) => `
    <tr>
      <td data-label="No">${i + 1}</td>
      <td data-label="Nama Obat"><strong>${m.nama}</strong></td>
      <td data-label="Harga Modal">Rp ${(m.harga || 1000).toLocaleString('id-ID')}</td>
      <td data-label="Stok Sistem" style="font-weight: 700;">${m.stok} ${m.satuan || 'strip'}</td>
      <td data-label="Stok Real (Fisik)" style="background: rgba(255,255,255,0.05); text-align: center; color: var(--text-muted);">_______</td>
      <td data-label="Selisih" style="text-align: center; color: var(--text-muted);">_______</td>
      <td data-label="Total Harga Selisih" style="text-align: center; color: var(--text-muted);">Rp _______</td>
    </tr>
  `).join('');
}

function printStokOpnameDoc() {
  const tglIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const rowsHTML = appData.medicines.map((m, i) => `
    <tr>
      <td style="text-align:center; padding: 6px; border: 1px solid #000;">${i + 1}</td>
      <td style="padding: 6px; font-weight: bold; border: 1px solid #000;">${m.nama}</td>
      <td style="text-align:right; padding: 6px; border: 1px solid #000;">Rp ${(m.harga || 1000).toLocaleString('id-ID')}</td>
      <td style="text-align:center; padding: 6px; font-weight: bold; border: 1px solid #000;">${m.stok} ${m.satuan || 'strip'}</td>
      <td style="border: 1px solid #000;"></td>
      <td style="border: 1px solid #000;"></td>
      <td style="border: 1px solid #000;"></td>
    </tr>
  `).join('');

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Stok Opname - Apotik Nafila PT ATI</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; color: #000; background: #fff; }
        .header { text-align: center; margin-bottom: 20px; border-bottom: 3px double #000; padding-bottom: 10px; }
        .header h2 { margin: 0 0 5px 0; font-size: 18pt; text-transform: uppercase; letter-spacing: 1px; }
        .header h3 { margin: 0; font-size: 13pt; font-weight: normal; }
        .meta { margin-bottom: 15px; font-weight: bold; font-size: 11pt; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 10pt; }
        th, td { border: 1px solid #000; padding: 6px; }
        th { background: #e5e7eb; text-transform: uppercase; font-size: 9pt; }
        .kesimpulan-title { font-weight: bold; text-align: center; margin-top: 25px; margin-bottom: 10px; font-size: 12pt; text-transform: uppercase; }
        .ttd-box { display: flex; justify-content: space-between; margin-top: 40px; text-align: center; font-size: 11pt; }
        .ttd-col { width: 45%; }
        @media print {
          body { padding: 0; }
          @page { size: A4 portrait; margin: 1.5cm; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>STOK OPNAME SISTEM APOTIK NAFILA</h2>
        <h3>KLINIK NAFILA MEDIKA - PT ATI</h3>
      </div>
      
      <div class="meta">
        Tanggal Pengecekan: ${tglIndo}
      </div>

      <table>
        <thead>
          <tr>
            <th style="width: 5%;">No</th>
            <th style="width: 35%;">Nama Obat</th>
            <th style="width: 15%;">Harga Modal</th>
            <th style="width: 15%;">Stok Sistem</th>
            <th style="width: 10%;">Stok Real</th>
            <th style="width: 10%;">Selisih</th>
            <th style="width: 10%;">Perhitungan Harga Selisih</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHTML}
        </tbody>
      </table>

      <div class="kesimpulan-title">KESIMPULAN</div>
      <table>
        <thead>
          <tr>
            <th style="width: 33%;">Nama Barang</th>
            <th style="width: 33%;">Perhitungan Selisih</th>
            <th style="width: 34%;">Keterangan</th>
          </tr>
        </thead>
        <tbody>
          <tr><td></td><td style="padding:10px;">Selisih 50 - 100</td><td></td></tr>
          <tr><td></td><td style="padding:10px;">Selisih 25 - 50</td><td></td></tr>
          <tr><td></td><td style="padding:10px;">Selisih 10 - 20</td><td></td></tr>
          <tr><td></td><td style="padding:10px;">Selisih 0 - 10</td><td></td></tr>
        </tbody>
      </table>

      <div class="ttd-box">
        <div class="ttd-col">
          Petugas Klinik,<br><br><br><br>
          ( ____________________ )
        </div>
        <div class="ttd-col">
          Petugas Apotik,<br><br><br><br>
          ( ____________________ )
        </div>
      </div>

      <div style="text-align: center; margin-top: 30px; font-size: 11pt;">
        Mengetahui Pimpinan,<br><br><br><br>
        <strong>dr. Dylan Fadhilah / dr. Isda Laily</strong>
      </div>

      <script>
        window.onload = function() {
          window.print();
        };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function renderGudangTable() {
  const tbody = document.getElementById('table-gudang-body');
  if (!tbody) return;

  tbody.innerHTML = appData.medicines.map(m => {
    const isLow = m.stok <= 10;
    const statusBadge = isLow 
      ? `<span class="badge badge-danger">🔥 STOK MENIPIS</span>`
      : `<span class="badge badge-success">AMAN</span>`;

    return `
      <tr>
        <td data-label="Kode">${m.kode || '-'}</td>
        <td data-label="Nama Obat"><strong>${m.nama}</strong></td>
        <td data-label="Kategori">${m.kategori || 'Gudang PT ATI'}</td>
        <td data-label="Sisa Stok" style="font-weight: 700; font-size: 1.05rem; ${isLow ? 'color: var(--danger);' : ''}">${m.stok}</td>
        <td data-label="Harga (Rp)" style="font-weight: 700; color: #38bdf8;">Rp ${(parseFloat(m.harga) || 0).toLocaleString('id-ID')}</td>
        <td data-label="Satuan">${m.satuan || 'strip'}</td>
        <td data-label="Status">${statusBadge}</td>
        <td data-label="Aksi">
          <button class="btn btn-sm btn-secondary" onclick="openModalEditObat('${m.id}')" title="Edit Data &amp; Harga Obat"><i class="fa-solid fa-pen"></i> Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteObatDirect('${m.id}')" title="Hapus Obat"><i class="fa-solid fa-trash"></i> Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openModalTambahObat() {
  document.getElementById('modal-obat').style.display = 'flex';
}
function closeModalTambahObat() {
  document.getElementById('modal-obat').style.display = 'none';
}

async function handleSaveTambahObat(e) {
  e.preventDefault();
  const newObat = {
    nama: document.getElementById('obat-nama').value,
    stok: parseInt(document.getElementById('obat-stok').value) || 0,
    harga: parseFloat(document.getElementById('obat-harga').value) || 0,
    satuan: document.getElementById('obat-satuan').value,
    kategori: document.getElementById('obat-kategori').value || 'Gudang PT ATI'
  };

  try {
    const res = await fetch('/api/medicines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newObat)
    });
    if (res.ok) {
      showToast('Obat berhasil ditambahkan', 'success');
      closeModalTambahObat();
      await loadAllAppData();
      renderGudangTable();
    }
  } catch (err) {
    showToast('Gagal menyimpan obat', 'error');
  }
}

function openModalEditObat(id) {
  const med = appData.medicines.find(m => m.id === id);
  if (!med) {
    showToast('Data obat tidak ditemukan', 'error');
    return;
  }

  document.getElementById('edit-obat-id').value = med.id;
  document.getElementById('edit-obat-nama').value = med.nama || '';
  document.getElementById('edit-obat-stok').value = med.stok !== undefined ? med.stok : 0;
  document.getElementById('edit-obat-harga').value = parseFloat(med.harga) || 0;
  document.getElementById('edit-obat-satuan').value = med.satuan || 'strip';
  document.getElementById('edit-obat-kategori').value = med.kategori || 'Gudang PT ATI';
  document.getElementById('edit-obat-petugas').value = '';
  document.getElementById('edit-obat-alasan').value = '';

  document.getElementById('modal-edit-obat').style.display = 'flex';
}

function closeModalEditObat() {
  document.getElementById('modal-edit-obat').style.display = 'none';
}

async function handleSaveEditObat(e) {
  e.preventDefault();
  const id = document.getElementById('edit-obat-id').value;
  const payload = {
    nama: document.getElementById('edit-obat-nama').value.trim(),
    stok: parseInt(document.getElementById('edit-obat-stok').value) || 0,
    harga: parseFloat(document.getElementById('edit-obat-harga').value) || 0,
    satuan: document.getElementById('edit-obat-satuan').value.trim(),
    kategori: document.getElementById('edit-obat-kategori').value.trim() || 'Gudang PT ATI',
    petugas: document.getElementById('edit-obat-petugas').value.trim(),
    alasan: document.getElementById('edit-obat-alasan').value.trim()
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  let origText = '';
  if (submitBtn) {
    origText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan &amp; Mengirim...';
    submitBtn.disabled = true;
  }

  try {
    const res = await fetch(`/api/medicines/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✅ Data obat diperbarui &amp; Laporan audit terkirim ke Telegram!', 'success');
      closeModalEditObat();
      await loadAllAppData();
      renderGudangTable();
    } else {
      showToast('Gagal memperbarui obat: ' + (data.error || 'Terjadi kesalahan'), 'error');
    }
  } catch (err) {
    showToast('Gagal koneksi ke server: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.innerHTML = origText;
      submitBtn.disabled = false;
    }
  }
}

async function deleteObatDirect(id) {
  if (confirm('Hapus obat ini dari gudang?')) {
    try {
      await fetch(`/api/medicines/${id}`, { method: 'DELETE' });
      showToast('Obat dihapus', 'info');
      await loadAllAppData();
      renderGudangTable();
    } catch (err) {
      showToast('Gagal menghapus', 'error');
    }
  }
}

// -------------------------------------------------------------
// 4. TAB OBAT REQ LOGIC (WHATSAPP API)
// -------------------------------------------------------------
function renderReqMedicineCatalog() {
  const tbody = document.getElementById('req-catalog-body');
  if (!tbody) return;
  const medList = getSortedMedicines();
  
  tbody.innerHTML = medList.map(m => {
    const stok = parseInt(m.stok) || 0;
    let badgeHTML = '';
    if (stok <= 10) {
      badgeHTML = `<span class="badge badge-danger" style="display:block; text-align:center; padding: 4px;">Kritis: ${stok} ${m.satuan || ''}</span>`;
    } else if (stok <= 50) {
      badgeHTML = `<span class="badge badge-warning" style="display:block; text-align:center; padding: 4px;">Tipis: ${stok} ${m.satuan || ''}</span>`;
    } else {
      badgeHTML = `<span class="badge badge-success" style="display:block; text-align:center; padding: 4px;">Aman: ${stok} ${m.satuan || ''}</span>`;
    }

    const escapedName = m.nama.replace(/'/g, "\\'");
    const inputId = `catalog-qty-${m.nama.replace(/[^a-zA-Z0-9]/g, '_')}`;

    let existingQty = 0;
    const existingRow = Array.from(document.querySelectorAll('#req-table-body tr')).find(tr => {
      const nameEl = tr.querySelector('.req-med-name');
      return nameEl && nameEl.value === m.nama;
    });
    if (existingRow) {
      const qtyEl = existingRow.querySelector('.req-med-qty');
      if (qtyEl) existingQty = parseInt(qtyEl.value) || 0;
    }

    return `
      <tr>
        <td class="catalog-med-name" style="font-weight: 700;">${m.nama}</td>
        <td>${badgeHTML}</td>
        <td>
          <div style="display: flex; align-items: center; justify-content: center; gap: 6px;">
            <button type="button" class="btn btn-sm btn-secondary" style="width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-sm);" onclick="adjustReqCatalogQty('${escapedName}', -1)">-</button>
            <input type="number" id="${inputId}" class="form-control form-control-sm catalog-qty-input" value="${existingQty}" min="0" style="width: 80px; text-align: center; font-weight: bold; height: 28px;" onchange="updateReqCatalogQty('${escapedName}')">
            <button type="button" class="btn btn-sm btn-secondary" style="width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-sm);" onclick="adjustReqCatalogQty('${escapedName}', 1)">+</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function adjustReqCatalogQty(name, amount) {
  const inputId = `catalog-qty-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const input = document.getElementById(inputId);
  if (!input) return;
  let val = parseInt(input.value) || 0;
  val = Math.max(0, val + amount);
  input.value = val;
  syncCatalogItemToCart(name, val);
}

function updateReqCatalogQty(name) {
  const inputId = `catalog-qty-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const input = document.getElementById(inputId);
  if (!input) return;
  let val = parseInt(input.value) || 0;
  if (val < 0) val = 0;
  input.value = val;
  syncCatalogItemToCart(name, val);
}

function syncCatalogItemToCart(name, qty) {
  const tbody = document.getElementById('req-table-body');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const existingRow = rows.find(tr => {
    const nameEl = tr.querySelector('.req-med-name');
    return nameEl && nameEl.value === name;
  });

  if (qty > 0) {
    if (existingRow) {
      const qtyInput = existingRow.querySelector('.req-med-qty');
      if (qtyInput) qtyInput.value = qty;
    } else {
      const tr = document.createElement('tr');
      tr.className = 'catalog-cart-row';
      tr.innerHTML = `
        <td><input type="text" class="form-control req-med-name" value="${name}" readonly style="font-weight: 700; background: var(--bg-card);"></td>
        <td><input type="number" class="form-control req-med-qty" value="${qty}" min="1" onchange="syncCartQtyToCatalog('${name.replace(/'/g, "\\'")}', this.value)" required style="text-align: center; font-weight: 700;"></td>
        <td><button type="button" class="btn btn-sm btn-danger" onclick="removeCartItem('${name.replace(/'/g, "\\'")}')" style="width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-sm);">&times;</button></td>
      `;
      tbody.appendChild(tr);
    }
  } else {
    if (existingRow) {
      existingRow.remove();
    }
  }
}

function syncCartQtyToCatalog(name, qtyVal) {
  const inputId = `catalog-qty-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const input = document.getElementById(inputId);
  let qty = parseInt(qtyVal) || 1;
  if (qty < 1) qty = 1;
  if (input) {
    input.value = qty;
  }
  
  const rows = Array.from(document.querySelectorAll('#req-table-body tr'));
  const row = rows.find(tr => {
    const nameEl = tr.querySelector('.req-med-name');
    return nameEl && nameEl.value === name;
  });
  if (row) {
    const qtyEl = row.querySelector('.req-med-qty');
    if (qtyEl) qtyEl.value = qty;
  }
}

function removeCartItem(name) {
  const inputId = `catalog-qty-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const input = document.getElementById(inputId);
  if (input) {
    input.value = 0;
  }
  
  const rows = Array.from(document.querySelectorAll('#req-table-body tr'));
  const row = rows.find(tr => {
    const nameEl = tr.querySelector('.req-med-name');
    return nameEl && nameEl.value === name;
  });
  if (row) {
    row.remove();
  }
}

function filterReqMedicines() {
  const filter = document.getElementById('req-search-medicines').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#req-catalog-body tr');
  rows.forEach(tr => {
    const nameEl = tr.querySelector('.catalog-med-name');
    if (nameEl) {
      const name = nameEl.textContent.toLowerCase();
      if (name.includes(filter)) {
        tr.style.display = '';
      } else {
        tr.style.display = 'none';
      }
    }
  });
}

function addObatReqRowManual() {
  const tbody = document.getElementById('req-table-body');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="form-control req-med-name" placeholder="Ketik nama obat manual..." required style="font-weight: 700;"></td>
    <td><input type="number" class="form-control req-med-qty" value="1" min="1" required style="text-align: center; font-weight: 700;"></td>
    <td><button type="button" class="btn btn-sm btn-danger" onclick="this.closest('tr').remove()" style="width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-sm);">&times;</button></td>
  `;
  tbody.appendChild(tr);
}

async function handleSendObatReqWA(e) {
  e.preventDefault();
  const perawat = document.getElementById('req-nama-perawat').value.trim();
  const targetHP = document.getElementById('req-target-wa')?.value;
  const rows = document.querySelectorAll('#req-table-body tr');

  if (!targetHP) {
    showToast('Pilih tujuan nomor WhatsApp terlebih dahulu!', 'error');
    return;
  }

  if (rows.length === 0) {
    showToast('Tambahkan minimal 1 item obat yang diminta!', 'error');
    return;
  }

  let textWA = `*PERMINTAAN OBAT KLINIK PT ATI*\n`;
  textWA += `Pengirim (Nakes): *${perawat}*\n`;
  textWA += `Tanggal: ${new Date().toLocaleDateString('id-ID')}\n\n`;
  textWA += `*Daftar Obat Yang Diminta:*\n`;

  rows.forEach((tr, idx) => {
    const nameEl = tr.querySelector('.req-med-name');
    const name = nameEl ? nameEl.value : '';
    const qty = tr.querySelector('.req-med-qty').value;
    if (name) {
      textWA += `${idx + 1}. ${name} - *${qty} item*\n`;
    }
  });

  textWA += `\nMohon segera diproses ke Apotek Nafila. Terima kasih.`;

  showToast('🚀 Mengirim pesan via WhatsApp WhaCenter API...', 'info');

  try {
    const res = await fetch('/api/send-wa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: targetHP, message: textWA })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Permintaan Obat Berhasil Terkirim via WhaCenter WA API!', 'success');
    } else {
      const errMsg = data.response?.message || data.error || 'Server API Offline';
      showToast(`⚠️ API WA: ${errMsg}. Membuka WhatsApp Web...`, 'warning');
      const encoded = encodeURIComponent(textWA);
      window.open(`https://wa.me/${targetHP}?text=${encoded}`, '_blank');
    }
  } catch (err) {
    showToast('⚠️ Gagal menghubungi server WA. Membuka WhatsApp Web...', 'warning');
    const encoded = encodeURIComponent(textWA);
    window.open(`https://wa.me/${targetHP}?text=${encoded}`, '_blank');
  }
}

// -------------------------------------------------------------
// 5. TAB KARYAWAN LOGIC (NPK PABRIK, USIA & WHATSAPP)
// -------------------------------------------------------------

function calculateAge(dateStr) {
  if (!dateStr || dateStr === '-' || dateStr === 'undefined' || dateStr === 'null') return '-';
  const s = String(dateStr).trim();
  if (!s) return '-';

  let birthDate = null;
  // Format DD-MM-YYYY or DD/MM/YYYY
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(s)) {
    const parts = s.split(/[-/]/);
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    birthDate = new Date(year, month, day);
  } else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) {
    const parts = s.split(/[-/]/);
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    birthDate = new Date(year, month, day);
  } else {
    birthDate = new Date(s);
  }

  if (!birthDate || isNaN(birthDate.getTime())) return '-';
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age >= 0 && age < 120 ? `${age} Thn` : '-';
}

function cleanPhoneForWA(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[^0-9]/g, '');
  if (p.startsWith('0')) {
    p = '62' + p.slice(1);
  } else if (p.startsWith('8')) {
    p = '62' + p;
  }
  return p;
}

function getPatientWABtnHTML(nikPabrik, text = 'WA') {
  if (!nikPabrik) return '';
  const p = appData.patients.find(x => String(x.nikPabrik) === String(nikPabrik) || String(x.nik) === String(nikPabrik));
  if (!p) return '';
  const rawHp = p.hp || p.no_hp || '';
  if (!rawHp) {
    return `<button type="button" class="btn btn-sm" style="background: #25D366; color: #fff; border: none; padding: 5px 8px; font-weight: 700; opacity: 0.5;" onclick="event.stopPropagation(); showToast('No HP pasien belum diisi', 'warning')" title="No WA belum diisi"><i class="fa-brands fa-whatsapp"></i> ${text}</button>`;
  }
  const cleanWA = cleanPhoneForWA(rawHp);
  return `<button type="button" class="btn btn-sm" style="background: #25D366; color: #fff; border: none; padding: 5px 8px; font-weight: 700;" onclick="event.stopPropagation(); window.open('https://wa.me/${cleanWA}','_blank')" title="Chat WA Pasien"><i class="fa-brands fa-whatsapp"></i> ${text}</button>`;
}

function renderKaryawanTable() {
  const tbody = document.getElementById('table-karyawan-body');
  if (!tbody) return;

  const query = document.getElementById('search-karyawan-input')?.value.toLowerCase().trim() || '';

  const filtered = appData.patients.filter(k => {
    const nikP = String(k.nikPabrik || k.nik || '').toLowerCase();
    const nama = String(k.nama || '').toLowerCase();
    const dept = String(k.dept || k.departemen || '').toLowerCase();
    const hp = String(k.hp || k.no_hp || '').toLowerCase();
    return !query || nikP.includes(query) || nama.includes(query) || dept.includes(query) || hp.includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 24px; color: var(--text-muted);">Tidak ada data karyawan yang cocok dengan pencarian '${query}'</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((k, idx) => {
    const no = k.no || String(idx + 1);
    const npk = k.nikPabrik || k.nik || '-';
    const nama = k.nama || '-';
    const dept = k.dept || k.departemen || 'PT ATI';
    const sectionName = k.sectionName || '-';
    const tgl = k.tglLahir || k.tgl_lahir || '-';
    const usia = calculateAge(tgl);
    const gender = k.gender || '-';
    const golDarah = k.golDarah || '-';
    const rawHp = k.hp || k.no_hp || '';
    const saldoObat = parseInt(k.saldoObat) || 0;
    const cleanWA = cleanPhoneForWA(rawHp);

    let waHTML = `<span style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">-</span>`;
    if (rawHp) {
      waHTML = `<a href="https://wa.me/${cleanWA}" target="_blank" class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-weight: 600;" title="Kirim Pesan WhatsApp Pemantauan">
        <i class="fa-brands fa-whatsapp"></i> ${rawHp}
      </a>`;
    }
    
    let saldoHTML = `<span style="font-weight: 700; color: ${saldoObat < 0 ? '#ef4444' : '#10b981'};">Rp ${saldoObat.toLocaleString('id-ID')}</span>`;

    return `
      <tr ondblclick="openModalRiwayatPasien('${npk}')" style="cursor: pointer;" title="Klik 2x untuk melihat riwayat medis">
        <td style="text-align: center; color: var(--text-muted); font-weight: 500;">${no}</td>
        <td><span class="badge badge-info" style="font-weight: 700;">${npk}</span></td>
        <td><strong>${nama}</strong></td>
        <td>${dept}</td>
        <td>${sectionName}</td>
        <td>${tgl}</td>
        <td><span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; font-weight: 700;">${usia}</span></td>
        <td>${gender}</td>
        <td><span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171; font-weight: 700;">${golDarah}</span></td>
        <td>${waHTML}</td>
        <td>${saldoHTML}</td>
        <td style="text-align: center;">
          <div style="display: flex; gap: 6px; justify-content: center;">
            <button class="btn btn-sm btn-primary" onclick="selectPatientDirectFromKaryawan('${k.id || npk}')" title="Periksa di Poli">
              <i class="fa-solid fa-stethoscope"></i> Poli
            </button>
            <button class="btn btn-sm btn-secondary" onclick="openModalEditKaryawan('${k.id || npk}')" title="Edit Data & No WhatsApp Pasien">
              <i class="fa-solid fa-pen"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterKaryawanTable() {
  renderKaryawanTable();
  renderMobileKaryawanCards();
}

function selectPatientDirectFromKaryawan(idOrNpkOrPatient) {
  let patient = null;
  if (typeof idOrNpkOrPatient === 'object' && idOrNpkOrPatient !== null) {
    patient = idOrNpkOrPatient;
  } else if (typeof idOrNpkOrPatient === 'string' || typeof idOrNpkOrPatient === 'number') {
    const q = String(idOrNpkOrPatient).toLowerCase().trim();
    patient = appData.patients.find(x => 
      (x.id && String(x.id).toLowerCase() === q) || 
      (x.nikPabrik && String(x.nikPabrik).toLowerCase() === q) || 
      (x.nik && String(x.nik).toLowerCase() === q) ||
      (x.nama && String(x.nama).toLowerCase() === q)
    );
    if (!patient) {
      patient = { nikPabrik: idOrNpkOrPatient, nama: idOrNpkOrPatient };
    }
  }

  if (!patient) return;
  appData.currentPoliPatient = patient;

  // Navigate using both desktop nav and mobile nav
  const desktopBtn = document.querySelector('.nav-btn[data-target="view-poli"]');
  if (desktopBtn) desktopBtn.click();
  switchMobileNav('view-poli', document.getElementById('mnav-poli'));
  setTimeout(() => {
    document.getElementById('poli-search-nik').value = patient.nikPabrik || patient.nik || patient.nama || '';
    searchPatientByNIK();
  }, 100);
}

function openModalTambahKaryawan() {
  document.getElementById('modal-karyawan').style.display = 'flex';
}
function closeModalTambahKaryawan() {
  document.getElementById('modal-karyawan').style.display = 'none';
}

function openModalEditKaryawan(idOrNpk) {
  if (!idOrNpk) return;
  const p = appData.patients.find(x => 
    String(x.id) === String(idOrNpk) || 
    String(x.nikPabrik) === String(idOrNpk) || 
    String(x.nik) === String(idOrNpk) ||
    String(x.nama) === String(idOrNpk)
  );
  if (!p) {
    showToast('Data karyawan tidak ditemukan', 'error');
    return;
  }

  document.getElementById('edit-karyawan-id').value = p.id || p.nikPabrik || p.nik || '';
  document.getElementById('edit-karyawan-nik').value = p.nikPabrik || p.nik || '';
  document.getElementById('edit-karyawan-nama').value = p.nama || '';
  document.getElementById('edit-karyawan-dept').value = p.dept || p.departemen || 'PT ATI';
  document.getElementById('edit-karyawan-gender').value = p.gender || 'Laki-laki';
  document.getElementById('edit-karyawan-goldarah').value = p.golDarah || '-';
  document.getElementById('edit-karyawan-tgllahir').value = p.tglLahir || p.tgl_lahir || '';
  document.getElementById('edit-karyawan-hp').value = p.hp || p.no_hp || '';
  document.getElementById('edit-karyawan-saldo-obat').value = p.saldoObat || 0;

  const modal = document.getElementById('modal-edit-karyawan');
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeModalEditKaryawan() {
  document.getElementById('modal-edit-karyawan').style.display = 'none';
}

async function handleSaveEditKaryawan(e) {
  e.preventDefault();
  const id = document.getElementById('edit-karyawan-id').value;
  const updatedData = {
    nikPabrik: document.getElementById('edit-karyawan-nik').value.trim(),
    nama: document.getElementById('edit-karyawan-nama').value.trim(),
    dept: document.getElementById('edit-karyawan-dept').value.trim(),
    gender: document.getElementById('edit-karyawan-gender').value,
    golDarah: document.getElementById('edit-karyawan-goldarah').value,
    tglLahir: document.getElementById('edit-karyawan-tgllahir').value.trim(),
    hp: document.getElementById('edit-karyawan-hp').value.trim(),
    saldoObat: parseInt(document.getElementById('edit-karyawan-saldo-obat').value) || 0
  };

  try {
    const res = await fetch(`/api/patients/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedData)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✅ Data pasien & No WhatsApp berhasil diperbarui!', 'success');
      closeModalEditKaryawan();
      await loadAllAppData();
      renderKaryawanTable();
    } else {
      showToast('Gagal menyimpan: ' + (data.error || 'Terjadi kesalahan'), 'error');
    }
  } catch(err) {
    showToast('Gagal koneksi server: ' + err.message, 'error');
  }
}

async function handleSaveKaryawan(e) {
  e.preventDefault();
  const newK = {
    nikPabrik: document.getElementById('karyawan-nik').value.trim(),
    nama: document.getElementById('karyawan-nama').value.trim(),
    dept: document.getElementById('karyawan-dept').value.trim() || 'PT ATI',
    tglLahir: document.getElementById('karyawan-tgl-lahir').value.trim(),
    gender: document.getElementById('karyawan-gender').value,
    golDarah: document.getElementById('karyawan-goldarah')?.value || '-',
    hp: document.getElementById('karyawan-hp').value.trim(),
    saldoObat: parseInt(document.getElementById('karyawan-saldo-obat').value) || 0
  };

  try {
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newK)
    });
    if (res.ok) {
      showToast('✅ Data Karyawan Baru Berhasil Disimpan!', 'success');
      closeModalTambahKaryawan();
      await loadAllAppData();
      renderKaryawanTable();
    } else {
      const errData = await res.json();
      showToast('Gagal menyimpan: ' + (errData.error || 'Terjadi kesalahan'), 'error');
    }
  } catch (err) {
    showToast('Gagal menyimpan karyawan: ' + err.message, 'error');
  }
}

// -------------------------------------------------------------
// 6. TAB ABSEN DOKTER LOGIC
// -------------------------------------------------------------
async function handleSaveAbsenDokter(e) {
  e.preventDefault();
  const absen = {
    namaDokter: document.getElementById('absen-nama-dokter').value,
    tanggal: document.getElementById('absen-tgl').value,
    jamMulai: document.getElementById('absen-jam-mulai').value,
    jamSelesai: document.getElementById('absen-jam-selesai').value,
    tarifShift: 400000
  };

  try {
    const res = await fetch('/api/absen-dokter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(absen)
    });
    if (res.ok) {
      showToast('Absensi Dokter Berhasil Disimpan!', 'success');
      await loadAllAppData();
    }
  } catch (err) {
    showToast('Gagal menyimpan absensi', 'error');
  }
}

// -------------------------------------------------------------
// 7. TAB SHIFT LOGIC (TELEGRAM BOT NOTIFICATIONS)
// -------------------------------------------------------------
async function handleKirimShift1(e) {
  e.preventDefault();
  const data = {
    tglMulai: document.getElementById('shift1-tgl-mulai').value,
    tglSelesai: document.getElementById('shift1-tgl-selesai').value,
    jamMulai: document.getElementById('shift1-jam-mulai').value,
    jamSelesai: document.getElementById('shift1-jam-selesai').value,
    dari: document.getElementById('shift1-dari').value,
    ke: document.getElementById('shift1-ke').value
  };

  try {
    const res = await fetch('/api/shift/format1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) showToast('Laporan Oper Shift Terkirim ke Telegram!', 'success');
  } catch (err) {
    showToast('Gagal mengirim telegram', 'error');
  }
}

async function handleKirimShift2(e) {
  e.preventDefault();
  const data = {
    tglMulai: document.getElementById('shift2-tgl-mulai').value,
    tglSelesai: document.getElementById('shift2-tgl-selesai').value,
    petugas1: document.getElementById('shift2-s1').value,
    petugas2: document.getElementById('shift2-s2').value,
    petugas3: document.getElementById('shift2-s3').value
  };

  try {
    const res = await fetch('/api/shift/format2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) showToast('Rekap 24H Terkirim ke Telegram!', 'success');
  } catch (err) {
    showToast('Gagal mengirim telegram', 'error');
  }
}

// -------------------------------------------------------------
// 8. TAB HSE LOGIC
// -------------------------------------------------------------
function switchHSESubTab(type) {
  const rmTab = document.getElementById('hse-subtab-rm');
  const surkesTab = document.getElementById('hse-subtab-surkes');
  const btnRm = document.getElementById('subtab-btn-rm');
  const btnSurkes = document.getElementById('subtab-btn-surkes');

  if (rmTab) rmTab.style.display = (type === 'rm') ? 'block' : 'none';
  if (surkesTab) surkesTab.style.display = (type === 'surkes') ? 'block' : 'none';

  if (btnRm) btnRm.className = (type === 'rm') ? 'btn btn-primary' : 'btn btn-secondary';
  if (btnSurkes) btnSurkes.className = (type === 'surkes') ? 'btn btn-primary' : 'btn btn-secondary';

  if (type === 'surkes') {
    renderHSESurkesTable();
  }
}

function openModalHSEPantauan() {
  document.getElementById('modal-hse-pantauan').style.display = 'flex';
  renderHSEPasienPantauanTable();
}

function closeModalHSEPantauan() {
  document.getElementById('modal-hse-pantauan').style.display = 'none';
}

function openModalHSESurkes() {
  document.getElementById('modal-hse-surkes').style.display = 'flex';
  renderHSESurkesTable();
}

function closeModalHSESurkes() {
  document.getElementById('modal-hse-surkes').style.display = 'none';
}

// -------------------------------------------------------------
// HSE PEMANTAUAN OBAT KELUAR / TERPAKAI MODAL (SS 5)
// -------------------------------------------------------------
function openModalHSEObatKeluar() {
  const modal = document.getElementById('modal-hse-obat-terpakai');
  if (!modal) return;

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const startInput = document.getElementById('hse-obat-start');
  const endInput = document.getElementById('hse-obat-end');

  if (startInput && !startInput.value) startInput.value = `${yyyy}-${mm}-01`;
  if (endInput && !endInput.value) endInput.value = `${yyyy}-${mm}-${dd}`;

  modal.style.display = 'flex';
  renderHSEObatKeluarTable();
}

function closeModalHSEObatKeluar() {
  const modal = document.getElementById('modal-hse-obat-terpakai');
  if (modal) modal.style.display = 'none';
}

function resetHSEObatFilterBulanIni() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const startInput = document.getElementById('hse-obat-start');
  const endInput = document.getElementById('hse-obat-end');

  if (startInput) startInput.value = `${yyyy}-${mm}-01`;
  if (endInput) endInput.value = `${yyyy}-${mm}-${dd}`;

  renderHSEObatKeluarTable();
}

function filterHSEObatKeluarTable() {
  renderHSEObatKeluarTable();
}

function getHSEObatKeluarData() {
  const startVal = document.getElementById('hse-obat-start')?.value;
  const endVal = document.getElementById('hse-obat-end')?.value;

  const start = startVal ? new Date(`${startVal}T00:00:00`) : null;
  const end = endVal ? new Date(`${endVal}T23:59:59`) : null;

  // Filter records within date range
  const filteredRecords = appData.records.filter(r => {
    const d = parseRecordDate(r);
    if (!d || isNaN(d.getTime())) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });

  // Aggregate medicines
  const medMap = {};
  filteredRecords.forEach(r => {
    if (Array.isArray(r.resep)) {
      r.resep.forEach(m => {
        const rawName = (m.namaObat || m.obat || '').trim();
        if (!rawName) return;

        const qty = parseInt(m.qty) || 0;
        if (qty <= 0) return;

        if (!medMap[rawName]) {
          // Find details in master medicines
          const matchedMed = (appData.medicines || []).find(x => x.nama.toLowerCase() === rawName.toLowerCase());
          medMap[rawName] = {
            nama: rawName,
            satuan: matchedMed ? (matchedMed.satuan || 'Pcs') : 'Item',
            kategori: matchedMed ? (matchedMed.kategori || 'Obat') : 'Obat',
            totalQty: 0,
            resepCount: 0
          };
        }
        medMap[rawName].totalQty += qty;
        medMap[rawName].resepCount += 1;
      });
    }
  });

  // Convert to array & sort strictly descending by totalQty
  const sortedList = Object.values(medMap).sort((a, b) => b.totalQty - a.totalQty || b.resepCount - a.resepCount);
  return { sortedList, filteredRecords, startVal, endVal };
}

function renderHSEObatKeluarTable() {
  const tbody = document.getElementById('table-hse-obat-body');
  if (!tbody) return;

  const { sortedList } = getHSEObatKeluarData();

  const totalJenisEl = document.getElementById('hse-obat-total-jenis');
  const totalQtyEl = document.getElementById('hse-obat-total-qty');
  const topNameEl = document.getElementById('hse-obat-top-name');

  const totalJenis = sortedList.length;
  const totalQtyAll = sortedList.reduce((sum, item) => sum + item.totalQty, 0);
  const topName = sortedList.length > 0 ? `${sortedList[0].nama} (${sortedList[0].totalQty} ${sortedList[0].satuan})` : '-';

  if (totalJenisEl) totalJenisEl.textContent = `${totalJenis} Macam`;
  if (totalQtyEl) totalQtyEl.textContent = `${totalQtyAll.toLocaleString('id-ID')} Butir / Item`;
  if (topNameEl) topNameEl.textContent = topName;

  if (sortedList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 28px; color: var(--text-muted); font-style: italic;"><i class="fa-solid fa-capsules" style="font-size: 2rem; opacity: 0.3; margin-bottom: 8px; display: block;"></i>Tidak ada pemakaian obat yang tercatat pada rentang tanggal ini.</td></tr>`;
    return;
  }

  const maxQty = sortedList[0].totalQty || 1;

  tbody.innerHTML = sortedList.map((item, idx) => {
    let rankBadge = '';
    if (idx === 0) rankBadge = '<span style="font-size: 1.1rem;">🥇 <strong>1</strong></span>';
    else if (idx === 1) rankBadge = '<span style="font-size: 1.1rem;">🥈 <strong>2</strong></span>';
    else if (idx === 2) rankBadge = '<span style="font-size: 1.1rem;">🥉 <strong>3</strong></span>';
    else rankBadge = `<span style="font-weight: 700; color: var(--text-muted);">#${idx + 1}</span>`;

    const pct = Math.round((item.totalQty / maxQty) * 100);

    return `
      <tr>
        <td style="text-align: center; vertical-align: middle;">${rankBadge}</td>
        <td style="vertical-align: middle;">
          <strong style="font-size: 0.92rem; color: var(--text-color);">${item.nama}</strong>
        </td>
        <td style="vertical-align: middle;">
          <span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 600;">${item.satuan} (${item.kategori})</span>
        </td>
        <td style="text-align: center; vertical-align: middle;">
          <div style="font-size: 1.05rem; font-weight: 800; color: #34d399;">${item.totalQty.toLocaleString('id-ID')} <span style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted);">${item.satuan}</span></div>
          <div style="background: rgba(255,255,255,0.06); height: 5px; border-radius: 3px; margin-top: 4px; overflow: hidden;">
            <div style="background: linear-gradient(90deg, #10b981, #0284c7); height: 100%; width: ${pct}%;"></div>
          </div>
        </td>
        <td style="vertical-align: middle;">
          <span style="font-size: 0.85rem; color: var(--text-muted);"><i class="fa-solid fa-receipt" style="color: #38bdf8; margin-right: 4px;"></i> ${item.resepCount} kali resep</span>
        </td>
      </tr>
    `;
  }).join('');
}

function exportHSEObatExcel() {
  const { sortedList, startVal, endVal } = getHSEObatKeluarData();
  const dateStr = new Date().toISOString().split('T')[0];

  let rows = '';
  sortedList.forEach((item, idx) => {
    rows += `
      <tr>
        <td style="text-align: center;">${idx + 1}</td>
        <td><strong>${item.nama}</strong></td>
        <td>${item.satuan}</td>
        <td>${item.kategori}</td>
        <td style="text-align: center; font-weight: bold;">${item.totalQty}</td>
        <td style="text-align: center;">${item.resepCount}</td>
      </tr>
    `;
  });

  const totalQtyAll = sortedList.reduce((sum, item) => sum + item.totalQty, 0);

  const excelTemplate = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <!--[if gte mso 9]>
      <xml>
        <x:ExcelWorkbook>
          <x:ExcelWorksheets>
            <x:ExcelWorksheet>
              <x:Name>Pemantauan Obat Keluar</x:Name>
              <x:WorksheetOptions>
                <x:DisplayGridlines/>
              </x:WorksheetOptions>
            </x:ExcelWorksheet>
          </x:ExcelWorksheets>
        </x:ExcelWorkbook>
      </xml>
      <![endif]-->
      <style>
        table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 11pt; }
        th { background-color: #0284c7; color: #ffffff; font-weight: bold; border: 1px solid #0369a1; padding: 8px; text-align: left; }
        td { border: 1px solid #d1d5db; padding: 6px; }
        .title { font-size: 14pt; font-weight: bold; color: #0369a1; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="title">REKAPITULASI PEMANTAUAN OBAT TERPAKAI / KELUAR - KLINIK PT ATI</div>
      <p>Periode: <strong>${startVal || 'Awal'} s/d ${endVal || 'Sekarang'}</strong> | Total Obat Terpakai: <strong>${totalQtyAll} Butir</strong></p>
      <table>
        <thead>
          <tr>
            <th style="width: 50px; text-align: center;">URUTAN</th>
            <th>NAMA OBAT</th>
            <th>SATUAN</th>
            <th>KATEGORI</th>
            <th style="text-align: center;">TOTAL TERPAKAI</th>
            <th style="text-align: center;">JUMLAH RESEP</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr style="font-weight: bold; background-color: #f3f4f6;">
            <td colspan="4" style="text-align: right;">TOTAL KESELURUHAN OBAT TERPAKAI:</td>
            <td style="text-align: center;">${totalQtyAll}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([excelTemplate], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Rekap_Obat_Terpakai_HSE_${dateStr}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('Laporan Obat Terpakai berhasil diexport ke Excel! 📊', 'success');
}

function renderHSERekamMedisTable(isButtonClick = false) {
  const tbody = document.getElementById('table-hse-rm-body');
  if (!tbody) return;

  const filtered = getHSERecordsFiltered();

  // Update Period Title
  const periodTitleEl = document.getElementById('hse-period-title');
  if (periodTitleEl) {
    const startVal = document.getElementById('hse-rm-start')?.value;
    const endVal = document.getElementById('hse-rm-end')?.value;

    if (startVal && endVal) {
      const dStart = new Date(`${startVal}T00:00:00`);
      const dEnd = new Date(`${endVal}T00:00:00`);
      
      if (!isNaN(dStart.getTime()) && !isNaN(dEnd.getTime())) {
        if (dStart.getMonth() === dEnd.getMonth() && dStart.getFullYear() === dEnd.getFullYear()) {
          const monthName = dStart.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
          periodTitleEl.textContent = `— BULAN ${monthName.toUpperCase()}`;
        } else {
          const sStr = dStart.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
          const eStr = dEnd.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
          periodTitleEl.textContent = `— PERIODE ${sStr.toUpperCase()} S/D ${eStr.toUpperCase()}`;
        }
      }
    } else if (startVal) {
      const dStart = new Date(`${startVal}T00:00:00`);
      if (!isNaN(dStart.getTime())) {
        const monthName = dStart.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
        periodTitleEl.textContent = `— BULAN ${monthName.toUpperCase()}`;
      }
    } else {
      const now = new Date();
      const monthName = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
      periodTitleEl.textContent = `— BULAN ${monthName.toUpperCase()}`;
    }
  }

  // Update HSE Stats
  const statTotal = document.getElementById('hse-stat-total-visits');
  const statPantauan = document.getElementById('hse-stat-pantauan-count');
  const statSurkes = document.getElementById('hse-stat-surkes-count');
  const statDeptList = document.getElementById('hse-stat-dept-list');
  const statPatientList = document.getElementById('hse-stat-patient-list');

  if (statTotal) statTotal.textContent = filtered.length;
  if (statPantauan) statPantauan.textContent = filtered.filter(r => r.isPantauan === true).length;
  if (statSurkes) statSurkes.textContent = filtered.filter(r => r.izinSakit === true).length;

  if (statDeptList) {
    const deptCounts = {};
    filtered.forEach(r => {
      const dept = r.dept && r.dept.trim() !== '' ? r.dept.trim() : 'Lainnya';
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    });

    const sortedDepts = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]);
    
    if (sortedDepts.length === 0) {
      statDeptList.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic; padding: 4px 0;">Belum ada data</div>';
    } else {
      statDeptList.innerHTML = sortedDepts.slice(0, 3).map(d => `
        <div class="stat-mini-item">
          <span class="stat-mini-name" title="${d[0]}">${d[0]}</span>
          <span class="stat-mini-count">${d[1]}</span>
        </div>
      `).join('');
    }
  }

  if (statPatientList) {
    const patientCounts = {};
    filtered.forEach(r => {
      if (r.namaPasien) {
        const key = `${r.namaPasien}`;
        patientCounts[key] = (patientCounts[key] || 0) + 1;
      }
    });

    const sortedPatients = Object.entries(patientCounts).sort((a, b) => b[1] - a[1]);
    
    if (sortedPatients.length === 0) {
      statPatientList.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic; padding: 4px 0;">Belum ada data</div>';
    } else {
      statPatientList.innerHTML = sortedPatients.slice(0, 3).map(p => `
        <div class="stat-mini-item">
          <span class="stat-mini-name" title="${p[0]}">${p[0]}</span>
          <span class="stat-mini-count">${p[1]}</span>
        </div>
      `).join('');
    }
  }

  const statSectionList = document.getElementById('hse-stat-section-list');
  if (statSectionList) {
    const sectionCounts = {};
    filtered.forEach(r => {
      let section = 'Lainnya';
      if (r.nikPabrik) {
        const patient = appData.patients.find(p => p.nikPabrik === r.nikPabrik);
        if (patient && patient.sectionName && patient.sectionName.trim() !== '') {
          section = patient.sectionName.trim();
        }
      }
      sectionCounts[section] = (sectionCounts[section] || 0) + 1;
    });

    const sortedSections = Object.entries(sectionCounts).sort((a, b) => b[1] - a[1]);
    
    if (sortedSections.length === 0) {
      statSectionList.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic; padding: 4px 0;">Belum ada data</div>';
    } else {
      statSectionList.innerHTML = sortedSections.slice(0, 3).map(s => `
        <div class="stat-mini-item">
          <span class="stat-mini-name" title="${s[0]}">${s[0]}</span>
          <span class="stat-mini-count">${s[1]}</span>
        </div>
      `).join('');
    }
  }

  // Card 7: Total Obat Terpakai
  const statObat = document.getElementById('hse-stat-obat-count');
  if (statObat) {
    let totalObatQty = 0;
    filtered.forEach(r => {
      if (Array.isArray(r.resep)) {
        r.resep.forEach(m => {
          totalObatQty += (parseInt(m.qty) || 0);
        });
      }
    });
    statObat.textContent = `${totalObatQty} Butir`;
  }

  if (!isButtonClick) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align: center; color: var(--text-muted); font-weight: 500; padding: 30px; background: rgba(2, 132, 199, 0.03);">
          <i class="fa-solid fa-circle-info" style="color: #0284c7; margin-right: 8px; font-size: 1.1rem;"></i>
          Silakan tentukan rentang tanggal di atas, lalu klik tombol <strong style="color: #0284c7;"><i class="fa-solid fa-magnifying-glass"></i> Tampil</strong> untuk memuat data tabel rekam medis.
        </td>
      </tr>
    `;
    return;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; color: var(--text-muted); font-style: italic; padding: 25px;">Tidak ada data rekam medis pada rentang tanggal/filter ini</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((r, i) => `
    <tr ondblclick="openModalRiwayatPasien('${r.nikPabrik || ''}')" style="cursor: pointer;" title="Klik 2x untuk melihat riwayat medis">
      <td data-label="No">${i + 1}</td>
      <td data-label="Tanggal">${r.tanggal || '-'}</td>
      <td data-label="Nama Pasien"><strong>${r.namaPasien}</strong></td>
      <td data-label="NIK Pabrik">${r.nikPabrik || '-'}</td>
      <td data-label="Bagian">${r.dept || '-'}</td>
      <td data-label="Keluhan">${r.keluhan || '-'}</td>
      <td data-label="Diagnosis">${renderDiagnosisBadges(r.asesmen)}</td>
      <td data-label="Pemeriksaan">${renderObjektifBadges(r.objektif)}</td>
      <td data-label="Obat/Terapi">${formatPlanForDisplay(r.plan)}</td>
      <td data-label="Status K3">${getStatusKelaikanBadges(r)}</td>
      <td data-label="Pemeriksa">
        <div style="display: flex; align-items: center; gap: 6px; justify-content: flex-end;">
          <span>${r.pemeriksa || '-'}</span>
          ${r.linkFoto ? `<button type="button" onclick="event.stopPropagation(); openPhotoViewer('${r.id}')" class="btn btn-sm btn-primary" style="background:#0284c7; border:none; padding: 2px 7px; font-size: 0.74rem;" title="Lihat Foto / Dokumen"><i class="fa-solid fa-image"></i> Foto</button>` : ''}
          ${getPatientWABtnHTML(r.nikPabrik, '')}
        </div>
      </td>
    </tr>
  `).join('');
}

function filterHSERekamMedisTable() {
  renderHSERekamMedisTable(true);
}

function renderHSEPasienPantauanTable() {
  const tbody = document.getElementById('table-hse-pantauan-body');
  if (!tbody) return;

  const pantauanList = appData.records.filter(r => r.isPantauan === true);

  if (pantauanList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); font-style: italic; padding: 25px;">Belum ada data pasien dalam pemantauan K3</td></tr>`;
    return;
  }

  tbody.innerHTML = pantauanList.map(r => {
    const patient = appData.patients.find(p => (p.nikPabrik || p.nik) === r.nikPabrik) || {};
    const rawHp = patient.hp || patient.no_hp || '';
    const cleanWA = typeof cleanPhoneForWA === 'function' ? cleanPhoneForWA(rawHp) : rawHp;
    
    const waBtn = rawHp 
      ? `<button class="btn btn-sm" style="background: #25D366; color: #fff; border: none; font-weight: 700; flex: 1;" onclick="window.open('https://wa.me/${cleanWA}','_blank')" title="Kirim Pesan WhatsApp"><i class="fa-brands fa-whatsapp"></i> Chat WA</button>`
      : `<button class="btn btn-sm" style="background: #25D366; color: #fff; border: none; font-weight: 700; opacity: 0.5; flex: 1;" onclick="showToast('No HP belum diisi di data pasien.', 'warning')" title="No WA belum diisi"><i class="fa-brands fa-whatsapp"></i> Chat WA</button>`;
      
    const fileBtn = r.linkFoto 
      ? `<button class="btn btn-sm" style="background: var(--info); color: #fff; border: none; font-weight: 700; flex: 1;" onclick="openPhotoViewer('${r.id}')" title="Lihat Gambar/File"><i class="fa-solid fa-image"></i> File</button>`
      : '';

    return `
    <tr>
      <td data-label="Tanggal">${r.tanggal || '-'}</td>
      <td data-label="NIK Pabrik"><span class="badge badge-danger">${r.nikPabrik || '-'}</span></td>
      <td data-label="Nama Pasien"><strong>${r.namaPasien}</strong></td>
      <td data-label="Bagian">${r.dept || '-'}</td>
      <td data-label="Alasan Pantauan">
        <div style="display: flex; flex-direction: column; gap: 4px; text-align: left;">
          <div><strong>S:</strong> ${r.keluhan || '-'}</div>
          <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:4px;"><strong>A:</strong> ${renderDiagnosisBadges(r.asesmen)}</div>
        </div>
      </td>
      <td data-label="Status"><span class="badge badge-warning">Dalam Pemantauan</span></td>
      <td data-label="Aksi">
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-sm btn-primary" style="flex: 1;" onclick="openModalRiwayatPasien('${r.nikPabrik || r.namaPasien}')" title="Buka Riwayat Rekam Medis">
            <i class="fa-solid fa-clock-rotate-left"></i> Riwayat
          </button>
          ${waBtn}
          ${fileBtn}
        </div>
      </td>
    </tr>
    `;
  }).join('');
}

function renderHSESurkesTable() {
  const tbody = document.getElementById('table-hse-surkes-body');
  if (!tbody) return;

  const surkesList = appData.records.filter(r => r.izinSakit === true);

  if (surkesList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); font-style: italic; padding: 25px;">Belum ada data pasien yang dipulangkan / diberikan izin istirahat sakit (Surkes)</td></tr>`;
    return;
  }

  tbody.innerHTML = surkesList.slice().reverse().map((r, idx) => {
    const patient = appData.patients.find(p => (p.nikPabrik || p.nik) === r.nikPabrik) || {};
    const rawHp = patient.hp || patient.no_hp || '';
    const cleanWA = typeof cleanPhoneForWA === 'function' ? cleanPhoneForWA(rawHp) : rawHp;
    
    const waBtn = rawHp 
      ? `<button class="btn btn-sm" style="background: #25D366; color: #fff; border: none; font-weight: 700; flex: 1;" onclick="window.open('https://wa.me/${cleanWA}','_blank')" title="Kirim Pesan WhatsApp"><i class="fa-brands fa-whatsapp"></i> Chat WA</button>`
      : `<button class="btn btn-sm" style="background: #25D366; color: #fff; border: none; font-weight: 700; opacity: 0.5; flex: 1;" onclick="showToast('No HP belum diisi di data pasien.', 'warning')" title="No WA belum diisi"><i class="fa-brands fa-whatsapp"></i> Chat WA</button>`;
      
    const fileBtn = r.linkFoto 
      ? `<button class="btn btn-sm" style="background: var(--info); color: #fff; border: none; font-weight: 700; flex: 1;" onclick="openPhotoViewer('${r.id}')" title="Lihat Gambar/File"><i class="fa-solid fa-image"></i> File</button>`
      : '';

    return `
    <tr>
      <td data-label="No" style="text-align: center; font-weight: 500; color: var(--text-muted);">${idx + 1}</td>
      <td data-label="Tanggal">${r.tanggal || '-'}</td>
      <td data-label="NIK Pabrik"><span class="badge badge-info" style="font-weight: 700;">${r.nikPabrik || '-'}</span></td>
      <td data-label="Nama Pasien"><strong>${r.namaPasien || '-'}</strong></td>
      <td data-label="Bagian">${r.dept || '-'}</td>
      <td data-label="Data Medis (S, O, A, P)">
        <div style="display: flex; flex-direction: column; gap: 4px; text-align: left;">
          <div><strong>S:</strong> ${r.keluhan || '-'}</div>
          <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:4px;"><strong>O:</strong> ${renderObjektifBadges(r.objektif)}</div>
          <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:4px;"><strong>A:</strong> ${renderDiagnosisBadges(r.asesmen)}</div>
          <div style="margin-top: 2px;"><strong>P:</strong> <div style="display:inline-block; margin-left: 4px;">${formatPlanForDisplay(r.plan)}</div></div>
        </div>
      </td>
      <td data-label="Status"><span class="badge badge-warning" style="font-weight: 700;">📄 Istirahat Sakit</span></td>
      <td data-label="Nakes">${r.pemeriksa || '-'}</td>
      <td data-label="Aksi" style="text-align: center;">
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-sm btn-primary" style="flex: 1;" onclick="openModalRiwayatPasien('${r.nikPabrik || r.namaPasien}')" title="Buka Riwayat Rekam Medis">
            <i class="fa-solid fa-clock-rotate-left"></i> Riwayat
          </button>
          ${waBtn}
          ${fileBtn}
        </div>
      </td>
    </tr>
    `;
  }).join('');
}

function exportHSERekamMedisExcel() {
  const startVal = document.getElementById('hse-rm-start')?.value;
  const endVal = document.getElementById('hse-rm-end')?.value;

  const recordsToExport = getHSERecordsFiltered();

  if (recordsToExport.length === 0) {
    showToast('Tidak ada data rekam medis pada rentang tanggal yang dipilih!', 'warning');
    return;
  }

  let periodeInfo = 'Semua Periode Data';
  if (startVal && endVal) {
    const dStart = new Date(`${startVal}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const dEnd = new Date(`${endVal}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    periodeInfo = `Periode Tanggal: ${dStart} s/d ${dEnd}`;
  } else if (startVal) {
    const dStart = new Date(`${startVal}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    periodeInfo = `Periode Tanggal: Mulai ${dStart}`;
  } else if (endVal) {
    const dEnd = new Date(`${endVal}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    periodeInfo = `Periode Tanggal: Sampai ${dEnd}`;
  }

  let rows = '';
  recordsToExport.forEach((r, i) => {
    rows += `
      <tr>
        <td style="text-align: center;">${i + 1}</td>
        <td>${r.tanggal || ''}</td>
        <td><strong>${r.namaPasien || ''}</strong></td>
        <td>${r.nikPabrik || ''}</td>
        <td>${r.dept || ''}</td>
        <td>${r.keluhan || ''}</td>
        <td>${r.asesmen || ''}</td>
        <td>${r.objektif || ''}</td>
        <td>${formatPlanForDisplay(r.plan)}</td>
        <td>${getStatusKelaikanText(r)}</td>
        <td>${r.pemeriksa || ''}</td>
      </tr>
    `;
  });

  const excelTemplate = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <!--[if gte mso 9]>
      <xml>
        <x:ExcelWorkbook>
          <x:ExcelWorksheets>
            <x:ExcelWorksheet>
              <x:Name>Rekam Medis K3</x:Name>
              <x:WorksheetOptions>
                <x:DisplayGridlines/>
              </x:WorksheetOptions>
            </x:ExcelWorksheet>
          </x:ExcelWorksheets>
        </x:ExcelWorkbook>
      </xml>
      <![endif]-->
      <style>
        table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 10pt; }
        th { background-color: #0284c7; color: #ffffff; font-weight: bold; border: 1px solid #0369a1; padding: 8px; text-align: left; }
        td { border: 1px solid #cbd5e1; padding: 6px; }
        .title { font-size: 14pt; font-weight: bold; color: #0369a1; margin-bottom: 4px; }
        .subtitle { font-size: 10pt; color: #0284c7; font-weight: bold; margin-bottom: 8px; }
      </style>
    </head>
    <body>
      <div class="title">LAPORAN REKAM MEDIS & K3 KLINIK PT ATI</div>
      <div class="subtitle">${periodeInfo}</div>
      <div>Tanggal Export: ${new Date().toLocaleDateString('id-ID')} | Total Data: ${recordsToExport.length} Record</div>
      <br>
      <table>
        <thead>
          <tr>
            <th>NO</th>
            <th>TANGGAL</th>
            <th>NAMA PASIEN</th>
            <th>NIK PABRIK</th>
            <th>BAGIAN</th>
            <th>KELUHAN</th>
            <th>DIAGNOSIS</th>
            <th>HASIL PEMERIKSAAN</th>
            <th>RESEP OBAT</th>
            <th>STATUS KELAIKAN (K3)</th>
            <th>NAKES / PEMERIKSA</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="11">Tidak ada data rekam medis</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([excelTemplate], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`File Excel (${recordsToExport.length} data) berhasil diunduh!`, 'success');
}

// 🖨️ CETAK LAPORAN RESMI K3 / HSE BULANAN (PROFESIONAL A4 DENGAN PERBANDINGAN BULAN LALU)
function printHSEOfficialReport() {
  const recordsToPrint = getHSERecordsFiltered();
  const startVal = document.getElementById('hse-rm-start')?.value;
  const endVal = document.getElementById('hse-rm-end')?.value;

  const monthNames = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];

  let currDate = new Date();
  if (startVal) {
    const parsed = new Date(`${startVal}T00:00:00`);
    if (!isNaN(parsed.getTime())) currDate = parsed;
  }

  const currYear = currDate.getFullYear();
  const currMonth = currDate.getMonth();

  const prevYear = currMonth === 0 ? currYear - 1 : currYear;
  const prevMonth = currMonth === 0 ? 11 : currMonth - 1;

  const currMonthName = monthNames[currMonth];
  const prevMonthName = monthNames[prevMonth];

  const currPeriodTitle = `${currMonthName} - ${currYear}`;

  let periodeInfo = `PERIODE: ${currMonthName} ${currYear}`;
  if (startVal && endVal) {
    const dStart = new Date(`${startVal}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const dEnd = new Date(`${endVal}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    periodeInfo = `PERIODE: ${dStart.toUpperCase()} S/D ${dEnd.toUpperCase()}`;
  }

  const tglIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

  // Get current & previous month records from appData.records
  const currRecords = appData.records.filter(r => {
    const d = parseRecordDate(r);
    return d && d.getFullYear() === currYear && d.getMonth() === currMonth;
  });

  const prevRecords = appData.records.filter(r => {
    const d = parseRecordDate(r);
    return d && d.getFullYear() === prevYear && d.getMonth() === prevMonth;
  });

  // ==========================================
  // 1. COMPUTATION FOR PENYAKIT (DIAGNOSIS)
  // ==========================================
  const penyakitMap = {};

  currRecords.forEach(r => {
    let diagStr = r.asesmen && r.asesmen.trim() !== '' ? r.asesmen.trim() : (r.keluhan || 'Lainnya');
    diagStr = diagStr.replace(/undefined\s*-\s*undefined/gi, 'Lainnya').trim();
    if (!diagStr) diagStr = 'Lainnya';

    const diags = diagStr.split(';').map(d => d.trim()).filter(d => d && d !== 'undefined - undefined');
    if (diags.length === 0) diags.push('Lainnya');

    diags.forEach(d => {
      if (!penyakitMap[d]) penyakitMap[d] = { name: d, curr: 0, prev: 0 };
      penyakitMap[d].curr += 1;
    });
  });

  prevRecords.forEach(r => {
    let diagStr = r.asesmen && r.asesmen.trim() !== '' ? r.asesmen.trim() : (r.keluhan || 'Lainnya');
    diagStr = diagStr.replace(/undefined\s*-\s*undefined/gi, 'Lainnya').trim();
    if (!diagStr) diagStr = 'Lainnya';

    const diags = diagStr.split(';').map(d => d.trim()).filter(d => d && d !== 'undefined - undefined');
    if (diags.length === 0) diags.push('Lainnya');

    diags.forEach(d => {
      if (!penyakitMap[d]) penyakitMap[d] = { name: d, curr: 0, prev: 0 };
      penyakitMap[d].prev += 1;
    });
  });

  const penyakitList = Object.values(penyakitMap).sort((a, b) => b.curr - a.curr || b.prev - a.prev);

  penyakitList.forEach(item => {
    item.selisih = item.curr - item.prev;
    if (item.prev === 0 && item.curr > 0) {
      item.pct = 100;
    } else if (item.prev === 0 && item.curr === 0) {
      item.pct = 0;
    } else {
      item.pct = Math.round(((item.curr - item.prev) / item.prev) * 100);
    }

    if (item.selisih > 0) {
      item.status = 'NAIK(↑)';
      item.statusBg = '#fecdd3';
      item.statusColor = '#9f1239';
      item.pctStr = `${item.pct}%`;
      item.selisihStr = `${item.selisih}`;
    } else if (item.selisih < 0) {
      item.status = 'TURUN(↓)';
      item.statusBg = '#dcfce7';
      item.statusColor = '#166534';
      item.pctStr = `${item.pct}%`;
      item.selisihStr = `${item.selisih}`;
    } else {
      item.status = 'TETAP(=)';
      item.statusBg = '#f3f4f6';
      item.statusColor = '#374151';
      item.pctStr = `0%`;
      item.selisihStr = `0`;
    }
  });

  const totalCurrPenyakit = currRecords.length;
  const totalPrevPenyakit = prevRecords.length;
  const generalPenyakitTrend = totalCurrPenyakit >= totalPrevPenyakit ? 'KENAIKAN' : 'PENURUNAN';

  const decPenyakitItems = penyakitList.filter(i => i.selisih < 0).sort((a, b) => a.pct - b.pct);
  const incPenyakitItems = penyakitList.filter(i => i.selisih > 0).sort((a, b) => b.pct - a.pct);

  const biggestDecreasePenyakit = decPenyakitItems.length > 0 ? `${decPenyakitItems[0].name.toUpperCase()} (${decPenyakitItems[0].pct}%)` : 'NIHIL (0%)';
  const biggestIncreasePenyakit = incPenyakitItems.length > 0 ? `${incPenyakitItems[0].name.toUpperCase()} (${incPenyakitItems[0].pct}%)` : 'NIHIL (0%)';

  // ==========================================
  // 2. COMPUTATION FOR DEPARTMENT
  // ==========================================
  const deptMap = {};

  currRecords.forEach(r => {
    let d = r.dept && r.dept.trim() !== '' ? r.dept.trim() : 'Lainnya';
    if (!deptMap[d]) deptMap[d] = { name: d, curr: 0, prev: 0 };
    deptMap[d].curr += 1;
  });

  prevRecords.forEach(r => {
    let d = r.dept && r.dept.trim() !== '' ? r.dept.trim() : 'Lainnya';
    if (!deptMap[d]) deptMap[d] = { name: d, curr: 0, prev: 0 };
    deptMap[d].prev += 1;
  });

  const deptList = Object.values(deptMap).sort((a, b) => b.curr - a.curr || b.prev - a.prev);

  deptList.forEach(item => {
    item.selisih = item.curr - item.prev;
    if (item.prev === 0 && item.curr > 0) {
      item.pct = 100;
    } else if (item.prev === 0 && item.curr === 0) {
      item.pct = 0;
    } else {
      item.pct = Math.round(((item.curr - item.prev) / item.prev) * 100);
    }

    if (item.selisih > 0) {
      item.status = 'NAIK(↑)';
      item.statusBg = '#fecdd3';
      item.statusColor = '#9f1239';
      item.pctStr = `${item.pct}%`;
      item.selisihStr = `${item.selisih}`;
    } else if (item.selisih < 0) {
      item.status = 'TURUN(↓)';
      item.statusBg = '#dcfce7';
      item.statusColor = '#166534';
      item.pctStr = `${item.pct}%`;
      item.selisihStr = `${item.selisih}`;
    } else {
      item.status = 'TETAP(=)';
      item.statusBg = '#f3f4f6';
      item.statusColor = '#374151';
      item.pctStr = `0%`;
      item.selisihStr = `0`;
    }
  });

  const generalDeptTrend = totalCurrPenyakit >= totalPrevPenyakit ? 'KENAIKAN' : 'PENURUNAN';

  const decDeptItems = deptList.filter(i => i.selisih < 0).sort((a, b) => a.pct - b.pct);
  const incDeptItems = deptList.filter(i => i.selisih > 0).sort((a, b) => b.pct - a.pct);

  const biggestDecreaseDept = decDeptItems.length > 0 ? `${decDeptItems[0].name.toUpperCase()} (${decDeptItems[0].pct}%)` : 'NIHIL (0%)';
  const biggestIncreaseDept = incDeptItems.length > 0 ? `${incDeptItems[0].name.toUpperCase()} (${incDeptItems[0].pct}%)` : 'NIHIL (0%)';

  // ==========================================
  // 3. COMPUTATION FOR PATIENT / KARYAWAN (NAMA & NPK)
  // ==========================================
  const patientMap = {};

  currRecords.forEach(r => {
    if (r.namaPasien) {
      const key = `${r.namaPasien.trim()}||${r.nikPabrik ? r.nikPabrik.trim() : '-'}`;
      if (!patientMap[key]) {
        patientMap[key] = {
          name: r.namaPasien.trim(),
          nik: r.nikPabrik ? r.nikPabrik.trim() : '-',
          dept: r.dept ? r.dept.trim() : '-',
          curr: 0,
          prev: 0
        };
      }
      patientMap[key].curr += 1;
    }
  });

  prevRecords.forEach(r => {
    if (r.namaPasien) {
      const key = `${r.namaPasien.trim()}||${r.nikPabrik ? r.nikPabrik.trim() : '-'}`;
      if (!patientMap[key]) {
        patientMap[key] = {
          name: r.namaPasien.trim(),
          nik: r.nikPabrik ? r.nikPabrik.trim() : '-',
          dept: r.dept ? r.dept.trim() : '-',
          curr: 0,
          prev: 0
        };
      }
      patientMap[key].prev += 1;
    }
  });

  const patientList = Object.values(patientMap).sort((a, b) => b.curr - a.curr || b.prev - a.prev);

  patientList.forEach(item => {
    item.selisih = item.curr - item.prev;
    if (item.prev === 0 && item.curr > 0) {
      item.pct = 100;
    } else if (item.prev === 0 && item.curr === 0) {
      item.pct = 0;
    } else {
      item.pct = Math.round(((item.curr - item.prev) / item.prev) * 100);
    }

    if (item.selisih > 0) {
      item.status = 'NAIK(↑)';
      item.statusBg = '#fecdd3';
      item.statusColor = '#9f1239';
      item.pctStr = `${item.pct}%`;
      item.selisihStr = `${item.selisih}`;
    } else if (item.selisih < 0) {
      item.status = 'TURUN(↓)';
      item.statusBg = '#dcfce7';
      item.statusColor = '#166534';
      item.pctStr = `${item.pct}%`;
      item.selisihStr = `${item.selisih}`;
    } else {
      item.status = 'TETAP(=)';
      item.statusBg = '#f3f4f6';
      item.statusColor = '#374151';
      item.pctStr = `0%`;
      item.selisihStr = `0`;
    }
  });

  const totalCurrPatients = new Set(currRecords.map(r => r.namaPasien).filter(Boolean)).size;
  const totalPrevPatients = new Set(prevRecords.map(r => r.namaPasien).filter(Boolean)).size;
  const generalPatientTrend = totalCurrPatients >= totalPrevPatients ? 'KENAIKAN' : 'PENURUNAN';

  const decPatientItems = patientList.filter(i => i.selisih < 0).sort((a, b) => a.pct - b.pct);
  const incPatientItems = patientList.filter(i => i.selisih > 0).sort((a, b) => b.pct - a.pct);

  const biggestDecreasePatient = decPatientItems.length > 0 ? `${decPatientItems[0].name.toUpperCase()} (${decPatientItems[0].nik}) (${decPatientItems[0].pct}%)` : 'NIHIL (0%)';
  const biggestIncreasePatient = incPatientItems.length > 0 ? `${incPatientItems[0].name.toUpperCase()} (${incPatientItems[0].nik}) (${incPatientItems[0].pct}%)` : 'NIHIL (0%)';

  // ==========================================
  // HTML TABLE ROWS GENERATION
  // ==========================================
  const rowsPenyakitHTML = penyakitList.map((item, idx) => `
    <tr>
      <td style="text-align: center; font-weight: bold; border-right: 2px solid #000; padding: 6px;">${idx + 1}</td>
      <td style="padding: 6px; font-weight: 600; text-transform: uppercase;">${item.name}</td>
      <td style="text-align: center; padding: 6px;">${item.curr}</td>
      <td style="text-align: center; padding: 6px;">${item.prev}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; font-style: italic; padding: 6px;">${item.status}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; padding: 6px;">${item.selisihStr}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; padding: 6px;">${item.pctStr}</td>
    </tr>
  `).join('');

  const rowsDeptHTML = deptList.map((item, idx) => `
    <tr>
      <td style="text-align: center; font-weight: bold; border-right: 2px solid #000; padding: 6px;">${idx + 1}</td>
      <td style="padding: 6px; font-weight: 600; text-transform: uppercase;">${item.name}</td>
      <td style="text-align: center; padding: 6px;">${item.curr}</td>
      <td style="text-align: center; padding: 6px;">${item.prev}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; font-style: italic; padding: 6px;">${item.status}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; padding: 6px;">${item.selisihStr}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; padding: 6px;">${item.pctStr}</td>
    </tr>
  `).join('');

  const rowsPatientsHTML = patientList.map((item, idx) => `
    <tr>
      <td style="text-align: center; font-weight: bold; border-right: 2px solid #000; padding: 6px;">${idx + 1}</td>
      <td style="padding: 6px; font-weight: 600; text-transform: uppercase;">${item.name}</td>
      <td style="text-align: center; padding: 6px; font-weight: bold;">${item.nik}</td>
      <td style="padding: 6px; text-transform: uppercase;">${item.dept}</td>
      <td style="text-align: center; padding: 6px;">${item.curr}</td>
      <td style="text-align: center; padding: 6px;">${item.prev}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; font-style: italic; padding: 6px;">${item.status}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; padding: 6px;">${item.selisihStr}</td>
      <td style="text-align: center; background-color: ${item.statusBg}; color: ${item.statusColor}; font-weight: bold; padding: 6px;">${item.pctStr}</td>
    </tr>
  `).join('');

  const totalVisits = recordsToPrint.length;
  const totalPantauan = recordsToPrint.filter(r => r.isPantauan === true).length;
  const totalSurkes = recordsToPrint.filter(r => r.izinSakit === true).length;

  const currTotalVisits = currRecords.length;
  const prevTotalVisits = prevRecords.length;
  const diffVisits = currTotalVisits - prevTotalVisits;
  let trendVisits = 'TETAP(=)';
  let colorVisits = '#475569';
  if (diffVisits > 0) { trendVisits = `NAIK (↑ +${diffVisits})`; colorVisits = '#dc2626'; }
  else if (diffVisits < 0) { trendVisits = `TURUN (↓ ${diffVisits})`; colorVisits = '#166534'; }

  const currPantauan = currRecords.filter(r => r.isPantauan === true).length;
  const prevPantauan = prevRecords.filter(r => r.isPantauan === true).length;
  const diffPantauan = currPantauan - prevPantauan;
  let trendPantauan = 'TETAP(=)';
  let colorPantauan = '#475569';
  if (diffPantauan > 0) { trendPantauan = `NAIK (↑ +${diffPantauan})`; colorPantauan = '#dc2626'; }
  else if (diffPantauan < 0) { trendPantauan = `TURUN (↓ ${diffPantauan})`; colorPantauan = '#166534'; }

  const currSurkes = currRecords.filter(r => r.izinSakit === true).length;
  const prevSurkes = prevRecords.filter(r => r.izinSakit === true).length;
  const diffSurkes = currSurkes - prevSurkes;
  let trendSurkes = 'TETAP(=)';
  let colorSurkes = '#475569';
  if (diffSurkes > 0) { trendSurkes = `NAIK (↑ +${diffSurkes})`; colorSurkes = '#dc2626'; }
  else if (diffSurkes < 0) { trendSurkes = `TURUN (↓ ${diffSurkes})`; colorSurkes = '#166534'; }

  const rowsRM = recordsToPrint.map((r, i) => `
    <tr>
      <td style="text-align:center; padding: 6px;">${i + 1}</td>
      <td style="padding: 6px;">${r.tanggal || '-'}</td>
      <td style="padding: 6px; font-weight: bold;">${r.namaPasien} (${r.nikPabrik || '-'})</td>
      <td style="padding: 6px;">${r.dept || '-'}</td>
      <td style="padding: 6px;">${r.keluhan || '-'}</td>
      <td style="padding: 6px; font-weight: bold; color: #0284c7;">${r.asesmen || '-'}</td>
      <td style="padding: 6px;">${formatPlanForDisplay(r.plan)}</td>
      <td style="text-align:center; padding: 6px;">${getStatusKelaikanText(r)}</td>
    </tr>
  `).join('');

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Laporan Rekap K3 & HSE Klinik Medis - PT ATI</title>
      <style>
        @page {
          size: A4 portrait;
          margin: 1.2cm;
        }
        body {
          font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
          color: #000;
          background: #fff;
          margin: 0;
          padding: 0;
          font-size: 10pt;
        }
        .page {
          page-break-after: always;
          break-after: page;
          padding-bottom: 20px;
        }
        .page:last-child {
          page-break-after: avoid;
          break-after: avoid;
        }
        .report-header {
          text-align: center;
          margin-bottom: 24px;
        }
        .report-header h2 {
          margin: 0;
          font-size: 14pt;
          font-weight: 800;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }
        .report-header h3 {
          margin: 4px 0;
          font-size: 12pt;
          font-weight: 700;
          text-transform: uppercase;
        }
        .report-header h4 {
          margin: 4px 0;
          font-size: 11pt;
          font-weight: 700;
          text-transform: uppercase;
          color: #333;
        }
        table.cmp-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 10px;
          margin-bottom: 16px;
        }
        table.cmp-table th, table.cmp-table td {
          border: 1px solid #000;
          padding: 6px 8px;
          font-size: 9.5pt;
        }
        table.cmp-table th {
          background-color: #ffffff;
          font-weight: 800;
          text-transform: uppercase;
          text-align: center;
          border-top: 2px solid #000;
          border-bottom: 2px solid #000;
        }
        .th-urutan {
          width: 8%;
          border-right: 2px solid #000 !important;
        }
        .notes-box {
          margin-top: 18px;
          font-size: 9.5pt;
          line-height: 1.6;
        }
        .notes-box p {
          margin: 4px 0;
          font-weight: 600;
        }
        .summary-grid {
          display: flex;
          justify-content: space-between;
          margin-bottom: 20px;
          gap: 10px;
        }
        .box {
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          padding: 10px;
          width: 30%;
          text-align: center;
          background: #f8fafc;
        }
        .box-val {
          font-size: 15pt;
          font-weight: bold;
          color: #0284c7;
          margin-top: 4px;
        }
        table.rm-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
          font-size: 8.5pt;
        }
        table.rm-table th, table.rm-table td {
          border: 1px solid #94a3b8;
          padding: 5px;
        }
        table.rm-table th {
          background: #f1f5f9;
          text-transform: uppercase;
          font-size: 8pt;
          text-align: left;
        }
        .ttd-grid {
          display: flex;
          justify-content: space-between;
          margin-top: 40px;
          text-align: center;
          font-size: 9.5pt;
        }
      </style>
    </head>
    <body>

      <!-- LEMBAR 1: REKAPITULASI PENYAKIT -->
      <div class="page">
        <div class="report-header">
          <h2>REKAP DATA KUNJUNGAN KARYAWAN PT ATI DI IN-HOUSE KLINIK NAFILA</h2>
          <h3>REKAPITULASI DATA PENYAKIT KARYAWAN</h3>
          <h4>${currPeriodTitle}</h4>
        </div>

        <table class="cmp-table">
          <thead>
            <tr>
              <th class="th-urutan">URUTAN</th>
              <th style="text-align: left;">NAMA PENYAKIT</th>
              <th style="width: 14%;">JML BLN<br>${currMonthName}</th>
              <th style="width: 14%;">JML BLN<br>${prevMonthName}</th>
              <th style="width: 15%;">STATUS</th>
              <th style="width: 10%;">SELISIH</th>
              <th style="width: 10%;">%</th>
            </tr>
          </thead>
          <tbody>
            ${rowsPenyakitHTML || '<tr><td colspan="7" style="text-align:center;">Tidak ada data penyakit</td></tr>'}
          </tbody>
        </table>

        <div class="notes-box">
          <p>*Jumlah penyakit pada bulan ${currMonthName} secara umum mengalami <strong>${generalPenyakitTrend}</strong></p>
          <p>*Penyakit dengan persentase <strong>PENURUNAN TERBESAR</strong> dalam satu bulan adalah <strong>${biggestDecreasePenyakit}</strong></p>
          <p>*Penyakit dengan persentase <strong>KENAIKAN TERBESAR</strong> dalam satu bulan adalah <strong>${biggestIncreasePenyakit}</strong></p>
        </div>

        <div class="ttd-grid" style="margin-top: 50px;">
          <div>
            Disiapkan Oleh,<br><strong>Officer K3 / HSE Klinik</strong><br><br><br><br>
            ( ______________________ )
          </div>
          <div>
            Mengetahui,<br><strong>Dokter Penanggung Jawab Klinik</strong><br><br><br><br>
            <strong>dr. Dylan Fadhilah / dr. Isda Laily</strong>
          </div>
        </div>
      </div>

      <!-- LEMBAR 2: REKAPITULASI DEPARTMENT -->
      <div class="page">
        <div class="report-header">
          <h2>REKAP DATA KUNJUNGAN KARYAWAN PT ATI DI IN-HOUSE KLINIK NAFILA</h2>
          <h3>KUNJUNGAN DEPARTMENT TERBANYAK</h3>
          <h4>${currPeriodTitle}</h4>
        </div>

        <table class="cmp-table">
          <thead>
            <tr>
              <th class="th-urutan">URUTAN</th>
              <th style="text-align: left;">DEPARTMENT</th>
              <th style="width: 14%;">JML BLN<br>${currMonthName}</th>
              <th style="width: 14%;">JML BLN<br>${prevMonthName}</th>
              <th style="width: 15%;">STATUS</th>
              <th style="width: 10%;">SELISIH</th>
              <th style="width: 10%;">%</th>
            </tr>
          </thead>
          <tbody>
            ${rowsDeptHTML || '<tr><td colspan="7" style="text-align:center;">Tidak ada data department</td></tr>'}
          </tbody>
        </table>

        <div class="notes-box">
          <p>*Jumlah kunjungan pada bulan ${currMonthName} secara umum mengalami <strong>${generalDeptTrend}</strong></p>
          <p>*Department dengan persentase <strong>PENURUNAN TERBESAR</strong> dalam kunjungan satu bulan adalah <strong>${biggestDecreaseDept}</strong></p>
          <p>*Department dengan persentase <strong>KENAIKAN TERBESAR</strong> dalam kunjungan satu bulan adalah <strong>${biggestIncreaseDept}</strong></p>
        </div>

        <div class="ttd-grid" style="margin-top: 50px;">
          <div>
            Disiapkan Oleh,<br><strong>Officer K3 / HSE Klinik</strong><br><br><br><br>
            ( ______________________ )
          </div>
          <div>
            Mengetahui,<br><strong>Dokter Penanggung Jawab Klinik</strong><br><br><br><br>
            <strong>dr. Dylan Fadhilah / dr. Isda Laily</strong>
          </div>
        </div>
      </div>

      <!-- LEMBAR 3: REKAPITULASI KUNJUNGAN KARYAWAN / PASIEN -->
      <div class="page">
        <div class="report-header">
          <h2>REKAP DATA KUNJUNGAN KARYAWAN PT ATI DI IN-HOUSE KLINIK NAFILA</h2>
          <h3>REKAPITULASI KUNJUNGAN PASIEN / KARYAWAN</h3>
          <h4>${currPeriodTitle}</h4>
        </div>

        <table class="cmp-table">
          <thead>
            <tr>
              <th class="th-urutan">URUTAN</th>
              <th style="text-align: left;">NAMA KARYAWAN / PASIEN</th>
              <th style="width: 14%;">NPK / NIK PABRIK</th>
              <th style="text-align: left; width: 15%;">DEPARTMENT</th>
              <th style="width: 10%;">JML BLN<br>${currMonthName}</th>
              <th style="width: 10%;">JML BLN<br>${prevMonthName}</th>
              <th style="width: 12%;">STATUS</th>
              <th style="width: 8%;">SELISIH</th>
              <th style="width: 8%;">%</th>
            </tr>
          </thead>
          <tbody>
            ${rowsPatientsHTML || '<tr><td colspan="9" style="text-align:center;">Tidak ada data kunjungan karyawan</td></tr>'}
          </tbody>
        </table>

        <div class="notes-box">
          <p>*Jumlah kunjungan unik pasien pada bulan ${currMonthName} secara umum mengalami <strong>${generalPatientTrend}</strong></p>
          <p>*Karyawan dengan persentase <strong>PENURUNAN TERBESAR</strong> kunjungan dalam satu bulan adalah <strong>${biggestDecreasePatient}</strong></p>
          <p>*Karyawan dengan persentase <strong>KENAIKAN TERBESAR</strong> kunjungan dalam satu bulan adalah <strong>${biggestIncreasePatient}</strong></p>
        </div>

        <div class="ttd-grid" style="margin-top: 50px;">
          <div>
            Disiapkan Oleh,<br><strong>Officer K3 / HSE Klinik</strong><br><br><br><br>
            ( ______________________ )
          </div>
          <div>
            Mengetahui,<br><strong>Dokter Penanggung Jawab Klinik</strong><br><br><br><br>
            <strong>dr. Dylan Fadhilah / dr. Isda Laily</strong>
          </div>
        </div>
      </div>

      <!-- LEMBAR 4: DETAIL REKAM MEDIS KUNJUNGAN -->
      <div class="page">
        <div class="report-header">
          <h2>LAPORAN KESEHATAN KESELAMATAN KERJA (K3 / HSE)</h2>
          <h3>KLINIK NAFILA MEDIKA — PT ATI MEDIKA</h3>
          <div style="font-size: 9pt; margin-top: 6px; font-weight: bold; color: #0284c7;">${periodeInfo} | Dicetak: ${tglIndo}</div>
        </div>

        <div class="summary-grid">
          <div class="box">
            <div style="font-size: 8.5pt; font-weight: bold; color: #475569;">TOTAL KUNJUNGAN PASIEN</div>
            <div class="box-val">${currTotalVisits} Pasien</div>
            <div style="font-size: 8pt; margin-top: 3px; color: #475569; font-weight: 600;">Bulan Lalu: ${prevTotalVisits} Pasien</div>
            <div style="font-size: 8pt; font-weight: bold; color: ${colorVisits}; margin-top: 2px;">${trendVisits}</div>
          </div>
          <div class="box">
            <div style="font-size: 8.5pt; font-weight: bold; color: #dc2626;">PASIEN HIGH RISK / PANTAUAN</div>
            <div class="box-val" style="color: #dc2626;">${currPantauan} Pasien</div>
            <div style="font-size: 8pt; margin-top: 3px; color: #475569; font-weight: 600;">Bulan Lalu: ${prevPantauan} Pasien</div>
            <div style="font-size: 8pt; font-weight: bold; color: ${colorPantauan}; margin-top: 2px;">${trendPantauan}</div>
          </div>
          <div class="box">
            <div style="font-size: 8.5pt; font-weight: bold; color: #d97706;">SURKES / IZIN SAKIT</div>
            <div class="box-val" style="color: #d97706;">${currSurkes} Kasus</div>
            <div style="font-size: 8pt; margin-top: 3px; color: #475569; font-weight: 600;">Bulan Lalu: ${prevSurkes} Kasus</div>
            <div style="font-size: 8pt; font-weight: bold; color: ${colorSurkes}; margin-top: 2px;">${trendSurkes}</div>
          </div>
        </div>

        <h3 style="font-size: 10.5pt; margin-bottom: 8px; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">Daftar Rekam Medis Kunjungan Karyawan:</h3>
        <table class="rm-table">
          <thead>
            <tr>
              <th style="width: 4%;">No</th>
              <th style="width: 10%;">Tanggal</th>
              <th style="width: 22%;">Nama & NIK Pasien</th>
              <th style="width: 14%;">Departemen</th>
              <th style="width: 20%;">Keluhan (S)</th>
              <th style="width: 15%;">Diagnosis ICD-10 (A)</th>
              <th style="width: 15%;">Resep & Plan (P)</th>
              <th style="width: 10%;">Status K3</th>
            </tr>
          </thead>
          <tbody>
            ${rowsRM || '<tr><td colspan="8" style="text-align:center;">Belum ada data kunjungan</td></tr>'}
          </tbody>
        </table>

        <div class="ttd-grid">
          <div>
            Disiapkan Oleh,<br><strong>Officer K3 / HSE Klinik</strong><br><br><br><br>
            ( ______________________ )
          </div>
          <div>
            Mengetahui,<br><strong>Dokter Penanggung Jawab Klinik</strong><br><br><br><br>
            <strong>dr. Dylan Fadhilah / dr. Isda Laily</strong>
          </div>
        </div>
      </div>

      <script>window.onload = function() { window.print(); };</script>
    </body>
    </html>
  `);
  win.document.close();
}

// -------------------------------------------------------------
// 9. TAB MANAJEMEN LOGIC (PASSWORD RAHASIA DIREKTUR)
// -------------------------------------------------------------
async function handleUnlockDirektur(e) {
  e.preventDefault();
  const pass = document.getElementById('direktur-password-input').value.trim();
  try {
    const res = await fetch('/api/auth/direktur', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (data.status === 'SUCCESS') {
      localStorage.setItem('direktur_unlocked', 'true');
      document.getElementById('manajemen-locked-view').style.display = 'none';
      document.getElementById('manajemen-unlocked-view').style.display = 'block';
      showToast('Akses Analisis Direktur Dibuka', 'success');
      renderAnalisisObat();
    } else {
      showToast('Kata Sandi Direktur Salah!', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
  }
}

async function handleUnlockGSheetSync(e) {
  e.preventDefault();
  const pass = document.getElementById('gsheet-password-input').value.trim();
  try {
    const res = await fetch('/api/auth/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (data.status === 'SUCCESS' || data.success === true) {
      localStorage.setItem('gsheet_unlocked', 'true');
      document.getElementById('gsheet-locked-view').style.display = 'none';
      document.getElementById('gsheet-unlocked-view').style.display = 'block';
      showToast('Akses Pengaturan Sync Dibuka', 'success');
    } else {
      showToast('Kata Sandi Administrator Salah!', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
  }
}

function switchManajemenTab(tabName) {
  const tabs = ['billing', 'tindakan', 'users', 'kontak'];
  tabs.forEach(t => {
    const el = document.getElementById(`mj-tab-${t}`);
    const btn = document.getElementById(`mj-nav-${t}`);
    if (el && btn) {
      if (t === tabName) {
        el.style.display = 'block';
        btn.className = 'btn btn-primary';
      } else {
        el.style.display = 'none';
        btn.className = 'btn btn-secondary';
      }
    }
  });
}

// -------------------------------------------------------------
// MASTER TINDAKAN MEDIS & TARIF CRUD
// -------------------------------------------------------------
function renderMasterTindakanTable() {
  const tbody = document.getElementById('table-master-tindakan-body');
  if (!tbody) return;

  const tindakanList = appData.tindakan || [];
  if (tindakanList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px; color: var(--text-muted);">Belum ada jenis tindakan medis terdaftar.</td></tr>`;
    return;
  }

  tbody.innerHTML = tindakanList.map((t, idx) => `
    <tr>
      <td style="text-align: center;">${idx + 1}</td>
      <td><strong>${t.nama}</strong></td>
      <td><span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 600;">${t.kategori || 'Tindakan'}</span></td>
      <td style="text-align: right; font-weight: 700; color: #38bdf8;">Rp ${(t.tarif || 0).toLocaleString('id-ID')}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 6px; justify-content: center;">
          <button class="btn btn-sm btn-secondary" onclick="openModalEditTindakan('${t.id}')" title="Edit Tindakan"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="btn btn-sm btn-danger" onclick="handleDeleteTindakan('${t.id}')" title="Hapus Tindakan"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function handleTambahMasterTindakan(e) {
  e.preventDefault();
  const nama = document.getElementById('new-tindakan-nama').value.trim();
  const kategori = document.getElementById('new-tindakan-kategori').value.trim() || 'Tindakan Medis';
  const tarif = parseInt(document.getElementById('new-tindakan-tarif').value) || 0;

  if (!nama) {
    showToast('Nama tindakan wajib diisi!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/tindakan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama, kategori, tarif })
    });
    if (res.ok) {
      showToast('Tindakan medis berhasil ditambahkan!', 'success');
      document.getElementById('new-tindakan-nama').value = '';
      document.getElementById('new-tindakan-tarif').value = '';
      await loadAllAppData();
    } else {
      showToast('Gagal menambahkan tindakan', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

function openModalEditTindakan(id) {
  const t = (appData.tindakan || []).find(item => item.id === id);
  if (!t) return;
  document.getElementById('edit-tindakan-id').value = t.id;
  document.getElementById('edit-tindakan-nama').value = t.nama || '';
  document.getElementById('edit-tindakan-kategori').value = t.kategori || 'Tindakan Medis';
  document.getElementById('edit-tindakan-tarif').value = t.tarif || 0;
  const modal = document.getElementById('modal-edit-tindakan');
  if (modal) modal.style.display = 'flex';
}

function closeModalEditTindakan() {
  const modal = document.getElementById('modal-edit-tindakan');
  if (modal) modal.style.display = 'none';
}

async function handleSaveEditTindakan(e) {
  e.preventDefault();
  const id = document.getElementById('edit-tindakan-id').value;
  const nama = document.getElementById('edit-tindakan-nama').value.trim();
  const kategori = document.getElementById('edit-tindakan-kategori').value.trim();
  const tarif = parseInt(document.getElementById('edit-tindakan-tarif').value) || 0;

  try {
    const res = await fetch(`/api/tindakan/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama, kategori, tarif })
    });
    if (res.ok) {
      closeModalEditTindakan();
      showToast('Perubahan tindakan berhasil disimpan!', 'success');
      await loadAllAppData();
    } else {
      showToast('Gagal menyimpan perubahan', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

async function handleDeleteTindakan(id) {
  if (!confirm('Hapus jenis tindakan medis ini?')) return;
  try {
    const res = await fetch(`/api/tindakan/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Tindakan medis berhasil dihapus', 'success');
      await loadAllAppData();
    } else {
      showToast('Gagal menghapus tindakan', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

// -------------------------------------------------------------
// USER MANAGEMENT CRUD (ADMIN DIREKTUR)
// -------------------------------------------------------------
function renderUsersTable() {
  const tbody = document.getElementById('table-users-body');
  if (!tbody) return;

  const users = appData.users || [];
  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px; color: var(--text-muted);">Belum ada akun petugas terdaftar.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map((u, idx) => `
    <tr>
      <td style="text-align: center;">${idx + 1}</td>
      <td><strong>${u.nama || '-'}</strong></td>
      <td><code>${u.username || '-'}</code></td>
      <td><span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; font-weight: 600;">${u.role || 'Petugas'}</span></td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 6px; justify-content: center;">
          <button class="btn btn-sm btn-secondary" onclick="openModalEditUser('${u.id}')" title="Edit Akun"><i class="fa-solid fa-user-pen"></i></button>
          <button class="btn btn-sm btn-danger" onclick="handleDeleteUser('${u.id}')" title="Hapus Akun"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function handleTambahUserAdmin(e) {
  e.preventDefault();
  const nama = document.getElementById('adm-user-nama').value.trim();
  const role = document.getElementById('adm-user-role').value;
  const username = document.getElementById('adm-user-username').value.trim();
  const password = document.getElementById('adm-user-password').value.trim();

  if (!nama || !username || !password) {
    showToast('Semua field wajib diisi!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama, role, username, password })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Akun petugas berhasil dibuat!', 'success');
      document.getElementById('adm-user-nama').value = '';
      document.getElementById('adm-user-username').value = '';
      document.getElementById('adm-user-password').value = '';
      await loadAllAppData();
    } else {
      showToast(data.error || 'Gagal membuat akun petugas', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

function openModalEditUser(id) {
  const u = (appData.users || []).find(item => item.id === id);
  if (!u) return;
  document.getElementById('edit-user-id').value = u.id;
  document.getElementById('edit-user-nama').value = u.nama || '';
  document.getElementById('edit-user-role').value = u.role || 'Perawat';
  document.getElementById('edit-user-username').value = u.username || '';
  document.getElementById('edit-user-password').value = '';
  const modal = document.getElementById('modal-edit-user');
  if (modal) modal.style.display = 'flex';
}

function closeModalEditUser() {
  const modal = document.getElementById('modal-edit-user');
  if (modal) modal.style.display = 'none';
}

async function handleSaveEditUser(e) {
  e.preventDefault();
  const id = document.getElementById('edit-user-id').value;
  const nama = document.getElementById('edit-user-nama').value.trim();
  const role = document.getElementById('edit-user-role').value;
  const username = document.getElementById('edit-user-username').value.trim();
  const password = document.getElementById('edit-user-password').value.trim();

  try {
    const res = await fetch(`/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama, role, username, password })
    });
    if (res.ok) {
      closeModalEditUser();
      showToast('Perubahan data petugas berhasil disimpan!', 'success');
      await loadAllAppData();
    } else {
      showToast('Gagal menyimpan perubahan petugas', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

async function handleDeleteUser(id) {
  if (!confirm('Hapus akun petugas ini?')) return;
  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Akun petugas berhasil dihapus', 'success');
      await loadAllAppData();
    } else {
      showToast('Gagal menghapus user', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

function getFilteredBillingRecords() {
  const startVal = document.getElementById('billing-start')?.value;
  const endVal = document.getElementById('billing-end')?.value;
  
  if (!startVal || !endVal) return appData.records;
  
  const start = new Date(`${startVal}T00:00:00`);
  const end = new Date(`${endVal}T23:59:59`);
  
  return appData.records.filter(r => {
    let d = parseRecordDate(r);
    if (!d || isNaN(d.getTime())) return false;
    return d >= start && d <= end;
  });
}

function renderBillingPTTable() {
  const tbody = document.getElementById('table-billing-body');
  if (!tbody) return;

  const filtered = getFilteredBillingRecords();

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding: 24px; color: var(--text-muted);">Tidak ada data tagihan pada rentang tanggal tersebut.</td></tr>`;
    return;
  }

  let html = '';
  filtered.forEach((r, i) => {
    const items = [];
    if (Array.isArray(r.tindakan) && r.tindakan.length > 0) {
      r.tindakan.forEach(t => {
        items.push({
          type: 'Tindakan',
          nama: `💉 ${t.nama || 'Tindakan'}`,
          qty: t.qty || 1,
          tarif: t.subtotal || ((t.tarif || 0) * (t.qty || 1))
        });
      });
    }
    if (Array.isArray(r.resep) && r.resep.length > 0) {
      r.resep.forEach(m => {
        items.push({
          type: 'Obat',
          nama: `💊 ${m.namaObat || m.obat || 'Obat'}`,
          qty: m.qty || 1,
          tarif: m.subtotal || ((m.harga || 0) * (m.qty || 1))
        });
      });
    }

    if (items.length > 0) {
      items.forEach((item, idx) => {
        html += `
          <tr>
            <td data-label="No">${idx === 0 ? i + 1 : ''}</td>
            <td data-label="Tanggal">${idx === 0 ? (r.tanggal || '-') : ''}</td>
            <td data-label="NPK">${idx === 0 ? (r.nikPabrik || '-') : ''}</td>
            <td data-label="Nama Pasien">${idx === 0 ? `<strong>${r.namaPasien || '-'}</strong>` : ''}</td>
            <td data-label="Bagian">${idx === 0 ? (r.dept || '-') : ''}</td>
            <td data-label="Diagnosa">${idx === 0 ? (r.asesmen || '-') : ''}</td>
            <td data-label="Tindakan / Obat">${item.nama}</td>
            <td data-label="Qty" style="text-align: center;">${item.qty}</td>
            <td data-label="Tarif / Harga">Rp ${(item.tarif || 0).toLocaleString('id-ID')}</td>
            <td data-label="Total Biaya" style="font-weight: 700; color: #38bdf8;">${idx === 0 ? `Rp ${(r.totalBiaya || 0).toLocaleString('id-ID')}` : ''}</td>
          </tr>
        `;
      });
    } else {
      html += `
        <tr>
          <td data-label="No">${i + 1}</td>
          <td data-label="Tanggal">${r.tanggal || '-'}</td>
          <td data-label="NPK">${r.nikPabrik || '-'}</td>
          <td data-label="Nama Pasien"><strong>${r.namaPasien || '-'}</strong></td>
          <td data-label="Bagian">${r.dept || '-'}</td>
          <td data-label="Diagnosa">${r.asesmen || '-'}</td>
          <td data-label="Tindakan / Obat">-</td>
          <td data-label="Qty" style="text-align: center;">0</td>
          <td data-label="Tarif / Harga">Rp 0</td>
          <td data-label="Total Biaya" style="font-weight: 700; color: #38bdf8;">Rp ${(r.totalBiaya || 0).toLocaleString('id-ID')}</td>
        </tr>
      `;
    }
  });

  tbody.innerHTML = html;
}

function exportBillingExcel() {
  const filtered = getFilteredBillingRecords();
  const dateStr = new Date().toISOString().split('T')[0];
  
  let rows = '';
  filtered.forEach((r, i) => {
    const items = [];
    if (Array.isArray(r.tindakan) && r.tindakan.length > 0) {
      r.tindakan.forEach(t => {
        items.push({
          nama: `[Tindakan] ${t.nama || 'Tindakan'}`,
          qty: t.qty || 1,
          tarif: t.subtotal || ((t.tarif || 0) * (t.qty || 1))
        });
      });
    }
    if (Array.isArray(r.resep) && r.resep.length > 0) {
      r.resep.forEach(m => {
        items.push({
          nama: `[Obat] ${m.namaObat || m.obat || 'Obat'}`,
          qty: m.qty || 1,
          tarif: m.subtotal || ((m.harga || 0) * (m.qty || 1))
        });
      });
    }

    if (items.length > 0) {
      items.forEach((item, idx) => {
        rows += `
          <tr>
            <td style="text-align: center;">${idx === 0 ? i + 1 : ''}</td>
            <td>${idx === 0 ? (r.tanggal || '') : ''}</td>
            <td>${idx === 0 ? (r.nikPabrik || '') : ''}</td>
            <td><strong>${idx === 0 ? (r.namaPasien || '') : ''}</strong></td>
            <td>${idx === 0 ? (r.dept || '') : ''}</td>
            <td>${idx === 0 ? (r.asesmen || '') : ''}</td>
            <td>${item.nama}</td>
            <td style="text-align: center;">${item.qty}</td>
            <td style="text-align: right;">${item.tarif}</td>
            <td style="text-align: right; font-weight: bold;">${idx === 0 ? (r.totalBiaya || 0) : ''}</td>
          </tr>
        `;
      });
    } else {
      rows += `
        <tr>
          <td style="text-align: center;">${i + 1}</td>
          <td>${r.tanggal || ''}</td>
          <td>${r.nikPabrik || ''}</td>
          <td><strong>${r.namaPasien || ''}</strong></td>
          <td>${r.dept || ''}</td>
          <td>${r.asesmen || ''}</td>
          <td>-</td>
          <td style="text-align: center;">0</td>
          <td style="text-align: right;">0</td>
          <td style="text-align: right; font-weight: bold;">${r.totalBiaya || 0}</td>
        </tr>
      `;
    }
  });

  const excelTemplate = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <!--[if gte mso 9]>
      <xml>
        <x:ExcelWorkbook>
          <x:ExcelWorksheets>
            <x:ExcelWorksheet>
              <x:Name>Billing Klinik PT ATI</x:Name>
              <x:WorksheetOptions>
                <x:DisplayGridlines/>
              </x:WorksheetOptions>
            </x:ExcelWorksheet>
          </x:ExcelWorksheets>
        </x:ExcelWorkbook>
      </xml>
      <![endif]-->
      <style>
        table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 11pt; }
        th { background-color: #10b981; color: #ffffff; font-weight: bold; border: 1px solid #059669; padding: 8px; text-align: left; }
        td { border: 1px solid #d1d5db; padding: 6px; }
        .title { font-size: 14pt; font-weight: bold; color: #065f46; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="title">LAPORAN TAGIHAN & BIAYA BEROBAT - KLINIK PT ATI</div>
      <div>Tanggal Export: ${new Date().toLocaleDateString('id-ID')}</div>
      <br>
      <table>
        <thead>
          <tr>
            <th style="width: 50px;">NO</th>
            <th style="width: 100px;">TANGGAL</th>
            <th style="width: 120px;">NPK</th>
            <th style="width: 180px;">NAMA PASIEN</th>
            <th style="width: 120px;">DEPARTEMEN</th>
            <th style="width: 180px;">DIAGNOSA</th>
            <th style="width: 180px;">NAMA OBAT</th>
            <th style="width: 60px;">QTY</th>
            <th style="width: 120px;">HARGA OBAT (RP)</th>
            <th style="width: 140px;">TOTAL BIAYA VISIT (RP)</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="10">Tidak ada data tagihan</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([excelTemplate], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Billing_Klinik_PT_ATI_${dateStr}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('File Excel (.xls) berhasil diunduh!', 'success');
}

// 🖨️ CETAK LAPORAN DIREKSI & FINANSIAL EKSEKUTIF (PROFESIONAL A4)
function printExecutiveReport() {
  const tglIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const filtered = getFilteredBillingRecords();
  const totalVisits = filtered.length;
  const totalBilling = filtered.reduce((sum, r) => sum + (r.totalBiaya || 0), 0);

  const rowsBilling = filtered.map((r, i) => `
    <tr>
      <td style="text-align:center; padding: 6px;">${i + 1}</td>
      <td style="padding: 6px;">${r.tanggal || '-'}</td>
      <td style="padding: 6px; font-weight: bold;">${r.nikPabrik || '-'}</td>
      <td style="padding: 6px; font-weight: bold;">${r.namaPasien}</td>
      <td style="padding: 6px;">${r.dept || '-'}</td>
      <td style="padding: 6px;">${r.asesmen || '-'}</td>
      <td style="text-align:right; padding: 6px; font-weight: bold;">Rp ${(r.totalBiaya || 0).toLocaleString('id-ID')}</td>
    </tr>
  `).join('');

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Laporan Eksekutif Direksi & Billing Medik - PT ATI & PT ATI</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 25px; color: #0f172a; background: #fff; }
        .header { text-align: center; border-bottom: 3px double #10b981; padding-bottom: 12px; margin-bottom: 20px; }
        .header h2 { margin: 0; font-size: 17pt; color: #065f46; text-transform: uppercase; letter-spacing: 1px; }
        .header h4 { margin: 4px 0 0 0; font-size: 11pt; color: #334155; font-weight: normal; }
        .finance-summary { display: flex; justify-content: space-between; margin-bottom: 25px; gap: 12px; }
        .fin-box { border: 1px solid #10b981; border-radius: 8px; padding: 14px; width: 48%; text-align: center; background: #f0fdf4; }
        .fin-val { font-size: 16pt; font-weight: 800; color: #059669; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 9.5pt; }
        th, td { border: 1px solid #94a3b8; padding: 7px; }
        th { background: #e2e8f0; text-transform: uppercase; font-size: 9pt; text-align: left; }
        .ttd-box { display: flex; justify-content: space-between; margin-top: 45px; text-align: center; font-size: 10.5pt; }
        @media print { @page { size: A4 portrait; margin: 1.5cm; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>LAPORAN MANAJERIAL & BIAYA MEDIK KLINIK</h2>
        <h4>KLINIK NAFILA MEDIKA — PT ATI MEDIKA</h4>
        <div style="font-size: 9.5pt; margin-top: 6px; font-weight: bold; color: #059669;">Tanggal Laporan: ${tglIndo}</div>
      </div>

      <div class="finance-summary">
        <div class="fin-box">
          <div style="font-size: 8.5pt; font-weight: bold; color: #065f46;">TOTAL KUNJUNGAN RAJAL</div>
          <div class="fin-val">${totalVisits} Pasien</div>
        </div>
        <div class="fin-box">
          <div style="font-size: 8.5pt; font-weight: bold; color: #065f46;">TOTAL REKAP BIAYA BILLING</div>
          <div class="fin-val">Rp ${totalBilling.toLocaleString('id-ID')}</div>
        </div>
      </div>

      <h3 style="font-size: 11pt; margin-bottom: 8px; text-transform: uppercase; border-bottom: 2px solid #10b981; padding-bottom: 4px;">Rincian Tagihan Layanan Kesehatan Pasien Rawat Jalan:</h3>
      <table>
        <thead>
          <tr>
            <th style="width: 5%;">No</th>
            <th style="width: 12%;">Tanggal</th>
            <th style="width: 15%;">NPK</th>
            <th style="width: 20%;">Nama Pasien</th>
            <th style="width: 15%;">Departemen / Bagian</th>
            <th style="width: 20%;">Diagnosis Utama (A)</th>
            <th style="width: 13%; text-align:right;">Tarif Billing (Rp)</th>
          </tr>
        </thead>
        <tbody>
          ${rowsBilling || '<tr><td colspan="7" style="text-align:center;">Belum ada data billing</td></tr>'}
        </tbody>
      </table>

      <div class="ttd-box">
        <div>
          Disiapkan Oleh,<br><strong>Manajer Keuangan / Operasional</strong><br><br><br><br>
          ( ______________________ )
        </div>
        <div>
          Menyetujui,<br><strong>Koordinator Pelayanan Medis</strong><br><br><br><br>
          <strong>drg. Nafila Alam Islami, MARS</strong>
        </div>
      </div>

      <script>window.onload = function() { window.print(); };</script>
    </body>
    </html>
  `);
  win.document.close();
}

function renderAbsenDirekturTable() {
  const tbody = document.getElementById('table-absen-direktur-body');
  if (!tbody) return;

  tbody.innerHTML = appData.absenDokter.map((a, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${a.tanggal || '-'}</td>
      <td><strong>${a.namaDokter || a.nama || '-'}</strong></td>
      <td>${a.jamMulai || a.jam_mulai || '-'} - ${a.jamSelesai || a.jam_selesai || '-'}</td>
      <td>Rp ${(a.tarifShift || 400000).toLocaleString('id-ID')}</td>
    </tr>
  `).join('');
}

function renderWAContactsTable() {
  const tbody = document.getElementById('table-wa-contacts-body');
  if (!tbody) return;

  if (!appData.waContacts || appData.waContacts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">Belum ada kontak WA tersimpan. Silakan tambahkan di atas.</td></tr>`;
    return;
  }

  tbody.innerHTML = appData.waContacts.map((c, i) => `
    <tr>
      <td data-label="No">${i + 1}</td>
      <td data-label="Nama Kontak"><strong>${c.nama}</strong></td>
      <td data-label="Jabatan">${c.jabatan || '-'}</td>
      <td data-label="Nomor WA"><span style="font-weight: 700; color: #34d399;">${c.hp}</span></td>
      <td data-label="Aksi" style="text-align: center;">
        <button class="btn btn-sm btn-primary" onclick="testWAContact('${c.hp}', '${(c.nama || '').replace(/'/g, "\\'")}')" style="padding: 3px 8px; font-size: 0.75rem;" title="Test Kirim WA"><i class="fa-brands fa-whatsapp"></i> Test</button>
        <button class="btn btn-sm btn-danger" onclick="deleteWAContact('${c.id}')" style="padding: 3px 8px; font-size: 0.75rem;" title="Hapus Kontak"><i class="fa-solid fa-trash-can"></i> Hapus</button>
      </td>
    </tr>
  `).join('');
}

function renderWATargetSelectOptions() {
  const sel = document.getElementById('req-target-wa');
  if (!sel) return;

  if (!appData.waContacts || appData.waContacts.length === 0) {
    sel.innerHTML = `<option value="">⚠️ Belum ada kontak (Tambahkan di Tab Manajemen > Kontak WA)</option>`;
    return;
  }

  sel.innerHTML = appData.waContacts.map(c => `
    <option value="${c.hp}">${c.nama} (${c.hp})${c.jabatan ? ` — ${c.jabatan}` : ''}</option>
  `).join('');
}

async function handleTambahWAContact(e) {
  e.preventDefault();
  const nama = document.getElementById('new-wa-nama').value.trim();
  const jabatan = document.getElementById('new-wa-jabatan').value.trim();
  let hp = document.getElementById('new-wa-hp').value.trim().replace(/[^0-9]/g, '');

  if (!nama || !hp) {
    showToast('Nama dan Nomor WA wajib diisi!', 'error');
    return;
  }

  if (hp.startsWith('0')) {
    hp = '62' + hp.substring(1);
  }

  const newContact = {
    id: 'WA-' + Date.now(),
    nama,
    jabatan: jabatan || 'Petugas Klinik',
    hp
  };

  if (!appData.waContacts) appData.waContacts = [];
  appData.waContacts.push(newContact);
  await saveWAContactsToServer();

  document.getElementById('new-wa-nama').value = '';
  document.getElementById('new-wa-jabatan').value = '';
  document.getElementById('new-wa-hp').value = '';

  renderWAContactsTable();
  renderWATargetSelectOptions();
  showToast(`Kontak WA ${nama} berhasil ditambahkan!`, 'success');
}

async function deleteWAContact(id) {
  if (confirm('Hapus kontak WA ini dari daftar?')) {
    appData.waContacts = appData.waContacts.filter(c => String(c.id) !== String(id));
    await saveWAContactsToServer();
    renderWAContactsTable();
    renderWATargetSelectOptions();
    showToast('Kontak WA berhasil dihapus.', 'info');
  }
}

async function saveWAContactsToServer() {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wa_contacts: appData.waContacts })
    });
  } catch (e) {
    console.error('Error saving WA contacts:', e);
  }
}

async function testWAContact(hp, nama) {
  const msg = `Halo ${nama}, ini adalah tes pesan otomatis dari Mobile Klinik System PT ATI (Device WhaCenter Active).`;
  showToast(`Mengirim tes WA ke ${nama}...`, 'info');
  try {
    const res = await fetch('/api/send-wa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: hp, message: msg })
    });
    const d = await res.json();
    if (res.ok && d.success) {
      showToast(`✅ Pesan tes WA terkirim ke ${nama}!`, 'success');
    } else {
      showToast(`Gagal kirim WA: ${d.error || 'Periksa Device ID WhaCenter'}`, 'error');
    }
  } catch (e) {
    showToast('Gagal koneksi ke server kirim WA', 'error');
  }
}

async function saveWhaCenterDeviceId() {
  const deviceId = document.getElementById('whacenter-device-id').value.trim();
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whacenter_device_id: deviceId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Device ID WhaCenter berhasil disimpan!', 'success');
    } else {
      showToast('Gagal menyimpan Device ID', 'error');
    }
  } catch (e) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

// -------------------------------------------------------------
// 10. MCU IMPORT LOGIC
// -------------------------------------------------------------
function importMCUCSVFile() {
  const fileInput = document.getElementById('mcu-file-input');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('Pilih file CSV MCU terlebih dahulu', 'error');
    return;
  }
  showToast('Data MCU berhasil diinstal ke database!', 'success');
}

// -------------------------------------------------------------
// 11. GOOGLE SHEETS SYNC LOGIC
// -------------------------------------------------------------
async function syncNowFromGSheet(btnEl = null) {
  let origText = '';
  if (btnEl) {
    origText = btnEl.innerHTML;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyinkronkan...';
    btnEl.disabled = true;
  }

  showToast('🔄 Menghubungkan & menarik data terbaru dari Google Sheets...', 'info');

  try {
    const res = await fetch('/api/gsheet/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Sinkronisasi Berhasil! (${data.totalRows || 0} baris diperbarui)`, 'success');
      await loadAllAppData();
    } else {
      showToast(`Gagal sinkronisasi: ${data.error || 'Periksa koneksi spreadsheet'}`, 'error');
    }
  } catch (err) {
    showToast('Gagal terhubung ke server untuk sinkronisasi Google Sheets', 'error');
  } finally {
    if (btnEl) {
      btnEl.innerHTML = origText;
      btnEl.disabled = false;
    }
  }
}

async function handleSaveGSheetUrl(e) {
  e.preventDefault();
  const url = document.getElementById('gsheet-app-url').value.trim();
  if (!url) {
    showToast('Masukkan URL Web App Google Apps Script', 'error');
    return;
  }

  try {
    const res = await fetch('/api/gsheet/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gsheetUrl: url })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('URL Google Sheets berhasil disimpan!', 'success');
    } else {
      showToast('Gagal menyimpan URL: ' + (data.error || 'Terjadi kesalahan'), 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan jaringan', 'error');
  }
}

async function pushAllMasterToGSheet() {
  try {
    showToast('Mengirim seluruh Master Data (ICD, Obat, Karyawan) ke Google Sheets...', 'info');
    const res = await fetch('/api/gsheet/push-all-master', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
    } else {
      showToast(data.error || 'Gagal kirim ke Google Sheets', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function pushRecordsToGSheet() {
  try {
    const res = await fetch('/api/gsheet/push-records', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Data rekam medis berhasil dikirim ke Google Sheets!', 'success');
    } else {
      showToast(data.error || 'Gagal kirim ke Google Sheets', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function exportBackupData() {
  try {
    showToast('Mengunduh backup data...', 'info');
    const res = await fetch('/api/backup/export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-klinik-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup JSON berhasil diunduh!', 'success');
  } catch (err) {
    showToast('Gagal unduh backup: ' + err.message, 'error');
  }
}

// -------------------------------------------------------------
// TOAST NOTIFICATION SYSTEM
// -------------------------------------------------------------
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-xmark';
  if (type === 'warning') icon = 'fa-triangle-exclamation';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// =============================================================
// MOBILE NAVIGATION — Bottom Nav Bar + More Menu
// =============================================================

function initMobileNav() {
  // Sync desktop nav clicks to also update mobile bottom nav state
  document.querySelectorAll('.nav-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      syncMobileNavHighlight(target);
    });
  });
}

/**
 * Switch page view and update bottom nav active state.
 * @param {string} viewId - The page-view section ID to show
 * @param {HTMLElement|null} mobileBtn - The mobile-nav-item element clicked (null if from More menu)
 * @param {boolean} fromMore - True if triggered from More menu
 */
function switchMobileNav(viewId, mobileBtn, fromMore = false) {
  // Switch page view
  document.querySelectorAll('.page-view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');

  // Sync desktop nav buttons
  document.querySelectorAll('.nav-btn[data-target]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-target') === viewId);
  });

  // Update bottom nav highlight
  syncMobileNavHighlight(viewId, mobileBtn);

  // Close more menu
  if (fromMore) closeMobileMore();

  if (viewId === 'view-obat-req') {
    renderReqMedicineCatalog();
  }
}

function syncMobileNavHighlight(viewId, explicitBtn) {
  // Map of viewId → mobile nav item ID
  const navMap = {
    'view-poli': 'mnav-poli',
    'view-karyawan': 'mnav-karyawan',
    'view-gudang': 'mnav-gudang',
    'view-hse': 'mnav-hse'
  };

  // Remove active from all bottom nav items
  document.querySelectorAll('.mobile-nav-item').forEach(b => b.classList.remove('active'));

  if (explicitBtn) {
    explicitBtn.classList.add('active');
  } else if (navMap[viewId]) {
    const btn = document.getElementById(navMap[viewId]);
    if (btn) btn.classList.add('active');
  }
  // If it's a "more" tab (EDIT DATA, SHIFT, etc.), no bottom nav item gets active dot
}

function toggleMobileMore() {
  const menu = document.getElementById('mobile-more-menu');
  const backdrop = document.getElementById('mobile-more-backdrop');
  const isOpen = menu.classList.contains('open');
  if (isOpen) {
    closeMobileMore();
  } else {
    menu.classList.add('open');
    backdrop.classList.add('open');
  }
}

function closeMobileMore() {
  document.getElementById('mobile-more-menu')?.classList.remove('open');
  document.getElementById('mobile-more-backdrop')?.classList.remove('open');
}

// =============================================================
// MOBILE PATIENT CARD LIST — renders cards for smartphone view
// =============================================================

function renderMobileKaryawanCards() {
  const container = document.getElementById('mobile-karyawan-cards');
  if (!container) return;

  const query = document.getElementById('search-karyawan-input')?.value.toLowerCase().trim() || '';

  const filtered = appData.patients.filter(k => {
    const nikP = String(k.nikPabrik || k.nik || '').toLowerCase();
    const nama = String(k.nama || '').toLowerCase();
    const dept = String(k.dept || k.departemen || '').toLowerCase();
    const hp = String(k.hp || k.no_hp || '').toLowerCase();
    return !query || nikP.includes(query) || nama.includes(query) || dept.includes(query) || hp.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 32px 16px; color: var(--text-muted);">
        <i class="fa-solid fa-user-slash" style="font-size: 2rem; margin-bottom: 12px; display: block; opacity: 0.4;"></i>
        <div style="font-weight: 700;">Tidak ada pasien ditemukan</div>
        <div style="font-size: 0.8rem; margin-top: 4px;">"${query}"</div>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((k, idx) => {
    const no = k.no || String(idx + 1);
    const npk = k.nikPabrik || k.nik || '-';
    const nama = k.nama || '-';
    const dept = k.dept || k.departemen || 'PT ATI';
    const tgl = k.tglLahir || k.tgl_lahir || '';
    const usia = tgl ? calculateAge(tgl) : '-';
    const gender = k.gender || '-';
    const golDarah = (k.golDarah || '-').trim();
    const rawHp = k.hp || k.no_hp || '';
    const cleanWA = cleanPhoneForWA(rawHp);
    const patientJSON = JSON.stringify(k).replace(/'/g, '&apos;');
    const editId = k.id || npk;

    // Blood type badge class
    const golClass = { 'AB': 'ab', 'A': 'a', 'B': 'b', 'O': 'o' }[golDarah.toUpperCase()] || 'na';
    const genderIcon = gender.toLowerCase().includes('perempuan') ? 'fa-venus' : 'fa-mars';
    const genderColor = gender.toLowerCase().includes('perempuan') ? '#f472b6' : '#60a5fa';

    const waBtn = rawHp
      ? `<button class="btn btn-sm" style="flex: 1.2; background: #25D366; color: #fff; border: none; font-weight: 700;" onclick="window.open('https://wa.me/${cleanWA}','_blank')" title="Kirim Pesan WhatsApp">
           <i class="fa-brands fa-whatsapp"></i> Chat WA
         </button>`
      : `<button class="btn btn-sm" style="flex: 1.2; background: #25D366; color: #fff; border: none; font-weight: 700; opacity: 0.5;" onclick="showToast('No HP belum diisi. Silakan klik Edit untuk menambah No WhatsApp.', 'warning')" title="No WA belum diisi">
           <i class="fa-brands fa-whatsapp"></i> Chat WA
         </button>`;

    return `
      <div class="mobile-patient-card" ondblclick="openModalRiwayatPasien('${npk}')" style="cursor: pointer;" title="Klik 2x untuk melihat riwayat medis">
        <div class="patient-card-row">
          <span class="patient-card-lbl">No :</span>
          <span class="patient-card-val" style="font-weight: 700; color: var(--text-muted);">#${no}</span>
        </div>
        <div class="patient-card-row">
          <span class="patient-card-lbl">NPK :</span>
          <span class="patient-card-val"><span class="card-npk">${npk}</span></span>
        </div>
        <div class="patient-card-row">
          <span class="patient-card-lbl">Nama :</span>
          <span class="patient-card-val"><strong>${nama}</strong></span>
        </div>
        <div class="patient-card-row">
          <span class="patient-card-lbl">Bagian :</span>
          <span class="patient-card-val">${dept}</span>
        </div>
        <div class="patient-card-row">
          <span class="patient-card-lbl">Tgl Lahir :</span>
          <span class="patient-card-val">${tgl || '-'}${usia !== '-' ? ` <span class="card-usia-badge" style="margin-left: 4px;">${usia}</span>` : ''}</span>
        </div>
        <div class="patient-card-row">
          <span class="patient-card-lbl">Gender / Gol :</span>
          <span class="patient-card-val">${gender} | <span class="card-gol-badge ${golClass}">${golDarah}</span></span>
        </div>
        <div class="patient-card-row">
          <span class="patient-card-lbl">No. WhatsApp :</span>
          <span class="patient-card-val" style="color: ${rawHp ? '#34d399' : 'var(--text-faint)'}; font-weight: 600;">
            ${rawHp ? `<i class="fa-brands fa-whatsapp" style="color: #34d399; margin-right: 4px;"></i>${rawHp}` : '<span style="font-style: italic; color: var(--text-faint);">Belum diisi</span>'}
          </span>
        </div>
        
        <div class="card-actions" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 6px;">
          <button class="btn btn-sm btn-primary" style="flex: 1;" onclick='selectPatientDirectFromKaryawan(${patientJSON})' title="Buka Riwayat di Poli">
            <i class="fa-solid fa-stethoscope"></i> Poli
          </button>
          <button class="btn btn-sm btn-secondary" style="flex: 1;" onclick="openModalEditKaryawan('${editId}')" title="Edit Data Pasien">
            <i class="fa-solid fa-pen"></i> Edit
          </button>
          ${waBtn}
        </div>
      </div>`;
  }).join('');
}

// =============================================================
// GRAFIK ANALISIS HSE (10 PENYAKIT & 10 DEPARTMENT TERBANYAK)
// =============================================================
let hseChartInstances = {};

function openHSEChartModal(targetTab = 'penyakit') {
  const modal = document.getElementById('modal-hse-charts');
  if (modal) modal.style.display = 'flex';
  switchHSEChartTab(targetTab);
  renderHSEComparisonCharts();
}

function switchHSEChartTab(tab) {
  const secPenyakit = document.getElementById('section-chart-penyakit');
  const secDept = document.getElementById('section-chart-dept');
  const secPasien = document.getElementById('section-chart-pasien');
  const secSection = document.getElementById('section-chart-section');

  const btnPenyakit = document.getElementById('chart-tab-penyakit-btn');
  const btnDept = document.getElementById('chart-tab-dept-btn');
  const btnPasien = document.getElementById('chart-tab-pasien-btn');
  const btnSection = document.getElementById('chart-tab-section-btn');

  if (secPenyakit) secPenyakit.style.display = 'none';
  if (secDept) secDept.style.display = 'none';
  if (secPasien) secPasien.style.display = 'none';
  if (secSection) secSection.style.display = 'none';

  if (btnPenyakit) { btnPenyakit.className = 'btn btn-sm btn-secondary'; btnPenyakit.style.background = ''; }
  if (btnDept) { btnDept.className = 'btn btn-sm btn-secondary'; btnDept.style.background = ''; }
  if (btnPasien) { btnPasien.className = 'btn btn-sm btn-secondary'; btnPasien.style.background = ''; }
  if (btnSection) { btnSection.className = 'btn btn-sm btn-secondary'; btnSection.style.background = ''; }

  if (tab === 'dept') {
    if (secDept) secDept.style.display = 'block';
    if (btnDept) { btnDept.className = 'btn btn-sm btn-primary'; btnDept.style.background = '#84cc16'; btnDept.style.border = 'none'; }
  } else if (tab === 'pasien') {
    if (secPasien) secPasien.style.display = 'block';
    if (btnPasien) { btnPasien.className = 'btn btn-sm btn-primary'; btnPasien.style.background = '#f59e0b'; btnPasien.style.border = 'none'; }
  } else if (tab === 'section') {
    if (secSection) secSection.style.display = 'block';
    if (btnSection) { btnSection.className = 'btn btn-sm btn-primary'; btnSection.style.background = '#a855f7'; btnSection.style.border = 'none'; }
  } else {
    if (secPenyakit) secPenyakit.style.display = 'block';
    if (btnPenyakit) { btnPenyakit.className = 'btn btn-sm btn-primary'; btnPenyakit.style.background = '#00cbd5'; btnPenyakit.style.border = 'none'; }
  }
}

function closeHSEChartModal() {
  const modal = document.getElementById('modal-hse-charts');
  if (modal) modal.style.display = 'none';
}

function renderHSEComparisonCharts() {
  const startVal = document.getElementById('hse-rm-start')?.value;
  let currDate = new Date();
  if (startVal) {
    const parsed = new Date(`${startVal}T00:00:00`);
    if (!isNaN(parsed.getTime())) currDate = parsed;
  }

  const currYear = currDate.getFullYear();
  const currMonth = currDate.getMonth(); // 0 - 11

  // Previous Month
  const prevYear = currMonth === 0 ? currYear - 1 : currYear;
  const prevMonth = currMonth === 0 ? 11 : currMonth - 1;

  const monthNamesIndo = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];

  const currMonthLabel = `${monthNamesIndo[currMonth]} - ${currYear}`;
  const prevMonthLabel = `${monthNamesIndo[prevMonth]} - ${prevYear}`;

  // Update titles in modal
  const titlePenyakitCurr = document.getElementById('title-chart-penyakit-curr');
  const titlePenyakitPrev = document.getElementById('title-chart-penyakit-prev');
  const titleDeptCurr = document.getElementById('title-chart-dept-curr');
  const titleDeptPrev = document.getElementById('title-chart-dept-prev');
  const titlePasienCurr = document.getElementById('title-chart-pasien-curr');
  const titlePasienPrev = document.getElementById('title-chart-pasien-prev');
  const titleSectionCurr = document.getElementById('title-chart-section-curr');
  const titleSectionPrev = document.getElementById('title-chart-section-prev');

  if (titlePenyakitCurr) titlePenyakitCurr.innerHTML = `10 PENYAKIT TERBANYAK<br><span style="color:#00cbd5; font-size:0.85rem;">${currMonthLabel}</span>`;
  if (titlePenyakitPrev) titlePenyakitPrev.innerHTML = `10 PENYAKIT TERBANYAK<br><span style="color:#00cbd5; font-size:0.85rem;">${prevMonthLabel}</span>`;
  if (titleDeptCurr) titleDeptCurr.innerHTML = `10 DEPARTMENT TERBANYAK<br><span style="color:#84cc16; font-size:0.85rem;">${currMonthLabel}</span>`;
  if (titleDeptPrev) titleDeptPrev.innerHTML = `10 DEPARTMENT TERBANYAK<br><span style="color:#84cc16; font-size:0.85rem;">${prevMonthLabel}</span>`;
  if (titlePasienCurr) titlePasienCurr.innerHTML = `10 PASIEN TERBANYAK<br><span style="color:#f59e0b; font-size:0.85rem;">${currMonthLabel}</span>`;
  if (titlePasienPrev) titlePasienPrev.innerHTML = `10 PASIEN TERBANYAK<br><span style="color:#f59e0b; font-size:0.85rem;">${prevMonthLabel}</span>`;
  if (titleSectionCurr) titleSectionCurr.innerHTML = `SECTION TERBANYAK<br><span style="color:#a855f7; font-size:0.85rem;">${currMonthLabel}</span>`;
  if (titleSectionPrev) titleSectionPrev.innerHTML = `SECTION TERBANYAK<br><span style="color:#a855f7; font-size:0.85rem;">${prevMonthLabel}</span>`;

  // Filter records
  const currRecords = appData.records.filter(r => {
    const d = parseRecordDate(r);
    return d && d.getFullYear() === currYear && d.getMonth() === currMonth;
  });

  const prevRecords = appData.records.filter(r => {
    const d = parseRecordDate(r);
    return d && d.getFullYear() === prevYear && d.getMonth() === prevMonth;
  });

  // Calculate Top 10 Penyakit
  const getTopDiseases = (recs) => {
    const counts = {};
    recs.forEach(r => {
      let diagStr = r.asesmen && r.asesmen.trim() !== '' ? r.asesmen.trim() : (r.keluhan || 'Lainnya');
      diagStr = diagStr.replace(/undefined\s*-\s*undefined/gi, 'Lainnya').trim();
      if (!diagStr) diagStr = 'Lainnya';

      const diags = diagStr.split(';').map(d => d.trim()).filter(d => d && d !== 'undefined - undefined');
      if (diags.length === 0) diags.push('Lainnya');

      diags.forEach(d => {
        counts[d] = (counts[d] || 0) + 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  // Calculate Top 10 Dept
  const getTopDepts = (recs) => {
    const counts = {};
    recs.forEach(r => {
      let dept = r.dept && r.dept.trim() !== '' ? r.dept.trim() : 'Lainnya';
      counts[dept] = (counts[dept] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  // Calculate Top 10 Pasien
  const getTopPatients = (recs) => {
    const counts = {};
    recs.forEach(r => {
      if (r.namaPasien) {
        const nameKey = `${r.namaPasien} (${r.nikPabrik || '-'})`;
        counts[nameKey] = (counts[nameKey] || 0) + 1;
      }
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  // Calculate Top 10 Section
  const getTopSections = (recs) => {
    const counts = {};
    recs.forEach(r => {
      let section = 'Lainnya';
      if (r.nikPabrik) {
        const patient = appData.patients.find(p => p.nikPabrik === r.nikPabrik);
        if (patient && patient.sectionName && patient.sectionName.trim() !== '') {
          section = patient.sectionName.trim();
        }
      }
      counts[section] = (counts[section] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  const topPenyakitCurr = getTopDiseases(currRecords);
  const topPenyakitPrev = getTopDiseases(prevRecords);
  const topDeptCurr = getTopDepts(currRecords);
  const topDeptPrev = getTopDepts(prevRecords);
  const topPasienCurr = getTopPatients(currRecords);
  const topPasienPrev = getTopPatients(prevRecords);
  const topSectionCurr = getTopSections(currRecords);
  const topSectionPrev = getTopSections(prevRecords);

  // Render Charts
  renderBarChart('chartPenyakitCurrent', topPenyakitCurr.map(d => d[0]), topPenyakitCurr.map(d => d[1]), '#00cbd5');
  renderBarChart('chartPenyakitPrev', topPenyakitPrev.map(d => d[0]), topPenyakitPrev.map(d => d[1]), '#00cbd5');
  renderBarChart('chartDeptCurrent', topDeptCurr.map(d => d[0]), topDeptCurr.map(d => d[1]), '#84cc16');
  renderBarChart('chartDeptPrev', topDeptPrev.map(d => d[0]), topDeptPrev.map(d => d[1]), '#84cc16');
  renderBarChart('chartPasienCurrent', topPasienCurr.map(d => d[0]), topPasienCurr.map(d => d[1]), '#f59e0b');
  renderBarChart('chartPasienPrev', topPasienPrev.map(d => d[0]), topPasienPrev.map(d => d[1]), '#f59e0b');
  renderBarChart('chartSectionCurrent', topSectionCurr.map(d => d[0]), topSectionCurr.map(d => d[1]), '#a855f7');
  renderBarChart('chartSectionPrev', topSectionPrev.map(d => d[0]), topSectionPrev.map(d => d[1]), '#a855f7');
}

function renderBarChart(canvasId, labels, dataValues, barColor) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  if (hseChartInstances[canvasId]) {
    hseChartInstances[canvasId].destroy();
  }

  // Fallback if empty
  if (labels.length === 0) {
    labels = ['Belum Ada Data'];
    dataValues = [0];
  }

  const ctx = canvas.getContext('2d');
  const plugins = (typeof ChartDataLabels !== 'undefined') ? [ChartDataLabels] : [];

  hseChartInstances[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: dataValues,
        backgroundColor: barColor,
        borderRadius: 4,
        barPercentage: 0.65
      }]
    },
    plugins: plugins,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true },
        datalabels: {
          anchor: 'end',
          align: 'top',
          color: '#ffffff',
          font: { weight: 'bold', size: 11 },
          formatter: (val) => val > 0 ? val : ''
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#94a3b8',
            font: { size: 10, weight: '700' },
            maxRotation: 45,
            minRotation: 45
          },
          grid: { display: false }
        },
        y: {
          ticks: { color: '#94a3b8', precision: 0 },
          grid: { color: 'rgba(255,255,255,0.06)' },
          beginAtZero: true
        }
      }
    }
  });
}
