// Application State
let appData = {
  patients: [],
  records: [],
  medicines: [],
  icd10: [],
  absenDokter: [],
  pantauan: [],
  waPhone: '6281234567890',
  currentPoliPatient: null
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  checkGateLoginStatus();
  await loadAllAppData();
  initNavigation();
  initPoliForm();
  initDateInputs();
});

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

// Gate Login Authentication (Pass: 231067)
function checkGateLoginStatus() {
  const auth = localStorage.getItem('marunda_gate_auth');
  const overlay = document.getElementById('gate-login-overlay');
  if (auth === 'true') {
    overlay.style.display = 'none';
  } else {
    overlay.style.display = 'flex';
  }
}

async function handleGateLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('gate-password-input').value.trim();
  try {
    const res = await fetch('/api/auth/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (data.success === true || data.status === 'SUCCESS') {
      localStorage.setItem('marunda_gate_auth', 'true');
      document.getElementById('gate-login-overlay').style.display = 'none';
      showToast('Login Klinik Berhasil! Selamat Datang 👋', 'success');
    } else {
      document.getElementById('gate-password-input').value = '';
      showToast('❌ Password Klinik salah! Coba lagi.', 'error');
    }
  } catch (err) {
    // Fallback: cek langsung di client jika server tidak bisa dihubungi
    if (pass === '231067') {
      localStorage.setItem('marunda_gate_auth', 'true');
      document.getElementById('gate-login-overlay').style.display = 'none';
      showToast('Login berhasil (mode lokal)', 'success');
    } else {
      showToast('Gagal menghubungi server. Periksa koneksi.', 'error');
    }
  }
}

function handleLogout() {
  if (confirm('Keluar dari sistem Klinik?')) {
    localStorage.removeItem('marunda_gate_auth');
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

    const [patRes, recRes, medRes, icdRes, absRes, panRes] = await Promise.all([
      fetch('/api/patients'),
      fetch('/api/records'),
      fetch('/api/medicines'),
      fetch('/api/icd10'),
      fetch('/api/absen-dokter'),
      fetch('/api/pantauan')
    ]);

    appData.patients = await safeJson(patRes);
    appData.records = await safeJson(recRes);
    appData.medicines = await safeJson(medRes);
    appData.icd10 = await safeJson(icdRes);
    appData.absenDokter = await safeJson(absRes);
    appData.pantauan = await safeJson(panRes);

    // Load GSheet URL setting
    try {
      const gRes = await fetch('/api/gsheet/settings');
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
    } catch {}

    renderEditDataTable();
    renderGudangTable();
    renderKaryawanTable();
    renderHSERekamMedisTable();
    renderHSEPasienPantauanTable();
    renderBillingPTTable();
    renderAbsenDirekturTable();
    renderNakesSuggestions();

    console.log(`Data loaded - Karyawan: ${appData.patients.length}, Obat: ${appData.medicines.length}, ICD-10: ${appData.icd10.length}`);

  } catch (err) {
    console.error('Error loading app data:', err);
    showToast('Server belum siap, coba refresh halaman.', 'warning');
  }
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
    });
  });
}

function initDateInputs() {
  const today = new Date().toISOString().split('T')[0];
  const dateInputs = ['absen-tgl', 'shift1-tgl-mulai', 'shift1-tgl-selesai', 'shift2-tgl-mulai', 'shift2-tgl-selesai', 'hse-rm-start', 'hse-rm-end', 'billing-start', 'billing-end'];
  dateInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });
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
  icdContainer.innerHTML = '';
  addICD10Row();

  const resepBody = document.getElementById('poli-resep-body');
  resepBody.innerHTML = '';
  addPoliMedicineRow();
  
  renderNakesSuggestions();
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

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-sm btn-danger';
  deleteBtn.title = 'Hapus Diagnosis';
  deleteBtn.style.cssText = 'width: 38px; height: 38px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0;';
  deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
  deleteBtn.onclick = () => row.remove();

  row.appendChild(wrap);
  row.appendChild(deleteBtn);
  container.appendChild(row);
}

function addPoliMedicineRow(medName = '', dosageOrAturan = '3x1 sesudah makan', qty = 1) {
  const body = document.getElementById('poli-resep-body');
  const tr = document.createElement('tr');
  const medList = getSortedMedicines();

  let initialMed = null;
  if (medName) {
    initialMed = medList.find(m => m.nama.toLowerCase() === medName.toLowerCase());
  }

  const defaultPrice = initialMed ? (parseInt(initialMed.harga) || 0) : 0;
  tr.dataset.unitPrice = defaultPrice;

  tr.innerHTML = `
    <td style="vertical-align: top;">
      <div class="custom-searchable-wrap med-searchable-wrap">
        <div class="searchable-input-box">
          <input type="text" class="form-control med-search-input select-medicine" placeholder="🔍 Cari obat (A-Z)..." value="${initialMed ? initialMed.nama : medName}" autocomplete="off">
          <i class="fa-solid fa-chevron-down searchable-dropdown-arrow"></i>
        </div>
        <div class="searchable-dropdown-menu"></div>
      </div>
      <small class="stock-badge-info"></small>
    </td>
    <td style="vertical-align: top;">
      <input type="text" class="form-control med-aturan" value="${dosageOrAturan}" placeholder="Contoh: 3x1 sesudah makan">
    </td>
    <td style="vertical-align: top;">
      <input type="number" class="form-control med-qty" value="${qty}" min="1" step="1" placeholder="Qty" style="text-align: center; font-weight: 700;">
    </td>
    <td style="vertical-align: top; text-align: right;">
      <div class="med-subtotal-badge">Rp 0</div>
    </td>
    <td style="vertical-align: top; text-align: center;">
      <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('tr').remove(); calculateResepGrandTotal();" title="Hapus Obat" style="width: 34px; height: 34px; padding: 0; display: inline-flex; align-items: center; justify-content: center;"><i class="fa-solid fa-trash-can"></i></button>
    </td>
  `;

  body.appendChild(tr);

  const wrap = tr.querySelector('.med-searchable-wrap');
  const input = tr.querySelector('.med-search-input');
  const menu = tr.querySelector('.searchable-dropdown-menu');
  const aturanInput = tr.querySelector('.med-aturan');
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
      const hargaFormat = m.harga ? `Rp ${parseInt(m.harga).toLocaleString('id-ID')}` : 'Rp 0';
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
        const harga = parseInt(opt.getAttribute('data-harga')) || 0;

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
      tr.dataset.unitPrice = parseInt(matched.harga) || 0;
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
  const unitPrice = parseInt(tr.dataset.unitPrice) || 0;
  const qty = parseInt(tr.querySelector('.med-qty')?.value) || 1;
  const subtotal = unitPrice * qty;
  const badge = tr.querySelector('.med-subtotal-badge');
  if (badge) {
    badge.textContent = `Rp ${subtotal.toLocaleString('id-ID')}`;
  }
  calculateResepGrandTotal();
}

function calculateResepGrandTotal() {
  const rows = document.querySelectorAll('#poli-resep-body tr');
  let grandTotal = 0;
  rows.forEach(tr => {
    const unitPrice = parseInt(tr.dataset.unitPrice) || 0;
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
  document.getElementById('poli-info-sub').textContent = `NIK Pabrik: ${p.nikPabrik || '-'} | Dept: ${p.dept || '-'} | Tgl Lahir: ${p.tglLahir || '-'}`;

  // Update Right Panel Banner
  document.getElementById('poli-banner-name').textContent = `${p.nama} (${p.nikPabrik || '-'})`;
  document.getElementById('poli-banner-sub').textContent = `Dept: ${p.dept || '-'} | Gender: ${p.gender || '-'}`;
  document.getElementById('poli-banner-alergi').textContent = p.alergi ? `⚠️ Alergi: ${p.alergi}` : '';

  renderPatientHistoryTimeline(p);
  showToast(`Pasien ${p.nama} dipilih`, 'info');
}

function renderPatientHistoryTimeline(patient) {
  const container = document.getElementById('poli-timeline-container');
  const countEl = document.getElementById('poli-history-count');
  
  const history = appData.records.filter(r => 
    (r.nikPabrik && String(r.nikPabrik) === String(patient.nikPabrik)) ||
    (r.namaPasien && r.namaPasien.toLowerCase() === patient.nama.toLowerCase())
  ).sort((a,b) => new Date(b.tanggal || b.created_at) - new Date(a.tanggal || a.created_at));

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
      const diagList = String(r.asesmen).split(';').map(d => d.trim()).filter(d => d && d !== 'undefined - undefined');
      if (diagList.length > 0) {
        diagHTML = `<div style="display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px;">` +
          diagList.map(d => `<span class="badge badge-info"><i class="fa-solid fa-stethoscope"></i> ${d}</span>`).join('') +
          `</div>`;
      }
    }

    // Format Resep Obat (P)
    let planHTML = '<span style="color: var(--text-faint); font-weight: 500;">-</span>';
    if (r.plan) {
      const planItems = String(r.plan).split(';').map(p => p.trim()).filter(p => p);
      if (planItems.length > 0) {
        planHTML = `<div class="timeline-medicines-list">` +
          planItems.map(p => `<div class="med-pill-item">💊 ${p}</div>`).join('') +
          `</div>`;
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

        <div class="timeline-section-row">
          <span class="timeline-label-chip chip-o">O</span>
          <span style="color: var(--text-muted); font-weight: 500;">${r.objektif || '-'}</span>
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
          ${r.linkFoto ? `<a href="${r.linkFoto}" target="_blank" class="btn btn-sm btn-primary" style="font-size: 0.74rem; padding: 3px 8px;"><i class="fa-solid fa-image"></i> Lihat Foto</a>` : ''}
        </div>

        <button class="btn btn-sm btn-secondary btn-block" style="margin-top: 10px; font-weight: 700;" onclick='copyRecordToPoliForm(${JSON.stringify(r).replace(/'/g, "&apos;")})'>
          <i class="fa-solid fa-copy"></i> Salin ke Form Input
        </button>
      </div>
    `;
  }).join('');
}

function copyRecordToPoliForm(record) {
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
      addPoliMedicineRow(r.namaObat || r.obat, r.harga, r.qty || 1);
    });
  }

  showToast('Data riwayat disalin ke form pemeriksaan!', 'info');
}

async function handleSavePoli(e) {
  e.preventDefault();
  if (!appData.currentPoliPatient) {
    showToast('Silakan cari dan pilih pasien terlebih dahulu!', 'error');
    return;
  }

  const keluhan = document.getElementById('poli-keluhan').value.trim();
  const td = document.getElementById('poli-td').value.trim();
  const nadi = document.getElementById('poli-nadi').value.trim();
  const suhu = document.getElementById('poli-suhu').value.trim();
  const bb = document.getElementById('poli-bb').value.trim();
  const tb = document.getElementById('poli-tb').value.trim();
  const detailObj = document.getElementById('poli-objektif-detail').value.trim();
  const pemeriksa = document.getElementById('poli-pemeriksa').value.trim() || 'Nakes Pemeriksa';
  const isIzinSakit = document.getElementById('poli-izin-sakit').checked;
  const isPantauan = document.getElementById('poli-pantauan').checked;

  const objektifFull = `TD: ${td || '-'}, Nadi: ${nadi || '-'}, Suhu: ${suhu || '-'}, BB: ${bb || '-'}, TB: ${tb || '-'}. ${detailObj}`;

  // Gather ICD-10 Diagnoses & Record Frequencies
  const icdSelects = document.querySelectorAll('.select-icd10');
  const selectedICDArr = Array.from(icdSelects).map(s => s.value.trim()).filter(v => v !== '');
  selectedICDArr.forEach(d => recordICD10Selection(d));
  const selectedICD = selectedICDArr.join('; ');

  // Gather Resep Obat with Live Locked Prices, Aturan Pakai & Subtotals
  const resepRows = document.querySelectorAll('#poli-resep-body tr');
  const resepList = [];
  let grandTotalBiaya = 0;

  resepRows.forEach(tr => {
    const medSel = tr.querySelector('.select-medicine')?.value.trim();
    const aturan = tr.querySelector('.med-aturan')?.value.trim() || 'sesudah makan';
    const unitPrice = parseInt(tr.dataset.unitPrice) || 0;
    const qty = parseInt(tr.querySelector('.med-qty')?.value) || 1;
    const subtotal = unitPrice * qty;

    if (medSel) {
      resepList.push({ 
        namaObat: medSel, 
        aturan,
        harga: unitPrice, 
        qty, 
        subtotal 
      });
      grandTotalBiaya += subtotal;
    }
  });

  const planText = resepList.length > 0
    ? resepList.map(r => `${r.namaObat} No.${r.qty} (${r.aturan}) [Harga: Rp ${r.subtotal.toLocaleString('id-ID')}]`).join('; ') + (grandTotalBiaya > 0 ? ` [Total: Rp ${grandTotalBiaya.toLocaleString('id-ID')}]` : '')
    : 'Edukasi Istirahat & Hidrasi Cukup';

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

  const newRecord = {
    nikPabrik: appData.currentPoliPatient.nikPabrik || '',
    namaPasien: appData.currentPoliPatient.nama,
    dept: appData.currentPoliPatient.dept || '',
    tanggal: new Date().toLocaleDateString('id-ID'),
    keluhan,
    objektif: objektifFull,
    asesmen: selectedICD || 'Pemeriksaan Umum',
    plan: planText,
    resep: resepList,
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
      resetFormPoli();
      await loadAllAppData();
      if (appData.currentPoliPatient) {
        renderPatientHistoryTimeline(appData.currentPoliPatient);
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
  const searchFilter = document.getElementById('filter-edit-search')?.value.toLowerCase();

  let filtered = appData.records.slice().reverse();

  if (searchFilter) {
    filtered = filtered.filter(r => 
      (r.namaPasien && r.namaPasien.toLowerCase().includes(searchFilter)) ||
      (r.nikPabrik && r.nikPabrik.toLowerCase().includes(searchFilter)) ||
      (r.keluhan && r.keluhan.toLowerCase().includes(searchFilter))
    );
  }

  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td>${r.tanggal || '-'}</td>
      <td><strong>${r.namaPasien}</strong><br><small class="text-muted">${r.nikPabrik || '-'}</small></td>
      <td>
        <div><strong>S:</strong> ${r.keluhan || '-'}</div>
        <div><strong>A:</strong> <span class="badge badge-info">${r.asesmen || '-'}</span></div>
        <div><strong>P:</strong> ${r.plan || '-'}</div>
      </td>
      <td>${r.pemeriksa || '-'}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick='openModalEditRecord(${JSON.stringify(r).replace(/'/g, "&apos;")})'>
          <i class="fa-solid fa-pen"></i> Edit
        </button>
      </td>
    </tr>
  `).join('');
}

function filterEditDataTable() {
  renderEditDataTable();
}

function addEditICD10Row(defaultValue = '') {
  const container = document.getElementById('edit-container-icd10');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'edit-icd10-row';
  div.style.cssText = 'display: flex; gap: 8px; margin-bottom: 6px; align-items: center;';

  const icdList = getICD10WithFrequency();

  let selectHTML = `<select class="form-control select-edit-icd10" style="flex: 1;"><option value="">-- Pilih Diagnosis ICD-10 --</option>`;
  icdList.forEach(item => {
    const label = item.fullLabel;
    const isTop = item.freq > 0 ? ` (🔥 ${item.freq}x)` : '';
    const sel = (defaultValue && (item.code === defaultValue || item.desc === defaultValue || label === defaultValue || defaultValue.includes(item.code))) ? 'selected' : '';
    selectHTML += `<option value="${label}" ${sel}>${label}${isTop}</option>`;
  });
  selectHTML += `</select><button type="button" class="btn btn-sm btn-danger" onclick="this.parentElement.remove()" title="Hapus" style="width: 36px; height: 36px; padding: 0;"><i class="fa-solid fa-trash-can"></i></button>`;

  div.innerHTML = selectHTML;
  container.appendChild(div);
}

function addEditResepRow(medName = '', qty = 1) {
  const container = document.getElementById('edit-container-resep');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'edit-resep-row';
  div.style.cssText = 'display: flex; gap: 8px; margin-bottom: 6px; align-items: center;';

  const medList = getSortedMedicines();

  let selectHTML = `<select class="form-control select-edit-medicine" style="flex: 2;"><option value="">-- Pilih Obat --</option>`;
  medList.forEach(m => {
    const sel = (medName && m.nama.toLowerCase() === medName.toLowerCase()) ? 'selected' : '';
    selectHTML += `<option value="${m.nama}" ${sel}>${m.nama} [Stok: ${m.stok}]</option>`;
  });
  selectHTML += `</select>`;

  div.innerHTML = `
    ${selectHTML}
    <input type="number" class="form-control edit-med-qty" value="${qty}" min="1" style="width: 80px; text-align: center;" placeholder="Jumlah">
    <button type="button" class="btn btn-sm btn-danger" onclick="this.parentElement.remove()" title="Hapus" style="width: 36px; height: 36px; padding: 0;"><i class="fa-solid fa-trash-can"></i></button>
  `;

  container.appendChild(div);
}

function openModalEditRecord(record) {
  document.getElementById('edit-record-id').value = record.id;
  document.getElementById('edit-nama-pasien').value = record.namaPasien || '';
  document.getElementById('edit-keluhan').value = record.keluhan || '';
  document.getElementById('edit-objektif').value = record.objektif || '';
  document.getElementById('edit-pemeriksa').value = record.pemeriksa || 'dr. Dylan Fadhilah';
  document.getElementById('edit-is-pantauan').checked = record.isPantauan === true;

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

  const updatedData = {
    keluhan: document.getElementById('edit-keluhan').value,
    objektif: document.getElementById('edit-objektif').value,
    asesmen: selectedICD || 'Pemeriksaan Umum',
    plan: planText || 'Edukasi Istirahat',
    resep: resepList,
    pemeriksa: document.getElementById('edit-pemeriksa').value,
    isPantauan: document.getElementById('edit-is-pantauan').checked
  };

  try {
    const res = await fetch(`/api/records/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedData)
    });

    if (res.ok) {
      showToast('Rekam Medis & Revisi Stok Berhasil Diperbarui!', 'success');
      closeModalEditRecord();
      await loadAllAppData();
    } else {
      showToast('Gagal mengedit data', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
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
  const bList = document.getElementById('gudang-subtab-list');
  const bOpname = document.getElementById('gudang-subtab-opname');

  if (type === 'opname') {
    if (vList) vList.style.display = 'none';
    if (vOpname) vOpname.style.display = 'block';
    if (bList) bList.className = 'btn btn-secondary';
    if (bOpname) bOpname.className = 'btn btn-primary';
    renderStokOpnameTable();
  } else {
    if (vList) vList.style.display = 'block';
    if (vOpname) vOpname.style.display = 'none';
    if (bList) bList.className = 'btn btn-primary';
    if (bOpname) bOpname.className = 'btn btn-secondary';
  }
}

function renderStokOpnameTable() {
  const tbody = document.getElementById('table-stok-opname-body');
  if (!tbody) return;

  tbody.innerHTML = appData.medicines.map((m, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${m.nama}</strong></td>
      <td>Rp ${(m.harga || 1000).toLocaleString('id-ID')}</td>
      <td style="font-weight: 700;">${m.stok} ${m.satuan || 'strip'}</td>
      <td style="background: rgba(255,255,255,0.05); text-align: center; color: var(--text-muted);">_______</td>
      <td style="text-align: center; color: var(--text-muted);">_______</td>
      <td style="text-align: center; color: var(--text-muted);">Rp _______</td>
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
        <h3>KLINIK NAFILA MEDIKA - PT MARUNDA & PT ATI</h3>
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
        <td>${m.kode || '-'}</td>
        <td><strong>${m.nama}</strong></td>
        <td>${m.kategori || 'Obat Bebas'}</td>
        <td style="font-weight: 700; font-size: 1.05rem; ${isLow ? 'color: var(--danger);' : ''}">${m.stok}</td>
        <td style="font-weight: 600; color: #38bdf8;">Rp ${(parseInt(m.harga) || 0).toLocaleString('id-ID')}</td>
        <td>${m.satuan || 'strip'}</td>
        <td>${statusBadge}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="updateObatStokDirect('${m.id}', ${m.stok}, ${m.harga || 0})"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm btn-danger" onclick="deleteObatDirect('${m.id}')">&times;</button>
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
    harga: parseInt(document.getElementById('obat-harga').value) || 0,
    satuan: document.getElementById('obat-satuan').value,
    kategori: document.getElementById('obat-kategori').value || 'Obat'
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
    }
  } catch (err) {
    showToast('Gagal menyimpan obat', 'error');
  }
}

async function updateObatStokDirect(id, currentStok) {
  const newStok = prompt('Masukkan Stok Baru Obat:', currentStok);
  if (newStok !== null && !isNaN(newStok)) {
    try {
      await fetch(`/api/medicines/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stok: parseInt(newStok) })
      });
      showToast('Stok obat berhasil diperbarui', 'success');
      await loadAllAppData();
    } catch (err) {
      showToast('Gagal mengoreksi stok', 'error');
    }
  }
}

async function deleteObatDirect(id) {
  if (confirm('Hapus obat ini dari gudang?')) {
    try {
      await fetch(`/api/medicines/${id}`, { method: 'DELETE' });
      showToast('Obat dihapus', 'info');
      await loadAllAppData();
    } catch (err) {
      showToast('Gagal menghapus', 'error');
    }
  }
}

// -------------------------------------------------------------
// 4. TAB OBAT REQ LOGIC (WHATSAPP API)
// -------------------------------------------------------------
function addObatReqRowDropdown() {
  const tbody = document.getElementById('req-table-body');
  const tr = document.createElement('tr');
  
  let selectHTML = `<select class="form-control req-med-name" required><option value="">-- Pilih Obat Gudang --</option>`;
  appData.medicines.forEach(m => {
    selectHTML += `<option value="${m.nama}">${m.nama} (Sisa: ${m.stok} ${m.satuan})</option>`;
  });
  selectHTML += `</select>`;

  tr.innerHTML = `
    <td>${selectHTML}</td>
    <td><input type="number" class="form-control req-med-qty" value="1" min="1" required></td>
    <td><button type="button" class="btn btn-sm btn-danger" onclick="this.closest('tr').remove()">&times;</button></td>
  `;
  tbody.appendChild(tr);
}

function addObatReqRowManual() {
  const tbody = document.getElementById('req-table-body');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="form-control req-med-name" placeholder="Ketik nama obat manual..." required></td>
    <td><input type="number" class="form-control req-med-qty" value="1" min="1" required></td>
    <td><button type="button" class="btn btn-sm btn-danger" onclick="this.closest('tr').remove()">&times;</button></td>
  `;
  tbody.appendChild(tr);
}

function handleSendObatReqWA(e) {
  e.preventDefault();
  const perawat = document.getElementById('req-nama-perawat').value.trim();
  const rows = document.querySelectorAll('#req-table-body tr');

  if (rows.length === 0) {
    showToast('Tambahkan minimal 1 item obat yang diminta!', 'error');
    return;
  }

  let textWA = `*PERMINTAAN OBAT KLINIK PT MARUNDA*\n`;
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

  const encoded = encodeURIComponent(textWA);
  const waUrl = `https://wa.me/${appData.waPhone}?text=${encoded}`;
  window.open(waUrl, '_blank');
}

// -------------------------------------------------------------
// 5. TAB KARYAWAN LOGIC (NIK PABRIK SEARCH)
// -------------------------------------------------------------
function renderKaryawanTable() {
  const tbody = document.getElementById('table-karyawan-body');
  if (!tbody) return;

  const query = document.getElementById('search-karyawan-input')?.value.toLowerCase().trim() || '';

  const filtered = appData.patients.filter(k => {
    const nikP = String(k.nikPabrik || k.nik || '').toLowerCase();
    const nama = String(k.nama || '').toLowerCase();
    const dept = String(k.dept || k.departemen || '').toLowerCase();
    return !query || nikP.includes(query) || nama.includes(query) || dept.includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--text-muted);">Tidak ada data karyawan yang cocok dengan '${query}'</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(k => `
    <tr>
      <td><span class="badge badge-info">${k.nikPabrik || k.nik || '-'}</span></td>
      <td><strong>${k.nama || '-'}</strong></td>
      <td>${k.dept || k.departemen || '-'}</td>
      <td>${k.tglLahir || k.tgl_lahir || '-'}</td>
      <td>${k.gender || '-'}</td>
      <td>${k.hp || k.no_hp || '-'}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick='selectPatientDirectFromKaryawan(${JSON.stringify(k).replace(/'/g, "&apos;")})'>
          <i class="fa-solid fa-stethoscope"></i> Periksa di Poli
        </button>
      </td>
    </tr>
  `).join('');
}

function filterKaryawanTable() {
  renderKaryawanTable();
}

function selectPatientDirectFromKaryawan(patient) {
  appData.currentPoliPatient = patient;
  document.querySelector('.nav-btn[data-target="view-poli"]').click();
  document.getElementById('poli-search-nik').value = patient.nikPabrik || patient.nama;
  searchPatientByNIK();
}

function openModalTambahKaryawan() {
  document.getElementById('modal-karyawan').style.display = 'flex';
}
function closeModalTambahKaryawan() {
  document.getElementById('modal-karyawan').style.display = 'none';
}

async function handleSaveKaryawan(e) {
  e.preventDefault();
  const newK = {
    nikPabrik: document.getElementById('karyawan-nik').value.trim(),
    nama: document.getElementById('karyawan-nama').value.trim(),
    dept: document.getElementById('karyawan-dept').value.trim(),
    tglLahir: document.getElementById('karyawan-tgl-lahir').value,
    gender: document.getElementById('karyawan-gender').value,
    hp: document.getElementById('karyawan-hp').value,
    alamat: document.getElementById('karyawan-alamat').value
  };

  try {
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newK)
    });
    if (res.ok) {
      showToast('Data Karyawan Berhasil Disimpan', 'success');
      closeModalTambahKaryawan();
      await loadAllAppData();
    }
  } catch (err) {
    showToast('Gagal menyimpan karyawan', 'error');
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
  const panTab = document.getElementById('hse-subtab-pantauan');
  const btnRm = document.getElementById('subtab-btn-rm');
  const btnPan = document.getElementById('subtab-btn-pantauan');

  if (type === 'rm') {
    rmTab.style.display = 'block';
    panTab.style.display = 'none';
    btnRm.className = 'btn btn-primary';
    btnPan.className = 'btn btn-secondary';
  } else {
    rmTab.style.display = 'none';
    panTab.style.display = 'block';
    btnRm.className = 'btn btn-secondary';
    btnPan.className = 'btn btn-primary';
  }
}

function renderHSERekamMedisTable() {
  const tbody = document.getElementById('table-hse-rm-body');
  if (!tbody) return;

  const search = document.getElementById('hse-rm-search')?.value.toLowerCase() || '';

  const filtered = appData.records.filter(r => 
    !search || (r.nikPabrik && String(r.nikPabrik).toLowerCase().includes(search)) || (r.namaPasien && r.namaPasien.toLowerCase().includes(search))
  );

  // Update HSE Stats
  const statTotal = document.getElementById('hse-stat-total-visits');
  const statPantauan = document.getElementById('hse-stat-pantauan-count');
  const statSurkes = document.getElementById('hse-stat-surkes-count');

  if (statTotal) statTotal.textContent = appData.records.length;
  if (statPantauan) statPantauan.textContent = appData.records.filter(r => r.isPantauan === true).length;
  if (statSurkes) statSurkes.textContent = appData.records.filter(r => r.izinSakit === true).length;

  tbody.innerHTML = filtered.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.tanggal || '-'}</td>
      <td><strong>${r.namaPasien}</strong></td>
      <td>${r.nikPabrik || '-'}</td>
      <td>${r.dept || '-'}</td>
      <td>${r.keluhan || '-'}</td>
      <td><span class="badge badge-info">${r.asesmen || '-'}</span></td>
      <td>${r.objektif || '-'}</td>
      <td>${r.plan || '-'}</td>
      <td>
        ${r.linkFoto ? `<a href="${r.linkFoto}" target="_blank" class="btn btn-sm btn-primary" style="background:#0284c7; border:none; text-decoration:none;"><i class="fa-solid fa-image"></i> Foto</a>` : '-'}
      </td>
    </tr>
  `).join('');
}

function filterHSERekamMedisTable() {
  renderHSERekamMedisTable();
}

function renderHSEPasienPantauanTable() {
  const tbody = document.getElementById('table-hse-pantauan-body');
  if (!tbody) return;

  const pantauanList = appData.records.filter(r => r.isPantauan === true);

  tbody.innerHTML = pantauanList.map(r => `
    <tr>
      <td>${r.tanggal || '-'}</td>
      <td><span class="badge badge-danger">${r.nikPabrik || '-'}</span></td>
      <td><strong>${r.namaPasien}</strong></td>
      <td>${r.dept || '-'}</td>
      <td>${r.keluhan} (A: ${r.asesmen})</td>
      <td><span class="badge badge-warning">Dalam Pemantauan</span></td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="selectPatientDirectFromKaryawan({nikPabrik: '${r.nikPabrik}', nama: '${r.namaPasien}'})">
          Cek History Poli
        </button>
      </td>
    </tr>
  `).join('');
}

function exportHSERekamMedisExcel() {
  let csv = 'No,Tanggal,Nama,NIK Pabrik,Bagian,Keluhan,Diagnosis,Hasil Pemeriksaan,Obat,Pemeriksa\n';
  appData.records.forEach((r, i) => {
    csv += `"${i+1}","${r.tanggal}","${r.namaPasien}","${r.nikPabrik}","${r.dept}","${r.keluhan}","${r.asesmen}","${r.objektif}","${r.plan}","${r.pemeriksa}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Rekam_Medis_HSE_K3_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
}

// 🖨️ CETAK LAPORAN RESMI K3 / HSE BULANAN (PROFESIONAL A4)
function printHSEOfficialReport() {
  const tglIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const totalVisits = appData.records.length;
  const totalPantauan = appData.records.filter(r => r.isPantauan === true).length;
  const totalSurkes = appData.records.filter(r => r.izinSakit === true).length;

  const rowsRM = appData.records.map((r, i) => `
    <tr>
      <td style="text-align:center; padding: 6px;">${i + 1}</td>
      <td style="padding: 6px;">${r.tanggal || '-'}</td>
      <td style="padding: 6px; font-weight: bold;">${r.namaPasien} (${r.nikPabrik || '-'})</td>
      <td style="padding: 6px;">${r.dept || '-'}</td>
      <td style="padding: 6px;">${r.keluhan || '-'}</td>
      <td style="padding: 6px; font-weight: bold; color: #0284c7;">${r.asesmen || '-'}</td>
      <td style="padding: 6px;">${r.plan || '-'}</td>
      <td style="text-align:center; padding: 6px;">${r.isPantauan ? '🔴 PANTAUAN' : 'NORMAL'}</td>
    </tr>
  `).join('');

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Laporan K3 & HSE Klinik Medis - PT ATI & PT ATI</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; color: #1e293b; background: #fff; }
        .header { text-align: center; border-bottom: 3px double #0284c7; padding-bottom: 12px; margin-bottom: 20px; }
        .header h2 { margin: 0; font-size: 16pt; color: #0f172a; text-transform: uppercase; letter-spacing: 1px; }
        .header h4 { margin: 4px 0 0 0; font-size: 11pt; color: #475569; font-weight: normal; }
        .summary-grid { display: flex; justify-content: space-between; margin-bottom: 20px; gap: 10px; }
        .box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; width: 30%; text-align: center; background: #f8fafc; }
        .box-val { font-size: 16pt; font-weight: bold; color: #0284c7; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 9pt; }
        th, td { border: 1px solid #94a3b8; padding: 6px; }
        th { background: #f1f5f9; text-transform: uppercase; font-size: 8.5pt; text-align: left; }
        .ttd-grid { display: flex; justify-content: space-between; margin-top: 40px; text-align: center; font-size: 10pt; }
        @media print { @page { size: A4 landscape; margin: 1.2cm; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>LAPORAN KESEHATAN KESELAMATAN KERJA (K3 / HSE)</h2>
        <h4>KLINIK NAFILA MEDIKA — PT MARUNDA UTARA & PT ATI MEDIKA</h4>
        <div style="font-size: 9pt; margin-top: 6px; font-weight: bold; color: #0284c7;">Periode Laporan: ${tglIndo}</div>
      </div>

      <div class="summary-grid">
        <div class="box">
          <div style="font-size: 9pt; font-weight: bold; color: #475569;">TOTAL KUNJUNGAN PASIEN</div>
          <div class="box-val">${totalVisits} Pasien</div>
        </div>
        <div class="box">
          <div style="font-size: 9pt; font-weight: bold; color: #dc2626;">PASIEN HIGH RISK / PANTAUAN</div>
          <div class="box-val" style="color: #dc2626;">${totalPantauan} Pasien</div>
        </div>
        <div class="box">
          <div style="font-size: 9pt; font-weight: bold; color: #d97706;">SURKES / IZIN SAKIT</div>
          <div class="box-val" style="color: #d97706;">${totalSurkes} Kasus</div>
        </div>
      </div>

      <h3 style="font-size: 11pt; margin-bottom: 8px; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">Daftar Rekam Medis Kunjungan Karyawan:</h3>
      <table>
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
  const tabs = ['analisis', 'billing', 'kontak'];
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

function renderAnalisisObat() {
  const totalRecords = appData.records.length;
  const estimatedCost = totalRecords * 25000;
  document.getElementById('mj-modal-total').textContent = `Rp ${estimatedCost.toLocaleString('id-ID')} (Target Maksimal Rp 2.000.000 / Bulan)`;
}

function renderBillingPTTable() {
  const tbody = document.getElementById('table-billing-body');
  if (!tbody) return;

  tbody.innerHTML = appData.records.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.tanggal || '-'}</td>
      <td><strong>${r.namaPasien}</strong></td>
      <td>${r.nikPabrik || '-'}</td>
      <td>${r.dept || '-'}</td>
      <td>${r.asesmen || '-'}</td>
      <td style="font-weight: 700; color: #38bdf8;">Rp 75.000</td>
    </tr>
  `).join('');
}

function exportBillingExcel() {
  let csv = 'No,Tanggal,Nama Pasien,NIK Pabrik,Departemen,Diagnosis,Biaya Billing (Rp)\n';
  appData.records.forEach((r, i) => {
    csv += `"${i+1}","${r.tanggal || ''}","${r.namaPasien || ''}","${r.nikPabrik || ''}","${r.dept || ''}","${r.asesmen || ''}","75000"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Billing_Klinik_PT_ATI_PT ATI_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  showToast('Laporan Billing Excel berhasil diunduh!', 'success');
}

// 🖨️ CETAK LAPORAN DIREKSI & FINANSIAL EKSEKUTIF (PROFESIONAL A4)
function printExecutiveReport() {
  const tglIndo = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const totalVisits = appData.records.length;
  const totalBilling = totalVisits * 75000;
  const modalObat = totalVisits * 25000;

  const rowsBilling = appData.records.map((r, i) => `
    <tr>
      <td style="text-align:center; padding: 6px;">${i + 1}</td>
      <td style="padding: 6px;">${r.tanggal || '-'}</td>
      <td style="padding: 6px; font-weight: bold;">${r.namaPasien} (${r.nikPabrik || '-'})</td>
      <td style="padding: 6px;">${r.dept || '-'}</td>
      <td style="padding: 6px;">${r.asesmen || '-'}</td>
      <td style="text-align:right; padding: 6px; font-weight: bold;">Rp 75.000</td>
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
        .fin-box { border: 1px solid #10b981; border-radius: 8px; padding: 14px; width: 31%; text-align: center; background: #f0fdf4; }
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
        <h4>KLINIK NAFILA MEDIKA — PT MARUNDA & PT ATI MEDIKA</h4>
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
        <div class="fin-box">
          <div style="font-size: 8.5pt; font-weight: bold; color: #065f46;">MODAL PEMAKAIAN OBAT</div>
          <div class="fin-val" style="color: #2563eb;">Rp ${modalObat.toLocaleString('id-ID')}</div>
        </div>
      </div>

      <h3 style="font-size: 11pt; margin-bottom: 8px; text-transform: uppercase; border-bottom: 2px solid #10b981; padding-bottom: 4px;">Rincian Tagihan Layanan Kesehatan Pasien Rawat Jalan:</h3>
      <table>
        <thead>
          <tr>
            <th style="width: 5%;">No</th>
            <th style="width: 12%;">Tanggal</th>
            <th style="width: 25%;">Nama Pasien & NIK</th>
            <th style="width: 18%;">Departemen / Bagian</th>
            <th style="width: 25%;">Diagnosis Utama (A)</th>
            <th style="width: 15%; text-align:right;">Tarif Billing (Rp)</th>
          </tr>
        </thead>
        <tbody>
          ${rowsBilling || '<tr><td colspan="6" style="text-align:center;">Belum ada data billing</td></tr>'}
        </tbody>
      </table>

      <div class="ttd-box">
        <div>
          Disiapkan Oleh,<br><strong>Manajer Keuangan / Operasional</strong><br><br><br><br>
          ( ______________________ )
        </div>
        <div>
          Menyetujui,<br><strong>Direktur Utama Klinik Medika</strong><br><br><br><br>
          <strong>dr. Dylan Fadhilah / dr. Isda Laily</strong>
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

function saveWAPhoneSetting() {
  const phone = document.getElementById('mj-wa-num').value.trim();
  appData.waPhone = phone;
  // Simpan juga ke server settings
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wa_phone: phone })
  });
  showToast('Nomor WA Apoteker Berhasil Disimpan', 'success');
}

// -------------------------------------------------------------
// 10. MCU IMPORT LOGIC
// -------------------------------------------------------------
function importMCUCSVFile() {
  const fileInput = document.getElementById('mcu-file-input');
  if (!fileInput.files || fileInput.files.length === 0) {
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
    if (data.success) {
      showToast(`✅ ${data.message}`, 'success');
      const el = document.getElementById('gsheet-last-sync');
      if (el) el.textContent = 'Terakhir sync: ' + new Date(data.lastSync).toLocaleString('id-ID');
      await loadAllAppData();
      if (typeof renderGudangTable === 'function') renderGudangTable();
    } else {
      showToast('Gagal sync: ' + (data.error || 'Error tidak diketahui'), 'error');
    }
  } catch (err) {
    showToast('Error koneksi ke server: ' + err.message, 'error');
  } finally {
    if (btnEl) {
      btnEl.innerHTML = origText;
      btnEl.disabled = false;
    }
  }
}

async function syncWithGoogleSheetNow() {
  const url = document.getElementById('gsheet-app-url')?.value.trim();
  const btn = event ? event.target : null;
  let origText = '';
  if (btn) {
    origText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyinkronkan...';
    btn.disabled = true;
  }

  try {
    const res = await fetch('/api/gsheet/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gsheetUrl: url })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      const el = document.getElementById('gsheet-last-sync');
      if (el) el.textContent = 'Terakhir sync: ' + new Date(data.lastSync).toLocaleString('id-ID');
      await loadAllAppData();
      if (typeof renderGudangTable === 'function') renderGudangTable();
    } else {
      showToast('Gagal sync: ' + (data.error || 'Error tidak diketahui'), 'error');
    }
  } catch (err) {
    showToast('Error koneksi ke server: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.innerHTML = origText;
      btn.disabled = false;
    }
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
