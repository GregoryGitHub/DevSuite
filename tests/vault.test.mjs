// Testes do modo cofre das Notas (nomes de arquivo, caminhos, metadados): node tests/vault.test.mjs
// A conversão HTML <-> Markdown precisa de DOM e é a mesma da importação/exportação.
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const v = await import(base + "vaultNote.js");
const nc = await import(base + "noteContent.js");

// --- nomes iguais aos do Rust (safe_name em notes_vault.rs)
assert.equal(v.safeName("a/b: c?", "x"), "ab c");
assert.equal(v.safeName("  ...  ", "Nova Nota"), "Nova Nota");
assert.equal(v.safeName("con", "x"), "con_");
assert.equal(v.safeName("fim.", "x"), "fim");
assert.equal(v.safeName("Reunião   de\tquinta", "x"), "Reunião de quinta");
assert.equal(v.safeName("a".repeat(100), "x").length, 80);

// --- diretório de uma pasta do app
const folders = [
  { id: 1, name: "Projetos", parent_id: 0 },
  { id: 2, name: "CI/CD", parent_id: 1 },
];
assert.equal(v.folderDir(folders, 2), "Projetos/CICD");
assert.equal(v.folderDir(folders, 0), "");
assert.equal(v.dirOf("a/b/Nota.md"), "a/b");
assert.equal(v.dirOf("Nota.md"), "");

// --- caminhos relativos das imagens
assert.equal(v.relPath("", "attachments/x.png"), "attachments/x.png");
assert.equal(v.relPath("Projetos/Rust", "attachments/x.png"), "../../attachments/x.png");
assert.equal(v.relPath("Projetos", "Projetos/img/a.png"), "img/a.png");
assert.equal(v.relPath("a/b", "a/c/d.png"), "../c/d.png");

// --- URLs das imagens do cofre
const url = nc.vaultImageUrl("img/foto 1#.png");
assert.match(url, /\/v\/img\/foto%201%23\.png$/);
assert.equal(nc.vaultImageRel(url), "img/foto 1#.png");
assert.equal(nc.vaultImageRel("https://x/v/a.png"), null);
assert.equal(nc.localImageName(url), null);

// --- índice para imagens pelo nome (![[x.png]]) e caminhos relativos
const index = v.vaultLookupIndex(["attachments/x.png", "Projetos/img/a.png"], ["Projetos/Nota.md"]);
const { vaultImageLookup } = await import(base + "mdImport.js");
const look = vaultImageLookup(index, "Projetos/Nota.md");
assert.equal(look("x.png"), "attachments/x.png");
assert.equal(look("img/a.png"), "Projetos/img/a.png");
assert.equal(look("../attachments/x.png"), "attachments/x.png");
assert.equal(look("https://x/y.png"), null);

// --- metadados: front-matter vira props e created_at
const meta = v.vaultMeta({ id: 1, created_at: "2020-01-01T00:00:00.000Z", front_matter: "tags:\n  - a/b\ncreated: 2024-03-05\nautor: Ana" });
assert.deepEqual(meta.props.tags, ["a/b"]);
assert.equal(meta.props.author, "Ana");
assert.equal(meta.created_at.slice(0, 10), "2024-03-05");
assert.equal(v.vaultMeta({ id: 2, created_at: "x", front_matter: "" }).props, null);
assert.equal(v.vaultMeta({ id: 2, created_at: "x", front_matter: "" }).created_at, "x");

// --- fixada: o front-matter é a verdade (vale para todos que abrem o cofre)
assert.equal(v.vaultMeta({ id: 3, pinned: 5, front_matter: "tags: [a]" }).pinned, 0);
assert.equal(v.vaultMeta({ id: 3, front_matter: "pinned: 4" }).pinned, 4);
assert.equal(v.vaultMeta({ id: 3, front_matter: "Pinned: true" }).pinned, 1);

// --- lista de cofres (troca rápida na barra lateral)
const W = (p) => p.replace(/\//g, "\\"); // caminhos do Windows sem escapes
assert.ok(v.sameVaultPath(W("C:/Notas/"), W("c:/notas")));
assert.equal(v.vaultName(W("//srv/equipe/Notas/")), "Notas");
assert.equal(v.vaultName("/home/ana/notas"), "notas");
assert.deepEqual(v.addVaultPath([W("C:/A"), W("C:/B")], W("c:/b/")), [W("c:/b"), W("C:/A")]);
assert.deepEqual(v.knownVaults({ vaults: [W("C:/A")], vault_path: W("D:/X") }), [W("C:/A"), W("D:/X")]);
assert.deepEqual(v.knownVaults({ vaults: [W("C:/A")], vault_path: W("c:/a") }), [W("C:/A")]);
assert.deepEqual(v.vaultLabels([W("C:/x/Notas"), W("D:/Notas"), W("E:/Outro")]), [W("C:/x/Notas"), W("D:/Notas"), "Outro"]);

console.log("vault ok");
