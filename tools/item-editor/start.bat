@echo off
REM Launch the Lumen item editor and open it in the default browser.
REM Double-click this file, or run it from a terminal. Ctrl+C to stop.

cd /d "%~dp0..\.."

echo Starting the Lumen item editor on http://localhost:3941 ...
start "" http://localhost:3941
node "tools\item-editor\item-editor.js"

REM Keep the window open if node exits (e.g. port in use) so the error is readable.
pause
