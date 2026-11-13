# PowerShell script to ensure Google Gemini Desktop (with CDP Port 9222) is active for Antigravity

$ErrorActionPreference = "Stop"

$port = 9222
$chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "D:\gemini-web-harness\.chrome-profile"

function Test-PortOpen([int]$p) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect("127.0.0.1", $p, $null, $null)
        $success = $iar.AsyncWaitHandle.WaitOne(800, $false)
        if ($success -and $tcp.Connected) {
            $tcp.EndConnect($iar)
            $tcp.Close()
            return $true
        }
        $tcp.Close()
        return $false
    } catch {
        return $false
    }
}

Write-Host "[Gemini Desktop Bridge] Checking if CDP port $port is active..."
if (Test-PortOpen -p $port) {
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp -and $resp.Count -gt 0) {
            Write-Host "[Gemini Desktop Bridge] Port $port is already active with $($resp.Count) target(s)."
            exit 0
        }
    } catch {}
}

Write-Host "[Gemini Desktop Bridge] Launching Gemini Desktop Window on port $port..."
Start-Process -FilePath $chromeExe -ArgumentList "--remote-debugging-port=$port", "--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--app=https://gemini.google.com/app"

$timeoutSec = 12
$startTime = [Environment]::TickCount
$ready = $false

while (([Environment]::TickCount - $startTime) -lt ($timeoutSec * 1000)) {
    Start-Sleep -Milliseconds 500
    if (Test-PortOpen -p $port) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($resp -and $resp.Count -gt 0) {
                Write-Host "[Gemini Desktop Bridge] Gemini Desktop CDP is active and ready on port $port!"
                $ready = $true
                break
            }
        } catch {}
    }
}

if (-not $ready) {
    Write-Warning "[Gemini Desktop Bridge] Port $port did not respond within $timeoutSec seconds."
    exit 1
}

exit 0
