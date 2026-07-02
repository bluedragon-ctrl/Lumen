@echo off
REM Launch the Lumen room spawn & item editor and open it in the default browser.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.

cd /d "%~dp0..\.."

echo Starting the Lumen room spawn ^& item editor on http://localhost:3940 ...
start "" http://localhost:3940
node "tools\spawn-editor\spawn-editor.js"

REM Keep the window open if node exits (e.g. port in use) so the error is readable.
pause
