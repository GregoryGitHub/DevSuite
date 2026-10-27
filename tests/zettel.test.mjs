// Testes do Zettelkasten das Notas (links, propriedades, YAML, grafo, busca): node tests/zettel.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const z = await import(base + "zettel.js");
const { createLayout, DEFAULT_FORCES } = await import(base + "graphLayout.js");

// --- links no HTML
const a = z.linkHtml({ id: 12, title: "Rust & SQL" });
assert.equal(a, '<a class="nt-link" contenteditable="false" data-note="12">Rust &amp; SQL</a>');
const b = z.linkHtml('Nota "nova"', "apelido");
assert.match(b, /data-target="Nota &quot;nova&quot;"/);
assert.match(b, /data-alias="">apelido<\/a>$/);
assert.deepEqual(z.noteLinks(`<p>${a} e ${b} e de novo ${a}</p><p>${z.linkHtml('nota  "NOVA"')}</p>`), [12, 'Nota "nova"']);
assert.deepEqual(z.noteLinks("<p>sem links</p>"), []);
assert.deepEqual(z.noteLinks('<p><a class="nt-link" data-target="">x</a></p>'), []);
assert.deepEqual(z.splitLinkText(" Título | outro texto "), { title: "Título", alias: "outro texto" });
assert.deepEqual(z.splitLinkText("Só título"), { title: "Só título", alias: "" });

// --- propriedades
const p = z.normalizeProps({ tags: ["#rust", "Rust", "a b", ""], aliases: "um, dois", type: "permanent", extra: { x: 1 } });
assert.deepEqual(p.tags, ["rust", "a-b"]);
assert.deepEqual(p.aliases, ["um", "dois"]);
assert.deepEqual(p.extra, { x: "1" });
assert.ok(z.propsEmpty(null));
assert.ok(!z.propsEmpty({ tags: ["x"] }));
assert.equal(z.propsSearchText({ tags: ["rust"], aliases: ["Ferrugem"] }), "#rust Ferrugem");

const d = new Date(2026, 9, 8, 15, 30, 7);
assert.equal(z.newZid(d), "202610081530");
assert.equal(z.newZid(d, new Set(["202610081530"])), "20261008153007");
assert.equal(z.newZid(d, new Set(["202610081530", "20261008153007"])), "20261008153007-1");

// --- YAML ida e volta
const props = z.normalizeProps({
  zid: "202610081530",
  tags: ["rust", "banco/sqlite"],
  aliases: ["Ferrugem", "true"],
  type: "permanent",
  status: "done",
  source: "https://exemplo.com/a?b=1",
  author: "Ana: B",
  extra: { "chave livre": "v" },
});
const yaml = z.propsToYaml(props);
assert.ok(yaml.startsWith("---\nid: 202610081530\ntags:\n  - rust\n  - banco/sqlite\n"));
assert.match(yaml, /- "true"/);
const fm = z.splitFrontMatter(yaml + "# Título\n");
assert.equal(fm.body, "# Título\n");
assert.deepEqual(z.yamlToProps(fm.yaml), props);
assert.equal(z.propsToYaml({}), "");
assert.deepEqual(z.splitFrontMatter("# sem\n"), { yaml: null, body: "# sem\n" });

// YAML do Obsidian: listas inline, chaves singulares, aspas simples, comentários
const obs = z.yamlToProps("tags: [ideia, 'zettel']\nalias: Outro nome\ncreated: 2024-01-01 # criado\nurl: http://x.y\n");
assert.deepEqual(obs.tags, ["ideia", "zettel"]);
assert.deepEqual(obs.aliases, ["Outro nome"]);
assert.equal(obs.source, "http://x.y");
assert.deepEqual(obs.extra, {}); // created vira a data de criação da nota (parseFrontMatter)

// Front-matter das notas da wiki: "Data criação", tags com "#" entre aspas, "Autor".
const wiki = z.parseFrontMatter(
  'Data criação: 2025-11-18\ntags:\n  - hub-de-credito\n  - "#políticas"\n  - "#classificação"\n  - "#políticas-classificação"\n  - "#visualização"\nAutor: jose.grigorio@localiza.com',
);
assert.deepEqual(wiki.props.tags, ["hub-de-credito", "políticas", "classificação", "políticas-classificação", "visualização"]);
assert.equal(wiki.props.author, "jose.grigorio@localiza.com");
assert.deepEqual(wiki.props.extra, {});
assert.equal(wiki.created, new Date(2025, 10, 18).getTime());
assert.equal(z.dateOnly(wiki.created), "2025-11-18");
// Volta no export com chaves padrão (created/author), e relê igual.
const wikiYaml = z.propsToYaml(wiki.props, { created: new Date(wiki.created).toISOString() });
assert.match(wikiYaml, /\ncreated: 2025-11-18\n/);
assert.match(wikiYaml, /\nauthor: jose.grigorio@localiza.com\n/);
const wikiAgain = z.parseFrontMatter(z.splitFrontMatter(wikiYaml).yaml);
assert.deepEqual(wikiAgain.props, wiki.props);
assert.equal(wikiAgain.created, wiki.created);
assert.equal(z.propsToYaml(null, { created: "2026-01-02T10:00:00" }), "---\ncreated: 2026-01-02\n---\n");
assert.equal(z.propsToYaml(null, { created: "2026-01-02T10:00:00", pinned: 3 }), "---\ncreated: 2026-01-02\npinned: 3\n---\n");
assert.equal(z.propsToYaml(null, { pinned: 0 }), "");
assert.equal(z.parseFrontMatter("pinned: 3\nfoo: bar").pinned, 3);
assert.deepEqual(z.parseFrontMatter("pinned: 3\nfoo: bar").props.extra, { foo: "bar" });
assert.equal(z.parseFrontMatter("pinned: false").pinned, 0);

// Datas aceitas; inválidas ficam como campo livre.
assert.equal(z.parseNoteDate("18/11/2025"), new Date(2025, 10, 18).getTime());
assert.equal(z.parseNoteDate("2025-11-18 09:30"), new Date(2025, 10, 18, 9, 30).getTime());
assert.equal(z.parseNoteDate("2025-11-18T12:00:00Z"), Date.UTC(2025, 10, 18, 12));
assert.equal(z.parseNoteDate("2025-02-30"), null);
assert.equal(z.parseNoteDate("ontem"), null);
const bad = z.parseFrontMatter("date: algum dia\ncriado em: 2024-03-05");
assert.deepEqual(bad.props.extra, { date: "algum dia" });
assert.equal(z.dateOnly(bad.created), "2024-03-05");

// --- índice de títulos
const notes = [
  { id: 1, title: "Rust", updated_at: 5, links: [2, "Inexistente"], props: { tags: ["lang"], type: "permanent" }, folder_id: 0 },
  { id: 2, title: "SQLite", updated_at: 4, links: ["rust"], props: { tags: ["db", "lang/sql"], aliases: ["Banco embutido"] }, folder_id: 1 },
  { id: 3, title: "Reunião", updated_at: 9, links: [], props: {}, folder_id: 0 },
  { id: 4, title: "Rust", updated_at: 1, links: [1], props: {}, deleted_at: 7, folder_id: 0 },
  { id: 5, title: "Ruby", updated_at: 3, links: [], props: null, folder_id: 0 },
];
const titleOf = (n) => n.title;
const idx = new z.TitleIndex(notes, titleOf);
assert.equal(idx.resolve("RUST").id, 1); // a da lixeira não conta
assert.equal(idx.resolve("banco  EMBUTIDO").id, 2);
assert.equal(idx.resolve("reuniao").id, 3); // sem acento
assert.equal(idx.resolve("nada"), null);
assert.deepEqual(idx.suggest("ru").map((s) => s.note.id), [1, 5]);
assert.deepEqual(idx.suggest("embut").map((s) => [s.note.id, s.alias]), [[2, "Banco embutido"]]);
assert.deepEqual(idx.suggest("", 2).map((s) => s.note.id), [3, 1]);
assert.deepEqual(idx.suggest("rust", 8, 1), []);

// --- backlinks
const back = z.backlinkMap(notes, idx);
assert.deepEqual([...back.get(1)], [2]); // "rust" resolvido pelo título; a nota 4 está na lixeira
assert.deepEqual([...back.get(2)], [1]);
assert.equal(back.get(3), undefined);

// --- grafo
let g = z.buildGraph(notes, { titleOf, index: idx });
const keys = g.nodes.map((n) => n.key).sort();
assert.deepEqual(keys, ["n:1", "n:2", "n:3", "n:5", "t:db", "t:lang", "t:lang/sql"].sort());
assert.equal(g.edges.length, 4); // 1-2 (uma vez só), 1-lang, 2-db, 2-lang/sql
assert.equal(g.nodes.find((n) => n.key === "n:1").degree, 2);
g = z.buildGraph(notes, { titleOf, index: idx, tags: false, orphans: false, missing: true });
assert.deepEqual(g.nodes.map((n) => n.key).sort(), ["m:inexistente", "n:1", "n:2"]);
g = z.buildGraph(notes, { titleOf, index: idx, center: 2, depth: 1, tags: false });
assert.deepEqual(g.nodes.map((n) => n.key).sort(), ["n:1", "n:2"]);
g = z.buildGraph(notes, { titleOf, index: idx, center: 2, depth: 2 });
assert.ok(g.nodes.some((n) => n.key === "t:lang")); // 2 -> 1 -> lang
g = z.buildGraph(notes, { titleOf, index: idx, folderId: 1, tags: false });
assert.deepEqual(g.nodes.map((n) => n.key), ["n:2"]);
for (const [x, y] of g.edges) assert.ok(x < g.nodes.length && y < g.nodes.length);

// --- busca relacional
let q = z.parseQuery('tag:rust #lang/sql type:perm status:"Em progresso" id:2026 [[SQLite]] texto livre');
assert.deepEqual(q, { text: "texto livre", tags: ["rust", "lang/sql"], type: "perm", status: "Em progresso", zid: "2026", linksTo: ["SQLite"] });
assert.ok(z.hasFilters(q));
q = z.parseQuery("só texto #");
assert.equal(q.text, "só texto #");
assert.ok(!z.hasFilters(q));
const match = (query, id) => z.matchesFilters(notes.find((n) => n.id === id), z.parseQuery(query), idx);
assert.ok(match("tag:lang", 2)); // hierárquica: lang casa com lang/sql
assert.ok(match("#LANG", 1));
assert.ok(!match("tag:db", 1));
assert.ok(match("type:permanent", 1));
assert.ok(match("type:perma", 1)); // pelo rótulo "Permanente"
assert.ok(!match("type:perm", 2));
assert.ok(match("[[sqlite]]", 1));
assert.ok(match("[[Rust]]", 2)); // link guardado como título
assert.ok(!match("[[Reunião]]", 1));

assert.deepEqual(z.tagCounts(notes).map((t) => [t.tag, t.count]), [["db", 1], ["lang", 1], ["lang/sql", 1]]);

// --- layout: converge, sem NaN, para sozinho e lembra as posições
const N = 400;
const nodes = Array.from({ length: N }, (_, i) => ({ key: `n:${i}` }));
const edges = [];
for (let i = 1; i < N; i++) edges.push([i, Math.floor(Math.sqrt(i * 7)) % i]);
const memory = new Map();
const sim = createLayout(nodes, edges, memory);
let steps = 0;
const t0 = performance.now();
while (sim.active && steps < 2000) sim.step(), steps++;
const ms = performance.now() - t0;
assert.ok(!sim.active, "simulação deve parar");
assert.ok(steps < 600, `passos: ${steps}`);
for (let i = 0; i < N; i++) assert.ok(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i]));
const len = ([i, j]) => Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j]);
const avgEdge = edges.reduce((s, e) => s + len(e), 0) / edges.length;
assert.ok(avgEdge > 10 && avgEdge < 200, `aresta média ${avgEdge}`);
sim.positions();
const again = createLayout(nodes, edges, memory);
assert.equal(again.x[5], sim.x[5]);
assert.ok(again.alpha < 0.1); // reabrir não "explode" o desenho
console.log(`layout ${N} nós: ${steps} passos em ${ms.toFixed(0)} ms`);

// Forças ajustáveis: mais repulsão = grafo mais espalhado; setForces reaquece.
assert.deepEqual(Object.keys(DEFAULT_FORCES).sort(), ["gravity", "linkDistance", "linkStrength", "repulsion"]);
const spread = (s) => {
  let r = 0;
  for (let i = 0; i < N; i++) r += Math.hypot(s.x[i], s.y[i]);
  return r / N;
};
const settle = (s) => {
  for (let i = 0; i < 2000 && s.active; i++) s.step();
  return s;
};
const weak = settle(createLayout(nodes, edges, new Map(), { repulsion: 40 }));
const strong = settle(createLayout(nodes, edges, new Map(), { repulsion: 200 }));
assert.ok(spread(strong) > spread(weak) * 1.3, `espalhamento ${spread(weak).toFixed(0)} -> ${spread(strong).toFixed(0)}`);
const before = spread(weak);
weak.setForces({ repulsion: 200, linkDistance: 150 });
assert.ok(weak.active && weak.alpha >= 0.5);
settle(weak);
assert.ok(spread(weak) > before * 1.3, "setForces reorganiza");

// pontos coincidentes e grafo vazio
const same = createLayout([{ key: "a" }, { key: "b" }, { key: "c" }], [], new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: 0 }], ["c", { x: 0, y: 0 }]]));
for (let i = 0; i < 50; i++) same.step();
assert.ok([...same.x].every(Number.isFinite));
const empty = createLayout([], []);
empty.step();
assert.ok(!empty.active);

console.log("zettel: ok");
