# ════════════════════════════════════════════════════════════════════════════
#  rezeis-admin DEMO orchestrator
#
#  Spins up the full demo stack (postgres + valkey x2 + admin + worker + web
#  + reiwa) so an operator can click through the panel in the browser.
#
#  Usage:
#    powershell -File rezeis/demo/run-demo.ps1            # full clean start
#    powershell -File rezeis/demo/run-demo.ps1 -Reset     # nuke volumes first
#    powershell -File rezeis/demo/run-demo.ps1 -Stop      # tear down only
#
#  Browser entry-points after start:
#    Admin UI       http://localhost:3500
#    Admin API      http://localhost:3100/api
#    API Swagger    http://localhost:3100/api/docs
#    Reiwa BFF      http://localhost:3200/api/v1/health
#
#  Bootstrap admin (created on first visit to the UI):
#    username: demoadmin
#    password: demoadmin-pass-2026
# ════════════════════════════════════════════════════════════════════════════

param(
  [switch]$Reset,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$here        = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $here 'docker-compose.demo.yml'
$adminDir    = Resolve-Path (Join-Path $here '..\rezeis-admin')
$projectName = 'rezeis-demo'

$bootstrapLogin    = 'demoadmin'
$bootstrapPassword = 'demoadmin-pass-2026'

function Step([string]$Message) {
  Write-Host ''
  Write-Host "── $Message ──" -ForegroundColor Cyan
}

function Tear-Down {
  Step 'Tearing down demo stack'
  cmd /c "docker rm -f reiwa-demo-api 2>nul"
  cmd /c "docker compose -p $projectName -f `"$composeFile`" down -v --remove-orphans 2>nul"
  cmd /c "docker network rm rezeis-demo 2>nul"
  Write-Host '  Stack stopped.' -ForegroundColor Green
}

if ($Stop) {
  Tear-Down
  exit 0
}

if ($Reset) {
  Tear-Down
}

# ── 1. Build images ────────────────────────────────────────────────────────

Step 'Checking Docker'
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker daemon is not reachable. Start Docker Desktop and retry.' -ForegroundColor Red
  exit 1
}

Step 'Building images (admin + worker + web + reiwa)'
$ErrorActionPreference = 'Continue'
& docker compose -p $projectName -f $composeFile build 2>&1 | ForEach-Object { Write-Host $_ }
$ErrorActionPreference = 'Stop'

$haveAdmin = (docker images -q rezeis-admin:demo | Out-String).Trim()
$haveWeb   = (docker images -q rezeis-admin-web:demo | Out-String).Trim()
$haveReiwa = (docker images -q reiwa:demo | Out-String).Trim()
if (-not $haveAdmin) { throw 'rezeis-admin:demo image was not produced' }
if (-not $haveWeb)   { throw 'rezeis-admin-web:demo image was not produced' }
if (-not $haveReiwa) { throw 'reiwa:demo image was not produced' }
Write-Host '  All three images present.' -ForegroundColor Green

# ── 2. Infra ────────────────────────────────────────────────────────────────

Step 'Starting infra (postgres + valkey x2)'
cmd /c "docker compose -p $projectName -f `"$composeFile`" up -d rezeis-demo-db rezeis-demo-redis reiwa-demo-redis 2>&1"

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  cmd /c "docker exec rezeis-demo-db pg_isready -U rezeis -d rezeis 2>nul" | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Postgres did not become ready in time' }
Write-Host '  Infra ready.' -ForegroundColor Green

# ── 3. Migrate ─────────────────────────────────────────────────────────────

Step 'Applying Prisma migrations (host-side, port 35432)'
Push-Location $adminDir
try {
  $env:DATABASE_URL = 'postgresql://rezeis:rezeis_demo_secret@127.0.0.1:35432/rezeis'
  & cmd.exe /c "npx prisma migrate deploy 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed (exit $LASTEXITCODE)" }
  Write-Host '  Migrations applied.' -ForegroundColor Green
}
finally {
  Pop-Location
}

# ── 4. Admin + worker + web ────────────────────────────────────────────────

Step 'Starting rezeis-admin + worker + web'
cmd /c "docker compose -p $projectName -f `"$composeFile`" up -d rezeis-demo-admin rezeis-demo-worker rezeis-demo-web 2>&1"

Step 'Waiting for admin /api/health (max 90s)'
$ready = $false
for ($i = 0; $i -lt 45; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3100/api/health' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) {
  cmd /c "docker logs rezeis-demo-admin --tail 50 2>&1"
  throw 'rezeis-admin /api/health did not respond in time'
}
Write-Host '  rezeis-admin healthy.' -ForegroundColor Green

# ── 5. Bootstrap admin + mint api token for reiwa ──────────────────────────

Step 'Bootstrapping demo admin + minting reiwa token'
$status = (Invoke-RestMethod -Uri 'http://localhost:3100/api/admin/auth/status').hasAdmins
if (-not $status) {
  $regBody = @{ username = $bootstrapLogin; password = $bootstrapPassword } | ConvertTo-Json
  $reg     = Invoke-RestMethod -Uri 'http://localhost:3100/api/admin/auth/register' -Method POST -Body $regBody -ContentType 'application/json'
  $bearer  = $reg.accessToken
  Write-Host "  Created admin: $bootstrapLogin" -ForegroundColor Green
} else {
  $loginBody = @{ username = $bootstrapLogin; password = $bootstrapPassword } | ConvertTo-Json
  try {
    $login  = Invoke-RestMethod -Uri 'http://localhost:3100/api/admin/auth/login' -Method POST -Body $loginBody -ContentType 'application/json'
    $bearer = $login.accessToken
    Write-Host "  Reused existing admin: $bootstrapLogin" -ForegroundColor Yellow
  } catch {
    Write-Host '  An admin already exists in this volume but with a different password.' -ForegroundColor Yellow
    Write-Host '  Re-run with `-Reset` to wipe the demo database, or sign in with your own credentials.' -ForegroundColor Yellow
    $bearer = $null
  }
}

if ($bearer) {
  $headers = @{ Authorization = "Bearer $bearer" }
  $existing = (Invoke-RestMethod -Uri 'http://localhost:3100/api/admin/api-tokens' -Headers $headers).items | Where-Object { $_.name -eq 'reiwa-demo' } | Select-Object -First 1
  if ($existing) {
    Invoke-RestMethod -Uri "http://localhost:3100/api/admin/api-tokens/$($existing.id)" -Method DELETE -Headers $headers | Out-Null
  }
  $createBody = @{ name = 'reiwa-demo' } | ConvertTo-Json
  $created    = Invoke-RestMethod -Uri 'http://localhost:3100/api/admin/api-tokens' -Method POST -Body $createBody -ContentType 'application/json' -Headers $headers
  $rezeisToken = $created.token
  Write-Host '  reiwa API token issued.' -ForegroundColor Green
} else {
  $rezeisToken = 'demo-placeholder'
}

# ── 6. Reiwa ───────────────────────────────────────────────────────────────

Step 'Starting reiwa'
cmd /c "docker rm -f reiwa-demo-api 2>nul"
& docker run -d `
  --name reiwa-demo-api `
  --hostname reiwa-demo-api `
  --network rezeis-demo `
  -p 127.0.0.1:3200:5000 `
  -e NODE_ENV=production `
  -e PORT=5000 `
  -e REZEIS_HOST=rezeis-demo-admin `
  -e REZEIS_PORT=8000 `
  -e REZEIS_TOKEN=$rezeisToken `
  -e REDIS_URL=redis://reiwa-demo-redis:6379 `
  -e REIWA_COOKIE_SECRET=demo-cookie-secret-please-change-me `
  -e REIWA_PUBLIC_WEB_URL=http://localhost:3500 `
  reiwa:demo | Out-Null

Step 'Waiting for reiwa /api/v1/health (max 60s)'
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3200/api/v1/health' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) {
  cmd /c "docker logs reiwa-demo-api --tail 30 2>&1"
  Write-Host '  reiwa did not become healthy — admin still works without it.' -ForegroundColor Yellow
} else {
  Write-Host '  reiwa healthy.' -ForegroundColor Green
}

# ── 7. Print access banner ─────────────────────────────────────────────────

Write-Host ''
Write-Host '════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host '  DEMO STACK READY' -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host '  Admin UI         http://localhost:3500' -ForegroundColor White
Write-Host '  Admin API        http://localhost:3100/api' -ForegroundColor White
Write-Host '  API Swagger      http://localhost:3100/api/docs' -ForegroundColor White
Write-Host '  Reiwa BFF        http://localhost:3200/api/v1/health' -ForegroundColor White
Write-Host ''
Write-Host '  Login:' -ForegroundColor White
Write-Host "    Username: $bootstrapLogin" -ForegroundColor Yellow
Write-Host "    Password: $bootstrapPassword" -ForegroundColor Yellow
Write-Host ''
Write-Host '  Stop with:' -ForegroundColor White
Write-Host '    powershell -File rezeis/demo/run-demo.ps1 -Stop' -ForegroundColor DarkGray
Write-Host ''
