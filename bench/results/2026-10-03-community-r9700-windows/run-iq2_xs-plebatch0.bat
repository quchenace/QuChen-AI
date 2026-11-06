@echo off
title QuChen IQ2_XS (QUCHEN_PLE_BATCH=0)
cd /d "D:\AI\QuChen\QuChen-main\QuChen-main"
set QUCHEN_PLE_BATCH=0
echo Starting QuChen with QUCHEN_PLE_BATCH=0
"D:\AI\QuChen\QuChen-main\QuChen-main\.venv\Scripts\python.exe" "D:\AI\QuChen\QuChen-main\QuChen-main\serve\server.py" "--engine" "quchen" "--config" "D:\AI\QuChen\QuChen-main\QuChen-main\quchen-iq2_xs.json" "--port" "8080" "--open"
if errorlevel 1 pause
