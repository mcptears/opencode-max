@echo off
REM Builds all Hadi binaries (Windows). Run from the repo root after git pull.
cd /d "%~dp0backend"
echo Building hadi-server...
go build -o hadi-server.exe . || exit /b 1
echo Building qwen-login...
go build -o qwen-login.exe ./cmd/qwen-login || exit /b 1
echo Building zai-collect...
go build -o zai-collect.exe ./cmd/zai-collect || exit /b 1
cd /d "%~dp0"
echo.
echo Done. Restart hadi-server: .\backend\hadi-server.exe
