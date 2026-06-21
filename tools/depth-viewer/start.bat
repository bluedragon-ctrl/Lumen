@echo off
REM Launch the Lumen depth viewer and open it in the default browser.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.
REM Read-only: this tool never writes to the world data.

cd /d "%~dp0..\.."

echo Starting the Lumen depth viewer on http://localhost:3942 ...
start "" http://localhost:3942
node "tools\depth-viewer\depth-viewer.js"

REM Keep the window open if node exits (e.g. port in use) so the error is readable.
pause
