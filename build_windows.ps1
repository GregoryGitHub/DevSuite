$ErrorActionPreference = 'Stop'
$env:CARGO_HTTP_CHECK_REVOKE = 'false'
Set-Location $PSScriptRoot

Write-Host "=== Iniciando Build de Release para Windows ===" -ForegroundColor Green

$hasCli = Get-Command cargo-tauri -ErrorAction SilentlyContinue
if (-not $hasCli) {
    Write-Host "Instalando tauri-cli..." -ForegroundColor Yellow
    cargo install tauri-cli --version '^2.0' --locked
}

if (Test-Path "_gen_icons.ps1") {
    Write-Host "Gerando ícones..." -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot '_gen_icons.ps1')
}

# CLI `devsuite`: vai no instalador ao lado do app (e no PATH do usuário, pelo hook do NSIS).
& (Join-Path $PSScriptRoot 'build_cli.ps1')

Write-Host "Executando cargo tauri build..." -ForegroundColor Yellow
cargo tauri build --config src-tauri/tauri.release.conf.json

Write-Host ""
Write-Host "=== Build para Windows concluído com sucesso! ===" -ForegroundColor Green
Write-Host "Arquivos e empacotamento gerados em: src-tauri\target\release\bundle\" -ForegroundColor Cyan
