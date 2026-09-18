$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\update-data.mjs"
$nodePath = (Get-Command node).Source
$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument "`"$scriptPath`"" `
  -WorkingDirectory $projectRoot
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At "07:00"),
  (New-ScheduledTaskTrigger -Daily -At "19:00")
)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName "Market Conflict Atlas Data Refresh" `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Description "Refresh market, commodity, index, and Federal Reserve data every 12 hours." `
  -Force | Out-Null

Write-Host "Installed 12-hour data update task. Runs daily at 07:00 and 19:00 local time."
