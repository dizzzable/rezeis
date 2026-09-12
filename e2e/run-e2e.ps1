# ════════════════════════════════════════════════════════════════════════════
#  E2E orchestrator
#
#  Spins up the docker-compose stack, applies Prisma migrations against the
#  fresh database, bootstraps the first admin, mints an API token and
#  injects it into reiwa, then runs the test runner.
#
#  Usage  (from repo root, in PowerShell):
#    powershell -File rezeis/e2e/run-e2e.ps1
#    powershell -File rezeis/e2e/run-e2e.ps1 -KeepAlive    # don't tear down
#    powershell -File rezeis/e2e/run-e2e.ps1 -Reset        # nuke volumes first
#
#  NO EM DASH INSIDE A DOUBLE-QUOTED STRING IN THIS FILE. It is UTF-8 with no
#  BOM, and Windows PowerShell 5.1 reads a BOM-less script as the ANSI code
#  page: the three bytes of an em dash decode to three characters, the last of
#  which is U+201D, and PowerShell accepts a curly double quote as a string
#  TERMINATOR. The string ends at the dash, the rest of the line runs on, and
#  the error surfaces as "missing the terminator" tens of lines further down.
#  Comments and single-quoted strings are safe; the box-drawing characters
#  below carry the same byte and survive only because they come in pairs.
#  Check a change with:
#    [System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e)
# ════════════════════════════════════════════════════════════════════════════

param(
  [switch]$KeepAlive,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $here 'docker-compose.e2e.yml'
$adminDir    = Resolve-Path (Join-Path $here '..\rezeis-admin')
$projectName = 'rezeis-e2e'

function Step([string]$Message) {
  Write-Host ''
  Write-Host "── $Message ──" -ForegroundColor Cyan
}

function Ensure-DockerOnline {
  Step 'Checking Docker daemon'
  docker info --format '{{.ServerVersion}}' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is not reachable. Start Docker Desktop / dockerd first.'
  }
}

function Bring-StackUp {
  if ($Reset) {
    Step 'Reset: tearing down old stack + volumes'
    # Runs of the script BEFORE reiwa moved into the compose project left a
    # standalone `reiwa-e2e-api`. It is not in the project, so `compose down`
    # neither removes it nor can drop the network it is still attached to —
    # and the reset then silently leaves the old network and its volumes.
    cmd /c "docker rm -f -v reiwa-e2e-api 2>nul"
    docker compose -p $projectName -f $composeFile down -v --remove-orphans 2>$null | Out-Null
  }
  Step 'Building images (rezeis-admin + reiwa)'
  # `docker compose build` on Docker 29+ on Windows occasionally returns
  # a non-zero exit code through the buildx layer even on a fully
  # successful build (compose-bake / metadata edge case). We swallow the
  # error and verify the produced images instead — much more robust.
  $ErrorActionPreference = 'Continue'
  & docker compose -p $projectName -f $composeFile build 2>&1 | ForEach-Object { Write-Host $_ }
  $ErrorActionPreference = 'Stop'
  $haveAdmin = (docker images -q rezeis-admin:e2e | Out-String).Trim()
  $haveReiwa = (docker images -q reiwa:e2e | Out-String).Trim()
  if (-not $haveAdmin) { throw 'rezeis-admin:e2e image was not produced' }
  if (-not $haveReiwa) { throw 'reiwa:e2e image was not produced' }
  Write-Host '  Both images present.' -ForegroundColor Green

  Step 'Starting infrastructure (db + redis x2)'
  docker compose -p $projectName -f $composeFile up -d rezeis-e2e-db rezeis-e2e-redis reiwa-e2e-redis
  if ($LASTEXITCODE -ne 0) { throw 'Failed to bring infra up' }

  Step 'Waiting for Postgres'
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    docker exec rezeis-e2e-db pg_isready -U rezeis -d rezeis 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Postgres did not become ready in time' }
}

function Apply-Migrations-FromHost {
  Step 'Applying Prisma migrations against forwarded postgres (port 15432)'
  Push-Location $adminDir
  try {
    $env:DATABASE_URL = 'postgresql://rezeis:rezeis_secret@127.0.0.1:15432/rezeis'
    # Prisma writes informational lines to stderr; under
    # `$ErrorActionPreference = 'Stop'` PowerShell promotes those to
    # `NativeCommandError` and aborts. Run via `cmd.exe /c` so stderr
    # stays a regular byte stream and the exit code is what matters.
    & cmd.exe /c "npx prisma migrate deploy 2>&1"
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { throw "prisma migrate deploy failed (exit $exit)" }
    Write-Host '  Migrations applied.' -ForegroundColor Green
  }
  finally {
    Pop-Location
  }
}

function Start-AdminAndWait {
  Step 'Starting rezeis-admin + worker'
  docker compose -p $projectName -f $composeFile up -d rezeis-e2e-admin rezeis-e2e-worker
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start admin' }

  Step 'Waiting for /api/health on rezeis-admin (max 90s)'
  $ready = $false
  for ($i = 0; $i -lt 45; $i++) {
    try {
      $r = Invoke-WebRequest -Uri 'http://localhost:18000/api/health' -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $ready) {
    docker logs rezeis-e2e-admin --tail 80
    throw 'rezeis-admin /api/health did not respond in time'
  }
  Write-Host '  rezeis-admin is up.' -ForegroundColor Green
}

function Bootstrap-AdminAndIssueToken {
  Step 'Bootstrapping first admin + minting API token'
  $authStatus = (Invoke-RestMethod -Uri 'http://localhost:18000/api/admin/auth/status').hasAdmins

  $loginBody = @{ username = 'e2eadmin'; password = 'e2eadmin-pass-9876' } | ConvertTo-Json
  if (-not $authStatus) {
    $regBody = @{ username = 'e2eadmin'; password = 'e2eadmin-pass-9876' } | ConvertTo-Json
    $reg = Invoke-RestMethod -Uri 'http://localhost:18000/api/admin/auth/register' -Method POST -Body $regBody -ContentType 'application/json'
    $bearer = $reg.accessToken
    Write-Host '  registered new admin.' -ForegroundColor Green
  } else {
    $login = Invoke-RestMethod -Uri 'http://localhost:18000/api/admin/auth/login' -Method POST -Body $loginBody -ContentType 'application/json'
    $bearer = $login.accessToken
    Write-Host '  reused existing admin.' -ForegroundColor Yellow
  }

  $headers = @{ Authorization = "Bearer $bearer" }
  $tokens = (Invoke-RestMethod -Uri 'http://localhost:18000/api/admin/api-tokens' -Headers $headers).items
  $existing = $tokens | Where-Object { $_.name -eq 'reiwa-e2e' } | Select-Object -First 1
  if ($existing) {
    # Can't recover the secret from the list — issue a fresh one and revoke the old.
    Invoke-RestMethod -Uri "http://localhost:18000/api/admin/api-tokens/$($existing.id)" -Method DELETE -Headers $headers | Out-Null
  }
  $createBody = @{ name = 'reiwa-e2e' } | ConvertTo-Json
  $created = Invoke-RestMethod -Uri 'http://localhost:18000/api/admin/api-tokens' -Method POST -Body $createBody -ContentType 'application/json' -Headers $headers
  Write-Host "  api token id=$($created.id) issued (length=$($created.token.Length))" -ForegroundColor Green
  return $created.token
}

function Start-Reiwa {
  param([string]$RezeisToken)
  Step 'Starting reiwa with the freshly-minted token'
  # The token reaches the container through compose interpolation
  # (`REZEIS_TOKEN: ${REZEIS_E2E_TOKEN:-e2e-placeholder}`) instead of a
  # hand-written `docker run`. That run was a SECOND copy of reiwa's env
  # block with nothing keeping the two in step, and it produced a container
  # OUTSIDE the compose project — so `compose down` could not remove it and
  # every teardown depended on remembering to name it separately.
  $env:REZEIS_E2E_TOKEN = $RezeisToken
  # A container left behind by a run of the older script holds the name and
  # is not ours to recreate.
  cmd /c "docker rm -f -v reiwa-e2e-api 2>nul"
  docker compose -p $projectName -f $composeFile up -d reiwa-e2e-api
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start reiwa' }

  Step 'Waiting for reiwa /api/v1/health (max 60s)'
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -Uri 'http://localhost:15000/api/v1/health' -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $ready) {
    docker logs reiwa-e2e-api --tail 80
    throw 'reiwa health did not respond in time'
  }
  Write-Host '  reiwa is up.' -ForegroundColor Green
}

# Every container this stack declares, and whether it is expected to carry a
# health probe. Kept next to the compose file it mirrors.
$ExpectedContainers = @(
  'rezeis-e2e-db',
  'rezeis-e2e-redis',
  'rezeis-e2e-admin',
  'rezeis-e2e-worker',
  'reiwa-e2e-redis',
  'reiwa-e2e-api'
)

function Assert-StackHealthy {
  # Only the admin and reiwa are reachable from the runner, so a container
  # that exits at boot is INVISIBLE to every scenario: the worker publishes
  # no port and nothing depends_on it, and both redises are only ever
  # touched through the two APIs. A missing env var there used to read as a
  # clean 15/15. This is the step that looks.
  Step 'Verifying every container is up (max 90s)'
  $deadline = (Get-Date).AddSeconds(90)
  $bad = @()
  while ($true) {
    $bad = @()
    foreach ($name in $ExpectedContainers) {
      $raw = (& cmd.exe /c "docker inspect --format ""{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"" $name 2>&1" | Out-String).Trim()
      if ($raw -notmatch '^[a-z]+\|') { $bad += "${name}: not created"; continue }
      $parts  = $raw.Split('|')
      $status = $parts[0]
      $health = $parts[1]
      if ($status -ne 'running') { $bad += "${name}: ${status}"; continue }
      if ($health -ne 'none' -and $health -ne 'healthy') { $bad += "${name}: ${health}" }
    }
    if ($bad.Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) { break }
    Start-Sleep -Seconds 3
  }
  if ($bad.Count -gt 0) {
    foreach ($name in $ExpectedContainers) {
      if (($bad -join ' ') -match [regex]::Escape($name)) {
        Write-Host "── logs: $name ──" -ForegroundColor Yellow
        cmd /c "docker logs $name --tail 40 2>&1"
      }
    }
    throw "Containers not up: $($bad -join '; ')"
  }
  Write-Host "  $($ExpectedContainers.Count)/$($ExpectedContainers.Count) containers running." -ForegroundColor Green
}

function Run-Tests {
  Step 'Installing e2e runner deps'
  Push-Location $here
  try {
    & cmd.exe /c "npm install --no-audit --no-fund --silent 2>&1"
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    Step 'Running e2e-runner.ts'
    $env:REZEIS_BASE = 'http://localhost:18000'
    $env:REIWA_BASE  = 'http://localhost:15000'
    & cmd.exe /c "npm run --silent test 2>&1"
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { throw "Test runner exited with $exit" }
  }
  finally {
    Pop-Location
  }
}

# Anything of ours still on the daemon. Every filter is anchored to a name
# this stack owns or to the compose project label, so an unrelated container
# on the same daemon is never in scope.
function Get-Stragglers {
  $left = @()
  foreach ($name in $ExpectedContainers) {
    $id = (& cmd.exe /c "docker ps -aq --filter ""name=^/?${name}$"" 2>nul" | Out-String).Trim()
    if ($id) { $left += "container $name" }
  }
  $net = (& cmd.exe /c "docker network ls -q --filter ""name=^rezeis-e2e$"" 2>nul" | Out-String).Trim()
  if ($net) { $left += 'network rezeis-e2e' }
  # The database keeps its state in an ANONYMOUS volume (postgres:17-alpine
  # declares one). `down` alone leaves it; only `down -v` takes it, and the
  # next run would otherwise find an admin already bootstrapped.
  $vols = (& cmd.exe /c "docker volume ls -q --filter ""label=com.docker.compose.project=$projectName"" 2>nul" | Out-String).Trim()
  if ($vols) { $left += "volume(s) $($vols -replace '\r?\n', ' ')" }
  return ,$left
}

function Tear-Down {
  if ($KeepAlive) {
    Write-Host ''
    Write-Host '── KeepAlive: leaving stack running ──' -ForegroundColor Yellow
    Write-Host '   stop manually with:' -ForegroundColor Yellow
    Write-Host "   docker compose -p $projectName -f $composeFile down -v" -ForegroundColor Yellow
    return
  }
  Step 'Tearing down stack'
  # Legacy: reiwa used to be started outside the project by `docker run`.
  cmd /c "docker rm -f -v reiwa-e2e-api 2>nul"
  cmd /c "docker compose -p $projectName -f `"$composeFile`" down -v --remove-orphans 2>nul"

  # The exit code of that line was discarded along with its output, so a
  # teardown that removed NOTHING printed the same thing as one that removed
  # everything — and the next run inherited a database with an admin already
  # in it. Assert the daemon instead of trusting the command.
  $left = Get-Stragglers
  if ($left.Count -gt 0) {
    Write-Host "  still present: $($left -join ', '), retrying" -ForegroundColor Yellow
    cmd /c "docker compose -p $projectName -f `"$composeFile`" down -v --remove-orphans 2>&1"
    $left = Get-Stragglers
  }
  if ($left.Count -gt 0) {
    $script:teardownIncomplete = $true
    Write-Host ''
    Write-Host '  TEARDOWN INCOMPLETE — these survived the run:' -ForegroundColor Red
    foreach ($item in $left) { Write-Host "    $item" -ForegroundColor Red }
    Write-Host "  remove by hand: docker compose -p $projectName -f ""$composeFile"" down -v" -ForegroundColor Red
    return
  }
  Write-Host '  Nothing of this stack is left on the daemon.' -ForegroundColor Green
}

# ── Main ───────────────────────────────────────────────────────────────────

$script:teardownIncomplete = $false
$runFailed = $false

try {
  Ensure-DockerOnline
  Bring-StackUp
  Apply-Migrations-FromHost
  Start-AdminAndWait
  $token = Bootstrap-AdminAndIssueToken
  Start-Reiwa -RezeisToken $token
  Assert-StackHealthy
  Run-Tests
  Write-Host ''
  Write-Host '════════════════════════════════════════════════════' -ForegroundColor Green
  Write-Host '  ALL E2E SCENARIOS PASSED' -ForegroundColor Green
  Write-Host '════════════════════════════════════════════════════' -ForegroundColor Green
}
catch {
  Write-Host ''
  Write-Host '════════════════════════════════════════════════════' -ForegroundColor Red
  Write-Host '  E2E FAILED' -ForegroundColor Red
  Write-Host "  $_" -ForegroundColor Red
  Write-Host '════════════════════════════════════════════════════' -ForegroundColor Red
  $runFailed = $true
}
finally {
  # Once. The old shape called Tear-Down from the catch AND from here, so a
  # failed run tore the stack down twice and the second `compose down` — a
  # no-op against an empty project — was the one whose output a reader saw.
  Tear-Down
}

# A stack that outlives a failed run poisons the next one: the database
# already has an admin, so `hasAdmins` takes the other branch. Surviving
# containers are a failure in their own right, not a footnote.
if ($runFailed -or $script:teardownIncomplete) { exit 1 }
exit 0
