// Monta o site do app Notas (PWA) em dist-web/ para o Firebase Hosting:
//   node tools/build_web.mjs        (ou build_web.ps1 / build_web.sh)
//   firebase deploy --only hosting
// Sem bundler: copia os ES modules de src/ como estão. notes.html vira index.html e a página
// do Dev Suite (de onde notes-main.js tira a markup das Notas) é publicada como suite.html.
// Gera precache.js com a lista de arquivos e uma versão (hash): o service worker baixa tudo
// na instalação (o app abre offline) e troca o cache quando a versão muda.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const out = join(root, "dist-web");

const FILES = ["notes-main.js", "sw.js", "manifest.webmanifest", "theme.css", "styles.css", "notes.css", "zettel.css", "git.css", "code.css", "http.css", "db.css", "notas.css"];
const DIRS = ["js", "vendor", "icons"];
// Partes do Dev Suite que o app Notas nunca carrega.
const SKIP = [/^js[\\/]cli[\\/]/, /^icons[\\/].*\.svg$/];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of FILES) cpSync(join(src, f), join(out, f));
for (const d of DIRS) cpSync(join(src, d), join(out, d), { recursive: true, filter: (p) => !SKIP.some((re) => re.test(relative(src, p))) });

const notes = readFileSync(join(src, "notes.html"), "utf8").replace('data-edition="notas"', 'data-edition="notas" data-template="suite.html"');
if (!notes.includes('data-template="suite.html"')) throw new Error("notes.html sem data-edition=\"notas\"");
writeFileSync(join(out, "index.html"), notes);
cpSync(join(src, "index.html"), join(out, "suite.html"));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(out).map((p) => relative(out, p).split(sep).join("/")).filter((f) => f !== "sw.js").sort();
const hash = createHash("sha256");
for (const f of files) hash.update(f).update(readFileSync(join(out, f)));
const version = hash.digest("hex").slice(0, 12);
// "./" = a própria página (navegação para a raiz do site).
writeFileSync(join(out, "precache.js"), `self.NOTAS_PRECACHE = ${JSON.stringify({ version, files: ["./", ...files] }, null, 1)};\n`);

const size = files.reduce((n, f) => n + statSync(join(out, f)).size, 0);
console.log(`dist-web: ${files.length} arquivos, ${(size / 1024 / 1024).toFixed(1)} MB, versão ${version}`);
if (!existsSync(join(out, "vendor", "firebase", "firebase-app.js"))) throw new Error("Firebase SDK ausente em src/vendor/firebase");
