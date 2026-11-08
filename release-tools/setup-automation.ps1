param([string]$SigningArchive = '', [switch]$CheckOnly, [switch]$CheckBootstrap, [switch]$MirrorOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$repo = 'windroye590-create/litakova-updates'
$claspVersion = '3.4.1'
$archiveCacheBase = 'https://raw.githubusercontent.com/windroye590-create/litakova-updates/6ed911b3cf28bf3f7401e0b80c79b8713d7ff61f/release-tools/vendor/'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Assert-NativeSuccess([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE)." }
}

function Get-PortableDefinition([string]$Command) {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    $arm = $architecture -eq 'ARM64'
    if (-not $arm -and $architecture -ne 'AMD64') { throw 'This setup supports Windows x64 and ARM64.' }
    if ($Command -eq 'gh') {
        $arch = 'amd64'
        $hash = '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0'
        $asset = '679195750'
        if ($arm) { $arch = 'arm64'; $hash = '197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484'; $asset = '679195799' }
        $mirror = $null
        if (-not $arm) { $mirror = $archiveCacheBase + 'gh_2.103.3_windows_amd64.zip' }
        return @{ Version = '2.103.3'; Arch = $arch; Exe = 'gh.exe'; SHA256 = $hash; MirrorUrl = $mirror; Url = "https://api.github.com/repos/cli/cli/releases/assets/$asset"; FallbackUrl = "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_$arch.zip" }
    }
    if ($Command -eq 'node') {
        $arch = 'x64'
        $hash = 'dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a'
        if ($arm) { $arch = 'arm64'; $hash = 'a9427139595156ef484e1fb08957676e09d4232368dd1743a2a9f93f3d241b14' }
        $mirror = $null
        if (-not $arm) { $mirror = $archiveCacheBase + 'node-v26.13.0-win-x64.zip' }
        return @{ Version = '26.13.0'; Arch = $arch; Exe = 'node.exe'; SHA256 = $hash; MirrorUrl = $mirror; Url = "https://nodejs.org/dist/v26.13.0/node-v26.13.0-win-$arch.zip" }
    }
    throw "Unknown setup tool: $Command"
}

function Install-PortableTool([string]$Command, [string]$ToolsRoot) {
    $definition = Get-PortableDefinition $Command
    $install = Join-Path $ToolsRoot "$Command-$($definition.Version)-$($definition.Arch)"
    $marker = Join-Path $install '.verified-sha256'
    if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -Raw -LiteralPath $marker).Trim() -ne $definition.SHA256) {
        $stage = Join-Path ([IO.Path]::GetTempPath()) ('litakova-tool-' + [Guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $stage -Force)
        try {
            $download = Join-Path $stage 'package.zip'
            Write-Host "Downloading official $Command $($definition.Version)..."
            $verified = $false
            $urls = @()
            if ($definition.MirrorUrl) { $urls += $definition.MirrorUrl }
            if (-not $MirrorOnly) {
                $urls += $definition.Url
                if ($definition.FallbackUrl) { $urls += $definition.FallbackUrl }
            }
            if ($urls.Count -eq 0) { throw 'The raw archive cache currently supports Windows x64 only.' }
            foreach ($url in $urls) {
                try {
                    $headers = @{ Accept = 'application/octet-stream' }
                    if ($url.StartsWith('https://api.github.com/')) { $headers['X-GitHub-Api-Version'] = '2022-11-28' }
                    Invoke-WebRequest -UseBasicParsing -Uri $url -Headers $headers -UserAgent 'Litakova-release-setup' -OutFile $download -TimeoutSec 90
                    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $definition.SHA256) {
                        throw "The downloaded $Command archive failed SHA-256 verification."
                    }
                    $verified = $true
                    break
                } catch {
                    Write-Host "Download attempt for $Command failed: $($_.Exception.Message)"
                }
            }
            if (-not $verified) { throw "Could not download the verified official $Command archive. Run setup again to retry." }
            $expanded = Join-Path $stage 'expanded'
            Expand-Archive -LiteralPath $download -DestinationPath $expanded
            $executables = @(Get-ChildItem -LiteralPath $expanded -Recurse -File -Filter $definition.Exe)
            if ($executables.Count -ne 1) { throw "Unexpected official $Command archive layout." }
            [void](New-Item -ItemType Directory -Path $ToolsRoot -Force)
            if (Test-Path -LiteralPath $install) { Remove-Item -LiteralPath $install -Recurse -Force }
            Move-Item -LiteralPath $expanded -Destination $install
            [IO.File]::WriteAllText($marker, $definition.SHA256)
        } finally {
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        }
    }
    $executables = @(Get-ChildItem -LiteralPath $install -Recurse -File -Filter $definition.Exe)
    if ($executables.Count -ne 1) { throw "Portable $Command is incomplete; remove $install and retry." }
    $env:Path = $executables[0].DirectoryName + [IO.Path]::PathSeparator + $env:Path
    return $executables[0].FullName
}

function Ensure-Tool([string]$Command) {
    $found = Get-Command $Command -ErrorAction SilentlyContinue
    $usable = $null -ne $found
    if ($usable -and $Command -eq 'node') {
        $major = [int]((& node --version).TrimStart('v').Split('.')[0])
        $usable = $major -ge 22 -and $null -ne (Get-Command npx.cmd -ErrorAction SilentlyContinue)
    }
    if (-not $usable) {
        $toolsRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'LitakovaReleaseTools'
        [void](Install-PortableTool $Command $toolsRoot)
    }
}

function Test-GitHubLogin {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & gh auth status --hostname github.com 1>$null 2>$null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Invoke-SetupProcess([string]$Executable, [string]$Arguments) {
    # A closed stdin keeps gh's browser authorization separate from Git setup.
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $process.StandardInput.Close()
        $process.WaitForExit()
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function Test-SetupProcessWithoutGit {
    $powershellPath = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
    $savedPath = $env:Path
    try {
        $env:Path = ''
        $arguments = '-NoProfile -NonInteractive -Command "if (Get-Command git -ErrorAction SilentlyContinue) { exit 93 }; if (-not [Console]::IsInputRedirected) { exit 91 }; if ([Console]::In.ReadToEnd().Length -ne 0) { exit 92 }; exit 0"'
        if ((Invoke-SetupProcess $powershellPath $arguments) -ne 0) { throw 'Browser login process must work without Git and with closed stdin.' }
        if ((Invoke-SetupProcess $powershellPath '-NoProfile -NonInteractive -Command "exit 23"') -ne 23) { throw 'Setup must retain child process error status.' }
    } finally { $env:Path = $savedPath }
}

function Test-PortableBootstrap {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('litakova-bootstrap-test-' + [Guid]::NewGuid().ToString('N'))
    try {
        foreach ($command in @('gh', 'node')) {
            $executable = Install-PortableTool $command $testRoot
            & $executable --version
            Assert-NativeSuccess "Running portable $command"
        }
        & npx.cmd --version
        Assert-NativeSuccess 'Running portable npm/npx'
        $signedIn = Test-GitHubLogin
        if ($signedIn -isnot [bool]) { throw 'GitHub login detection failed.' }
        Write-Host 'Portable GitHub CLI and Node.js verified without winget or administrator access.'
    } finally {
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
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
    Test-SetupProcessWithoutGit
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
    if ($CheckBootstrap) { Test-PortableBootstrap }
    Write-Host 'Windows setup verified: selected Google account and signing ZIP parsing.'
    exit 0
}

Write-Host 'Litakova release automation setup. No application or database will be deployed.'
Ensure-Tool 'gh'
Ensure-Tool 'node'
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Install Node.js 22 or newer, then run this script again.' }

if (-not (Test-GitHubLogin)) {
    Write-Host 'Authorize GitHub CLI using the one-time code printed below. Git installation is not required.'
    Start-Process 'https://github.com/login/device'
    $loginExit = Invoke-SetupProcess (Get-Command gh).Source 'auth login --hostname github.com --git-protocol https --web --skip-ssh-key'
    if ($loginExit -ne 0 -and -not (Test-GitHubLogin)) { throw "GitHub sign-in failed (exit $loginExit)." }
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
