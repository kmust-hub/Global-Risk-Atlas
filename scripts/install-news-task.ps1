$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\update-news.mjs"
$nodePath = (Get-Command node).Source
$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument "`"$scriptPath`"" `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).Date.AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName "Market Conflict Atlas News Refresh" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Refresh market-moving news every 15 minutes." `
  -Force | Out-Null

Write-Host "Installed news refresh task. It runs every 15 minutes."

