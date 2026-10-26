#!/usr/bin/env bash
# Compila a CLI `devsuite` (src-tauri/cli) e a coloca em src-tauri/binaries/devsuite-<target>[.exe],
# onde o `cargo tauri build --config src-tauri/tauri.release.conf.json` a empacota (externalBin).
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
EXT=""
case "$TARGET" in *windows*) EXT=".exe" ;; esac

echo "Compilando a CLI devsuite ($TARGET)..."
cargo build --release -p devsuite-cli --target "$TARGET" --manifest-path src-tauri/Cargo.toml
mkdir -p src-tauri/binaries
cp "src-tauri/target/$TARGET/release/devsuite$EXT" "src-tauri/binaries/devsuite-$TARGET$EXT"
