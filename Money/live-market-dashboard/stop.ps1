$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
    $process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $serverPid }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host '可视化服务已停止。'
} else {
    Write-Host '没有找到运行中的服务记录。'
}
