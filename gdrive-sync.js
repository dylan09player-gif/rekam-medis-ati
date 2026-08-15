/**
 * Google Drive Backup & Sync Module for Rekam Medis ATI
 */

const GDriveSync = {
  status: 'Ready',
  folderId: '',
  clientId: '',

  init() {
    this.loadSettings();
  },

  loadSettings() {
    const folderInput = document.getElementById('gdrive-folder-id');
    const clientInput = document.getElementById('gdrive-client-id');
    
    if (window.appState && window.appState.settings) {
      if (folderInput) folderInput.value = window.appState.settings.gdrive_folder_id || '';
      if (clientInput) clientInput.value = window.appState.settings.gdrive_client_id || '';
    }
  },

  async triggerBackup() {
    try {
      showToast('Mengunduh backup data Rekam Medis...', 'info');
      const response = await fetch('/api/backup/export');
      const blob = await response.blob();
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-rekam-medis-ati-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      
      showToast('Backup data berhasil diunduh! Siap diunggah ke Google Drive.', 'success');
    } catch (err) {
      showToast('Gagal melakukan backup: ' + err.message, 'error');
    }
  },

  async triggerRestore(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const jsonData = JSON.parse(e.target.result);
        const response = await fetch('/api/backup/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jsonData)
        });
        
        const result = await response.json();
        if (result.success) {
          showToast('Database berhasil dipulihkan dari backup!', 'success');
          if (window.loadAppData) window.loadAppData();
        } else {
          showToast('Error: ' + result.error, 'error');
        }
      } catch (err) {
        showToast('File JSON backup tidak valid', 'error');
      }
    };
    reader.readAsText(file);
  }
};

window.GDriveSync = GDriveSync;
