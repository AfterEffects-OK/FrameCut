@echo off
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.jsが見つかりません。Node.jsをインストールしてください。
  pause
  exit /b 1
)
start "" http://127.0.0.1:4173
npm.cmd start
