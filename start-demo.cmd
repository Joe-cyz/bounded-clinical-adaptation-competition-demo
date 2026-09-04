@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto missing_node

where pnpm >nul 2>nul
if not errorlevel 1 goto pnpm_ready

where corepack >nul 2>nul
if errorlevel 1 goto missing_pnpm
echo [Setup] Enabling pnpm...
call corepack enable
if errorlevel 1 goto setup_failed
call corepack prepare pnpm@11.19.0 --activate
if errorlevel 1 goto setup_failed

:pnpm_ready
if exist "node_modules\.bin\next.cmd" goto dependencies_ready
echo [Setup] Installing web dependencies for the first launch...
call pnpm install --frozen-lockfile
if errorlevel 1 goto setup_failed

:dependencies_ready
set "APP_RUNTIME_MODE=local-research"
set "LLM_PROVIDER=mock"
set "DEEPSEEK_ENABLED=false"
set "DEEPSEEK_API_KEY="
set "PWR08D_REAL_PROVIDER_ENABLED=false"
set "PWR08C_FAKE_FETCH=false"
set "SPEECH_PROVIDER=disabled"
if exist "speech-runtime\whisper-cli.exe" if exist "speech-runtime\ggml-small.bin" (
  set "SPEECH_PROVIDER=local-whisper"
  set "SPEECH_LOCAL_WHISPER_EXECUTABLE_PATH=%CD%\speech-runtime\whisper-cli.exe"
  set "SPEECH_LOCAL_WHISPER_MODEL_PATH=%CD%\speech-runtime\ggml-small.bin"
  set "SPEECH_LOCAL_WHISPER_TEMP_ROOT=%CD%\data\runtime\speech-temp"
)
set "DATABASE_PATH=data/runtime/competition-demo.sqlite"

if "%DEMO_CHECK_ONLY%"=="1" exit /b 0

echo [Start] Opening the demo in your browser...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"
call pnpm dev
if errorlevel 1 goto run_failed
exit /b 0

:missing_node
echo [Cannot start] Install Node.js 24, then double-click this file again.
echo Download: https://nodejs.org/en/download
pause
exit /b 1

:missing_pnpm
echo [Cannot start] pnpm and corepack were not found. Reinstall Node.js 24.
pause
exit /b 1

:setup_failed
echo [Setup failed] Check your network connection and try again.
pause
exit /b 1

:run_failed
echo [Start failed] Review the message above and try again.
pause
exit /b 1
