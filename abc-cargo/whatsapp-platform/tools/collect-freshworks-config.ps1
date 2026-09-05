<#
.SYNOPSIS
    Collects ABC Cargo Freshworks configuration to local JSON files for review.

.DESCRIPTION
    READ-ONLY. This script issues GET requests only. It never creates, updates or
    deletes anything in Freshdesk or Freshchat, and it never writes to any live
    system. It writes JSON files to a local folder that you choose.

    API keys are read from environment variables or prompted for securely. They are
    never written to disk, never printed to the console, and never included in the
    output files.

    Compatible with Windows PowerShell 5.1.

.PARAMETER FreshdeskDomain
    Your Freshdesk subdomain only, e.g. "abccargo" for abccargo.freshdesk.com.

.PARAMETER FreshchatDomain
    Your Freshchat subdomain only, e.g. "abccargo" for abccargo.freshchat.com.
    Optional. Omit to skip the Freshchat section.

.PARAMETER OutputPath
    Folder to write the JSON files into. Created if it does not exist.

.EXAMPLE
    # Recommended: set the keys as environment variables first, in the same window.
    $env:FRESHDESK_API_KEY = "<paste here, this window only>"
    $env:FRESHCHAT_API_TOKEN = "<paste here, this window only>"
    .\collect-freshworks-config.ps1 -FreshdeskDomain abccargo -FreshchatDomain abccargo -OutputPath C:\Temp\fw-config

.EXAMPLE
    # Or omit the variables and the script will prompt securely for each key.
    .\collect-freshworks-config.ps1 -FreshdeskDomain abccargo -OutputPath C:\Temp\fw-config

.NOTES
    Read-only inspection. No live change is made. Requires an agent or admin API key
    with read access. Generate the Freshdesk key from your profile settings, and the
    Freshchat token from Admin Settings.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9-]+$')]
    [string] $FreshdeskDomain,

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9-]*$')]
    [string] $FreshchatDomain = '',

    [Parameter(Mandatory = $true)]
    [string] $OutputPath
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- preflight

Write-Host ''
Write-Host 'ABC Cargo - Freshworks configuration collector' -ForegroundColor Cyan
Write-Host 'READ-ONLY. GET requests only. Nothing is modified.' -ForegroundColor Cyan
Write-Host ''

if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "Windows PowerShell 5.1 or later is required. Detected $($PSVersionTable.PSVersion)."
}

# Freshworks requires TLS 1.2. PowerShell 5.1 does not always negotiate it by default.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Write-Warning 'Could not force TLS 1.2. If requests fail, run: [Net.ServicePointManager]::SecurityProtocol = 3072'
}

if (-not (Test-Path -LiteralPath $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
    Write-Host "Created output folder: $OutputPath" -ForegroundColor Green
} else {
    Write-Host "Using output folder: $OutputPath" -ForegroundColor Green
}
$resolvedOut = (Resolve-Path -LiteralPath $OutputPath).Path

# ---------------------------------------------------------------- credentials

function Get-SecretValue {
    param([string] $EnvName, [string] $Prompt)

    $fromEnv = [Environment]::GetEnvironmentVariable($EnvName, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) {
        Write-Host "  Using $EnvName from the current session." -ForegroundColor DarkGray
        return $fromEnv
    }
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

Write-Host 'Credentials' -ForegroundColor Yellow
$freshdeskKey = Get-SecretValue -EnvName 'FRESHDESK_API_KEY' -Prompt '  Freshdesk API key (input hidden)'
if ([string]::IsNullOrWhiteSpace($freshdeskKey)) { throw 'A Freshdesk API key is required.' }

$freshchatToken = ''
if (-not [string]::IsNullOrWhiteSpace($FreshchatDomain)) {
    $freshchatToken = Get-SecretValue -EnvName 'FRESHCHAT_API_TOKEN' -Prompt '  Freshchat API token (input hidden, press Enter to skip)'
}

# Freshdesk uses Basic auth with the API key as the username and any password.
$pair  = "{0}:X" -f $freshdeskKey
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$freshdeskHeaders = @{ Authorization = "Basic $basic" }

Write-Host ''

# ---------------------------------------------------------------- helpers

$script:Collected = @()
$script:Failed    = @()

function Invoke-ReadOnlyGet {
    param(
        [string] $Uri,
        [hashtable] $Headers
    )
    # GET only. This function is the single network path in this script.
    return Invoke-RestMethod -Uri $Uri -Method Get -Headers $Headers -TimeoutSec 60
}

function Save-Endpoint {
    param(
        [string] $Label,
        [string] $Uri,
        [hashtable] $Headers,
        [string] $FileName,
        [switch] $Paginate
    )

    Write-Host ("  {0,-28}" -f $Label) -NoNewline
    try {
        if ($Paginate) {
            $all   = New-Object System.Collections.ArrayList
            $page  = 1
            $count = 0
            do {
                $sep  = if ($Uri -like '*?*') { '&' } else { '?' }
                $pageUri = "{0}{1}per_page=100&page={2}" -f $Uri, $sep, $page
                $batch = Invoke-ReadOnlyGet -Uri $pageUri -Headers $Headers
                if ($null -eq $batch) { break }
                $count = @($batch).Count
                if ($count -gt 0) { [void]$all.AddRange(@($batch)) }
                $page++
            } while ($count -eq 100 -and $page -le 50)
            $data = $all.ToArray()
        } else {
            $data = Invoke-ReadOnlyGet -Uri $Uri -Headers $Headers
        }

        $target = Join-Path $resolvedOut $FileName
        $data | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $target -Encoding UTF8
        $n = @($data).Count
        Write-Host ("OK  {0,5} record(s) -> {1}" -f $n, $FileName) -ForegroundColor Green
        $script:Collected += [pscustomobject]@{ Label = $Label; File = $FileName; Records = $n }
    }
    catch {
        $status = ''
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = '' }
        }
        $reason = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        Write-Host ("SKIPPED  {0}" -f $reason) -ForegroundColor Yellow
        $script:Failed += [pscustomobject]@{ Label = $Label; Reason = $reason }
    }
}

# ---------------------------------------------------------------- freshdesk

$fdBase = "https://$FreshdeskDomain.freshdesk.com/api/v2"
Write-Host "Freshdesk  ($fdBase)" -ForegroundColor Yellow

Save-Endpoint -Label 'Agents'            -Uri "$fdBase/agents"                 -Headers $freshdeskHeaders -FileName 'freshdesk-agents.json'            -Paginate
Save-Endpoint -Label 'Groups'            -Uri "$fdBase/groups"                 -Headers $freshdeskHeaders -FileName 'freshdesk-groups.json'            -Paginate
Save-Endpoint -Label 'Roles'             -Uri "$fdBase/roles"                  -Headers $freshdeskHeaders -FileName 'freshdesk-roles.json'             -Paginate
Save-Endpoint -Label 'Business hours'    -Uri "$fdBase/business_hours"         -Headers $freshdeskHeaders -FileName 'freshdesk-business-hours.json'
Save-Endpoint -Label 'SLA policies'      -Uri "$fdBase/sla_policies"           -Headers $freshdeskHeaders -FileName 'freshdesk-sla-policies.json'
Save-Endpoint -Label 'Ticket fields'     -Uri "$fdBase/ticket_fields"          -Headers $freshdeskHeaders -FileName 'freshdesk-ticket-fields.json'
Save-Endpoint -Label 'Contact fields'    -Uri "$fdBase/contact_fields"         -Headers $freshdeskHeaders -FileName 'freshdesk-contact-fields.json'
Save-Endpoint -Label 'Company fields'    -Uri "$fdBase/company_fields"         -Headers $freshdeskHeaders -FileName 'freshdesk-company-fields.json'
Save-Endpoint -Label 'Canned resp folders' -Uri "$fdBase/canned_response_folders" -Headers $freshdeskHeaders -FileName 'freshdesk-canned-folders.json'
Save-Endpoint -Label 'Email configs'     -Uri "$fdBase/email_configs"          -Headers $freshdeskHeaders -FileName 'freshdesk-email-configs.json'
Save-Endpoint -Label 'Products'          -Uri "$fdBase/products"               -Headers $freshdeskHeaders -FileName 'freshdesk-products.json'
Save-Endpoint -Label 'Surveys (CSAT)'    -Uri "$fdBase/surveys"                -Headers $freshdeskHeaders -FileName 'freshdesk-surveys.json'

Write-Host ''

# ---------------------------------------------------------------- freshchat

if (-not [string]::IsNullOrWhiteSpace($FreshchatDomain) -and -not [string]::IsNullOrWhiteSpace($freshchatToken)) {
    $fcBase = "https://$FreshchatDomain.freshchat.com/v2"
    $freshchatHeaders = @{ Authorization = "Bearer $freshchatToken"; Accept = 'application/json' }
    Write-Host "Freshchat  ($fcBase)" -ForegroundColor Yellow

    Save-Endpoint -Label 'Agents'   -Uri "$fcBase/agents"   -Headers $freshchatHeaders -FileName 'freshchat-agents.json'
    Save-Endpoint -Label 'Groups'   -Uri "$fcBase/groups"   -Headers $freshchatHeaders -FileName 'freshchat-groups.json'
    Save-Endpoint -Label 'Roles'    -Uri "$fcBase/roles"    -Headers $freshchatHeaders -FileName 'freshchat-roles.json'
    Save-Endpoint -Label 'Channels' -Uri "$fcBase/channels" -Headers $freshchatHeaders -FileName 'freshchat-channels.json'

    Write-Host ''
} else {
    Write-Host 'Freshchat  skipped (no domain or no token supplied)' -ForegroundColor DarkGray
    Write-Host ''
}

# ---------------------------------------------------------------- verify

Write-Host 'Result' -ForegroundColor Yellow
if ($script:Collected.Count -gt 0) {
    $script:Collected | Format-Table -AutoSize
} else {
    Write-Host '  Nothing was collected. Check the domain and the API key.' -ForegroundColor Red
}

if ($script:Failed.Count -gt 0) {
    Write-Host 'Endpoints skipped:' -ForegroundColor Yellow
    $script:Failed | Format-Table -AutoSize
    Write-Host '  HTTP 403 usually means the key lacks admin scope.' -ForegroundColor DarkGray
    Write-Host '  HTTP 404 usually means that feature is not enabled on your plan.' -ForegroundColor DarkGray
}

$written = Get-ChildItem -LiteralPath $resolvedOut -Filter '*.json' -File
Write-Host ''
Write-Host ("Verified {0} JSON file(s) written to {1}" -f $written.Count, $resolvedOut) -ForegroundColor Green
Write-Host ''
Write-Host 'STILL NEEDED - not available through the public API:' -ForegroundColor Cyan
Write-Host '  Chat Assignment Rules. Capture these from:' -ForegroundColor Cyan
Write-Host '  Admin Settings > Chat Assignment Rules - the full list in execution order,' -ForegroundColor Cyan
Write-Host '  then each rule opened to show its conditions and assign-to target.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Before sharing: open the JSON files and remove anything you do not wish to share.' -ForegroundColor Yellow
Write-Host 'No credential is contained in these files. Nothing was modified.' -ForegroundColor Green
Write-Host ''

# Clear the key variables from this session's memory.
$freshdeskKey = $null; $freshchatToken = $null; $pair = $null; $basic = $null
[GC]::Collect()
