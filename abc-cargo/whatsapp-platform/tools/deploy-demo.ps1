<#
.SYNOPSIS
    Redeploys the ABC Cargo Engage DEMONSTRATION to engage.abccargosupport.com.

.DESCRIPTION
    Updates the demo-only Worker (abc-cargo-engage-demo) with the current
    demo/app.html from the branch. That is ALL it does.

    What this touches:   the demonstration page on engage.abccargosupport.com.
    What this does NOT:  Meta, WhatsApp, Freshworks, Cloudflare Access, any
                         database, any customer, any secret. The demo Worker
                         has exactly one binding (DEPLOY_NOTE) and no
                         credentials, so it cannot reach anything live.

    Safe defaults:
      - Stops if run from the wrong folder or on the wrong branch.
      - Stops if you have uncommitted changes here, rather than overwrite them.
      - Pulls with --ff-only, so it never creates a merge commit.
      - Dry-runs first and shows the result before deploying anything.
      - Deploys only after you type DEPLOY DEMO.
      - Records the version that was live before, and prints the rollback.

    Requires: Windows PowerShell 5.1 or later, git, Node.js (npx), and a
    wrangler login on this machine for the ABC Cargo Cloudflare account
    (the same one you used for the first demo deploy).

.EXAMPLE
    Run from the project folder, in a Windows PowerShell CONSOLE (not ISE):

        cd <your clone>\abc-cargo\whatsapp-platform
        powershell.exe -ExecutionPolicy Bypass -File .\tools\deploy-demo.ps1

.NOTES
    Prepared by: ABC Cargo IT Department, 9 October 2026.
    Written to Windows PowerShell 5.1 rules: no && or ||, no ?? or ternary,
    exit codes read from $LASTEXITCODE. Native-command stderr is never
    redirected, because in 5.1 that turns wrangler's harmless warnings into
    terminating errors.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Branch      = 'claude/whatsapp-customer-communication-bg7m78'
$WorkerName  = 'abc-cargo-engage-demo'
$ConfigFile  = 'wrangler.demo.jsonc'
$DemoPage    = 'demo\app.html'
# The commit that carries the red/white/black palette, the report library,
# the bot fallback and the service-clock fix. Anything older is stale.
$MinCommit   = '6a0075c'

function Step($text)  { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text)    { Write-Host "    OK   $text" -ForegroundColor Green }
function Fail($text)  {
    Write-Host ""
    Write-Host "    STOP $text" -ForegroundColor Red
    Write-Host "    Nothing has been deployed." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "ABC Cargo Engage - redeploy the DEMONSTRATION" -ForegroundColor White
Write-Host "Touches the demo page only. Nothing live, no customer, no Meta." -ForegroundColor Gray

# ---------------------------------------------------------------- 1. tools
Step "Checking tools"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is not installed or not on PATH."
}
Ok "git found"
# npx.cmd rather than npx: the .ps1 shim is blocked by some execution
# policies, and the .cmd one is not.
if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
    Fail "npx.cmd not found. Install Node.js 20 or later."
}
Ok "npx.cmd found"

# --------------------------------------------------------------- 2. folder
Step "Checking this is the project folder"
if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
    Fail "$ConfigFile is not here. Run this from <clone>\abc-cargo\whatsapp-platform. Current folder: $((Get-Location).Path)"
}
$configText = Get-Content -LiteralPath $ConfigFile -Raw
if ($configText -notmatch [regex]::Escape("`"$WorkerName`"")) {
    Fail "$ConfigFile does not name the Worker $WorkerName. Wrong file - not deploying."
}
Ok "$ConfigFile names $WorkerName"
if (-not (Test-Path -LiteralPath 'package.json' -PathType Leaf)) {
    Fail "package.json is missing. Wrong folder."
}
$pkg = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
if ($pkg.name -ne 'abc-cargo-whatsapp-platform') {
    Fail "package.json belongs to '$($pkg.name)', not abc-cargo-whatsapp-platform."
}
Ok "package.json is abc-cargo-whatsapp-platform"

# --------------------------------------------------------------- 3. branch
Step "Checking the branch"
$current = (git rev-parse --abbrev-ref HEAD)
if ($LASTEXITCODE -ne 0) { Fail "This folder is not inside a git repository." }
if ($current -ne $Branch) {
    Fail "You are on branch '$current'. Switch first:  git checkout $Branch"
}
Ok "on $Branch"

# --------------------------------------------------- 4. no local changes lost
Step "Checking for uncommitted changes in this folder"
$dirty = (git status --porcelain -- .)
if ($LASTEXITCODE -ne 0) { Fail "git status failed." }
if ($dirty) {
    Write-Host $dirty
    Fail "There are uncommitted changes here. Commit or stash them first; this script will not overwrite your work."
}
Ok "working tree clean"

# ------------------------------------------------------------------ 5. pull
Step "Fetching the latest demonstration from GitHub"
git pull --ff-only origin $Branch
if ($LASTEXITCODE -ne 0) {
    Fail "git pull failed. If it says 'not possible to fast-forward', your local branch has diverged - ask IT before forcing anything."
}
$head = (git rev-parse --short HEAD)
Ok "now at $head"

git merge-base --is-ancestor $MinCommit HEAD
if ($LASTEXITCODE -ne 0) {
    Fail "This checkout does not contain commit $MinCommit, so it would deploy a stale demo. Check the branch and pull again."
}
Ok "contains $MinCommit (palette, reports, bot fallback, service-clock fix)"

# -------------------------------------------------------------- 6. the page
Step "Checking the demonstration page"
if (-not (Test-Path -LiteralPath $DemoPage -PathType Leaf)) {
    Fail "$DemoPage is missing."
}
$size = (Get-Item -LiteralPath $DemoPage).Length
if ($size -lt 200000) {
    Fail "$DemoPage is only $size bytes - expected roughly 290 KB. It may be a broken or partial build."
}
Ok ("{0} is {1:N0} KB" -f $DemoPage, ($size / 1KB))

# --------------------------------------------------------------- 7. dry run
Step "Dry run - builds the upload, deploys nothing"
& npx.cmd wrangler deploy -c $ConfigFile --dry-run
if ($LASTEXITCODE -ne 0) { Fail "The dry run failed. Send IT the output above." }
Ok "dry run passed"
Write-Host "    Expect: about 330 KiB, ONE binding (DEPLOY_NOTE). If you see a" -ForegroundColor Gray
Write-Host "    database, bucket, queue or secret listed above, STOP - that is" -ForegroundColor Gray
Write-Host "    the full platform, not the demo." -ForegroundColor Gray

# ------------------------------------------------------- 8. record for rollback
Step "Recording what is live now, so it can be put back"
& npx.cmd wrangler deployments list --name $WorkerName
if ($LASTEXITCODE -ne 0) {
    Fail "Could not read current deployments. Run:  npx wrangler login  then try again."
}
Ok "the most recent entry above is the version you would roll back to"

# --------------------------------------------------------------- 9. confirm
Write-Host ""
Write-Host "Ready to replace the demo on engage.abccargosupport.com with $head." -ForegroundColor Yellow
$answer = Read-Host "Type DEPLOY DEMO to continue, anything else to stop"
if ($answer -cne 'DEPLOY DEMO') {
    Write-Host ""
    Write-Host "    Stopped by you. Nothing has been deployed." -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------- 10. deploy
Step "Deploying"
& npx.cmd wrangler deploy -c $ConfigFile
if ($LASTEXITCODE -ne 0) {
    Fail "Deploy failed. The previous demo is still live - a failed deploy does not replace it."
}
Ok "deployed"

# ---------------------------------------------------------------- 11. verify
Step "Verifying"
& npx.cmd wrangler deployments list --name $WorkerName
if ($LASTEXITCODE -ne 0) { Write-Host "    Could not list deployments to confirm." -ForegroundColor Yellow }
Write-Host ""
Write-Host "    The newest entry above should be a few seconds old." -ForegroundColor Gray
Write-Host "    Then open https://engage.abccargosupport.com/ - sign in through" -ForegroundColor Gray
Write-Host "    Cloudflare Access - and check the Reports tab shows charts and" -ForegroundColor Gray
Write-Host "    the colours are red, white and black." -ForegroundColor Gray

# -------------------------------------------------------------- 12. rollback
Write-Host ""
Write-Host "If anything looks wrong, put the previous demo back with:" -ForegroundColor White
Write-Host "    npx wrangler rollback --name $WorkerName -m `"Revert demo`"" -ForegroundColor White
Write-Host "(No version id needed: it returns to the one before this deploy.)" -ForegroundColor Gray
Write-Host ""
exit 0
