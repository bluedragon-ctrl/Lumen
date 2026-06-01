@echo off
REM ===========================================================================
REM  Lumen - start the game server
REM  Double-click this file (or run it from a terminal) to launch the MUD.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install Node 18 or newer from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. See the messages above.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Starting the Lumen server...
echo   Open http://localhost:3737 in your browser to play.
echo   Press Ctrl+C in this window to stop the server.
echo.
node server\index.js

echo.
echo   Server stopped.
pause
endlocal
