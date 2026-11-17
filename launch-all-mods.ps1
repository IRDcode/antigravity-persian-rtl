param(
    [ValidateSet('launch', 'restore', 'doctor')]
    [string]$Action = 'launch',
    [string]$AsarPath = '',
    [switch]$AutoClose
)

$ErrorActionPreference = 'Stop'
$modDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$parentDir = Split-Path -Parent $modDir
$parentLauncher = Join-Path $parentDir 'launch-all-antigravity-mods.ps1'

if (Test-Path $parentLauncher) {
    & $parentLauncher -Action $Action -AsarPath $AsarPath -AutoClose:$AutoClose
    exit $LASTEXITCODE
}

# Standalone sibling-discovery mode when placed inside antigravity-rtl
$discovered = @($modDir)
$siblingContext = Get-ChildItem -Path $parentDir -Directory -Filter 'antigravity-*' -ErrorAction SilentlyContinue | Where-Object {
    $_.FullName -ne $modDir -and (Test-Path (Join-Path $_.FullName 'src\patcher.mjs'))
} | Sort-Object Name
foreach ($s in $siblingContext) {
    $discovered += $s.FullName
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $nodeExe)) {
    Write-Host "[antigravity-mods-suite] ERROR: Node.js 20+ not found." -ForegroundColor Red
    exit 1
}

$pathArgs = @()
if ($AsarPath) { $pathArgs = @('--path', $AsarPath) }

if ($Action -eq 'doctor') {
    $code = 0
    foreach ($dir in $discovered) {
        Write-Host "`n=== $(Split-Path -Leaf $dir) ===" -ForegroundColor White
        & $nodeExe (Join-Path $dir 'src\patcher.mjs') doctor @pathArgs
        if ($LASTEXITCODE -ne 0) { $code = 1 }
    }
    exit $code
}

if ($Action -eq 'restore') {
    if (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) {
        if (-not $AutoClose) {
            $ans = Read-Host "Close Antigravity Desktop and restore all mods? (Y/N)"
            if ($ans -notmatch '^[Yy]') { exit 0 }
        }
        Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
        Start-Sleep -Seconds 2
        Stop-Process -Name 'Antigravity' -Force -ErrorAction SilentlyContinue
    }
    [array]::Reverse($discovered)
    foreach ($dir in $discovered) {
        & $nodeExe (Join-Path $dir 'src\patcher.mjs') restore @pathArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    exit 0
}

$statuses = @()
foreach ($dir in $discovered) {
    $st = (& $nodeExe (Join-Path $dir 'src\patcher.mjs') status --json @pathArgs) | ConvertFrom-Json
    $statuses += [PSCustomObject]@{ Dir = $dir; Status = $st }
}

$primary = $statuses[0].Status
if (-not $primary.exists) {
    Write-Host "[antigravity-mods-suite] ERROR: Antigravity app.asar not found." -ForegroundColor Red
    exit 1
}

$needsPatch = ($statuses | Where-Object { $_.Status.state -ne 'patched' }).Count -gt 0
if ($needsPatch -and $primary.running) {
    if (-not $AutoClose) {
        $ans = Read-Host "Close Antigravity Desktop, apply all discovered mods, and relaunch? (Y/N)"
        if ($ans -notmatch '^[Yy]') { exit 0 }
    }
    Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
    Start-Sleep -Seconds 2
    Stop-Process -Name 'Antigravity' -Force -ErrorAction SilentlyContinue
}

foreach ($entry in $statuses) {
    $hasSidecarPending = ($null -ne $entry.Status.PSObject.Properties['sidecarInstalled'] -and (-not $entry.Status.sidecarInstalled))
    if ($entry.Status.state -ne 'patched' -or $hasSidecarPending) {
        & $nodeExe (Join-Path $entry.Dir 'src\patcher.mjs') patch --if-needed @pathArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}

$exePath = Join-Path (Split-Path (Split-Path $primary.asarPath -Parent) -Parent) 'Antigravity.exe'
if (Test-Path $exePath) {
    Start-Process -FilePath $exePath -WorkingDirectory (Split-Path $exePath -Parent)
}
