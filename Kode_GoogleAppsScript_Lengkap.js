// ============================================================
// SISTEM REKAM MEDIS & FARMASI PT ATI - GOOGLE APPS SCRIPT
// Spreadsheet ID: 1sNDmrxb4cB1eYKO-CbBXCWOElOCuiBRdJLG6ERrJkqY
// Backup Satu Arah: VPS Database -> Google Sheets (1x 24 Jam Jam 03:00 Subuh / On-Click)
// ============================================================

var SPREADSHEET_ID = "1sNDmrxb4cB1eYKO-CbBXCWOElOCuiBRdJLG6ERrJkqY";

function getSpreadsheet() {
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch(e) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}

// Helper: Format Header Kolom dengan Warna Indah, Teks Putih Tebal, dan Frozen Top Row
function setupSheetHeader(sheet, headers, bgColor) {
  sheet.clear();
  sheet.appendRow(headers);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setBackground(bgColor || "#0f766e");
  headerRange.setFontColor("#ffffff");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
  headerRange.setVerticalAlignment("middle");
  sheet.setRowHeight(1, 32);
  sheet.setFrozenRows(1);
}

// Helper: Auto-resize kolom agar rapi
function autoFitColumns(sheet, numCols) {
  for (var c = 1; c <= numCols; c++) {
    sheet.autoResizeColumn(c);
  }
}

// FUNGSI INISIALISASI OTOMATIS: Run ini di Apps Script Editor jika ingin membuat struktur tab seketika
function setupOtomatisLengkap() {
  var ss = getSpreadsheet();

  // 1. Diagnosis
  var sDiag = ss.getSheetByName("Diagnosis") || ss.insertSheet("Diagnosis");
  setupSheetHeader(sDiag, ["Kode ICD-10", "Deskripsi Penyakit"], "#0f766e");
  autoFitColumns(sDiag, 2);

  // 2. Obat
  var sObat = ss.getSheetByName("Obat") || ss.insertSheet("Obat");
  setupSheetHeader(sObat, ["ID Obat", "Kode Obat", "Nama Obat", "Stok Saat Ini", "Satuan", "Harga Satuan (Rp)", "Kategori"], "#1e40af");
  autoFitColumns(sObat, 7);

  // 3. Karyawan
  var sKary = ss.getSheetByName("Karyawan") || ss.insertSheet("Karyawan");
  setupSheetHeader(sKary, ["NIK Pabrik", "Nama Lengkap", "Departemen", "Gender", "Gol Darah", "Tanggal Lahir", "Tempat Lahir", "No Handphone", "Saldo Obat", "Section"], "#334155");
  autoFitColumns(sKary, 10);

  // 4. Tindakan
  var sTind = ss.getSheetByName("Tindakan") || ss.insertSheet("Tindakan");
  setupSheetHeader(sTind, ["ID Tindakan", "Nama Tindakan", "Tarif (Rp)", "Kategori"], "#4338ca");
  autoFitColumns(sTind, 4);

  // 5. Kunjungan
  var sKunj = ss.getSheetByName("Kunjungan") || ss.insertSheet("Kunjungan");
  setupSheetHeader(sKunj, [
    "No Rekam Medis", "Tanggal", "Jam", "NIK Pasien", "Nama Pasien", 
    "Departemen", "No HP", "Keluhan (S)", "Pemeriksaan Fisik (O)", 
    "Diagnosis / ICD-10 (A)", "Tindakan Medis", "Resep & Terapi (P)", 
    "Biaya Obat (Rp)", "Biaya Tindakan (Rp)", "Total Biaya (Rp)", 
    "Pemeriksa", "Status Kontrol", "Catatan Kontrol", "Link Foto Medis"
  ], "#15803d");
  autoFitColumns(sKunj, 19);

  // 6. Surat Jalan (Apotik)
  var sSJ = ss.getSheetByName("Surat Jalan") || ss.insertSheet("Surat Jalan");
  setupSheetHeader(sSJ, [
    "No Surat Jalan", "Tanggal", "Pengirim", "Penerima", 
    "Nama Obat", "Qty Dikirim", "Satuan", "Stok Awal", "Stok Akhir", "Waktu Input"
  ], "#b45309");
  autoFitColumns(sSJ, 10);

  // 7. Mutasi Stok
  var sMut = ss.getSheetByName("Mutasi Stok") || ss.insertSheet("Mutasi Stok");
  setupSheetHeader(sMut, [
    "ID Mutasi", "Tanggal", "Waktu Input", "Jenis Mutasi", 
    "Nama Obat", "Perubahan Qty", "Satuan", "Stok Sebelum", "Stok Sesudah", 
    "Dokumen Referensi", "Pasien / NIK", "Petugas Apotik", "Keterangan"
  ], "#7c2d12");
  autoFitColumns(sMut, 13);

  // 8. Surat Sakit Luar
  var sSakit = ss.getSheetByName("Surat Sakit Luar") || ss.insertSheet("Surat Sakit Luar");
  setupSheetHeader(sSakit, [
    "ID Surat", "Tanggal Input", "NIK Karyawan", "Nama Karyawan", 
    "Departemen", "Faskes Penerbit", "Dokter Pemeriksa", "Diagnosis", 
    "Lama Hari (Hari)", "Tgl Mulai", "Tgl Selesai", "Keterangan", "Link Foto Surat"
  ], "#0e7490");
  autoFitColumns(sSakit, 13);

  // Hapus Sheet1 bawaan jika ada tab lain
  var s1 = ss.getSheetByName("Sheet1") || ss.getSheetByName("Lembar1");
  if (s1 && ss.getSheets().length > 1) {
    try { ss.deleteSheet(s1); } catch(e) {}
  }

  Logger.log("Setup 8 Sheet Lengkap Berhasil!");
}

// Endpoint GET: Status & Informasi Spreadsheet
function doGet(e) {
  var ss = getSpreadsheet();
  var sheets = ss.getSheets().map(function(s) { 
    return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() }; 
  });
  
  return ContentService.createTextOutput(JSON.stringify({
    status: "online",
    system: "Rekam Medis & Farmasi PT ATI",
    mode: "One-Way VPS to Google Sheets (Backup 24 Jam Jam 03:00 Subuh)",
    spreadsheetId: SPREADSHEET_ID,
    sheets: sheets
  })).setMimeType(ContentService.MimeType.JSON);
}

// Endpoint POST: Menerima Export Data 1-Arah dari VPS Database
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = getSpreadsheet();

    // ==========================================================
    // ACTION: seedMaster -> MENULIS SELURUH 8 TAB SECARA RAPI
    // ==========================================================
    if (data.action === 'seedMaster') {
      
      // 1. Tab Diagnosis (ICD-10)
      if (data.icd10 && Array.isArray(data.icd10)) {
        var sDiag = ss.getSheetByName("Diagnosis") || ss.insertSheet("Diagnosis");
        var hDiag = ["Kode ICD-10", "Deskripsi Penyakit"];
        setupSheetHeader(sDiag, hDiag, "#0f766e");
        var rowsDiag = data.icd10.map(function(i){
          return [i.code || '', i.description || ''];
        });
        if (rowsDiag.length > 0) {
          sDiag.getRange(2, 1, rowsDiag.length, hDiag.length).setValues(rowsDiag);
        }
        autoFitColumns(sDiag, hDiag.length);
      }

      // 2. Tab Obat (Data Farmasi & Gudang)
      if (data.medicines && Array.isArray(data.medicines)) {
        var sObat = ss.getSheetByName("Obat") || ss.insertSheet("Obat");
        var hObat = ["ID Obat", "Kode Obat", "Nama Obat", "Stok Saat Ini", "Satuan", "Harga Satuan (Rp)", "Kategori"];
        setupSheetHeader(sObat, hObat, "#1e40af");
        var rowsObat = data.medicines.map(function(m){
          return [
            m.id || '',
            m.kode || m.id || '',
            m.nama || '',
            parseInt(m.stok) || 0,
            m.satuan || 'strip',
            parseInt(m.harga) || 0,
            m.kategori || 'Obat'
          ];
        });
        if (rowsObat.length > 0) {
          sObat.getRange(2, 1, rowsObat.length, hObat.length).setValues(rowsObat);
          sObat.getRange(2, 4, rowsObat.length, 1).setNumberFormat("#,##0");
          sObat.getRange(2, 6, rowsObat.length, 1).setNumberFormat("#,##0");
        }
        autoFitColumns(sObat, hObat.length);
      }

      // 3. Tab Karyawan
      if (data.employees && Array.isArray(data.employees)) {
        var sKary = ss.getSheetByName("Karyawan") || ss.insertSheet("Karyawan");
        var hKary = ["NIK Pabrik", "Nama Lengkap", "Departemen", "Gender", "Gol Darah", "Tanggal Lahir", "Tempat Lahir", "No Handphone", "Saldo Obat", "Section"];
        setupSheetHeader(sKary, hKary, "#334155");
        var rowsKary = data.employees.map(function(e){
          return [
            e.nikPabrik || e.nik || '',
            e.nama || '',
            e.dept || e.departemen || '',
            e.gender || '',
            e.golDarah || '-',
            e.tglLahir || e.tgl_lahir || '',
            e.birthPlace || '',
            e.hp || e.no_hp || '',
            e.saldoObat !== undefined ? e.saldoObat : '',
            e.sectionName || ''
          ];
        });
        if (rowsKary.length > 0) {
          sKary.getRange(2, 1, rowsKary.length, hKary.length).setValues(rowsKary);
        }
        autoFitColumns(sKary, hKary.length);
      }

      // 4. Tab Tindakan Medis
      if (data.tindakan && Array.isArray(data.tindakan)) {
        var sTind = ss.getSheetByName("Tindakan") || ss.insertSheet("Tindakan");
        var hTind = ["ID Tindakan", "Nama Tindakan", "Tarif (Rp)", "Kategori"];
        setupSheetHeader(sTind, hTind, "#4338ca");
        var rowsTind = data.tindakan.map(function(t){
          return [
            t.id || '',
            t.nama || '',
            parseInt(t.tarif) || 0,
            t.kategori || 'Tindakan Medis'
          ];
        });
        if (rowsTind.length > 0) {
          sTind.getRange(2, 1, rowsTind.length, hTind.length).setValues(rowsTind);
          sTind.getRange(2, 3, rowsTind.length, 1).setNumberFormat("#,##0");
        }
        autoFitColumns(sTind, hTind.length);
      }

      // 5. Tab Kunjungan / Rekam Medis (Diinput Perawat/Dokter saat Pasien Kunjungan)
      if (data.records && Array.isArray(data.records)) {
        var sKunj = ss.getSheetByName("Kunjungan") || ss.insertSheet("Kunjungan");
        var hKunj = [
          "No Rekam Medis", "Tanggal", "Jam", "NIK Pasien", "Nama Pasien", 
          "Departemen", "No HP", "Keluhan (S)", "Pemeriksaan Fisik (O)", 
          "Diagnosis / ICD-10 (A)", "Tindakan Medis", "Resep & Terapi (P)", 
          "Biaya Obat (Rp)", "Biaya Tindakan (Rp)", "Total Biaya (Rp)", 
          "Pemeriksa", "Status Kontrol", "Catatan Kontrol", "Link Foto Medis"
        ];
        setupSheetHeader(sKunj, hKunj, "#15803d");
        var rowsKunj = data.records.map(function(r){
          return [
            r.id || '',
            r.tanggal || '',
            r.jam || '',
            r.nikPabrik || '',
            r.namaPasien || '',
            r.dept || '',
            r.noHp || '',
            r.keluhan || '',
            r.objektif || '',
            r.asesmen || '',
            r.tindakan || '',
            r.plan || '',
            parseInt(r.biayaObat) || 0,
            parseInt(r.biayaTindakan) || 0,
            parseInt(r.totalBiaya) || 0,
            r.pemeriksa || '',
            r.statusKontrol || '',
            r.catatanKontrol || '',
            r.linkFoto || ''
          ];
        });
        if (rowsKunj.length > 0) {
          sKunj.getRange(2, 1, rowsKunj.length, hKunj.length).setValues(rowsKunj);
          sKunj.getRange(2, 13, rowsKunj.length, 3).setNumberFormat("#,##0");
        }
        autoFitColumns(sKunj, hKunj.length);
      }

      // 6. Tab Surat Jalan (Diinput Apotik saat Mutasi/Kirim Obat)
      if (data.suratJalan && Array.isArray(data.suratJalan)) {
        var sSJ = ss.getSheetByName("Surat Jalan") || ss.insertSheet("Surat Jalan");
        var hSJ = [
          "No Surat Jalan", "Tanggal", "Pengirim", "Penerima", 
          "Nama Obat", "Qty Dikirim", "Satuan", "Stok Awal", "Stok Akhir", "Waktu Input"
        ];
        setupSheetHeader(sSJ, hSJ, "#b45309");
        var rowsSJ = data.suratJalan.map(function(sj){
          return [
            sj.noSurat || '',
            sj.tanggal || '',
            sj.sender || '',
            sj.receiver || '',
            sj.namaObat || '',
            parseInt(sj.qty) || 0,
            sj.satuan || '',
            parseInt(sj.stokAwal) || 0,
            parseInt(sj.stokAkhir) || 0,
            sj.createdAt || ''
          ];
        });
        if (rowsSJ.length > 0) {
          sSJ.getRange(2, 1, rowsSJ.length, hSJ.length).setValues(rowsSJ);
          sSJ.getRange(2, 6, rowsSJ.length, 1).setNumberFormat("#,##0");
        }
        autoFitColumns(sSJ, hSJ.length);
      }

      // 7. Tab Mutasi Stok Obat (Semua Obat Keluar/Masuk Apotik & Klinik)
      if (data.stockMutations && Array.isArray(data.stockMutations)) {
        var sMut = ss.getSheetByName("Mutasi Stok") || ss.insertSheet("Mutasi Stok");
        var hMut = [
          "ID Mutasi", "Tanggal", "Waktu Input", "Jenis Mutasi", 
          "Nama Obat", "Perubahan Qty", "Satuan", "Stok Sebelum", "Stok Sesudah", 
          "Dokumen Referensi", "Pasien / NIK", "Petugas Apotik", "Keterangan"
        ];
        setupSheetHeader(sMut, hMut, "#7c2d12");
        var rowsMut = data.stockMutations.map(function(m){
          return [
            m.id || '',
            m.tanggal || '',
            m.createdAt || '',
            m.type || '',
            m.namaObat || '',
            parseInt(m.qty) || 0,
            m.satuan || '',
            m.stokSebelum !== '' ? (parseInt(m.stokSebelum) || 0) : '',
            m.stokSesudah !== '' ? (parseInt(m.stokSesudah) || 0) : '',
            m.refDoc || '',
            m.pasien || '',
            m.petugas || '',
            m.keterangan || ''
          ];
        });
        if (rowsMut.length > 0) {
          sMut.getRange(2, 1, rowsMut.length, hMut.length).setValues(rowsMut);
          sMut.getRange(2, 6, rowsMut.length, 1).setNumberFormat("#,##0");
        }
        autoFitColumns(sMut, hMut.length);
      }

      // 8. Tab Surat Sakit Luar
      if (data.suratSakitLuar && Array.isArray(data.suratSakitLuar)) {
        var sSakit = ss.getSheetByName("Surat Sakit Luar") || ss.insertSheet("Surat Sakit Luar");
        var hSakit = [
          "ID Surat", "Tanggal Input", "NIK Karyawan", "Nama Karyawan", 
          "Departemen", "Faskes Penerbit", "Dokter Pemeriksa", "Diagnosis", 
          "Lama Hari (Hari)", "Tgl Mulai", "Tgl Selesai", "Keterangan", "Link Foto Surat"
        ];
        setupSheetHeader(sSakit, hSakit, "#0e7490");
        var rowsSakit = data.suratSakitLuar.map(function(s){
          return [
            s.id || '',
            s.tanggal || '',
            s.nikPabrik || '',
            s.nama || '',
            s.dept || '',
            s.faskes || '',
            s.dokter || '',
            s.diagnosis || '',
            parseInt(s.lamaHari) || 0,
            s.tglMulai || '',
            s.tglSelesai || '',
            s.keterangan || '',
            s.linkFoto || ''
          ];
        });
        if (rowsSakit.length > 0) {
          sSakit.getRange(2, 1, rowsSakit.length, hSakit.length).setValues(rowsSakit);
        }
        autoFitColumns(sSakit, hSakit.length);
      }

      // Hapus Sheet1 bawaan jika ada tab lain
      var s1 = ss.getSheetByName("Sheet1") || ss.getSheetByName("Lembar1");
      if (s1 && ss.getSheets().length > 1) {
        try { ss.deleteSheet(s1); } catch(e) {}
      }

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        message: "Seluruh 8 Tab & Data Berhasil Disinkronkan dengan Rapi!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================================
    // ACTION: pushRecords -> TAMBAH DATA REKAM MEDIS
    // ==========================================================
    if (data.action === 'pushRecords') {
      var sh = ss.getSheetByName('Kunjungan') || ss.insertSheet('Kunjungan');
      if (sh.getLastRow() === 0) {
        var hKunj = [
          "No Rekam Medis", "Tanggal", "Jam", "NIK Pasien", "Nama Pasien", 
          "Departemen", "No HP", "Keluhan (S)", "Pemeriksaan Fisik (O)", 
          "Diagnosis / ICD-10 (A)", "Tindakan Medis", "Resep & Terapi (P)", 
          "Biaya Obat (Rp)", "Biaya Tindakan (Rp)", "Total Biaya (Rp)", 
          "Pemeriksa", "Status Kontrol", "Catatan Kontrol", "Link Foto Medis"
        ];
        setupSheetHeader(sh, hKunj, "#15803d");
      }
      if (Array.isArray(data.records)) {
        data.records.forEach(function(r){
          sh.appendRow([
            r.id || '', r.tanggal || '', r.jam || '', r.nikPabrik || '', r.namaPasien || '',
            r.dept || '', r.noHp || '', r.keluhan || '', r.objektif || '', r.asesmen || '',
            r.tindakan || '', r.plan || '', parseInt(r.biayaObat) || 0, parseInt(r.biayaTindakan) || 0,
            parseInt(r.totalBiaya) || 0, r.pemeriksa || '', r.statusKontrol || '', r.catatanKontrol || '', r.linkFoto || ''
          ]);
        });
      }
      return ContentService.createTextOutput(JSON.stringify({success: true}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================================
    // ACTION: uploadFile -> UPLOAD FOTO KE GOOGLE DRIVE
    // ==========================================================
    if (data.action === 'uploadFile') {
      var folderName = 'Rekam Medis ATI - Foto Penunjang';
      var folders = DriveApp.getFoldersByName(folderName);
      var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
      folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

      var base64Data = data.fileData.split(',')[1] || data.fileData;
      var decoded = Utilities.base64Decode(base64Data);
      var blob = Utilities.newBlob(decoded, data.mimeType || 'image/jpeg', data.fileName || 'Foto_RM.jpg');
      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        fileUrl: file.getUrl()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({success: false, error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
