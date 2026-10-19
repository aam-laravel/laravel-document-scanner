# Launched by the Scheduled Task; runs the agent in the foreground of this hidden
# PowerShell host so Task Scheduler can track and restart it.
param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$Entry
)
& $NodePath $Entry run
exit $LASTEXITCODE
