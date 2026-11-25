@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Update Node.js to version 22 or newer: https://nodejs.org/
  pause
  exit /b 1
)
if not defined MOPE_CDP_PORT set "MOPE_CDP_PORT=9222"
node -e "const p=Number(process.env.MOPE_CDP_PORT);process.exit(Number.isInteger(p)&&p>=1&&p<=65535?0:1)"
if errorlevel 1 (
  echo MOPE_CDP_PORT must be an integer from 1 to 65535.
  pause
  exit /b 1
)
if defined BROWSER goto browser_ready
for %%B in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do if not defined BROWSER if exist "%%~B" set "BROWSER=%%~B"
:browser_ready
if not exist "%BROWSER%" (
  echo Browser not found. Set BROWSER to the full path of Chrome or Edge.
  pause
  exit /b 1
)
set "PROFILE=%TEMP%\mope-cdp-profile-%MOPE_CDP_PORT%"
start "" "%BROWSER%" --remote-debugging-address=127.0.0.1 --remote-debugging-port=%MOPE_CDP_PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-session-crashed-bubble about:blank
node "%~dp0inject.js"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
