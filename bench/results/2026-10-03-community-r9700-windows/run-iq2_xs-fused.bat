@echo off
title QuChen IQ2_XS (QUCHEN_PF_FUSED=1)
cd /d "D:\AI\QuChen\QuChen-main\QuChen-main"
set QUCHEN_PF_FUSED=1
echo Starting QuChen with QUCHEN_PF_FUSED=1
"D:\AI\QuChen\QuChen-main\QuChen-main\.venv\Scripts\python.exe" "D:\AI\QuChen\QuChen-main\QuChen-main\serve\server.py" "--engine" "quchen" "--config" "D:\AI\QuChen\QuChen-main\QuChen-main\quchen-iq2_xs.json" "--port" "8080" "--open"
if errorlevel 1 pause
