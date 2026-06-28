# Download the SDB (Smart Development Bridge) binary from Samsung's Tizen SDK
# and place it in src-tauri/binaries/ with the correct Tauri sidecar naming convention.
# Run this once before `npm run build` on Windows.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\download-sdb.ps1

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir     = Join-Path $ScriptDir "..\src-tauri\binaries"
$TmpDir     = Join-Path $env:TEMP "sdb-download-$(Get-Random)"
$ZipPath    = Join-Path $TmpDir "sdb.zip"
$Url        = "https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.36_windows-64.zip"

New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null
New-Item -ItemType Directory -Force -Path $TmpDir  | Out-Null

Write-Host "Downloading SDB from $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

Write-Host "Extracting ..."
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force

$SdbSrc = Get-ChildItem -Recurse -Path $TmpDir -Filter "sdb.exe" | Select-Object -First 1 -ExpandProperty FullName

if (-not $SdbSrc) {
    Write-Host "ERROR: Could not find sdb.exe in downloaded package."
    Remove-Item -Recurse -Force $TmpDir
    exit 1
}

$Dst = Join-Path $BinDir "sdb-x86_64-pc-windows-msvc.exe"
Copy-Item -Path $SdbSrc -Destination $Dst -Force
Remove-Item -Recurse -Force $TmpDir

Write-Host ""
Write-Host "Done! SDB binary placed at:"
Write-Host "  $Dst"
Write-Host ""
Write-Host "You can now run: npm run build"
