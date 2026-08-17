@echo off
title Mobile Klinik System - PT ATI & ATI Medika
color 0b
cls
echo =========================================================
echo    MOBILE KLINIK SYSTEM - PT ATI ^& ATI MEDIKA
echo =========================================================
echo.
echo  [1] Akses dari Laptop ini : http://localhost:3000
echo  [2] Akses dari HP (Wi-Fi) : http://192.168.0.108:3000
echo.
echo  *Pastikan HP dan Laptop terhubung ke Wi-Fi yang sama!
echo =========================================================
echo.
echo Menjalankan server...
node server.js
pause
