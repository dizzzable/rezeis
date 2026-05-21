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
  $env:REZEIS_TOKEN_OVERRIDE = $RezeisToken
  # Recreate the reiwa container with the new env var. The compose file
  # has its own `reiwa-e2e-api` definition which we ignore — we run a
  # standalone container instead so the env var can be substituted at
  # invocation time without re-templating compose.
  cmd /c "docker rm -f reiwa-e2e-api 2>nul"
  & docker run -d `
    --name reiwa-e2e-api `
    --hostname reiwa-e2e-api `
    --network rezeis-e2e `
    -p 127.0.0.1:15000:5000 `
    -e NODE_ENV=production `
    -e PORT=5000 `
    -e REZEIS_HOST=rezeis-e2e-admin `
    -e REZEIS_PORT=8000 `
    -e REZEIS_TOKEN=$RezeisToken `
    -e REDIS_URL=redis://reiwa-e2e-redis:6379 `
    -e REIWA_COOKIE_SECRET=e2e-cookie-secret-please-change-me `
    -e REIWA_PUBLIC_WEB_URL=http://localhost:5500 `
    reiwa:e2e | Out-Null
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

function Tear-Down {
  if ($KeepAlive) {
    Write-Host ''
    Write-Host '── KeepAlive: leaving stack running ──' -ForegroundColor Yellow
    Write-Host '   stop manually with:' -ForegroundColor Yellow
    Write-Host "   docker compose -p $projectName -f $composeFile down -v" -ForegroundColor Yellow
    return
  }
  Step 'Tearing down stack'
  cmd /c "docker rm -f reiwa-e2e-api 2>nul"
  cmd /c "docker compose -p $projectName -f `"$composeFile`" down -v --remove-orphans 2>nul"
}

# ── Main ───────────────────────────────────────────────────────────────────

try {
  Ensure-DockerOnline
  Bring-StackUp
  Apply-Migrations-FromHost
  Start-AdminAndWait
  $token = Bootstrap-AdminAndIssueToken
  Start-Reiwa -RezeisToken $token
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
  if (-not $KeepAlive) { Tear-Down }
  exit 1
}
finally {
  Tear-Down
}
