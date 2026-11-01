# Build de release do app "Notas" (só as Notas, sem a CLI e os outros apps do Dev Suite).
# Desktop: src-tauri\target\release\bundle\. Web (PWA): ./build_web.ps1 + firebase deploy --only hosting
$ErrorActionPreference = 'Stop'
$env:CARGO_HTTP_CHECK_REVOKE = 'false'
Set-Location $PSScriptRoot

$hasCli = Get-Command cargo-tauri -ErrorAction SilentlyContinue
if (-not $hasCli) {
    cargo install tauri-cli --version '^2.0' --locked
}

cargo tauri build --config src-tauri/tauri.notas.conf.json -- --no-default-features
if ($LASTEXITCODE -ne 0) { throw "cargo tauri build falhou ($LASTEXITCODE)" }
Write-Host "Notas: instaladores em src-tauri\target\release\bundle\" -ForegroundColor Cyan
