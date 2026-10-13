// Testes das subpastas (Notas e HTTP), da importação de pasta de Markdown e do Postman aninhado:
// node tests/folders.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const t = await import(base + "folderTree.js");
const mi = await import(base + "mdImport.js");
const { importPostman, exportPostman } = await import(base + "httpConvert.js");
const { normalizeCollection } = await import(base + "httpModel.js");
const { inlineMarkdown } = await import(base + "markdown.js");

// --- árvore
const folders = [
  { id: 1, name: "Projetos", parent_id: 0 },
  { id: 2, name: "Rust", parent_id: 1 },
  { id: 3, name: "Tauri", parent_id: 2 },
  { id: 4, name: "Pessoal", parent_id: 0 },
  { id: 5, name: "Go", parent_id: 1 },
];
assert.deepEqual(t.childrenOf(folders, 1).map((f) => f.id), [2, 5]);
assert.deepEqual([...t.descendantIds(folders, 1)].sort(), [1, 2, 3, 5]);
assert.deepEqual([...t.descendantIds(folders, 4)], [4]);
assert.equal(t.folderPath(folders, 3), "Projetos / Rust / Tauri");
assert.equal(t.folderPath(folders, 99), "");
assert.equal(t.folderDepth(folders, 3), 2);
assert.deepEqual(
  t.flattenTree(folders).map((e) => `${e.depth}:${e.folder.name}${e.hasChildren ? "+" : ""}`),
  ["0:Projetos+", "1:Rust+", "2:Tauri", "1:Go", "0:Pessoal"],
);
assert.deepEqual(t.flattenTree(folders, new Set([2])).map((e) => e.folder.id), [1, 2, 5, 4]);
assert.ok(t.canMoveFolder(folders, 3, 4));
assert.ok(t.canMoveFolder(folders, 2, 0));
assert.ok(!t.canMoveFolder(folders, 1, 3)); // para dentro da própria subpasta
assert.ok(!t.canMoveFolder(folders, 2, 2));

// Pais inexistentes e ciclos viram nível superior (sem laço infinito).
const broken = t.normalizeFolderTree([
  { id: 1, name: "A", parent_id: 2 },
  { id: 2, name: "B", parent_id: 1 },
  { id: 3, name: "C", parent_id: 77 },
  { id: 4, name: "D", parent_id: "1" },
]);
assert.equal(broken.find((f) => f.id === 3).parent_id, 0);
assert.ok(broken.filter((f) => f.id <= 2).some((f) => f.parent_id === 0));
assert.equal(t.flattenTree(broken).length, 4);
assert.equal(broken.find((f) => f.id === 4).parent_id, 1);

assert.equal(t.uniqueFolderName(folders, 1, "rust"), "rust 2");
assert.equal(t.uniqueFolderName(folders, 0, "Rust"), "Rust");

const list = folders.map((f) => ({ ...f }));
let next = 100;
const make = (name, parent_id) => {
  const f = { id: next++, name, parent_id };
  list.push(f);
  return f;
};
assert.equal(t.ensureFolderPath(list, 1, ["rust", "Novo", "Mais"], make), 101); // "rust" reaproveita a pasta 2
assert.equal(t.folderPath(list, 101), "Projetos / Rust / Novo / Mais");
assert.equal(t.ensureFolderPath(list, 1, ["Rust", "Novo"], make), 100); // reaproveita
assert.equal(t.ensureFolderPath(list, 4, [], make), 4);
const gone = t.removeFolderTree(list, 2);
assert.deepEqual([...gone].sort((a, b) => a - b), [2, 3, 100, 101]);
assert.deepEqual(list.map((f) => f.id), [1, 4, 5]);

// --- importação de pasta de Markdown
assert.deepEqual(mi.relDirs("a/b/nota.md"), ["a", "b"]);
assert.deepEqual(mi.relDirs("nota.md"), []);
assert.equal(mi.relStem("a/b/Minha nota.md"), "Minha nota");
assert.equal(mi.joinRel("a/b", "../img/x.png"), "a/img/x.png");
assert.equal(mi.joinRel("a", "./x.png"), "a/x.png");
assert.equal(mi.joinRel("", "../x.png"), null);

const scan = {
  name: "Vault",
  notes: [
    { rel: "Inicio.md", path: "C:\\V\\Inicio.md", text: "" },
    { rel: "Projetos/Rust/Tauri.md", path: "C:\\V\\Projetos\\Rust\\Tauri.md", text: "" },
    { rel: "CI/CD.md", path: "C:\\V\\CI\\CD.md", text: "" },
  ],
  files: [
    { rel: "anexos/diagrama.png", path: "C:\\V\\anexos\\diagrama.png" },
    { rel: "Projetos/Rust/logo.png", path: "C:\\V\\Projetos\\Rust\\logo.png" },
    { rel: "Projetos/Rust/sub/logo.png", path: "C:\\V\\Projetos\\Rust\\sub\\logo.png" },
    { rel: "Imagem com espaço.png", path: "C:\\V\\Imagem com espaço.png" },
  ],
};
const index = mi.vaultIndex(scan);
const look = mi.vaultImageLookup(index, "Projetos/Rust/Tauri.md");
assert.equal(look("logo.png"), "C:\\V\\Projetos\\Rust\\logo.png"); // relativo à nota
assert.equal(look("../../anexos/diagrama.png"), "C:\\V\\anexos\\diagrama.png");
assert.equal(look("anexos/diagrama.png"), "C:\\V\\anexos\\diagrama.png"); // relativo à raiz
assert.equal(look("diagrama.png"), "C:\\V\\anexos\\diagrama.png"); // só pelo nome (![[x]])
assert.equal(look("Imagem%20com%20espa%C3%A7o.png"), "C:\\V\\Imagem com espaço.png");
assert.equal(mi.vaultImageLookup(index, "Inicio.md")("logo.png"), "C:\\V\\Projetos\\Rust\\logo.png"); // caminho mais curto
assert.equal(look("https://x.com/a.png"), null);
assert.equal(look("C:\\outro\\a.png"), null);
assert.equal(look("nao-existe.png"), null);

assert.equal(mi.normalizeVaultLinks("ver [[Projetos/Rust/Tauri]] e [[Tauri.md|app]]", index), "ver [[Tauri]] e [[Tauri|app]]");
assert.equal(mi.normalizeVaultLinks("[[Tauri#Instalação|passos]] [[Inicio^bloco]]", index), "[[Tauri|passos]] [[Inicio]]");
assert.equal(mi.normalizeVaultLinks("[[#Seção]] e [[#Seção|aqui]]", index), "Seção e aqui");
assert.equal(mi.normalizeVaultLinks("[[CI/CD]] [[C#]]", index), "[[CD]] [[C#]]"); // CI/CD.md existe; "C#" não é âncora
assert.equal(mi.normalizeVaultLinks("[[Outro/Caminho]]", index), "[[Outro/Caminho]]"); // não é nota da pasta
assert.equal(mi.normalizeVaultLinks("![[diagrama.png]] ![[Tauri.md]]", index), "![[diagrama.png]] ![[Tauri]]");

// Nome do arquivo = título da nota.
assert.equal(
  mi.applyFileTitle("<h3>Política de classificação</h3><p>x</p>", "HUB de crédito - Visualização políticas"),
  "<h1>HUB de crédito - Visualização políticas</h1><h3>Política de classificação</h3><p>x</p>",
);
assert.equal(mi.applyFileTitle("<h2>Minha Nota</h2><p>x</p>", "minha nota"), "<h1>Minha Nota</h1><p>x</p>"); // já é o título
assert.equal(mi.applyFileTitle("<h1>CI/CD &amp; deploy</h1>", "CICD & deploy"), "<h1>CI/CD &amp; deploy</h1>"); // nome exportado
assert.equal(mi.applyFileTitle("<p>só texto</p>", "A & B"), "<h1>A &amp; B</h1><p>só texto</p>");

// Embeds do Obsidian no Markdown: imagem vira <img>, nota vira link.
assert.match(inlineMarkdown("![[diagrama.png|300]]"), /^<img src="diagrama.png" alt="">$/);
assert.match(inlineMarkdown("![[Tauri]]"), /class="nt-link"[^>]*data-target="Tauri"/);

// --- Postman com pastas aninhadas
const pm = {
  info: { name: "API" },
  item: [
    {
      name: "Usuários",
      auth: { type: "bearer", bearer: [{ key: "token", value: "abc" }] },
      item: [
        { name: "Listar", request: { method: "GET", url: "https://x/users" } },
        {
          name: "Admin",
          item: [
            { name: "Apagar", request: { method: "DELETE", url: "https://x/users/1" } },
            { name: "Sem auth", request: { method: "GET", url: "https://x/a", auth: { type: "noauth" } } },
          ],
        },
      ],
    },
    { name: "Health", request: { method: "GET", url: "https://x/health" } },
  ],
};
const { collection, requests } = importPostman(pm);
const coll = normalizeCollection(collection);
assert.deepEqual(t.flattenTree(coll.folders).map((e) => `${e.depth}:${e.folder.name}`), ["0:Usuários", "1:Admin"]);
const byName = Object.fromEntries(requests.map((r) => [r.name, r]));
assert.equal(t.folderPath(coll.folders, byName.Apagar.folder_id), "Usuários / Admin");
assert.equal(byName.Listar.folder_id, coll.folders[0].id);
assert.equal(byName.Health.folder_id, 0);
// Auth da pasta vale para as requisições que herdam; noauth explícito é mantido.
assert.equal(byName.Apagar.auth.type, "bearer");
assert.equal(byName.Apagar.auth.bearer.token, "abc");
assert.equal(byName["Sem auth"].auth.type, "none");
assert.equal(byName.Health.auth.type, "inherit");
byName.Apagar.auth.bearer.token = "x";
assert.equal(byName.Listar.auth.bearer.token, "abc"); // cópias independentes

// Export volta a aninhar (requisições da pasta antes das subpastas).
const out = exportPostman(coll, requests);
assert.deepEqual(out.item.map((i) => i.name), ["Usuários", "Health"]);
assert.deepEqual(out.item[0].item.map((i) => i.name), ["Listar", "Admin"]);
assert.deepEqual(out.item[0].item[1].item.map((i) => i.name), ["Apagar", "Sem auth"]);

// Coleções antigas (pastas sem parent_id) continuam no nível da coleção.
const old = normalizeCollection({ id: 1, name: "Velha", folders: [{ id: 7, name: "P" }] });
assert.equal(old.folders[0].parent_id, 0);

console.log("folders tests ok");
