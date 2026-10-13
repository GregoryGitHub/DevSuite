// Testes dos blocos de código das Notas (dobras, linhas realçadas, linguagens): node tests/code-block.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const { foldRegions, splitHighlightedLines, guessCodeLang } = await import(base + "codeBlock.js");
const { highlightCode, CODE_LANGS, normalizeCodeLang } = await import(base + "highlight.js");

const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e]);

// --- dobras por chaves: a linha do fechamento fica visível
let lines = ["function f() {", "  const a = {", "    b: 1,", "  };", "  return a;", "}"];
let r = foldRegions(lines, "javascript");
assert.equal(r.get(0), 4);
assert.equal(r.get(1), 2);
assert.equal(r.size, 2);

// chaves dentro de strings e comentários não contam
lines = ['const s = "{";', "// {", "if (x) {", "  y();", "}"];
r = foldRegions(lines, "javascript");
assert.deepEqual([...r], [[2, 3]]);

// fechamento no meio da linha: esconde até ela
lines = ["[", "  1,", "  2] + x"];
assert.equal(foldRegions(lines, "json").get(0), 2);

// JSON aninhado
lines = JSON.stringify({ a: { b: [1, 2] }, c: 3 }, null, 2).split("\n");
r = foldRegions(lines, "json");
assert.equal(r.get(0), lines.length - 2);
assert.equal(r.get(1), 5);

// --- dobras por recuo (Python, YAML, SQL, Mermaid)
lines = ["def f():", "    x = 1", "", "    return x", "print(f())"];
assert.deepEqual([...foldRegions(lines, "python")], [[0, 3]]);
lines = ["a:", "  b:", "    c: 1", "d: 2"];
assert.deepEqual([...foldRegions(lines, "yaml")], [[0, 2], [1, 2]]);
lines = ["graph TD", "  subgraph X", "    A --> B", "  end"];
assert.deepEqual([...foldRegions(lines, "mermaid")], [[0, 3], [1, 2]]);

// --- HTML realçado dividido em linhas (spans de várias linhas fechados e reabertos)
let html = highlightCode("/* a\nb */ x", "javascript");
let parts = splitHighlightedLines(html);
assert.equal(parts.length, 2);
assert.equal(parts[0], '<span class="tok-comment">/* a</span>');
assert.ok(parts[1].startsWith('<span class="tok-comment">b */</span>'));
assert.deepEqual(splitHighlightedLines(""), [""]);
assert.deepEqual(splitHighlightedLines("a\n\nb"), ["a", "", "b"]);

// --- todo realce preserva o texto e mantém o número de linhas
const samples = {
  text: "olá <mundo> & 'aspas'",
  mermaid: 'graph TD\n  A[Início] -->|sim| B{Decisão}\n  B -.-> C((Fim))\n  %% comentário\nsequenceDiagram\n  Alice->>Bob: Oi "x"',
  json: '{\n  "a": [1, 2.5e3, true, null],\n  "b": "x\\"y"\n}',
  javascript: "const a = `t ${x}`; // c\nfunction f(b) { return b?.c ?? 0x1F; }",
  typescript: "interface A { b: string }\ntype C = keyof A;\nconst d: number = 1 as any;",
  html: '<!doctype html>\n<div class="a" id=b>&amp; texto</div>',
  xml: '<?xml version="1.0"?>\n<a x="1"><![CDATA[ <b> ]]></a>',
  css: "@media (max-width: 600px) {\n  .a:hover, #b::before { color: #fff !important; margin: -1.5em 0 }\n}\n:root { --x: calc(100% - 4px); }",
  sql: "SELECT TOP 10 a, COUNT(*) FROM [dbo].[t] WHERE b = N'x' -- c\nGO",
  python: '@dec\ndef f(a, *b):\n    """doc"""\n    return f"{a}" if a else None  # c',
  bash: '#!/bin/bash\nfor f in *.txt; do echo "$f ${HOME}" --flag; done # fim',
  powershell: '<# bloco #>\n$x = Get-ChildItem -Path "C:\\a" | Where-Object { $_.Length -gt 1KB }\n[string]$y = @"\noi\n"@',
  csharp: 'public record A(int B);\nvar s = $"x {y}"; // c\n#region R',
  java: "@Override\npublic static void main(String[] args) { System.out.println(\"x\"); }",
  go: "func main() {\n\tfmt.Println(`raw`, 'c', nil)\n}",
  rust: "#[derive(Debug)]\nfn main() -> Result<(), Box<dyn Error>> { let x: &'a str = \"s\"; println!(\"{x}\"); Ok(()) }",
  cpp: "#include <vector>\nint main() { std::vector<int> v{1, 2}; return 0; }",
  yaml: "# c\nkey: value\nlist:\n  - a: 1\n  - 'b'\nanchor: &x { a: [1, 2] }\nblock: |\n  texto",
  graphql: "query Q($id: ID!) { user(id: $id) @include(if: true) { name } }",
  diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same",
  markdown: "# Título\n- item",
};
for (const [id] of CODE_LANGS) {
  const src = samples[id];
  assert.ok(src !== undefined, `sem amostra para ${id}`);
  const out = highlightCode(src, id === "html" ? "xml" : id);
  assert.equal(plain(out), src, `texto alterado no realce de ${id}`);
  assert.equal(splitHighlightedLines(out).length, src.split("\n").length, `linhas em ${id}`);
}
assert.ok(highlightCode("SELECT 1", "sql").includes("tok-keyword"));
assert.ok(highlightCode("A --> B", "mermaid").includes("tok-fn"));
assert.ok(highlightCode("+a\n-b", "diff").includes("tok-ins"));
assert.ok(highlightCode("color: red;", "css").includes("tok-key"));

// --- linguagens: aliases do Markdown e detecção
assert.equal(normalizeCodeLang("JS"), "javascript");
assert.equal(normalizeCodeLang("c#"), "csharp");
assert.equal(normalizeCodeLang("yml"), "yaml");
assert.equal(normalizeCodeLang(""), "text");
assert.equal(normalizeCodeLang("kotlin"), "java");
assert.equal(normalizeCodeLang("elixir"), "elixir");
assert.equal(normalizeCodeLang("<script>"), "text");

assert.equal(guessCodeLang("graph LR\n A --> B"), "mermaid");
assert.equal(guessCodeLang("%% título\nsequenceDiagram\n A->>B: oi"), "mermaid");
assert.equal(guessCodeLang('{"a": 1}'), "json");
assert.equal(guessCodeLang("select * from t"), "sql");
assert.equal(guessCodeLang("<root><a/></root>"), "xml");
assert.equal(guessCodeLang(".a { color: red; }"), "css");
assert.equal(guessCodeLang("const x = 1;"), "javascript");
assert.equal(guessCodeLang("def f():\n    return 1"), "python");
assert.equal(guessCodeLang("só um texto"), null);
assert.equal(guessCodeLang("{ não é json"), null);

// --- colar Markdown nas Notas: o que vira formatação
const { markdownKind, inlineMarkdown } = await import(base + "markdown.js");
assert.equal(markdownKind("Esse `texto` de exemplo"), "inline");
assert.equal(inlineMarkdown("Esse `texto` de exemplo"), "Esse <code>texto</code> de exemplo");
assert.equal(markdownKind("**negrito** aqui"), "inline");
assert.equal(markdownKind("# Título\nTexto"), "block");
assert.equal(markdownKind("- a\n- b"), "block");
assert.equal(markdownKind("```sql\nselect 1\n```"), "block");
assert.equal(markdownKind("| a | b |\n|---|---|\n| 1 | 2 |"), "block");
assert.equal(markdownKind("linha 1\nlinha 2"), null);
assert.equal(markdownKind("- um item só\noutra linha"), null);
assert.equal(markdownKind("2*3*4 e snake_case_name"), null);
assert.equal(markdownKind("https://x.com/a_b_c"), null);

console.log("code-block: ok");
