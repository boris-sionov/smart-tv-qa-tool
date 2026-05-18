# Download the SDB (Smart Development Bridge) binary from Samsung's Tizen SDK
# and install it to %USERPROFILE%\tizen-studio\tools\sdb.exe
# (the default location the app looks in on Windows).
#
# Run this once before using Samsung Tizen features.
# If download fails, install Tizen Studio from:
#   https://developer.samsung.com/tizen/overview.html
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\download-sdb.ps1

$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:USERPROFILE "tizen-studio\tools"
$Dst        = Join-Path $InstallDir "sdb.exe"
$TmpDir     = Join-Path $env:TEMP "sdb-download-$(Get-Random)"
$ZipPath    = Join-Path $TmpDir "sdb.zip"
$Url        = "https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.12_windows.zip"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $TmpDir     | Out-Null

Write-Host "Downloading SDB from $Url ..."

try {
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "ERROR: Download failed."
    Write-Host ""
    Write-Host "Please install Tizen Studio manually:"
    Write-Host "  https://developer.samsung.com/tizen/overview.html"
    Write-Host ""
    Write-Host "After installing, SDB will be at:"
    Write-Host "  %USERPROFILE%\tizen-studio\tools\sdb.exe"
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Extracting ..."
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force

# Find sdb.exe inside the extracted archive
$SdbSrc = Get-ChildItem -Recurse -Path $TmpDir -Filter "sdb.exe" | Select-Object -First 1 -ExpandProperty FullName

if (-not $SdbSrc) {
    Write-Host "ERROR: Could not find sdb.exe in downloaded package."
    Remove-Item -Recurse -Force $TmpDir
    exit 1
}

Copy-Item -Path $SdbSrc -Destination $Dst -Force
Remove-Item -Recurse -Force $TmpDir

Write-Host ""
Write-Host "Done! SDB installed at: $Dst"
Write-Host ""
Write-Host "Verify with:  & `"$Dst`" version"
Write-Host ""
Write-Host "You can now use Samsung Tizen features in the app."
