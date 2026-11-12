#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# Força o build.rs a regravar data/commit da build (Configurações → Sobre) a cada execução.
export DEVSUITE_BUILD_STAMP="$(date +%Y%m%d%H%M%S)"

echo "=== Iniciando Build de Release para Linux ==="

if ! command -v cargo-tauri &> /dev/null && ! cargo tauri --version &> /dev/null; then
    echo "Instalando tauri-cli..."
    cargo install tauri-cli --version '^2.0' --locked
fi

# CLI `devsuite`: o .deb/.rpm a instalam em /usr/bin ao lado do app.
./build_cli.sh

echo "Executando cargo tauri build..."
cargo tauri build --config src-tauri/tauri.release.conf.json

echo ""
echo "=== Build para Linux concluído com sucesso! ==="
echo "Arquivos e empacotamento gerados em: src-tauri/target/release/bundle/"
