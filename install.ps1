# Installs PixelForge for the current user (no admin rights needed):
#   copies it to %LOCALAPPDATA%\Programs\PixelForge and adds a Start menu shortcut.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1             # install
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Desktop    # also add a desktop shortcut
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall  # remove (keeps your projects)
param([switch]$Desktop, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'Programs\PixelForge'
$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'PixelForge.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PixelForge.lnk'

if ($Uninstall) {
    if (Get-Process PixelForge -ErrorAction SilentlyContinue) { throw 'Close PixelForge first, then run this again.' }
    foreach ($p in @($dest, $startLink, $desktopLink)) { if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
    Write-Host 'PixelForge was removed. Your projects in Documents\PixelForge were kept.'
    return
}

if (-not (Test-Path (Join-Path $src 'PixelForge.exe'))) { & (Join-Path $src 'build.ps1') }
if (Get-Process PixelForge -ErrorAction SilentlyContinue) { throw 'Close PixelForge first, then run this again.' }

New-Item -ItemType Directory -Force $dest | Out-Null
if (Test-Path (Join-Path $dest 'app')) { Remove-Item (Join-Path $dest 'app') -Recurse -Force }
Copy-Item (Join-Path $src 'PixelForge.exe') $dest -Force
Copy-Item (Join-Path $src 'app') $dest -Recurse -Force

function New-Shortcut([string]$path) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = Join-Path $dest 'PixelForge.exe'
    $lnk.WorkingDirectory = $dest
    $lnk.IconLocation = (Join-Path $dest 'PixelForge.exe') + ',0'
    $lnk.Description = 'PixelForge 2D game maker'
    $lnk.Save()
}
New-Shortcut $startLink
if ($Desktop) { New-Shortcut $desktopLink }

Write-Host "Installed to $dest"
Write-Host 'Start it from the Start menu: PixelForge'
