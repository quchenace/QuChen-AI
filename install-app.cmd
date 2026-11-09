@echo off
rem QuChen: double-click installer for the desktop app. Runs install-app.ps1 from the newest release.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/quchenace/QuChen-AI/releases/latest/download/install-app.ps1 | iex"
if errorlevel 1 pause
