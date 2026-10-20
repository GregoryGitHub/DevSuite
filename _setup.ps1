$ErrorActionPreference = 'Stop'
$env:CARGO_HTTP_CHECK_REVOKE = 'false'
Set-Location $PSScriptRoot

$hasCli = Get-Command cargo-tauri -ErrorAction SilentlyContinue
if (-not $hasCli) {
    Write-Host "Installing tauri-cli..."
    cargo install tauri-cli --version '^2.0' --locked
}

Write-Host "Generating icons from dev-suite.svg..."
& (Join-Path $PSScriptRoot '_gen_icons.ps1')
