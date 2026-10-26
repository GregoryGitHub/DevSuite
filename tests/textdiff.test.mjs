// Testes do diff do controle de versão das Notas (linhas, palavras, dobras, reverter, merge 3 vias):
// node tests/textdiff.test.mjs
import assert from "node:assert/strict";
const d = await import(new URL("../src/js/utils/textDiff.js", import.meta.url).href);

const types = (r) => r.chunks.map((c) => `${c.type}:${c.a0}-${c.a1}/${c.b0}-${c.b1}`);

// Aplica os blocos: a esquerda + as alterações tem que dar a direita.
function rebuild({ left, right, chunks }) {
  const out = [];
  for (const c of chunks) {
    if (c.type === "equal") assert.deepEqual(left.slice(c.a0, c.a1), right.slice(c.b0, c.b1));
    out.push(...right.slice(c.b0, c.b1));
  }
  assert.deepEqual(out, right);
  // Cobertura contínua dos dois lados.
  let a = 0;
  let b = 0;
  for (const c of chunks) {
    assert.equal(c.a0, a);
    assert.equal(c.b0, b);
    a = c.a1;
    b = c.b1;
  }
  assert.equal(a, left.length);
  assert.equal(b, right.length);
}

// --- linhas
assert.deepEqual(d.splitLines(""), []);
assert.deepEqual(d.splitLines("a\r\nb\r\n"), ["a", "b"]);
assert.deepEqual(d.splitLines("a\n\n"), ["a", ""]);
assert.equal(d.eolOf("a\r\nb"), "\r\n");

assert.deepEqual(types(d.diffLines("", "")), []);
assert.deepEqual(types(d.diffLines("", "a\nb\n")), ["insert:0-0/0-2"]);
assert.deepEqual(types(d.diffLines("a\nb\n", "")), ["delete:0-2/0-0"]);
assert.deepEqual(types(d.diffLines("a\nb\nc\n", "a\nX\nc\n")), ["equal:0-1/0-1", "modify:1-2/1-2", "equal:2-3/2-3"]);
assert.deepEqual(types(d.diffLines("a\nc\n", "a\nb\nc\n")), ["equal:0-1/0-1", "insert:1-1/1-2", "equal:1-2/2-3"]);
assert.deepEqual(types(d.diffLines("a\r\nb\r\n", "a\nb\n")), ["equal:0-2/0-2"]);
assert.deepEqual(types(d.diffLines("a  b\n", "a b\n", { ignoreWhitespace: true })), ["equal:0-1/0-1"]);

// Linhas repetidas e casos aleatórios: sempre reconstrói a direita.
rebuild(d.diffLines("x\nx\nx\ny\nx\n", "x\ny\nx\nx\nx\nx\n"));
let seed = 7;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
for (let t = 0; t < 200; t++) {
  const gen = () => Array.from({ length: rnd(15) }, () => "abcd"[rnd(4)]).join("\n");
  rebuild(d.diffLines(gen(), gen()));
}
// Muito diferentes (acima do limite do Myers): vira um bloco só no meio, mas continua correto.
{
  const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
  const r = d.diffLines(`topo\n${a}\nfim`, `topo\n${b}\nfim`);
  rebuild(r);
  assert.equal(d.changedChunks(r.chunks).length, 1);
}

// --- palavras
assert.deepEqual(d.tokenize("Olá, mundo!"), ["Olá", ",", " ", "mundo", "!"]);
{
  const w = d.diffWords("o gato preto dorme", "o cão preto dorme");
  assert.deepEqual(w.a, [[2, 6]]);
  assert.deepEqual(w.b, [[2, 5]]);
  // Espaço entre duas palavras alteradas: destaque contínuo.
  const w2 = d.diffWords("um dois três", "uno dos três");
  assert.deepEqual(w2.b, [[0, 7]]);
}
{
  const r = d.diffLines("a\nlinha um\nlinha dois\nz\n", "a\nlinha 1\nlinha dois!\nz\n");
  const c = d.changedChunks(r.chunks)[0];
  const w = d.chunkWordRanges(r.left, r.right, c);
  assert.deepEqual(w.a, [[[6, 8]], []]);
  assert.deepEqual(w.b, [[[6, 7]], [[10, 11]]]);
}

// --- dobras
{
  const left = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const right = [...left];
  right[15] = "mudou";
  const r = d.diffLines(left.join("\n"), right.join("\n"));
  const segs = d.foldSegments(r.chunks, { context: 3 });
  assert.deepEqual(segs.map((s) => `${s.type}:${s.a0}-${s.a1}`), ["fold:0-12", "equal:12-15", "modify:15-16", "equal:16-19", "fold:19-30"]);
  const open = d.foldSegments(r.chunks, { context: 3, expanded: new Set([0]) });
  assert.equal(open[0].type, "equal");
  assert.equal(d.foldSegments(r.chunks, { enabled: false }).length, 3);
}

// --- reverter um bloco (≫)
{
  const r = d.diffLines("a\nb\nc\n", "a\nB\nc\nnova\n");
  const [mod, ins] = d.changedChunks(r.chunks);
  assert.equal(d.revertChunk(r.left, r.right, mod), "a\nb\nc\nnova\n");
  assert.equal(d.revertChunk(r.left, r.right, ins, "\r\n"), "a\r\nB\r\nc\r\n");
  assert.equal(d.endsWithEol("x"), false);
}

// --- merge de 3 vias
{
  const base = "a\nb\nc\nd\ne\n";
  const blocks = d.merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
  assert.deepEqual(blocks.map((b) => b.type), ["stable", "ours", "stable", "theirs"]);
  assert.equal(d.mergeResultText(blocks), "a\nB\nc\nd\nE\n");

  const c = d.merge3(base, "a\nMINHA\nc\nd\ne\n", "a\nDELES\nc\nd\ne\n");
  assert.deepEqual(c.map((b) => b.type), ["stable", "conflict", "stable"]);
  const text = d.mergeResultText(c);
  assert.equal(text, "a\n<<<<<<< Minha\nMINHA\n=======\nDELES\n>>>>>>> Deles\nc\nd\ne\n");
  assert.equal(d.conflictMarkers(text).length, 1);
  assert.equal(d.resolveMarker(text, 0, "theirs"), "a\nDELES\nc\nd\ne\n");
  assert.equal(d.resolveMarker(text, 0, "both"), "a\nMINHA\nDELES\nc\nd\ne\n");

  // Mesma mudança dos dois lados = sem conflito.
  assert.deepEqual(d.merge3(base, "a\nX\nc\nd\ne\n", "a\nX\nc\nd\ne\n").map((b) => b.type), ["stable", "same", "stable"]);
  // Inserções no mesmo ponto com textos diferentes = conflito.
  assert.ok(d.merge3("a\nb\n", "a\n1\nb\n", "a\n2\nb\n").some((b) => b.type === "conflict"));
  // Arquivo novo dos dois lados (sem base).
  assert.deepEqual(d.merge3("", "x\n", "y\n").map((b) => b.type), ["conflict"]);
  // Linhas inseridas antes e mudança depois: deslocamentos certos.
  const m = d.merge3(base, "0\na\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
  assert.equal(d.mergeResultText(m), "0\na\nb\nc\nd\nE\n");
}

console.log("textdiff: ok");
