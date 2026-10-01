# Builds PixelForge.exe with the C# compiler that ships with Windows (.NET Framework 4).
# Nothing needs to be installed. Run:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Add-Type -AssemblyName System.Drawing

# ---------- Icon ----------
# Draws the PixelForge logo (a 20x20 pixel design) at one size and returns PNG bytes.
function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $k = $size / 20.0
    $rects = @(
        @('#5b8cff', 0, 0, 20, 20), @('#29366f', 0, 15, 20, 5), @('#ffd23f', 13, 4, 4, 4),
        @('#1a1c2c', 4, 7, 6, 8), @('#ffcd75', 5, 4, 4, 4), @('#e43b44', 4, 3, 6, 2))
    foreach ($r in $rects) {
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($r[0]))
        $g.FillRectangle($brush, [float]($r[1] * $k), [float]($r[2] * $k), [float]($r[3] * $k), [float]($r[4] * $k))
        $brush.Dispose()
    }
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

# An .ico file is a small directory of images; modern Windows accepts PNG images inside it.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($s in $sizes) { $pngs.Add((New-IconPng $s)) }
$iconPath = Join-Path $PSScriptRoot 'launcher\PixelForge.ico'
$fs = [System.IO.File]::Create($iconPath)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($d in $pngs) { $w.Write($d) }
$w.Close()

# ---------- Compile ----------
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'The .NET Framework C# compiler (csc.exe) was not found.' }

& $csc /nologo /optimize+ /target:winexe /out:PixelForge.exe "/win32icon:$iconPath" `
    /r:System.Windows.Forms.dll /r:Microsoft.VisualBasic.dll launcher\PixelForge.cs
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Built $(Join-Path $PSScriptRoot 'PixelForge.exe')"
