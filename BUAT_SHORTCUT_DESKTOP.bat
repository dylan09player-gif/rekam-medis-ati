@echo off
title Buat Shortcut Desktop - Rekam Medis Nafila Medika
cls
echo =====================================================================
echo    MEMBUAT SHORTCUT DESKTOP RESMI NAFILA MEDIKA
echo =====================================================================
echo.

set TARGET_BAT=%~dp0JALANKAN_KLINIK_NAFILA_DESKTOP.bat
set ICON_PATH=%~dp0ATI Logo.png
set SCRIPT_DIR=%~dp0

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'Rekam Medis Nafila Medika.lnk')); $s.TargetPath = '%TARGET_BAT%'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Description = 'Aplikasi Resmi Rekam Medis In-House Nafila Medika'; $s.Save()"

echo [v] Shortcut "Rekam Medis Nafila Medika" berhasil dibuat di Desktop Anda!
echo.
pause
