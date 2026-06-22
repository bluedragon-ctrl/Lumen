@echo off
REM Cut a Lumen release. Double-click this file, or run it from a terminal.
REM Any args are passed through to the script (e.g. release.bat --patch, release.bat 1.0.0).

cd /d "%~dp0.."

REM First show a dry-run preview so nothing happens by accident.
echo === Release preview (no files changed yet) ===
node "tools\release.js" --dry-run %*
if errorlevel 1 goto end

echo.
set /p ANSWER="Cut this release? It will branch, commit, push + open a PR. [y/N] "
if /i not "%ANSWER%"=="y" (
  echo Aborted. Nothing changed.
  goto end
)

echo.
echo === Cutting release ===
node "tools\release.js" %*

:end
REM Keep the window open so the output (or any error) stays readable.
pause
