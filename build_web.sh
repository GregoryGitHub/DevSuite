#!/usr/bin/env bash
# Site do app Notas (PWA) em dist-web/ — ver tools/build_web.mjs. Publicar: firebase deploy --only hosting
set -euo pipefail
cd "$(dirname "$0")"
node tools/build_web.mjs
