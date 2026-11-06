@echo off
title QuChen IQ2_XS (default)
cd /d "D:\AI\QuChen\QuChen-main\QuChen-main"
"D:\AI\QuChen\QuChen-main\QuChen-main\.venv\Scripts\python.exe" "D:\AI\QuChen\QuChen-main\QuChen-main\serve\server.py" "--engine" "quchen" "--config" "D:\AI\QuChen\QuChen-main\QuChen-main\quchen-iq2_xs.json" "--port" "8080" "--open"
if errorlevel 1 pause
