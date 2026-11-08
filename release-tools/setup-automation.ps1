param([string]$SigningArchive = '', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$repo = 'windroye590-create/litakova-updates'
$claspVersion = '3.4.1'

function Assert-NativeSuccess([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE)." }
}

function Refresh-ToolPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Ensure-Tool([string]$Command, [string]$Package) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "Install $Package, then run this script again. Windows Package Manager (winget) is unavailable."
        }
        & winget install --id $Package --exact --source winget --accept-source-agreements --accept-package-agreements
        Assert-NativeSuccess "Installing $Package"
        Refresh-ToolPath
        if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
            throw "Restart PowerShell, then run this script again to use $Command."
        }
    }
}

function Read-SigningArchive([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        $keyEntry = $archive.GetEntry('release-source/signing/litakova-release.jks')
        $passwordEntry = $archive.GetEntry('release-source/signing/storepass.txt')
        if ($null -eq $keyEntry -or $null -eq $passwordEntry -or $keyEntry.Length -gt 262144 -or $passwordEntry.Length -gt 4096) {
            throw 'Select the original Litakova-Komisiia-v1.4.1-source-and-signing.zip archive.'
        }
        $stream = $keyEntry.Open()
        $memory = New-Object IO.MemoryStream
        try { $stream.CopyTo($memory); $key = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
        $reader = [IO.StreamReader]::new($passwordEntry.Open(), [Text.Encoding]::UTF8)
        try { $password = $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
        if ($key.Length -eq 0 -or $password.Length -eq 0) { throw 'The signing archive is incomplete.' }
        return @{ Key = [Convert]::ToBase64String($key); Password = $password }
    } finally { $archive.Dispose() }
}

function Select-GoogleCredential($Stored) {
    if ($Stored.PSObject.Properties['tokens']) {
        $property = $Stored.tokens.PSObject.Properties['litakova-release']
        if ($null -eq $property) { throw 'The litakova-release Google login was not saved.' }
        $selected = $property.Value
    } else { throw 'Unexpected clasp credential format; run the pinned clasp login again.' }
    foreach ($name in @('client_id', 'client_secret', 'refresh_token')) {
        if (-not $selected.$name) { throw "Google authorization is missing $name. Sign in again." }
    }
    return @{ type = 'authorized_user'; client_id = $selected.client_id; client_secret = $selected.client_secret; refresh_token = $selected.refresh_token } | ConvertTo-Json -Compress
}

function Set-ActionSecret([string]$Name, [string]$Value) {
    # Pass private data through stdin, never command-line arguments or console output.
    $Value | & gh secret set $Name --repo $repo
    Assert-NativeSuccess "Saving secret $Name"
}

if ($CheckOnly) {
    $fixture = '{"tokens":{"litakova-release":{"client_id":"id","client_secret":"secret","refresh_token":"refresh"},"other":{"refresh_token":"must-not-be-uploaded"}}}' | ConvertFrom-Json
    $selected = Select-GoogleCredential $fixture
    if ($selected.Contains('must-not-be-uploaded') -or -not $selected.Contains('refresh_token')) { throw 'Credential account isolation failed.' }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $testZip = Join-Path ([IO.Path]::GetTempPath()) (([IO.Path]::GetRandomFileName()) + '.zip')
    try {
        $zip = [IO.Compression.ZipFile]::Open($testZip, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $entry = $zip.CreateEntry('release-source/signing/litakova-release.jks').Open()
            try { $entry.Write([byte[]](97,98,99), 0, 3) } finally { $entry.Dispose() }
            $writer = [IO.StreamWriter]::new($zip.CreateEntry('release-source/signing/storepass.txt').Open())
            try { $writer.Write('fixture-' + [char]0x0443) } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
        $data = Read-SigningArchive $testZip
        if ($data.Key -ne 'YWJj' -or $data.Password -ne ('fixture-' + [char]0x0443)) { throw 'Signing ZIP read failed.' }
    } finally { if (Test-Path $testZip) { Remove-Item -LiteralPath $testZip } }
    Write-Host 'Windows setup verified: selected Google account and signing ZIP parsing; no network calls.'
    exit 0
}

Write-Host 'Litakova release automation setup. No application or database will be deployed.'
Ensure-Tool 'gh' 'GitHub.cli'
Ensure-Tool 'node' 'OpenJS.NodeJS.LTS'
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Install Node.js 22 or newer, then run this script again.' }

& gh auth status --hostname github.com 2>$null
if ($LASTEXITCODE -ne 0) {
    & gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key
    Assert-NativeSuccess 'GitHub sign-in'
}
& gh api "repos/$repo/actions/secrets/public-key" 1>$null
if ($LASTEXITCODE -ne 0) { throw 'GitHub login cannot manage repository secrets. Run: gh auth refresh --hostname github.com --scopes repo' }

if (-not $SigningArchive) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Select the original source-and-signing ZIP from ChatGPT Library'
    $dialog.Filter = 'ZIP archives (*.zip)|*.zip'
    try {
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw 'No signing archive selected.' }
        $SigningArchive = $dialog.FileName
    } finally { $dialog.Dispose() }
}
$signing = Read-SigningArchive $SigningArchive

Write-Host 'Enable Apps Script API at https://script.google.com/home/usersettings, then sign in as the script owner.'
Start-Process 'https://script.google.com/home/usersettings'
[void](Read-Host 'Press Enter after enabling Apps Script API')
& npx.cmd --yes --package "@google/clasp@$claspVersion" clasp login --user litakova-release
Assert-NativeSuccess 'Google authorization'
$profileRoot = [Environment]::GetFolderPath('UserProfile')
$credentialPath = Join-Path $profileRoot '.clasprc.json'
$google = Select-GoogleCredential (Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json)

Set-ActionSecret 'GAS_CREDENTIALS' $google
Set-ActionSecret 'LK_SIGNING_PKCS12_BASE64' $signing.Key
Set-ActionSecret 'LK_SIGNING_PASSWORD' $signing.Password
$google = $null
$signing = $null

& gh workflow run verify-release-automation.yml --repo $repo --ref main -f check_credentials=true
Assert-NativeSuccess 'Starting read-only setup verification'
Write-Host 'Secrets saved. GitHub is now checking Google access and the original signing key without deployment.'
Write-Host "Result: https://github.com/$repo/actions/workflows/verify-release-automation.yml"
