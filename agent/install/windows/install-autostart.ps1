<#
  Registers a per-user Scheduled Task that starts the Document Scanner Agent
  at logon, hidden, without administrator rights. Asks for confirmation
  unless -Yes is passed. Undo with uninstall-autostart.ps1.

  Usage:
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 [-NodePath C:\...\node.exe] [-Yes]
#>
param(
  [string]$NodePath = '',
  [string]$TaskName = 'DocumentScannerAgent',
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$entry = Join-Path $agentDir 'bin\scanner-agent.js'
if (-not (Test-Path $entry)) { throw "Agent entry point not found: $entry" }
if (-not $NodePath) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node.exe not found in PATH; pass -NodePath.' }
  $NodePath = $cmd.Source
}
$launcher = Join-Path $PSScriptRoot 'start-hidden.ps1'

Write-Host "This will register a Scheduled Task '$TaskName' for user $env:USERNAME that runs:"
Write-Host "  $NodePath `"$entry`" run"
Write-Host 'at every logon (hidden window, normal user rights).'
if (-not $Yes) {
  $answer = Read-Host 'Continue? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Aborted.'; exit 1 }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -NodePath `"{1}`" -Entry `"{2}`"" -f $launcher, $NodePath, $entry) -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Document Scanner Agent (local scanner bridge for the web application)' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started. Check with: node `"$entry`" status"
