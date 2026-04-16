@echo off
REM Sets ANTHROPIC_BASE_URL for the current user session so Claude Code routes through the optimizer proxy.
REM Run this once before opening VS Code. If the variable persists across reboots, you only need to do this once.

set ANTHROPIC_BASE_URL=http://localhost:8787
setx ANTHROPIC_BASE_URL http://localhost:8787

echo.
echo [OK] ANTHROPIC_BASE_URL set to http://localhost:8787
echo      Open VS Code and press F5 to launch the extension.
echo.
pause
