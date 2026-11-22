@echo off
cd /d "%~dp0"
set PORT=4175
echo Receipt Desk is starting. Open http://127.0.0.1:4175 in your browser.
echo To stop the app, press Ctrl+C in this window.
node server.js
pause
