# Download the ADB binary from Android platform-tools and place it in
# src-tauri/binaries/ with the correct Tauri sidecar naming convention.
# Run this once before `npm run build` on Windows.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\download-adb.ps1

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir     = Join-Path $ScriptDir "..\src-tauri\binaries"
$TmpDir     = Join-Path $env:TEMP "adb-download-$(Get-Random)"
$ZipPath    = Join-Path $TmpDir "platform-tools.zip"
$Url        = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"

New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null
New-Item -ItemType Directory -Force -Path $TmpDir  | Out-Null

Write-Host "Downloading platform-tools from $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

Write-Host "Extracting ..."
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force

$Src = Join-Path $TmpDir "platform-tools\adb.exe"
$Dst = Join-Path $BinDir "adb-x86_64-pc-windows-msvc.exe"

Copy-Item -Path $Src -Destination $Dst -Force

Remove-Item -Recurse -Force $TmpDir

Write-Host ""
Write-Host "Done! ADB binary placed at:"
Write-Host "  $Dst"
Write-Host ""
Write-Host "You can now run: npm run build"
