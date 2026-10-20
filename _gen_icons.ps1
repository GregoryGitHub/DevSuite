$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Gera todos os ícones do bundle (png, ico, icns, Store/Android/iOS) a partir do SVG da raiz.
$sourcePath = Join-Path $PSScriptRoot 'dev-suite.svg'
if (-not (Test-Path $sourcePath)) {
    throw "Ícone fonte não encontrado em $sourcePath"
}

Write-Host "Gerando ícones a partir de $sourcePath..."
cargo tauri icon $sourcePath -o (Join-Path $PSScriptRoot 'src-tauri\icons')
if ($LASTEXITCODE -ne 0) { throw "cargo tauri icon falhou ($LASTEXITCODE)" }

$iconsDir = Join-Path $PSScriptRoot 'src-tauri\icons'

# Converte um SVG em PNGs nos tamanhos pedidos; devolve a pasta temporária com "<n>x<n>.png".
function Render-Svg($svg, $sizes) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("devsuite-icon-" + [System.IO.Path]::GetFileNameWithoutExtension($svg))
    cargo tauri icon $svg -o $tmp -p $sizes 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri icon falhou para $svg ($LASTEXITCODE)" }
    return $tmp
}

# Bandeja (monocromático): tray_white.png (64 px, embutido no main.rs) + 32/64/128.
foreach ($name in 'tray_white', 'tray_dark') {
    $tmp = Render-Svg (Join-Path $iconsDir "$name.svg") '32,64,128'
    Copy-Item (Join-Path $tmp '64x64.png') (Join-Path $iconsDir "$name.png") -Force
    foreach ($size in 32, 64, 128) {
        Copy-Item (Join-Path $tmp "${size}x${size}.png") (Join-Path $iconsDir "${name}_$size.png") -Force
    }
    Remove-Item $tmp -Recurse -Force
}

# Ícones das janelas desatachadas (src-tauri/icons/apps/<app>.svg -> <app>.png 256px + <app>.ico).
$appsDir = Join-Path $iconsDir 'apps'
foreach ($svg in Get-ChildItem $appsDir -Filter *.svg) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("devsuite-icon-" + $svg.BaseName)
    cargo tauri icon $svg.FullName -o $tmp 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri icon falhou para $($svg.Name) ($LASTEXITCODE)" }
    Copy-Item (Join-Path $tmp '128x128@2x.png') (Join-Path $appsDir "$($svg.BaseName).png") -Force
    Copy-Item (Join-Path $tmp 'icon.ico') (Join-Path $appsDir "$($svg.BaseName).ico") -Force
    Remove-Item $tmp -Recurse -Force
}
Write-Host "Done."
