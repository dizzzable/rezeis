# ----------------------------------------------------------------------------
#  E2E orchestrator, PowerShell entry.
#
#  A thin wrapper of run-e2e.mts, which does all the work on Windows and on
#  Linux CI alike: images, stack, first admin and the cabinet's API token,
#  scenarios, diagnostics on failure, and a teardown that always runs. Keeping
#  the logic in one place is the point; this file only maps switches to flags.
#
#  Usage (from anywhere, in PowerShell):
#    powershell -File rezeis/e2e/run-e2e.ps1
#    powershell -File rezeis/e2e/run-e2e.ps1 -Scenarios core
#    powershell -File rezeis/e2e/run-e2e.ps1 -PanelImage ghcr.io/dizzzable/rezeis:v0.9.7.70 `
#                                            -CabinetImage ghcr.io/dizzzable/reiwa:v0.9.7.52 -Scenarios core
#    powershell -File rezeis/e2e/run-e2e.ps1 -KeepAlive    # leave the stack up
#
#  -Reset is accepted and does nothing: every run now starts by removing
#  whatever an earlier run of the same project left behind.
#
#  KEEP THIS FILE ASCII. It is UTF-8 with no BOM, and Windows PowerShell 5.1
#  reads a BOM-less script in the ANSI code page: the three bytes of an em
#  dash decode to three characters, the last of which is U+201D, which
#  PowerShell accepts as a string TERMINATOR inside double quotes.
# ----------------------------------------------------------------------------

param(
  [switch]$KeepAlive,
  [switch]$Reset,
  [ValidateSet('all', 'core')]
  [string]$Scenarios = 'all',
  [string]$PanelImage = '',
  [string]$CabinetImage = '',
  [string]$Project = '',
  [switch]$NoPull,
  [switch]$SaveLogs
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw 'node is not on PATH; the suite needs Node 26.' }
if ($nodeVersion -notmatch '^v26\.') { Write-Host "  warning: the suite is written for Node 26, found $nodeVersion" -ForegroundColor Yellow }

Push-Location $here
try {
  # No npm step here any more. run-e2e.mts needs nothing installed, and runs
  # `npm ci` itself when the scenario runner's packages are missing or older
  # than the lock. The `npm install` this script used to run rewrote
  # package-lock.json with LF endings on every run.
  $flags = @('run-e2e.mts', '--scenarios', $Scenarios)
  if ($PanelImage)   { $flags += @('--panel-image', $PanelImage) }
  if ($CabinetImage) { $flags += @('--cabinet-image', $CabinetImage) }
  if ($Project)      { $flags += @('--project', $Project) }
  if ($NoPull)       { $flags += '--no-pull' }
  if ($SaveLogs)     { $flags += '--save-logs' }
  if ($KeepAlive)    { $flags += '--keep-alive' }

  $ErrorActionPreference = 'Continue'
  & node @flags
  $code = $LASTEXITCODE
}
finally {
  Pop-Location
}
exit $code
