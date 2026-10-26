#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Iniciando Build de Release para Windows (Cross-compilation) ==="

if ! command -v cargo-tauri &> /dev/null && ! cargo tauri --version &> /dev/null; then
    echo "Instalando tauri-cli..."
    cargo install tauri-cli --version '^2.0' --locked
fi

rustup target add x86_64-pc-windows-gnu 2>/dev/null || true

./build_cli.sh x86_64-pc-windows-gnu

echo "Executando cargo tauri build --target x86_64-pc-windows-gnu..."
cargo tauri build --target x86_64-pc-windows-gnu --config src-tauri/tauri.release.conf.json

echo ""
echo "=== Build concluído com sucesso! ==="
echo "Arquivos gerados em: src-tauri/target/x86_64-pc-windows-gnu/release/"
