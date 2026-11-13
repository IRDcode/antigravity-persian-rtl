param(
    [ValidateSet('launch', 'restore', 'doctor')]
    [string]$Action = 'launch',
    [string]$AsarPath = '',
    [switch]$AutoClose
)

$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$patcherJs = Join-Path $rootDir 'src\patcher.mjs'

function Write-Failure {
    param(
        [string]$Code,
        [string]$Message,
        [string]$Cause,
        [string]$Fix
    )
    Write-Host ""
    Write-Host "[antigravity-persian-rtl] ERROR ($Code): $Message" -ForegroundColor Red
    if ($Cause) { Write-Host "  Cause: $Cause" -ForegroundColor DarkGray }
    if ($Fix)   { Write-Host "  Fix:   $Fix" -ForegroundColor Yellow }
    Write-Host ""
}

function Resolve-NodeExe {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
        return $cmd.Source
    }
    $fallbacks = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($candidate in $fallbacks) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }
    return $null
}

function Ensure-NodeRuntime {
    $nodeExe = Resolve-NodeExe
    if (-not $nodeExe) {
        Write-Failure -Code 'NODE_NOT_FOUND' `
            -Message 'Node.js is not installed or not in PATH.' `
            -Cause 'The patcher requires Node.js 20 or newer to inspect and repack app.asar.' `
            -Fix 'Install Node.js LTS from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS'
        exit 1
    }

    & $nodeExe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" 2>$null
    if ($LASTEXITCODE -ne 0) {
        $ver = (& $nodeExe -v) 2>$null
        Write-Failure -Code 'NODE_TOO_OLD' `
            -Message "Detected Node.js $ver, but Node.js 20.0.0 or newer is required." `
            -Cause 'Older Node.js versions lack required ESM and test/crypto helpers.' `
            -Fix 'Update Node.js LTS from https://nodejs.org/ or run: winget upgrade OpenJS.NodeJS.LTS'
        exit 1
    }
    return $nodeExe
}

function Ensure-AsarDependency {
    param([string]$NodeExe)
    $depMarker = Join-Path $rootDir 'node_modules\@electron\asar\package.json'
    if (Test-Path $depMarker) {
        return
    }

    $nodeDir = Split-Path -Parent $NodeExe
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $npmCmd)) {
        $npmFromPath = Get-Command npm -ErrorAction SilentlyContinue
        if ($npmFromPath) { $npmCmd = $npmFromPath.Source }
    }
    if (-not $npmCmd -or -not (Test-Path $npmCmd)) {
        Write-Failure -Code 'NPM_NOT_FOUND' `
            -Message 'Missing @electron/asar and npm was not found.' `
            -Cause 'First-time launch needs npm to install the single dependency (@electron/asar).' `
            -Fix 'Install standard Node.js LTS (includes npm) from https://nodejs.org/ and run: npm install --omit=dev'
        exit 1
    }

    Write-Host "[antigravity-persian-rtl] First-time setup: installing @electron/asar..." -ForegroundColor Cyan
    Push-Location $rootDir
    try {
        & $npmCmd install --omit=dev --no-audit --no-fund
        $npmExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($npmExit -ne 0 -or -not (Test-Path $depMarker)) {
        Write-Failure -Code 'DEPS_INSTALL_FAILED' `
            -Message 'Could not install @electron/asar automatically.' `
            -Cause 'npm failed (often due to offline state, proxy/network block, or read-only folder permissions).' `
            -Fix "Open terminal in `"$rootDir`" with internet access and run: npm install --omit=dev"
        exit 1
    }
}

function Stop-RunningAntigravity {
    param(
        [string]$PromptText,
        [switch]$ForceAuto
    )
    if (-not $ForceAuto) {
        Write-Host ""
        Write-Host "[antigravity-persian-rtl] Antigravity Desktop is currently running (check System Tray)." -ForegroundColor Yellow
        $ans = Read-Host "$PromptText (Y/N)"
        if ($ans -notmatch '^[Yy]') {
            Write-Host "Cancelled. Close Antigravity manually and try again." -ForegroundColor Gray
            exit 0
        }
    }

    Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.CloseMainWindow() | Out-Null } catch {}
    }
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) {
        Stop-Process -Name 'Antigravity' -Force -ErrorAction SilentlyContinue
        $forceDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $forceDeadline)) {
            Start-Sleep -Milliseconds 200
        }
    }
    if (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) {
        Write-Failure -Code 'ANTIGRAVITY_STILL_RUNNING' `
            -Message 'Antigravity.exe did not close cleanly.' `
            -Cause 'An elevated or stuck helper process prevented automatic shutdown.' `
            -Fix 'Open Task Manager, end all Antigravity processes, and run this script again.'
        exit 2
    }
}

$nodeExe = Ensure-NodeRuntime
Ensure-AsarDependency -NodeExe $nodeExe

$pathArgs = @()
if ($AsarPath) {
    $pathArgs = @('--path', $AsarPath)
}

if ($Action -eq 'doctor') {
    & $nodeExe $patcherJs doctor @pathArgs
    exit $LASTEXITCODE
}

$statusRaw = & $nodeExe $patcherJs status --json @pathArgs
$status = $statusRaw | ConvertFrom-Json

if ($Action -eq 'restore') {
    if (-not $status.exists) {
        Write-Failure -Code 'ASAR_NOT_FOUND' `
            -Message 'Antigravity app.asar not found.' `
            -Cause 'Antigravity Desktop was not detected in standard installation directories.' `
            -Fix 'Pass --AsarPath "C:\path\to\resources\app.asar" or check Diagnose-Antigravity-RTL.bat.'
        exit 1
    }
    if ($status.running) {
        Stop-RunningAntigravity -PromptText 'Close Antigravity Desktop and restore original files?' -ForceAuto:$AutoClose
    }
    & $nodeExe $patcherJs restore @pathArgs
    exit $LASTEXITCODE
}

# Default action: launch (verify / repatch-if-needed / start Antigravity.exe)
if (-not $status.exists) {
    Write-Failure -Code 'ASAR_NOT_FOUND' `
        -Message 'Antigravity Desktop app.asar not found.' `
        -Cause 'Could not locate standalone Antigravity Desktop installation.' `
        -Fix 'Ensure official Antigravity Desktop is installed, or run: .\launch-antigravity.ps1 -AsarPath "C:\path\to\app.asar"'
    exit 1
}

$exePath = Join-Path (Split-Path (Split-Path $status.asarPath -Parent) -Parent) 'Antigravity.exe'
if (-not (Test-Path $exePath)) {
    Write-Failure -Code 'EXE_NOT_FOUND' `
        -Message "Antigravity.exe not found at $exePath" `
        -Cause 'The application binary alongside resources\app.asar is missing or corrupted.' `
        -Fix 'Repair or reinstall Antigravity Desktop (user data in %APPDATA%\Antigravity stays safe).'
    exit 1
}

if ($status.state -eq 'corrupt') {
    if ($status.backupState -eq 'clean') {
        Write-Host "[antigravity-persian-rtl] Detected damaged app.asar with clean backup available." -ForegroundColor Yellow
        if ($status.running) {
            Stop-RunningAntigravity -PromptText 'Close Antigravity and restore from clean backup before re-patching?' -ForceAuto:$AutoClose
        }
        & $nodeExe $patcherJs restore @pathArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $statusRaw = & $nodeExe $patcherJs status --json @pathArgs
        $status = $statusRaw | ConvertFrom-Json
    } else {
        Write-Failure -Code 'CORRUPT_ASAR' `
            -Message 'Antigravity app.asar appears damaged and has no clean backup.' `
            -Cause ($status.corruptReason) `
            -Fix 'Reinstall Antigravity Desktop (your conversations and settings in %APPDATA%\Antigravity remain intact).'
        exit 1
    }
}

if ($status.state -ne 'patched') {
    if ($status.running) {
        Stop-RunningAntigravity -PromptText "Close Antigravity (patch state: $($status.state)), apply hardened RTL patch, and relaunch?" -ForceAuto:$AutoClose
    }
    Write-Host "[antigravity-persian-rtl] Applying hardened RTL patch..." -ForegroundColor Cyan
    & $nodeExe $patcherJs patch --if-needed @pathArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Start-Process -FilePath $exePath -WorkingDirectory (Split-Path $exePath -Parent)
