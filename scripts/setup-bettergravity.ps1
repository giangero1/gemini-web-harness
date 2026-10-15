# setup-bettergravity.ps1
# Configures BetterGravity to route Antigravity requests to Gemini Web Harness (http://127.0.0.1:8046)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$scriptDir\setup-bettergravity.js"
