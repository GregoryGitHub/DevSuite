// Testes da CLI `devsuite` (sem framework): node tests/cli.test.mjs
// Utilitários puros (js/cli/cliUtils.js) e o catálogo commands.json contra os handlers do JS.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
const base = new URL("../src/js/cli/", import.meta.url);
const u = await import(new URL("cliUtils.js", base).href);

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof u.CliError && e.code === code, `esperado ${code}`);

// --- pick: id > igual > começa com > contém; ambiguidade
const items = [
  { id: 1, name: "Deploy da API" },
  { id: 2, name: "Deploy do Front" },
  { id: 3, name: "Reunião" },
  { id: 4, name: "Ações" },
];
assert.equal(u.pick(items, "2").id, 2);
assert.equal(u.pick(items, "reuniao").id, 3);
assert.equal(u.pick(items, "acoes").id, 4);
assert.equal(u.pick(items, "deploy da").id, 1);
throwsCode(() => u.pick(items, "deploy"), "ambiguous");
throwsCode(() => u.pick(items, "nada"), "not_found");
throwsCode(() => u.pick(items, "  "), "usage");
// Nome igual vence "contém" de outro item.
assert.equal(u.pick([{ id: 1, name: "Api" }, { id: 2, name: "Api v2" }], "api").id, 1);

// --- pares
assert.deepEqual(u.splitPair("a=b=c"), ["a", "b=c"]);
assert.deepEqual(u.splitPair("Content-Type: application/json", [":", "="]), ["Content-Type", "application/json"]);
assert.deepEqual(u.splitPair("x-a=1:2", [":", "="]), ["x-a", "1:2"]);
throwsCode(() => u.splitPair("semvalor"), "usage");
assert.deepEqual(u.list(undefined), []);
assert.deepEqual(u.list("a"), ["a"]);
throwsCode(() => u.requireFlag({}, "write", "x"), "needs_write");
throwsCode(() => u.requireFlag({}, "yes", "x"), "needs_yes");
u.requireFlag({ yes: true }, "yes", "x");

// --- prazo das tarefas
const today = (await import(new URL("../utils/date.js", base).href)).getTodayStr();
assert.equal(u.parseDue("hoje"), today);
assert.equal(u.parseDue("2026-01-05"), "2026-01-05");
assert.equal(u.parseDue("5/1/2026"), "2026-01-05");
assert.equal(u.parseDue("none"), null);
assert.match(u.parseDue("+3"), /^\d{4}-\d{2}-\d{2}$/);
throwsCode(() => u.parseDue("semana que vem"), "usage");

// --- auth do HTTP
assert.equal(u.parseAuth("inherit").type, "inherit");
assert.equal(u.parseAuth("bearer:abc:def").bearer.token, "abc:def");
const basic = u.parseAuth("basic:ana:s3:nha");
assert.deepEqual([basic.type, basic.basic.username, basic.basic.password], ["basic", "ana", "s3:nha"]);
const key = u.parseAuth("apikey:X-Key:123:query");
assert.deepEqual([key.apikey.key, key.apikey.value, key.apikey.in], ["X-Key", "123", "query"]);
assert.equal(u.parseAuth("apikey:X-Key:a:b").apikey.value, "a:b");
throwsCode(() => u.parseAuth("oauth:x"), "usage");

// --- SQL somente leitura (o resto exige --write)
const ro = (s) => u.sqlReadOnly(s);
assert.ok(ro("select * from dbo.Clientes"));
assert.ok(ro("with x as (select 1 a) select * from x"));
assert.ok(ro("declare @n int = 2; select top (@n) * from t"));
assert.ok(ro("set nocount on; select 1"));
assert.ok(ro("-- comentário com delete\nselect 1"));
assert.ok(ro("select 'insert into x' as texto"));
assert.ok(!ro("select * into dbo.X from dbo.Y"));
assert.ok(!ro("update t set a = 1"));
assert.ok(!ro("exec sp_rename 'a', 'b'"));
assert.ok(!ro("with x as (select 1 a) delete from t where a in (select a from x)"));
assert.ok(!ro("declare @t table (a int); insert into @t values (1)"));
assert.ok(!ro("create table t (a int)"));
assert.ok(!ro("truncate table t"));

// --- --since do log do RabbitMQ
const now = Date.now();
assert.ok(Math.abs(u.sinceMs("10m") - (now - 600_000)) < 2000);
assert.ok(Math.abs(u.sinceMs("2h") - (now - 7_200_000)) < 2000);
assert.equal(u.sinceMs("2026-01-02T03:04:05Z"), Date.parse("2026-01-02T03:04:05Z"));
throwsCode(() => u.sinceMs("ontem à tarde"), "usage");

// --- catálogo: nomes únicos, opções válidas e um handler no JS para cada comando
const spec = JSON.parse(readFileSync(new URL("../src-tauri/cli/commands.json", import.meta.url), "utf8"));
const GLOBAL = new Set(["json", "text", "pretty", "timeout", "no-start", "help"]);
const files = { notes: "notesCli.js", tasks: "tasksCli.js", http: "httpCli.js", db: "dbCli.js", rabbit: "rabbitCli.js", redis: "redisCli.js" };
assert.deepEqual(spec.groups.map((g) => g.name).sort(), Object.keys(files).sort());
for (const g of spec.groups) {
  const src = readFileSync(new URL(files[g.name], base), "utf8");
  const table = src.slice(src.lastIndexOf("export const"));
  const names = new Set();
  for (const c of g.commands) {
    assert.ok(!names.has(c.name), `${g.name} ${c.name} repetido`);
    names.add(c.name);
    const key = c.name.replace(/[ -]/g, "_");
    assert.match(table, new RegExp(`(^|\\s)${key}(:|,|\\n)`, "m"), `sem handler: ${g.name}.${key}`);
    const opts = new Set();
    for (const o of c.options || []) {
      assert.ok(!GLOBAL.has(o.name), `${g.name} ${c.name}: --${o.name} colide com opção global`);
      assert.ok(!opts.has(o.name), `${g.name} ${c.name}: --${o.name} repetida`);
      opts.add(o.name);
      if (!o.flag) assert.ok(o.value, `${g.name} ${c.name}: --${o.name} sem "value"`);
    }
    const args = c.args || [];
    args.forEach((a, i) => assert.ok(!a.rest || i === args.length - 1, `${g.name} ${c.name}: rest só no último`));
    if (c.guard) assert.ok(opts.has(c.guard), `${g.name} ${c.name}: guard ${c.guard} sem a opção`);
  }
}

// --- exemplos das skills (e do commands.json) usam comandos e opções que existem
const skillsDir = new URL("../skills/", import.meta.url);
const examples = [];
for (const d of readdirSync(skillsDir)) {
  // Linhas continuadas com "\" viram uma só.
  const text = readFileSync(new URL(`${d}/SKILL.md`, skillsDir), "utf8").replace(/\\\r?\n\s*/g, " ");
  for (const line of text.split(/\r?\n/)) {
    const m = /(?:^|\|\s*)devsuite\s+(.*)$/.exec(line.trim());
    if (m && !line.includes("<group>")) examples.push({ where: d, cmd: m[1].replace(/\s+#.*$/, "") });
  }
}
for (const g of spec.groups) for (const c of g.commands) for (const e of c.examples || []) examples.push({ where: `commands.json ${g.name} ${c.name}`, cmd: e.replace(/^.*?devsuite\s+/, "") });
const tokens = (s) => [...s.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((t) => t[0]);
let checked = 0;
for (const { where, cmd } of examples) {
  const t = tokens(cmd);
  const g = spec.groups.find((x) => x.name === t[0]);
  if (!g) continue; // status, schema, skills...
  const c = g.commands.find((x) => x.name === `${t[1]} ${t[2]}`) || g.commands.find((x) => x.name === t[1]);
  assert.ok(c, `${where}: comando inexistente: devsuite ${cmd}`);
  for (const tok of t) {
    const opt = /^--([a-z][a-z-]*)/.exec(tok)?.[1];
    if (!opt || GLOBAL.has(opt)) continue;
    assert.ok((c.options || []).some((o) => o.name === opt), `${where}: --${opt} não existe em ${g.name} ${c.name}`);
  }
  checked++;
}
assert.ok(checked > 60, `poucos exemplos verificados (${checked})`);

console.log("cli.test.mjs: ok");
