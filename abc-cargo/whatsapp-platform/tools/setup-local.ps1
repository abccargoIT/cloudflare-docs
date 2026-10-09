<#
.SYNOPSIS
	Prepares the ABC Cargo Engage platform to run on this computer for testing.

.DESCRIPTION
	READ-ONLY with respect to every ABC Cargo system. This script only touches
	files inside the project folder on this machine. It does not connect to
	Freshworks, to Meta, or to any ABC Cargo server, and it cannot send a
	message to a customer.

	What it does, in order:
	  1. Checks that Node.js 22 or newer is installed.
	  2. Installs the project's dependencies.
	  3. Creates .dev.vars from the example file, if it does not exist.
	  4. Creates a local test database on this computer and applies the schema.
	  5. Loads sample data so the screens are not empty.
	  6. Runs the test suite.

	Everything is local. The database is a file inside .wrangler in this folder.
	Deleting that folder removes it completely.

	Compatible with Windows PowerShell 5.1.

.PARAMETER SkipTests
	Skip step 6. Useful if you only want the environment ready.

.EXAMPLE
	.\tools\setup-local.ps1

.EXAMPLE
	.\tools\setup-local.ps1 -SkipTests
#>

[CmdletBinding()]
param(
	[switch] $SkipTests
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

function Write-Step {
	param([int] $Number, [string] $Text)
	Write-Host ''
	Write-Host ("[{0}/6] {1}" -f $Number, $Text) -ForegroundColor Cyan
}

function Write-Ok {
	param([string] $Text)
	Write-Host ("      OK  {0}" -f $Text) -ForegroundColor Green
}

function Write-Warn {
	param([string] $Text)
	Write-Host ("      --  {0}" -f $Text) -ForegroundColor Yellow
}

function Stop-WithGuidance {
	param([string] $Problem, [string] $Fix)
	Write-Host ''
	Write-Host 'STOPPED' -ForegroundColor Red
	Write-Host ("  Problem: {0}" -f $Problem)
	Write-Host ("  Fix:     {0}" -f $Fix)
	Write-Host ''
	exit 1
}

# The project root is the parent of the tools folder this script lives in.
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
	Stop-WithGuidance `
		-Problem "package.json was not found in $projectRoot." `
		-Fix 'Run this script from inside the whatsapp-platform folder.'
}
Set-Location $projectRoot

Write-Host ''
Write-Host '======================================================' -ForegroundColor White
Write-Host ' ABC Cargo Engage - local test setup' -ForegroundColor White
Write-Host ' Nothing in this script touches a live system.' -ForegroundColor White
Write-Host '======================================================' -ForegroundColor White
Write-Host ("Project folder: {0}" -f $projectRoot)

# ---------------------------------------------------------------- 1. Node.js

Write-Step 1 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	Stop-WithGuidance `
		-Problem 'Node.js is not installed, or not on the PATH.' `
		-Fix 'Install the LTS version from https://nodejs.org, then open a new PowerShell window and run this again.'
}
$nodeVersion = (& node --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) {
	Stop-WithGuidance `
		-Problem ("Node.js {0} is installed. This project needs 22 or newer." -f $nodeVersion) `
		-Fix 'Install the current LTS from https://nodejs.org, then run this again.'
}
Write-Ok ("Node.js {0}" -f $nodeVersion)

# ----------------------------------------------------------- 2. Dependencies

Write-Step 2 'Installing dependencies (this can take a few minutes the first time)'
& npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) {
	Stop-WithGuidance `
		-Problem 'npm install failed.' `
		-Fix 'Check the message above. A corporate proxy or firewall is the usual cause.'
}
Write-Ok 'Dependencies installed'

# -------------------------------------------------------------- 3. Local settings

Write-Step 3 'Preparing local settings'
$devVars = Join-Path $projectRoot '.dev.vars'
$example = Join-Path $projectRoot '.dev.vars.example'
if (Test-Path $devVars) {
	Write-Ok '.dev.vars already exists, left untouched'
}
else {
	if (-not (Test-Path $example)) {
		Stop-WithGuidance `
			-Problem '.dev.vars.example is missing.' `
			-Fix 'Pull the latest version of the project folder and run this again.'
	}
	Copy-Item -Path $example -Destination $devVars
	Write-Ok '.dev.vars created from the example (local test values only)'
}

# ------------------------------------------------------------ 4. Database

Write-Step 4 'Creating the local test database'
& npx wrangler d1 migrations apply abc-whatsapp --local
if ($LASTEXITCODE -ne 0) {
	Stop-WithGuidance `
		-Problem 'Could not apply the database schema locally.' `
		-Fix 'Check the message above, then send it to IT. The database is only a file in the .wrangler folder; nothing outside this project is affected.'
}
Write-Ok 'Schema applied to the local database'

# ------------------------------------------------------------ 5. Sample data

Write-Step 5 'Loading sample data'
$seed = Join-Path $projectRoot 'tools\seed-local.sql'
if (-not (Test-Path $seed)) {
	Stop-WithGuidance `
		-Problem 'tools\seed-local.sql is missing.' `
		-Fix 'Pull the latest version of the project folder and run this again.'
}
& npx wrangler d1 execute abc-whatsapp --local --file="$seed"
if ($LASTEXITCODE -ne 0) {
	Write-Warn 'Sample data did not load. The platform will still run, with empty screens.'
}
else {
	Write-Ok 'Sample customers and shipments loaded'
}

# ------------------------------------------------------------------ 6. Tests

if ($SkipTests) {
	Write-Step 6 'Skipping the test suite (-SkipTests was given)'
}
else {
	Write-Step 6 'Running the test suite'
	& npm test
	if ($LASTEXITCODE -ne 0) {
		Write-Warn 'Some tests failed. Send the output above to IT before going further.'
	}
	else {
		Write-Ok 'All tests passed'
	}
}

# ----------------------------------------------------------------- Next steps

Write-Host ''
Write-Host '======================================================' -ForegroundColor White
Write-Host ' Ready. Two windows from here.' -ForegroundColor White
Write-Host '======================================================' -ForegroundColor White
Write-Host ''
Write-Host ' In THIS window, start the platform and leave it running:'
Write-Host ''
Write-Host '     npm run dev' -ForegroundColor Yellow
Write-Host ''
Write-Host ' Then open a SECOND PowerShell window in the same folder'
Write-Host ' and send pretend customer messages to it:'
Write-Host ''
Write-Host '     npm run simulate' -ForegroundColor Yellow
Write-Host ''
Write-Host ' To try your own wording:'
Write-Host ''
Write-Host '     node tools\simulate-inbound.mjs --text "my parcel is broken"' -ForegroundColor Yellow
Write-Host ''
Write-Host ' Nothing reaches Meta, Freshworks or any customer.' -ForegroundColor Green
Write-Host ''
