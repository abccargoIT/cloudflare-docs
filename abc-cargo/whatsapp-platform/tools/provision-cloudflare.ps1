<#
.SYNOPSIS
	Creates the Cloudflare account resources ABC Cargo Engage needs, in the
	order a deployment requires them.

.DESCRIPTION
	This script CHANGES the ABC Cargo Cloudflare account. It is a live change
	and requires the Head of IT's written approval before it is run. Read
	docs/deployment-runbook.md first.

	It does NOT deploy the Worker, does NOT set any secret, and does NOT touch
	Meta, Freshworks or any live ABC Cargo system. No customer can be messaged
	as a result of running it. Deployment is a separate, later decision.

	What it does, in order:
	  1. Confirms wrangler is installed and signed in, and shows which account.
	  2. Creates the D1 database  abc-whatsapp        (skipped if it exists)
	  3. Writes the new database id into wrangler.jsonc, keeping a backup
	  4. Creates the R2 bucket    abc-whatsapp-media  (skipped if it exists)
	  5. Creates the queues       abc-whatsapp-webhooks and its dead-letter
	  6. Applies the D1 migrations to the remote database
	  7. Re-reads everything and reports what now exists

	Safe to run more than once. Every step checks for the resource first and
	skips it rather than failing, so an interrupted run can simply be repeated.

	Compatible with Windows PowerShell 5.1.

.PARAMETER WhatIf
	Show what would be done, change nothing. Run this first.

.PARAMETER SkipMigrations
	Create the resources but do not apply the database schema.

.EXAMPLE
	.\tools\provision-cloudflare.ps1 -WhatIf

.EXAMPLE
	.\tools\provision-cloudflare.ps1

.NOTES
	Rollback is in docs/deployment-runbook.md. In short: the queues, bucket and
	database can each be deleted from the Cloudflare dashboard, and
	wrangler.jsonc restored from the .bak file this script writes.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
	[switch]$SkipMigrations
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WranglerConfig = Join-Path $ProjectRoot "wrangler.jsonc"

$DatabaseName = "abc-whatsapp"
$BucketName = "abc-whatsapp-media"
$QueueName = "abc-whatsapp-webhooks"
$DeadLetterName = "abc-whatsapp-webhooks-dlq"

function Write-Step {
	param([string]$Message)
	Write-Host ""
	Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
	param([string]$Message)
	Write-Host "    OK   $Message" -ForegroundColor Green
}

function Write-Skip {
	param([string]$Message)
	Write-Host "    --   $Message" -ForegroundColor DarkGray
}

function Write-Warn {
	param([string]$Message)
	Write-Host "    !    $Message" -ForegroundColor Yellow
}

# Runs wrangler and returns its combined output as a single string. Wrangler
# writes some ordinary progress to stderr, so stderr is folded in rather than
# treated as failure; the exit code is what decides.
function Invoke-Wrangler {
	param(
		[string[]]$Arguments,
		[switch]$AllowFailure
	)
	Push-Location $ProjectRoot
	try {
		$output = & npx wrangler @Arguments 2>&1 | Out-String
		$code = $LASTEXITCODE
	} finally {
		Pop-Location
	}
	if ($code -ne 0 -and -not $AllowFailure) {
		Write-Host $output
		throw "wrangler $($Arguments -join ' ') failed with exit code $code."
	}
	return [pscustomobject]@{ Output = $output; ExitCode = $code }
}

Write-Host ""
Write-Host "ABC Cargo Engage - Cloudflare provisioning" -ForegroundColor White
Write-Host "This CHANGES the Cloudflare account. It does not deploy, does not" -ForegroundColor White
Write-Host "set secrets, and cannot reach Meta or any live ABC Cargo system." -ForegroundColor White

# ---------------------------------------------------------------- 1. identity

Write-Step "Checking wrangler and the signed-in account"

if (-not (Test-Path $WranglerConfig)) {
	throw "wrangler.jsonc not found at $WranglerConfig. Run this from the project."
}

$who = Invoke-Wrangler -Arguments @("whoami") -AllowFailure
if ($who.ExitCode -ne 0 -or $who.Output -match "not authenticated") {
	Write-Host $who.Output
	throw "Not signed in. Run 'npx wrangler login' first, then run this again."
}
Write-Host $who.Output

Write-Warn "Confirm above that this is the ABC Cargo account, NOT a personal one."
if (-not $PSCmdlet.ShouldProcess("the account shown above", "create D1, R2 and queue resources")) {
	Write-Host ""
	Write-Host "WhatIf: nothing was changed." -ForegroundColor Yellow
	return
}

# --------------------------------------------------------------------- 2. D1

Write-Step "D1 database '$DatabaseName'"

$existing = Invoke-Wrangler -Arguments @("d1", "list", "--json") -AllowFailure
$databaseId = $null
if ($existing.ExitCode -eq 0) {
	try {
		$databases = $existing.Output | ConvertFrom-Json
		foreach ($database in $databases) {
			if ($database.name -eq $DatabaseName) { $databaseId = $database.uuid }
		}
	} catch {
		Write-Warn "Could not read the database list as JSON; continuing."
	}
}

if ($databaseId) {
	Write-Skip "Already exists ($databaseId)"
} else {
	$created = Invoke-Wrangler -Arguments @("d1", "create", $DatabaseName)
	Write-Host $created.Output
	$match = [regex]::Match($created.Output, "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
	if (-not $match.Success) {
		throw "Database created, but its id could not be read from the output. Copy it from the Cloudflare dashboard into wrangler.jsonc by hand."
	}
	$databaseId = $match.Value
	Write-Ok "Created ($databaseId)"
}

# ------------------------------------------------- 3. write the id into config

Write-Step "Recording the database id in wrangler.jsonc"

$config = Get-Content -Path $WranglerConfig -Raw
if ($config -match [regex]::Escape($databaseId)) {
	Write-Skip "Already recorded"
} elseif ($config -match "REPLACE_AFTER_D1_CREATE") {
	$backup = "$WranglerConfig.bak"
	Set-Content -Path $backup -Value $config -NoNewline -Encoding UTF8
	$updated = $config -replace "REPLACE_AFTER_D1_CREATE", $databaseId
	Set-Content -Path $WranglerConfig -Value $updated -NoNewline -Encoding UTF8
	Write-Ok "Written. Previous file kept as wrangler.jsonc.bak"
	Write-Warn "Commit this change: the id is configuration, not a secret."
} else {
	Write-Warn "A different database id is already in wrangler.jsonc. Leaving it alone."
	Write-Warn "Expected to find $databaseId. Check which database is correct before deploying."
}

# --------------------------------------------------------------------- 4. R2

Write-Step "R2 bucket '$BucketName'"

$buckets = Invoke-Wrangler -Arguments @("r2", "bucket", "list") -AllowFailure
if ($buckets.ExitCode -ne 0) {
	Write-Host $buckets.Output
	Write-Warn "R2 may not be enabled on this account."
	Write-Warn "Enable it once in the dashboard under R2, then run this script again."
	throw "Cannot continue without R2."
}

if ($buckets.Output -match [regex]::Escape($BucketName)) {
	Write-Skip "Already exists"
} else {
	$null = Invoke-Wrangler -Arguments @("r2", "bucket", "create", $BucketName)
	Write-Ok "Created"
}

# ------------------------------------------------------------------ 5. queues

Write-Step "Queues '$QueueName' and '$DeadLetterName'"

$queues = Invoke-Wrangler -Arguments @("queues", "list") -AllowFailure
$queueOutput = $queues.Output

foreach ($queue in @($QueueName, $DeadLetterName)) {
	if ($queues.ExitCode -eq 0 -and $queueOutput -match [regex]::Escape($queue)) {
		Write-Skip "$queue already exists"
	} else {
		$result = Invoke-Wrangler -Arguments @("queues", "create", $queue) -AllowFailure
		if ($result.ExitCode -ne 0) {
			if ($result.Output -match "already exists") {
				Write-Skip "$queue already exists"
			} else {
				Write-Host $result.Output
				throw "Could not create queue $queue."
			}
		} else {
			Write-Ok "$queue created"
		}
	}
}

# -------------------------------------------------------------- 6. migrations

if ($SkipMigrations) {
	Write-Step "Database schema"
	Write-Skip "Skipped at your request (-SkipMigrations)"
} else {
	Write-Step "Applying the database schema to the remote database"
	$migrated = Invoke-Wrangler -Arguments @("d1", "migrations", "apply", $DatabaseName, "--remote")
	Write-Host $migrated.Output
	Write-Ok "Schema applied"
}

# ------------------------------------------------------------- 7. verification

Write-Step "Verifying what now exists"

$verifyD1 = Invoke-Wrangler -Arguments @("d1", "list") -AllowFailure
$verifyR2 = Invoke-Wrangler -Arguments @("r2", "bucket", "list") -AllowFailure
$verifyQ = Invoke-Wrangler -Arguments @("queues", "list") -AllowFailure

$d1Ok = ($verifyD1.ExitCode -eq 0 -and $verifyD1.Output -match [regex]::Escape($DatabaseName))
$r2Ok = ($verifyR2.ExitCode -eq 0 -and $verifyR2.Output -match [regex]::Escape($BucketName))
$qOk = ($verifyQ.ExitCode -eq 0 -and $verifyQ.Output -match [regex]::Escape($QueueName))
$dlqOk = ($verifyQ.ExitCode -eq 0 -and $verifyQ.Output -match [regex]::Escape($DeadLetterName))

Write-Host ""
Write-Host ("  D1 database {0,-28} {1}" -f $DatabaseName, $(if ($d1Ok) { "present" } else { "MISSING" }))
Write-Host ("  R2 bucket   {0,-28} {1}" -f $BucketName, $(if ($r2Ok) { "present" } else { "MISSING" }))
Write-Host ("  Queue       {0,-28} {1}" -f $QueueName, $(if ($qOk) { "present" } else { "MISSING" }))
Write-Host ("  Queue       {0,-28} {1}" -f $DeadLetterName, $(if ($dlqOk) { "present" } else { "MISSING" }))

if ($d1Ok -and $r2Ok -and $qOk -and $dlqOk) {
	Write-Host ""
	Write-Host "All resources are in place." -ForegroundColor Green
	Write-Host ""
	Write-Host "NOT done by this script, and each needs its own decision:" -ForegroundColor White
	Write-Host "  - The four secrets (wrangler secret put)."
	Write-Host "  - The three real phone number IDs in REGION_NUMBERS."
	Write-Host "  - Deploying the Worker (npx wrangler deploy)."
	Write-Host "  - Changing the Meta callback URL. This is the step that moves"
	Write-Host "    live customer traffic, and it is the last one, not the first."
} else {
	Write-Host ""
	Write-Warn "Something is missing above. Do not deploy until it is resolved."
	exit 1
}
