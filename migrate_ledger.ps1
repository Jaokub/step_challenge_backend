# One-shot: baseline existing DB + create points_ledger migration + backfill
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File .\migrate_ledger.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ── Step 1: Baseline (only if no migration history yet) ──────────────────────
if (-not (Test-Path "prisma\migrations\0_init\migration.sql")) {
    Write-Host "[1/3] Creating baseline migration from live database..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path "prisma\migrations\0_init" | Out-Null

    # Introspects the LIVE DB (datasource url), not the schema file
    npx prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script -o prisma\migrations\0_init\migration.sql
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "prisma\migrations\0_init\migration.sql") -or (Get-Item "prisma\migrations\0_init\migration.sql").Length -eq 0) {
        # Older prisma without -o: fall back to piping (utf8)
        npx prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script |
            Out-File -Encoding utf8 prisma\migrations\0_init\migration.sql
    }

    # Safety: baseline must NOT contain the new table (it should reflect the DB as-is)
    if (Select-String -Path "prisma\migrations\0_init\migration.sql" -Pattern "points_ledger" -Quiet) {
        Remove-Item -Recurse -Force "prisma\migrations\0_init"
        throw "Baseline unexpectedly contains points_ledger - it diffed against the schema file instead of the DB. Aborted, nothing changed."
    }

    Write-Host "[1/3] Marking baseline as already applied..." -ForegroundColor Cyan
    npx prisma migrate resolve --applied 0_init
    if ($LASTEXITCODE -ne 0) { throw "migrate resolve failed" }
} else {
    Write-Host "[1/3] Baseline already exists, skipping." -ForegroundColor DarkGray
}

# ── Step 2: Create + apply the points_ledger migration ───────────────────────
Write-Host "[2/3] Running migrate dev (add_points_ledger)..." -ForegroundColor Cyan
npx prisma migrate dev --name add_points_ledger
if ($LASTEXITCODE -ne 0) { throw "migrate dev failed" }

# ── Step 3: Backfill the ledger from existing data (idempotent) ──────────────
Write-Host "[3/3] Backfilling points ledger..." -ForegroundColor Cyan
node scripts/backfill_points_ledger.js
if ($LASTEXITCODE -ne 0) { throw "backfill failed" }

Write-Host "Done. Ledger is live and reconciled with existing totalPoints." -ForegroundColor Green
