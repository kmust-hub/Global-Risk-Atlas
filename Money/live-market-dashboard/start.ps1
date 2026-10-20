$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8787
$pidFile = Join-Path $root 'server.pid'

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Start-Process "http://127.0.0.1:$port"
    Write-Host "服务已在运行：http://127.0.0.1:$port"
    exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw '未找到 Node.js，请先安装 Node.js 18 或更高版本。'
}

$process = Start-Process -FilePath $node `
    -ArgumentList 'server.mjs' `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput (Join-Path $root 'server.log') `
    -RedirectStandardError (Join-Path $root 'server.err.log')

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:$port"
Write-Host "已启动：http://127.0.0.1:$port"
Write-Host "日志：$root\server.log"
