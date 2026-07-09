@echo off
REM Launch the Lumen biome preview (colour lab) and open it in the default browser.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.

cd /d "%~dp0..\.."

echo Starting the Lumen biome preview on http://localhost:3943 ...
start "" http://localhost:3943
node "tools\biome-preview\biome-preview.js"

REM Keep the window open if node exits (e.g. port in use) so the error is readable.
pause
