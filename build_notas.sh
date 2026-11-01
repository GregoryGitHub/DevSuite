#!/usr/bin/env bash
# Build de release do app "Notas" (só as Notas, sem a CLI e os outros apps do Dev Suite).
# Desktop: src-tauri/target/release/bundle/. Web (PWA): ./build_web.sh + firebase deploy --only hosting
set -euo pipefail
cd "$(dirname "$0")"
command -v cargo-tauri >/dev/null || cargo install tauri-cli --version '^2.0' --locked
cargo tauri build --config src-tauri/tauri.notas.conf.json -- --no-default-features
echo "Notas: instaladores em src-tauri/target/release/bundle/"
