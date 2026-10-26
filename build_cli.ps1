# Compila a CLI `devsuite` (src-tauri/cli) e a coloca em src-tauri/binaries/devsuite-<target>.exe,
# onde o `cargo tauri build --config src-tauri/tauri.release.conf.json` a empacota (externalBin).
param([string]$Target = "")
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $Target) {
    $Target = ((rustc -vV) | Select-String '^host: ').ToString().Substring(6).Trim()
}
Write-Host "Compilando a CLI devsuite ($Target)..." -ForegroundColor Yellow
cargo build --release -p devsuite-cli --target $Target --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar a CLI" }

New-Item -ItemType Directory -Force src-tauri/binaries | Out-Null
Copy-Item "src-tauri/target/$Target/release/devsuite.exe" "src-tauri/binaries/devsuite-$Target.exe" -Force
