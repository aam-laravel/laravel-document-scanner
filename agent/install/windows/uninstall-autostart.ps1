<#
  Stops the agent and removes the per-user Scheduled Task. Does not delete the
  config file or logs unless -RemoveData is passed.
#>
param(
  [string]$TaskName = 'DocumentScannerAgent',
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' not found."
}
if ($RemoveData) {
  foreach ($p in @((Join-Path $env:APPDATA 'DocumentScannerAgent'), (Join-Path $env:LOCALAPPDATA 'DocumentScannerAgent'))) {
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "Removed $p" }
  }
}
