@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first: https://nodejs.org/
  pause
  exit /b 1
)
node serve.mjs opening.html
pause
