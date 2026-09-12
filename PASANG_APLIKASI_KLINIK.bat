@echo off
title Installer Aplikasi Rekam Medis - Nafila Medika
color 0b
cls
echo ==============================================================================
echo       SELAMAT DATANG DI INSTALASI RESMI KLINIK NAFILA MEDIKA
echo       Sistem Rekam Medis Elektronik Terpadu In-House Pabrik & Multi-PT
echo ==============================================================================
echo.
echo  [+] Mempersiapkan shortcut aplikasi resmi...

set APP_DIR=%~dp0
set TARGET_EXE=%APP_DIR%KlinikNafila.exe
set ICON_FILE=%APP_DIR%nafila_icon.ico

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $d = [System.Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut([System.IO.Path]::Combine($d, 'Klinik Nafila Medika.lnk')); $s.TargetPath = '%TARGET_EXE%'; $s.WorkingDirectory = '%APP_DIR%'; $s.IconLocation = '%ICON_FILE%,0'; $s.Description = 'Aplikasi Resmi Rekam Medis In-House Nafila Medika'; $s.Save()"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $sm = [System.Environment]::GetFolderPath('StartMenu'); $prog = [System.IO.Path]::Combine($sm, 'Programs'); $s = $ws.CreateShortcut([System.IO.Path]::Combine($prog, 'Klinik Nafila Medika.lnk')); $s.TargetPath = '%TARGET_EXE%'; $s.WorkingDirectory = '%APP_DIR%'; $s.IconLocation = '%ICON_FILE%,0'; $s.Description = 'Aplikasi Resmi Rekam Medis In-House Nafila Medika'; $s.Save()"

echo.
echo  [v] SUKSES! Ikon resmi "Klinik Nafila Medika" telah dibuat di Desktop & Start Menu.
echo.
echo  [+] Membuka aplikasi sekarang...
start "" "%TARGET_EXE%"
timeout /t 3 /nobreak >nul
exit
