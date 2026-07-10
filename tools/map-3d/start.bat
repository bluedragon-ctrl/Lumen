@echo off
REM Launch the Lumen 3D world map and open it in the default browser.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.
REM Read-only: this tool never writes to the world data.

cd /d "%~dp0..\.."

echo Starting the Lumen 3D map on http://localhost:3945 ...
start "" http://localhost:3945
node "tools\map-3d\map-3d.js"

REM Keep the window open if node exits (e.g. port in use) so the error is readable.
pause
