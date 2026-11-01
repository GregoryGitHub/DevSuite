# Site do app Notas (PWA) em dist-web/ — ver tools/build_web.mjs. Publicar: firebase deploy --only hosting
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node tools/build_web.mjs
if ($LASTEXITCODE -ne 0) { throw "build_web falhou ($LASTEXITCODE)" }
