// Testes do .md aberto fora das Notas (janela de arquivo / prévia): node tests/mdfile.test.mjs
// A conversão HTML <-> Markdown precisa de DOM; aqui só o que envolve o texto do arquivo.
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const d = await import(base + "mdDoc.js");
const nc = await import(base + "noteContent.js");

// --- front-matter, EOL e BOM voltam como estavam
let m = d.readMdText("\uFEFF---\r\ntags: [a]\r\n---\r\n# T\r\n\r\ncorpo\r\n");
assert.deepEqual(m, { body: "# T\n\ncorpo\n", yaml: "tags: [a]", eol: "\r\n", bom: true });
assert.equal(d.writeMdText(m.body, m), "\uFEFF---\r\ntags: [a]\r\n---\r\n# T\r\n\r\ncorpo\r\n");

m = d.readMdText("só texto");
assert.deepEqual(m, { body: "só texto", yaml: null, eol: "\n", bom: false });
assert.equal(d.writeMdText("só texto\n", m), "só texto\n");
assert.equal(d.writeMdText("sem quebra", m), "sem quebra\n");

// --- caminhos relativos (os outros ficam como estão)
for (const src of ["img/a.png", "./a.png", "../a.png", "a b.png"]) assert.ok(d.isRelativeSrc(src), src);
for (const src of ["https://x/a.png", "data:image/png;base64,AA", "C:\\x\\a.png", "/abs/a.png", "file:///a.png", "#x", ""]) assert.ok(!d.isRelativeSrc(src), src);

// --- URL de imagem ao lado do arquivo: ida e volta, inclusive "../" e espaços
const url = nc.fileImageUrl("0a1b2c", "../img/meu print.png");
assert.match(url, /localhost\/f\/0a1b2c\/\.\.%2Fimg%2Fmeu%20print\.png$/);
assert.equal(new URL(url.replace(/^noteimg:\/\/localhost/, "http://noteimg.localhost")).pathname, "/f/0a1b2c/..%2Fimg%2Fmeu%20print.png");
assert.equal(nc.fileImageRel(url), "../img/meu print.png");
assert.equal(nc.fileImageRel(nc.vaultImageUrl("a.png")), null);
assert.equal(nc.vaultImageRel(url), null);
assert.equal(nc.localImageName(url), null);


// --- Ctrl+F na nota: sem maiúsculas/acentos, posições iguais às do texto original
const tf = await import(base + "textFind.js");
const hay = tf.foldText("Ação É ÇÃO ação\nstraße");
assert.equal(hay.length, "Ação É ÇÃO ação\nstraße".length);
assert.deepEqual(tf.findAll(hay, tf.foldText("ACAO")), [0, 11]);
assert.deepEqual(tf.findAll(tf.foldText("aaaa"), "aa"), [0, 2]); // sem sobreposição
assert.deepEqual(tf.findAll(hay, ""), []);
assert.deepEqual(tf.findAll(tf.foldText("xx xx xx"), "xx", 2), [0, 3]);
assert.deepEqual(tf.findAll(hay, tf.foldText("ção\nst")), [12]); // o "\n" entre blocos só casa se digitado (o input não deixa)
console.log("mdfile: ok");
