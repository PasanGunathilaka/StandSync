/**
 * Generates the two PNG icons the Teams app package requires, from the branded
 * master in appPackage/brand/.
 *
 *   color.png    192x192  the full-colour mark, as designed
 *   outline.png   32x32   white silhouette on transparent (Teams tints it)
 *
 * Both are derived from one source of truth (standsync-icon-1024.png) so the
 * package is reproducible from the repository.
 *
 * The outline is produced by masking rather than redrawing: the brand mark sits
 * on a blue gradient tile, so "blueness" (B - max(R,G)) separates background
 * from foreground cleanly — measured on the master: background ~+103, the white
 * ring 0, the green check -58. Masking keeps the real geometry and its
 * anti-aliasing instead of approximating the artwork with hand-drawn shapes.
 *
 * Rendering uses System.Drawing via PowerShell, the same way the packaging
 * script shells out for zipping — no image dependencies are added to the project.
 *
 * Usage: npm run teams:icons
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MASTER = 'appPackage/brand/standsync-icon-1024.png';
const COLOR_OUT = 'appPackage/color.png';
const OUTLINE_OUT = 'appPackage/outline.png';

/** Blueness at or below this is fully foreground; at or above BG_MAX is background. */
const FG_MAX = 30;
const BG_MIN = 90;

if (!existsSync(MASTER)) {
  console.error(`\nBrand master not found: ${MASTER}\n`);
  process.exit(1);
}

mkdirSync('appPackage', { recursive: true });

const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$master  = [System.Drawing.Bitmap]::FromFile('${resolve(MASTER).replace(/\\/g, '\\\\')}')

# ---- color.png : high-quality downscale of the master, unchanged artwork ----
$color = New-Object System.Drawing.Bitmap 192, 192
$g = [System.Drawing.Graphics]::FromImage($color)
$g.CompositingMode    = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($master, (New-Object System.Drawing.Rectangle 0, 0, 192, 192))
$g.Dispose()
$color.Save('${resolve(COLOR_OUT).replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$color.Dispose()

# ---- outline.png : mask the mark to white-on-transparent, then box-average ----
# 1024 -> 32 is an exact 32x reduction, so a box average is a clean downsample
# that preserves thin strokes better than interpolation would.
$size  = 32
$block = $master.Width / $size          # 32
$out   = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

# Read the master once into a byte array; GetPixel per pixel is far too slow.
$rect = New-Object System.Drawing.Rectangle 0, 0, $master.Width, $master.Height
$data = $master.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $master.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$master.UnlockBits($data)
$stride = $data.Stride

for ($oy = 0; $oy -lt $size; $oy++) {
  for ($ox = 0; $ox -lt $size; $ox++) {
    $sum = 0.0
    for ($dy = 0; $dy -lt $block; $dy++) {
      $row = ((($oy * $block) + $dy) * $stride)
      for ($dx = 0; $dx -lt $block; $dx++) {
        $i = $row + ((($ox * $block) + $dx) * 4)   # BGRA
        $b = $bytes[$i]; $gg = $bytes[$i+1]; $r = $bytes[$i+2]; $a = $bytes[$i+3]
        if ($a -eq 0) { continue }                  # rounded-corner transparency
        $maxRG = [Math]::Max($r, $gg)
        $blueness = $b - $maxRG
        if ($blueness -le ${FG_MAX}) { $fg = 1.0 }
        elseif ($blueness -ge ${BG_MIN}) { $fg = 0.0 }
        else { $fg = 1.0 - (($blueness - ${FG_MAX}) / (${BG_MIN} - ${FG_MAX})) }
        $sum += $fg * ($a / 255.0)
      }
    }
    $alpha = [int][Math]::Round(255.0 * $sum / ($block * $block))
    if ($alpha -gt 255) { $alpha = 255 }
    $out.SetPixel($ox, $oy, [System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
  }
}

$out.Save('${resolve(OUTLINE_OUT).replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
$master.Dispose()
Write-Output 'icons written'
`;

execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });

console.log(`Wrote ${COLOR_OUT} (192x192) and ${OUTLINE_OUT} (32x32, white on transparent)`);
console.log(`Source: ${MASTER}`);
