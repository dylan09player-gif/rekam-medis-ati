@echo off
title Aplikasi Rekam Medis In-House - Nafila Medika
color 0a
cls
echo =====================================================================
echo    APLIKASI RESMI REKAM MEDIS IN-HOUSE - NAFILA MEDIKA
echo    Sistem Pelayanan Klinik PT & Rekam Medis Elektronik Terpadu
echo =====================================================================
echo.
echo  [+] Memeriksa server offline klinik...

:: Cek apakah port 3000 sudah berjalan
netstat -ano | findstr :3000 >nul 2>&1
if %errorlevel% equ 0 (
    echo  [v] Server offline sudah aktif di port 3000.
) else (
    echo  [+] Menjalankan server di latar belakang...
    start /min "Server Klinik Nafila" node server.js
    timeout /t 2 /nobreak >nul
)

echo.
echo  [+] Membuka Aplikasi Desktop Resmi Klinik...
echo.

:: Jalankan Microsoft Edge dalam Desktop App Mode (tanpa URL bar, seperti software native)
start msedge.exe --app="http://localhost:3000" >nul 2>&1
if %errorlevel% neq 0 (
    start chrome.exe --app="http://localhost:3000" >nul 2>&1
    if %errorlevel% neq 0 (
        start http://localhost:3000
    )
)

echo =====================================================================
echo    Aplikasi Desktop Berhasil Terbuka!
echo    Anda dapat menggunakan aplikasi ini secara 100% Offline.
echo =====================================================================
timeout /t 3 /nobreak >nul
exit
