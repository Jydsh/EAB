#requires -Version 7
# 生成 EAB 安装器所需的 ICO / BMP / PNG。只依赖 Windows 自带的 System.Drawing。
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\assets')
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Mark($g, [float]$x, [float]$y, [float]$size, [bool]$darkText = $false) {
  $path = New-RoundedPath $x $y $size $size ($size * 0.18)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new($x, $y),
    [System.Drawing.PointF]::new($x + $size, $y + $size),
    [System.Drawing.Color]::FromArgb(255, 11, 107, 93),
    [System.Drawing.Color]::FromArgb(255, 20, 154, 128)
  )
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
  $textColor = if ($darkText) { [System.Drawing.Color]::FromArgb(255, 8, 74, 64) } else { [System.Drawing.Color]::White }
  $font = [System.Drawing.Font]::new('Arial', [Math]::Max(6, $size * 0.34), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = [System.Drawing.SolidBrush]::new($textColor)
  $fmt = [System.Drawing.StringFormat]::new()
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = [System.Drawing.RectangleF]::new($x, $y + $size * 0.02, $size, $size)
  $g.DrawString('EAB', $font, $textBrush, $rect, $fmt)
  $fmt.Dispose(); $textBrush.Dispose(); $font.Dispose()
}

function New-IconPng([int]$size) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)
  Draw-Mark $g 0 0 $size $false
  $g.Dispose()
  $ms = [System.IO.MemoryStream]::new()
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return $ms.ToArray()
}

function New-Ico([string]$path) {
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = foreach ($s in $sizes) { New-IconPng $s }
  $headerSize = 6 + (16 * $sizes.Count)
  $ms = [System.IO.MemoryStream]::new()
  $w = [System.IO.BinaryWriter]::new($ms)
  $w.Write([UInt16]0)
  $w.Write([UInt16]1)
  $w.Write([UInt16]$sizes.Count)
  $offset = $headerSize
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $w.Write([byte]0)
    $w.Write([byte]0)
    $w.Write([UInt16]1)
    $w.Write([UInt16]32)
    $w.Write([UInt32]$images[$i].Length)
    $w.Write([UInt32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($img in $images) { $w.Write($img) }
  $w.Flush()
  [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
  $w.Dispose(); $ms.Dispose()
}

function New-WizardBmp([string]$path) {
  $bmp = [System.Drawing.Bitmap]::new(164, 314, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $rect = [System.Drawing.Rectangle]::new(0, 0, 164, 314)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 8, 78, 69),
    [System.Drawing.Color]::FromArgb(255, 18, 145, 122),
    90
  )
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38, 255, 255, 255)), -48, 214, 220, 220)
  $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(22, 255, 255, 255)), 82, -60, 180, 180)
  Draw-Mark $g 42 38 80 $false
  $font = [System.Drawing.Font]::new('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $b = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $fmt = [System.Drawing.StringFormat]::new()
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('企业智能体基座', $font, $b, [System.Drawing.RectangleF]::new(0, 132, 164, 28), $fmt)
  $font2 = [System.Drawing.Font]::new('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $b2 = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(205, 255, 255, 255))
  $g.DrawString('WINDOWS 客户端', $font2, $b2, [System.Drawing.RectangleF]::new(0, 162, 164, 22), $fmt)
  $fmt.Dispose(); $b2.Dispose(); $b.Dispose(); $font2.Dispose(); $font.Dispose()
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
}

function New-HeaderBmp([string]$path) {
  $bmp = [System.Drawing.Bitmap]::new(150, 57, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::White)
  Draw-Mark $g 2 8 40 $false
  $font = [System.Drawing.Font]::new('Arial', 18, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $b = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 19, 38, 35))
  $g.DrawString('EAB', $font, $b, 50, 10)
  $font2 = [System.Drawing.Font]::new('Microsoft YaHei UI', 8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $b2 = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 97, 117, 112))
  $g.DrawString('桌面客户端', $font2, $b2, 94, 17)
  $b2.Dispose(); $font2.Dispose(); $b.Dispose(); $font.Dispose()
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
}

New-Ico (Join-Path $OutDir 'eab.ico')
New-WizardBmp (Join-Path $OutDir 'wizard.bmp')
New-HeaderBmp (Join-Path $OutDir 'header.bmp')
$png = New-IconPng 256
[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'eab.png'), $png)
Write-Output "Installer assets written to $OutDir"
