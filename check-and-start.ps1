# PowerShell script to check TypeScript and start the application

Write-Host "=== Rezeis Admin Backend Check & Start ===" -ForegroundColor Cyan

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
}

# Clear TypeScript cache
Write-Host "Clearing TypeScript cache..." -ForegroundColor Yellow
Remove-Item -Path "*.tsbuildinfo" -ErrorAction SilentlyContinue

# Check TypeScript compilation
Write-Host "Checking TypeScript compilation..." -ForegroundColor Yellow
$errors = npx tsc --noEmit 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "TypeScript errors found:" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    
    Write-Host "`nAttempting to fix common issues..." -ForegroundColor Yellow
    
    # Check for missing imports
    $importErrors = $errors | Select-String "Cannot find module"
    if ($importErrors) {
        Write-Host "Found missing module imports. Please ensure all dependencies are installed:" -ForegroundColor Yellow
        Write-Host "  npm install nest-winston winston @willsoto/nestjs-prometheus prom-client @nestjs/throttler @nestjs/terminus" -ForegroundColor Cyan
    }
    
    exit 1
}

Write-Host "TypeScript check passed!" -ForegroundColor Green

# Start the application
Write-Host "Starting application..." -ForegroundColor Green
npm run start:dev
