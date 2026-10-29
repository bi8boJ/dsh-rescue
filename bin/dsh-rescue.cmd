@echo off
rem dsh-rescue launcher for Windows.
rem Keep this file ASCII-only: cmd.exe parses it with the OEM codepage, and
rem multibyte characters in a .cmd can shift the parser and corrupt the script.
rem
rem It finds a Node.js 20+ runtime (PATH first, then the one DSH ships) and runs
rem the CLI. Double-click runs the interactive menu; pass arguments to run a
rem subcommand directly.
setlocal EnableExtensions
set "HERE=%~dp0"
set "NODE_EXE="

if defined DSH_RESCUE_NODE if exist "%DSH_RESCUE_NODE%" set "NODE_EXE=%DSH_RESCUE_NODE%"

if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%N"
  )
)

if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo [dsh-rescue] node.exe not found.
  echo   Option 1: install Node.js 20 or newer.
  echo   Option 2: set DSH_RESCUE_NODE to the full path of node.exe.
  echo.
  pause
  exit /b 2
)

"%NODE_EXE%" "%HERE%dsh-rescue.mjs" %*
set "CODE=%ERRORLEVEL%"

rem Double-click opens the interactive menu; keep the window readable afterwards.
if "%~1"=="" pause
exit /b %CODE%
