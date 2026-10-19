<#
  start | stop | restart | status for the autostart Scheduled Task.
  Usage: powershell -ExecutionPolicy Bypass -File agent-control.ps1 status
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'restart', 'status')][string]$Command,
  [string]$TaskName = 'DocumentScannerAgent'
)
$ErrorActionPreference = 'Stop'
switch ($Command) {
  'start' { Start-ScheduledTask -TaskName $TaskName }
  'stop' { Stop-ScheduledTask -TaskName $TaskName }
  'restart' { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 1; Start-ScheduledTask -TaskName $TaskName }
  'status' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host 'Not installed.'; exit 3 }
    Write-Host "Task state: $($t.State)"
    try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47115/v1/health' -TimeoutSec 3).Content } catch { Write-Host 'Agent not responding on 127.0.0.1:47115 (custom port? use: node bin\scanner-agent.js status).' }
  }
}
