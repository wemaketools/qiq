<#
.SYNOPSIS
    Run QuoteIQ locally (TypeScript / Vercel-functions / Supabase stack), and
    optionally reset and reseed the local database.

.DESCRIPTION
    One-command local runner for the migrated stack. By default it makes sure the
    local Supabase Docker stack is up, then starts the app (API function runner +
    SPA dev server) in the foreground. Press Ctrl+C to stop the app.

    The app is two processes started by 'npm run dev':
      - API function runner  : http://127.0.0.1:3001/api/v1
      - SPA (Vite) dev server: http://localhost:5173  (proxies /api/v1 to the runner)
      - Supabase Studio      : http://127.0.0.1:54323

    The Supabase stack is a Docker stack with its own lifecycle; this script starts
    it via 'npm run supabase:start' (a fast no-op if it is already running) and never
    stops it automatically. Use -StopDb to stop it.

    This replaces the pre-migration run.ps1, which brought up the retired
    .NET / docker-compose / Keycloak / Vault / MinIO / Liquibase stack.

.PARAMETER Reset
    Reset the local database: drop and re-apply every migration from empty and run
    the baseline seed (npm run supabase:reset). Destructive to LOCAL data only.

.PARAMETER Demo
    Load the layer-2 demo dataset after any reset (npm run db:seed:demo): two tenants,
    demo users with known passwords, brokers, leads, quotes, alerts and history that
    light up every dashboard, alert type and report.

.PARAMETER DbOnly
    Do the database work (start stack / reset / demo) but do NOT start the app.

.PARAMETER StopDb
    Stop the local Supabase stack (npm run supabase:stop) and exit.

.EXAMPLE
    .\run.ps1
    Ensure Supabase is up and start the app.

.EXAMPLE
    .\run.ps1 -Reset -Demo
    Reset the database, load the demo dataset, then start the app.

.EXAMPLE
    .\run.ps1 -Reset -Demo -DbOnly
    Reset and load the demo dataset without starting the app.

.EXAMPLE
    .\run.ps1 -StopDb
    Stop the local Supabase stack.
#>
[CmdletBinding()]
param(
    [switch] $Reset,
    [switch] $Demo,
    [switch] $DbOnly,
    [switch] $StopDb
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Invoke-Npm {
    param(
        [Parameter(Mandatory)] [string[]] $NpmArgs,
        [Parameter(Mandatory)] [string]   $What
    )
    Write-Host ''
    Write-Host (">> {0}  (npm {1})" -f $What, ($NpmArgs -join ' ')) -ForegroundColor Cyan
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("{0} failed (npm {1}) with exit code {2}." -f $What, ($NpmArgs -join ' '), $LASTEXITCODE)
    }
}

Write-Host 'QuoteIQ local runner (Node + Supabase)' -ForegroundColor Green

# --- Stop-only shortcut -------------------------------------------------------
if ($StopDb) {
    Invoke-Npm -NpmArgs @('run', 'supabase:stop') -What 'Stopping the local Supabase stack'
    Write-Host 'Supabase stack stopped.' -ForegroundColor Green
    return
}

# --- Preflight: Docker must be running (the Supabase stack runs on it) --------
try {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw 'docker not ready' }
} catch {
    Write-Host 'Docker does not appear to be running. Start Docker Desktop first - the local Supabase stack needs it.' -ForegroundColor Red
    exit 1
}

# --- Ensure the Supabase stack is up (idempotent) -----------------------------
Invoke-Npm -NpmArgs @('run', 'supabase:start') -What 'Ensuring the local Supabase stack is up'

# --- Optional reset -----------------------------------------------------------
if ($Reset) {
    Invoke-Npm -NpmArgs @('run', 'supabase:reset') -What 'Resetting the database (migrations + baseline seed)'
}

# --- Optional demo dataset ----------------------------------------------------
if ($Demo) {
    Invoke-Npm -NpmArgs @('run', 'db:seed:demo') -What 'Loading the demo dataset'
}

# --- Start the app, unless -DbOnly --------------------------------------------
if ($DbOnly) {
    Write-Host ''
    Write-Host 'Database is ready. App not started (-DbOnly).' -ForegroundColor Green
    Write-Host '  Supabase Studio: http://127.0.0.1:54323' -ForegroundColor Gray
    return
}

Write-Host ''
Write-Host 'Starting the app. Press Ctrl+C to stop.' -ForegroundColor Green
Write-Host '  SPA (open this): http://localhost:5173' -ForegroundColor Gray
Write-Host '  API runner:      http://127.0.0.1:3001/api/v1' -ForegroundColor Gray
Write-Host '  Supabase Studio: http://127.0.0.1:54323' -ForegroundColor Gray
Write-Host ''
& npm run dev
if ($LASTEXITCODE -ne 0) {
    throw ("'npm run dev' exited with code {0}." -f $LASTEXITCODE)
}
