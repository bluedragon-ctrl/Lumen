@echo off
REM Launch the Lumen recipe editor and open it in the default browser.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.

cd /d "%~dp0..\.."

echo Starting the Lumen recipe editor on http://localhost:3942 ...
start "" http://localhost:3942
node "tools\recipe-editor\recipe-editor.js"

REM Keep the window open if node exits (e.g. port in use) so the error is readable.
pause
