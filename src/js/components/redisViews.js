import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import { createTable, viewShell, toolBtn, filterInput, toggleBtn, updatedText, errorBox, chartCard, tile } from "./rabbitViews.js";
import { fmtNum, fmtBytes, fmtDuration, fmtTime, nameMatcher } from "../utils/rabbitModel.js";
import {
  parseInfo,
  keyspace,
  parseClientList,
  parseSlowlog,
  parseMonitorLine,
  respText,
  respInt,
  respPairs,
  respToJs,
  bulkLabel,
  detectFormat,
  typeInfo,
  fmtTtl,
  commandText,
} from "../utils/redisModel.js";

// Ferramentas de cada conexão Redis (abas): visão geral (INFO), configuração (CONFIG),
// slowlog/latência, clientes, Monitor, Pub/Sub, análise de memória e nós do Cluster.
// Cada função recebe (ctx, tab) e devolve { root, refresh(), dispose(), activate?(), live? }.

const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));
const num = (v) => (v === undefined || v === "" ? null : Number(v));

/** Seletor de nó (Cluster): devolve { el, value() } ou null fora do Cluster. */
async function nodePicker(ctx, c, onchange, { mastersOnly = false } = {}) {
  if (ctx.serverInfo(c)?.mode !== "cluster") return null;
  let nodes = [];
  try {
    nodes = await ctx.nodes(c);
  } catch {
    return null;
  }
  const list = nodes.filter((n) => !mastersOnly || n.role === "master");
  const sel = el("select.hx-select.small", { title: "Nó do Cluster", onchange: () => onchange(sel.value) }, ...list.map((n) => el("option", { value: n.address }, `${n.address} (${n.role})`)));
  return { el: sel, value: () => sel.value };
}

// ---------- Visão geral ----------

export function overviewView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  const v = viewShell({ title: "Visão geral", iconCls: "fa-solid fa-gauge-high" });
  const history = { ops: [], mem: [], net_in: [], net_out: [], clients: [] };
  let node = null;
  let picker = null;
  let disposed = false;
  let infoFilter = "";

  (async () => {
    picker = await nodePicker(ctx, c(), (n) => ((node = n), Object.values(history).forEach((h) => (h.length = 0)), refresh()));
    if (picker) {
      node = picker.value();
      v.head.append(picker.el);
    }
  })();

  async function refresh() {
    const r = await ctx.exec(c(), 0, ["INFO", "everything"], { node });
    if (r.t === "err") throw r.v;
    if (disposed) return;
    const text = r.t === "map" ? respText(r.v[0]?.[1]) : respText(r);
    render(parseInfo(text));
  }

  function push(arr, value) {
    arr.push(Number(value) || 0);
    if (arr.length > 120) arr.shift();
  }

  function render(info) {
    const s = info.server || {};
    const m = info.memory || {};
    const st = info.stats || {};
    const cl = info.clients || {};
    const rep = info.replication || {};
    const per = info.persistence || {};
    const ks = keyspace(info);
    push(history.ops, st.instantaneous_ops_per_sec);
    push(history.mem, m.used_memory);
    push(history.net_in, st.instantaneous_input_kbps);
    push(history.net_out, st.instantaneous_output_kbps);
    push(history.clients, cl.connected_clients);

    const hits = num(st.keyspace_hits) || 0;
    const misses = num(st.keyspace_misses) || 0;
    const hitRate = hits + misses ? (hits / (hits + misses)) * 100 : null;
    const used = num(m.used_memory) || 0;
    const max = num(m.maxmemory) || 0;
    const totalKeys = Object.values(ks).reduce((a, d) => a + (d.keys || 0), 0);
    const frag = Number(m.mem_fragmentation_ratio);

    v.body.innerHTML = "";
    const alerts = [];
    if (max && used / max > 0.9) alerts.push(`Memória em ${((used / max) * 100).toFixed(0)}% do maxmemory (${m.maxmemory_policy || "?"}).`);
    if (num(st.evicted_keys)) alerts.push(`${fmtNum(num(st.evicted_keys))} chave(s) despejada(s) por falta de memória (evicted_keys).`);
    if (num(st.rejected_connections)) alerts.push(`${fmtNum(num(st.rejected_connections))} conexão(ões) recusada(s) (maxclients).`);
    if (per.rdb_last_bgsave_status && per.rdb_last_bgsave_status !== "ok") alerts.push(`Último BGSAVE falhou (${per.rdb_last_bgsave_status}).`);
    if (per.aof_last_write_status && per.aof_last_write_status !== "ok") alerts.push(`Falha ao gravar o AOF (${per.aof_last_write_status}).`);
    if (rep.role === "slave" && rep.master_link_status && rep.master_link_status !== "up") alerts.push(`Réplica sem ligação com o master (${rep.master_link_status}).`);
    if (frag > 1.5 && used > 64 * 1024 * 1024) alerts.push(`Fragmentação alta (${frag.toFixed(2)}): considere activedefrag ou reiniciar a instância.`);
    if (alerts.length) v.body.append(el("div.rmq-alert", {}, icon("fa-solid fa-triangle-exclamation"), el("span", {}, alerts.join(" · "))));

    v.body.append(
      el(
        "div.rmq-tiles",
        {},
        tile("Versão", s.redis_version || s.valkey_version || "?", { sub: `${s.redis_mode || "standalone"} · ${rep.role || ""}` }),
        tile("Uptime", fmtDuration((num(s.uptime_in_seconds) || 0) * 1000)),
        tile("Ops/s", fmtNum(num(st.instantaneous_ops_per_sec)), { cls: "accent" }),
        tile("Memória", m.used_memory_human || fmtBytes(used), { sub: max ? `de ${m.maxmemory_human} · ${m.maxmemory_policy}` : "sem maxmemory", cls: max && used / max > 0.9 ? "warn" : "" }),
        tile("Pico", m.used_memory_peak_human || "—"),
        tile("Fragmentação", Number.isFinite(frag) ? frag.toFixed(2) : "—", { cls: frag > 1.5 ? "warn" : "" }),
        tile("Clientes", fmtNum(num(cl.connected_clients)), { sub: num(cl.blocked_clients) ? `${cl.blocked_clients} bloqueado(s)` : "", onclick: () => ctx.openTool(c(), "clients") }),
        tile("Chaves", fmtNum(totalKeys), { sub: `${fmtNum(num(st.expired_keys))} expiradas` }),
        tile("Acerto", hitRate === null ? "—" : `${hitRate.toFixed(1)}%`, { sub: `${fmtNum(hits)} hits · ${fmtNum(misses)} misses`, cls: hitRate !== null && hitRate < 80 ? "warn" : "" }),
        tile("Despejadas", fmtNum(num(st.evicted_keys)), { cls: num(st.evicted_keys) ? "warn" : "" }),
        tile("Rede", `${Number(st.instantaneous_input_kbps || 0).toFixed(1)} / ${Number(st.instantaneous_output_kbps || 0).toFixed(1)}`, { sub: "KB/s entrada / saída" }),
        tile("Persistência", per.aof_enabled === "1" ? "AOF + RDB" : "RDB", { sub: per.rdb_last_save_time ? `último save ${fmtTime(Number(per.rdb_last_save_time) * 1000, { millis: false })}` : "", cls: per.rdb_last_bgsave_status && per.rdb_last_bgsave_status !== "ok" ? "warn" : "" }),
      ),
    );

    v.body.append(
      el(
        "div.rmq-charts",
        {},
        chartCard("Operações por segundo", [{ label: "ops/s", cls: "s1", values: history.ops }], (x) => fmtNum(Math.round(x))),
        chartCard("Memória usada", [{ label: "memória", cls: "s2", values: history.mem }], fmtBytes),
        chartCard("Rede (KB/s)", [{ label: "entrada", cls: "s1", values: history.net_in }, { label: "saída", cls: "s3", values: history.net_out }], (x) => x.toFixed(1)),
      ),
    );

    const dbs = Object.entries(ks).map(([db, d]) => ({ db: Number(db), ...d }));
    if (dbs.length) {
      const t = createTable({
        columns: [
          { key: "db", label: "Banco", html: (r) => `<a href="#" data-open>db${r.db}</a>`, sort: (r) => r.db },
          { key: "keys", label: "Chaves", html: (r) => fmtNum(r.keys), sort: (r) => r.keys, align: "right" },
          { key: "expires", label: "Com TTL", html: (r) => fmtNum(r.expires), sort: (r) => r.expires, align: "right" },
          { key: "avg_ttl", label: "TTL médio", html: (r) => (r.avg_ttl ? fmtTtl(r.avg_ttl) : "—"), sort: (r) => r.avg_ttl, align: "right" },
        ],
        rowKey: (r) => String(r.db),
        onOpen: (r) => ctx.selectDb(c(), r.db),
      });
      t.setRows(dbs);
      v.body.append(el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-database"), " Keyspace"), t.root));
    }

    if (rep.role) {
      const replicas = Object.entries(rep)
        .filter(([k]) => /^slave\d+$/.test(k))
        .map(([k, val]) => ({ name: k, ...Object.fromEntries(val.split(",").map((p) => p.split("="))) }));
      const lines = [
        `Papel: ${rep.role}`,
        rep.role === "slave" ? `Master: ${rep.master_host}:${rep.master_port} · ligação ${rep.master_link_status} · atraso ${rep.master_last_io_seconds_ago ?? "?"} s` : `Réplicas: ${rep.connected_slaves ?? 0}`,
        ...replicas.map((r) => `${r.ip}:${r.port} · ${r.state} · offset ${r.offset} · lag ${r.lag}s`),
      ];
      v.body.append(el("div.rmq-card", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-clone"), " Replicação"), el("pre.rds-pre", {}, lines.join("\n"))));
    }

    // INFO completo, filtrável.
    const box = el("div.rmq-card.rds-info-all");
    const list = el("div.rds-info-list");
    const f = el("input.hx-input.small", { type: "search", placeholder: "Filtrar INFO (ex.: memory, latency, rdb_)", value: infoFilter, spellcheck: false });
    const paint = () => {
      const q = infoFilter.toLowerCase();
      list.innerHTML = Object.entries(info)
        .map(([sec, kv]) => {
          const rows = Object.entries(kv).filter(([k, val]) => !q || sec.includes(q) || k.toLowerCase().includes(q) || String(val).toLowerCase().includes(q));
          if (!rows.length) return "";
          return `<div class="rds-info-sec"><h4>${esc(sec)}</h4><table>${rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join("")}</table></div>`;
        })
        .join("");
    };
    f.addEventListener("input", () => ((infoFilter = f.value), paint()));
    paint();
    box.append(el("div.rmq-card-title", {}, icon("fa-solid fa-list"), " INFO completo", el("span.hx-flex"), f), list);
    v.body.append(box);
    v.foot.textContent = updatedText(Date.now(), [node, s.os, s.executable ? "" : "", `pid ${s.process_id}`, `porta ${s.tcp_port}`].filter(Boolean).join(" · "));
  }

  return { root: v.root, refresh, autoRefresh: true, dispose: () => (disposed = true) };
}

// ---------- Configuração ----------

export function configView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  const st = { text: "" };
  let rows = [];
  let node = null;
  const filter = filterInput(st, "Filtrar parâmetros", () => paint());
  const v = viewShell({
    title: "Configuração",
    iconCls: "fa-solid fa-sliders",
    filter: filter.box,
    tools: [toolBtn("fa-solid fa-floppy-disk", "Gravar a configuração atual no redis.conf (CONFIG REWRITE)", () => rewrite(), "REWRITE")],
  });
  const t = createTable({
    columns: [
      { key: "name", label: "Parâmetro", html: (r) => `<span class="rds-mono">${esc(r.name)}</span>`, sort: (r) => r.name, width: "34%" },
      { key: "value", label: "Valor", html: (r) => (r.value === "" ? '<span class="rmq-zero">(vazio)</span>' : `<span class="rds-cell">${esc(r.value)}</span>`), sort: (r) => r.value },
    ],
    rowKey: (r) => r.name,
    onOpen: (r) => edit(r),
    onMenu: (list, e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        { label: "Alterar (CONFIG SET)…", icon: "fa-solid fa-pen", run: () => edit(list[0]) },
        { label: "Copiar", icon: "fa-regular fa-copy", run: () => ctx.copy(list.map((r) => `${r.name} ${r.value}`).join("\n")) },
      ]),
    emptyText: "Nenhum parâmetro (CONFIG GET pode estar desabilitado em serviços gerenciados).",
  });
  v.body.append(t.root);
  (async () => {
    const p = await nodePicker(ctx, c(), (n) => ((node = n), refresh()));
    if (p) {
      node = p.value();
      v.head.append(p.el);
    }
  })();

  function paint() {
    const m = nameMatcher(st.text);
    t.setRows(rows.filter((r) => m(r.name) || m(r.value)));
    v.countEl.textContent = fmtNum(rows.length);
  }

  async function refresh() {
    const r = await ctx.exec(c(), 0, ["CONFIG", "GET", "*"], { node });
    if (r.t === "err") throw r.v;
    rows = respPairs(r)
      .map(([k, val]) => ({ name: respText(k), value: respText(val) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    paint();
    v.foot.textContent = updatedText(Date.now());
  }

  async function edit(r) {
    const next = await ctx.prompt({ title: `CONFIG SET ${r.name}`, label: "Novo valor", value: r.value, hint: "Vale para o servidor em execução; use REWRITE para gravar no redis.conf." });
    if (next === null || next === r.value) return;
    const ok = await ctx.danger(c(), { title: "Alterar configuração?", message: `${r.name}: "${r.value}" → "${next}"`, name: r.name, confirmLabel: "Alterar" });
    if (!ok) return;
    const res = await ctx.exec(c(), 0, ["CONFIG", "SET", r.name, next], { node });
    ctx.toast(res.t === "err" ? res.v : `${r.name} alterado`);
    refresh().catch(() => {});
  }

  async function rewrite() {
    const ok = await ctx.danger(c(), { title: "CONFIG REWRITE?", message: "O redis.conf do servidor será regravado com a configuração atual.", name: "rewrite", confirmLabel: "Regravar" });
    if (!ok) return;
    const res = await ctx.exec(c(), 0, ["CONFIG", "REWRITE"], { node });
    ctx.toast(res.t === "err" ? res.v : "redis.conf regravado");
  }

  return { root: v.root, refresh, focusFilter: () => filter.input.focus() };
}

// ---------- Slowlog e latência ----------

export function slowlogView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  let node = null;
  const v = viewShell({
    title: "Slowlog e latência",
    iconCls: "fa-solid fa-hourglass-half",
    tools: [toolBtn("fa-solid fa-eraser", "Apagar o slowlog (SLOWLOG RESET)", () => reset(), "Limpar")],
  });
  const slow = createTable({
    columns: [
      { key: "at", label: "Quando", html: (r) => esc(fmtTime(r.at, { millis: false })), sort: (r) => r.at, width: "150px" },
      { key: "us", label: "Duração", html: (r) => `<span class="${r.us > 100000 ? "rds-warn" : ""}">${(r.us / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ms</span>`, sort: (r) => r.us, align: "right", width: "100px" },
      { key: "cmd", label: "Comando", html: (r) => `<span class="rds-mono">${esc(r.args.join(" ").slice(0, 300))}</span>`, sort: (r) => r.args[0] },
      { key: "client", label: "Cliente", html: (r) => `${esc(r.client)}${r.name ? ` <span class="rmq-zero">${esc(r.name)}</span>` : ""}`, sort: (r) => r.client, width: "180px" },
    ],
    rowKey: (r) => String(r.id),
    onMenu: (list, e) => ctx.showMenu(e.clientX, e.clientY, [{ label: "Copiar comando", icon: "fa-regular fa-copy", run: () => ctx.copy(list.map((r) => r.args.join(" ")).join("\n")) }, { label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(c(), 0, list.map((r) => r.args.join(" ")).join("\n")) }]),
    emptyText: "Nenhum comando lento registrado.",
  });
  const lat = createTable({
    columns: [
      { key: "event", label: "Evento", html: (r) => esc(r.event), sort: (r) => r.event },
      { key: "at", label: "Último pico", html: (r) => esc(fmtTime(r.at, { millis: false })), sort: (r) => r.at },
      { key: "latest", label: "Último (ms)", html: (r) => fmtNum(r.latest), sort: (r) => r.latest, align: "right" },
      { key: "max", label: "Máximo (ms)", html: (r) => fmtNum(r.max), sort: (r) => r.max, align: "right" },
    ],
    rowKey: (r) => r.event,
    emptyText: "Sem eventos (latency-monitor-threshold = 0 desliga o monitor de latência).",
  });
  const cfg = el("div.rds-hint-line");
  const doctor = el("pre.rds-pre", { hidden: true });
  const doctorBtn = el("button.hx-btn.small", { type: "button", onclick: () => runDoctor() }, icon("fa-solid fa-stethoscope"), " LATENCY DOCTOR");
  v.body.append(
    cfg,
    el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-hourglass-half"), " Slowlog (128 mais recentes)"), slow.root),
    el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-chart-line"), " Latência (LATENCY LATEST)", el("span.hx-flex"), doctorBtn), lat.root, doctor),
  );
  (async () => {
    const p = await nodePicker(ctx, c(), (n) => ((node = n), refresh()));
    if (p) {
      node = p.value();
      v.head.append(p.el);
    }
  })();

  async function refresh() {
    const [s, l, conf1, conf2] = await ctx.pipeline(c(), 0, [["SLOWLOG", "GET", "128"], ["LATENCY", "LATEST"], ["CONFIG", "GET", "slowlog-log-slower-than"], ["CONFIG", "GET", "latency-monitor-threshold"]], { node });
    if (s.t === "err") throw s.v;
    slow.setRows(parseSlowlog(s));
    lat.setRows(l.t === "err" ? [] : (l.v || []).map((e) => ({ event: respText(e.v[0]), at: respInt(e.v[1]) * 1000, latest: respInt(e.v[2]), max: respInt(e.v[3]) })));
    const val = (r) => (r?.t === "err" ? "?" : respText(respPairs(r)[0]?.[1]));
    cfg.textContent = `slowlog-log-slower-than = ${val(conf1)} µs · latency-monitor-threshold = ${val(conf2)} ms`;
    v.countEl.textContent = fmtNum((s.v || []).length);
    v.foot.textContent = updatedText(Date.now());
  }

  async function runDoctor() {
    const r = await ctx.exec(c(), 0, ["LATENCY", "DOCTOR"], { node });
    doctor.hidden = false;
    doctor.textContent = respText(r);
  }

  async function reset() {
    const ok = await ctx.danger(c(), { title: "Limpar o slowlog?", message: "As entradas atuais do SLOWLOG serão apagadas.", name: "slowlog", confirmLabel: "Limpar" });
    if (!ok) return;
    const r = await ctx.exec(c(), 0, ["SLOWLOG", "RESET"], { node });
    ctx.toast(r.t === "err" ? r.v : "Slowlog limpo");
    refresh().catch(() => {});
  }

  return { root: v.root, refresh, autoRefresh: true };
}

// ---------- Clientes ----------

export function clientsView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  const st = { text: "" };
  let rows = [];
  let node = null;
  const filter = filterInput(st, "Filtrar (endereço, nome, comando…)", () => paint());
  const v = viewShell({ title: "Clientes", iconCls: "fa-solid fa-plug", filter: filter.box });
  const t = createTable({
    columns: [
      { key: "id", label: "ID", html: (r) => esc(r.id), sort: (r) => r.id, align: "right", width: "70px" },
      { key: "addr", label: "Endereço", html: (r) => `<span class="rds-mono">${esc(r.addr)}</span>`, sort: (r) => r.addr },
      { key: "name", label: "Nome / biblioteca", html: (r) => `${esc(r.name)}${r["lib-name"] ? ` <span class="rmq-zero">${esc(r["lib-name"])} ${esc(r["lib-ver"] || "")}</span>` : ""}`, sort: (r) => r.name || r["lib-name"] },
      { key: "db", label: "db", html: (r) => esc(r.db), sort: (r) => r.db, align: "right", width: "50px" },
      { key: "age", label: "Conectado há", html: (r) => fmtDuration((r.age || 0) * 1000), sort: (r) => r.age, align: "right" },
      { key: "idle", label: "Ocioso", html: (r) => fmtDuration((r.idle || 0) * 1000), sort: (r) => r.idle, align: "right" },
      { key: "cmd", label: "Último comando", html: (r) => `<span class="rds-mono">${esc(r.cmd)}</span>`, sort: (r) => r.cmd },
      { key: "flags", label: "Flags", html: (r) => esc(r.flags), sort: (r) => r.flags, title: "N = normal, S = réplica, M = master, P = pub/sub, x = MULTI, b = bloqueado" },
      { key: "mem", label: "Memória", html: (r) => fmtBytes(r["tot-mem"] ?? r.omem ?? 0), sort: (r) => r["tot-mem"], align: "right" },
    ],
    rowKey: (r) => String(r.id),
    onMenu: (list, e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        { label: "Copiar endereço", icon: "fa-regular fa-copy", run: () => ctx.copy(list.map((r) => r.addr).join("\n")) },
        "sep",
        { label: list.length > 1 ? `Desconectar ${list.length} clientes…` : "Desconectar (CLIENT KILL)…", icon: "fa-solid fa-plug-circle-xmark", danger: true, run: () => kill(list) },
      ]),
    emptyText: "Nenhum cliente.",
  });
  v.body.append(t.root);
  (async () => {
    const p = await nodePicker(ctx, c(), (n) => ((node = n), refresh()));
    if (p) {
      node = p.value();
      v.head.append(p.el);
    }
  })();

  function paint() {
    const m = nameMatcher(st.text);
    t.setRows(rows.filter((r) => m(r.addr) || m(r.name || "") || m(r.cmd || "") || m(r["lib-name"] || "")));
    v.countEl.textContent = fmtNum(rows.length);
  }

  async function refresh() {
    const r = await ctx.exec(c(), 0, ["CLIENT", "LIST"], { node });
    if (r.t === "err") throw r.v;
    rows = parseClientList(respText(r));
    paint();
    v.foot.textContent = updatedText(Date.now());
  }

  async function kill(list) {
    const ok = await ctx.danger(c(), { title: "Desconectar clientes?", message: list.map((r) => `${r.addr} ${r.name || ""}`).join("\n"), name: list.length === 1 ? list[0].addr : `${list.length} clientes`, confirmLabel: "Desconectar" });
    if (!ok) return;
    for (const r of list) {
      const res = await ctx.exec(c(), 0, ["CLIENT", "KILL", "ID", String(r.id)], { node });
      if (res.t === "err") ctx.toast(res.v);
    }
    refresh().catch(() => {});
  }

  return { root: v.root, refresh, autoRefresh: true, focusFilter: () => filter.input.focus() };
}

// ---------- Monitor ----------

const MONITOR_KEEP = 20000;
const MONITOR_DOM = 1500;

export function monitorView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  const st = { text: "" };
  let liveId = null;
  let paused = false;
  let lines = [];
  let total = 0;
  let node = null;
  let rateCount = 0;
  let rate = 0;
  const byCmd = new Map();
  const filter = filterInput(st, "Filtrar (texto, * ou /regex/)", () => repaint());
  const startBtn = el("button.hx-btn.primary.rmq-tool", { type: "button", onclick: () => (liveId ? stop() : start()) });
  const pauseBtn = toggleBtn("Pausar tela", false, (on) => ((paused = on), on || repaint()), "Continua recebendo, só não desenha");
  const v = viewShell({
    title: "Monitor",
    iconCls: "fa-solid fa-wave-square",
    filter: filter.box,
    tools: [pauseBtn, toolBtn("fa-solid fa-broom", "Limpar", () => ((lines = []), byCmd.clear(), (total = 0), repaint())), toolBtn("fa-solid fa-file-export", "Exportar", () => ctx.saveText(`monitor-${Date.now()}.log`, lines.map((l) => l.raw).join("\n"))), startBtn],
  });
  const warn = el("div.rmq-alert.info", {}, icon("fa-solid fa-circle-info"), el("span", {}, "MONITOR mostra todos os comandos do servidor em tempo real. Em servidores muito carregados ele reduz o desempenho: use por pouco tempo."));
  const list = el("div.rds-mon-list");
  const top = el("div.rds-mon-top");
  v.body.append(warn, top, list);
  (async () => {
    const p = await nodePicker(ctx, c(), (n) => (node = n));
    if (p) {
      node = p.value();
      v.head.insertBefore(p.el, startBtn);
    }
  })();

  function paintBtn() {
    startBtn.innerHTML = "";
    startBtn.append(icon(liveId ? "fa-solid fa-stop" : "fa-solid fa-play"), liveId ? " Parar" : " Iniciar");
    startBtn.classList.toggle("danger", !!liveId);
    startBtn.classList.toggle("primary", !liveId);
  }
  paintBtn();

  const rowHtml = (l) =>
    `<div class="rds-mon-row"><span class="t">${esc(new Date(l.at).toLocaleTimeString("pt-BR"))}.${String(l.at % 1000).padStart(3, "0")}</span><span class="d">db${l.db ?? "?"}</span><span class="c">${esc(l.client)}</span><span class="x"><b>${esc(l.args[0] || "")}</b> ${esc(l.args.slice(1).join(" ").slice(0, 500))}</span></div>`;

  function matches(l) {
    if (!st.text) return true;
    return nameMatcher(st.text)(l.raw);
  }

  function repaint() {
    const shown = lines.filter(matches).slice(-MONITOR_DOM);
    list.innerHTML = shown.map(rowHtml).join("");
    list.scrollTop = list.scrollHeight;
    paintTop();
  }

  function paintTop() {
    const topCmds = [...byCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    top.innerHTML = `<span><b>${fmtNum(total)}</b> comandos · <b>${fmtNum(rate)}</b>/s</span>${topCmds.map(([k, n]) => `<span class="rmq-chip">${esc(k)} ${fmtNum(n)}</span>`).join("")}`;
  }

  function onEvent(ev) {
    if (ev.type === "monitor") {
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
      const parsed = ev.lines.map(parseMonitorLine);
      total += parsed.length;
      rateCount += parsed.length;
      for (const l of parsed) {
        const k = String(l.args[0] || "").toUpperCase();
        byCmd.set(k, (byCmd.get(k) || 0) + 1);
      }
      lines.push(...parsed);
      if (lines.length > MONITOR_KEEP) lines.splice(0, lines.length - MONITOR_KEEP);
      if (paused) return;
      const add = parsed.filter(matches);
      list.insertAdjacentHTML("beforeend", add.map(rowHtml).join(""));
      while (list.childElementCount > MONITOR_DOM) list.firstElementChild.remove();
      if (atBottom) list.scrollTop = list.scrollHeight;
    } else if (ev.type === "stopped") {
      ctx.liveEnded(liveId);
      liveId = null;
      paintBtn();
      if (ev.error) ctx.toast(`Monitor parou: ${ev.error}`);
    }
  }

  const rateTimer = setInterval(() => {
    rate = rateCount;
    rateCount = 0;
    if (liveId) paintTop();
  }, 1000);

  async function start() {
    try {
      liveId = await ctx.liveStart(c(), { kind: "monitor", node: node || "", db: 0 }, onEvent, "Monitor");
      paintBtn();
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  function stop() {
    if (liveId) ctx.liveStop(liveId);
  }

  return {
    root: v.root,
    refresh: async () => {},
    get live() {
      return !!liveId;
    },
    focusFilter: () => filter.input.focus(),
    dispose() {
      clearInterval(rateTimer);
      stop();
    },
  };
}

// ---------- Pub/Sub ----------

const PUBSUB_KEEP = 5000;

export function pubsubView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  const st = { text: "" };
  let liveId = null;
  let msgs = [];
  let selected = null;
  const chInput = el("input.hx-input", { placeholder: "canais (separados por vírgula)", spellcheck: false });
  const patInput = el("input.hx-input", { placeholder: "padrões, ex.: pedidos.*, eventos:*", spellcheck: false });
  const subBtn = el("button.hx-btn.primary", { type: "button", onclick: () => (liveId ? stop() : start()) });
  const filter = filterInput(st, "Filtrar mensagens", () => paintMsgs());
  const v = viewShell({ title: "Pub/Sub", iconCls: "fa-solid fa-tower-broadcast", filter: filter.box, tools: [toolBtn("fa-solid fa-broom", "Limpar", () => ((msgs = []), paintMsgs())), toolBtn("fa-solid fa-file-export", "Exportar JSON", () => exportMsgs())] });

  const chanTable = createTable({
    columns: [
      { key: "name", label: "Canal ativo", html: (r) => `<span class="rds-mono">${esc(r.name)}</span>`, sort: (r) => r.name },
      { key: "subs", label: "Assinantes", html: (r) => fmtNum(r.subs), sort: (r) => r.subs, align: "right", width: "90px" },
    ],
    rowKey: (r) => r.name,
    onOpen: (r) => {
      chInput.value = [chInput.value, r.name].filter(Boolean).join(", ");
      pubCh.value = r.name;
    },
    emptyText: "Nenhum canal com assinantes (PUBSUB CHANNELS).",
  });
  const msgTable = createTable({
    columns: [
      { key: "at", label: "Hora", html: (r) => esc(fmtTime(r.at)), sort: (r) => r.at, width: "160px" },
      { key: "channel", label: "Canal", html: (r) => `<span class="rds-mono">${esc(r.channel)}</span>${r.pattern ? ` <span class="rmq-zero">${esc(r.pattern)}</span>` : ""}`, sort: (r) => r.channel, width: "28%" },
      { key: "payload", label: "Mensagem", html: (r) => `<span class="rds-cell">${esc(bulkLabel(r.payload).slice(0, 300))}</span>`, sort: (r) => bulkLabel(r.payload) },
    ],
    rowKey: (r) => String(r.seq),
    onSelect: (list) => showMsg(list.length === 1 ? list[0] : null),
    onMenu: (list, e) => ctx.showMenu(e.clientX, e.clientY, [{ label: "Copiar mensagem", icon: "fa-regular fa-copy", run: () => ctx.copy(list.map((r) => bulkLabel(r.payload)).join("\n")) }, { label: "Republicar", icon: "fa-solid fa-paper-plane", run: () => list.forEach((r) => publish(r.channel, bulkLabel(r.payload))) }]),
    emptyText: "Assine canais ou padrões para ver as mensagens.",
  });
  const detail = el("pre.rds-pre.rds-msg-detail", {}, "Selecione uma mensagem.");
  const pubCh = el("input.hx-input", { placeholder: "canal", spellcheck: false });
  const pubMsg = el("textarea.hx-code-input.rds-mono", { rows: 3, placeholder: "mensagem", spellcheck: false });
  const pubBtn = el("button.hx-btn.primary", { type: "button", onclick: () => publish(pubCh.value, pubMsg.value) }, icon("fa-solid fa-paper-plane"), " Publicar");
  pubMsg.addEventListener("keydown", (e) => e.key === "Enter" && e.ctrlKey && (e.preventDefault(), pubBtn.click()));

  v.body.append(
    el(
      "div.rds-ps",
      {},
      el(
        "div.rds-ps-side",
        {},
        el("div.rmq-card", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-satellite-dish"), " Assinar"), chInput, patInput, el("div.rds-ps-actions", {}, subBtn)),
        el("div.rmq-card", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-paper-plane"), " Publicar"), pubCh, pubMsg, el("div.rds-ps-actions", {}, el("span.rmq-zero", {}, "Ctrl+Enter"), pubBtn)),
        el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-list"), " Canais ativos", el("span.hx-flex"), el("button.hx-icon-btn", { type: "button", title: "Atualizar", onclick: () => refresh() }, icon("fa-solid fa-rotate"))), chanTable.root),
      ),
      el("div.rds-ps-main", {}, el("div.rds-ps-list", {}, msgTable.root), detail),
    ),
  );

  function paintBtn() {
    subBtn.innerHTML = "";
    subBtn.append(icon(liveId ? "fa-solid fa-stop" : "fa-solid fa-satellite-dish"), liveId ? " Parar" : " Assinar");
    subBtn.classList.toggle("danger", !!liveId);
    subBtn.classList.toggle("primary", !liveId);
    chInput.disabled = patInput.disabled = !!liveId;
  }
  paintBtn();

  let seq = 0;
  function paintMsgs() {
    const m = nameMatcher(st.text);
    msgTable.setRows(msgs.filter((r) => !st.text || m(r.channel) || m(bulkLabel(r.payload))).slice(-2000).reverse());
    v.countEl.textContent = fmtNum(msgs.length);
  }

  function showMsg(r) {
    selected = r;
    if (!r) return (detail.textContent = "Selecione uma mensagem.");
    const f = detectFormat(r.payload);
    detail.textContent = `${r.channel}${r.pattern ? ` (padrão ${r.pattern})` : ""} · ${fmtTime(r.at)}\n\n${f.kind === "json" ? f.pretty : f.text}`;
  }

  let paintTimer = 0;
  function onEvent(ev) {
    if (ev.type === "messages") {
      for (const m of ev.items) msgs.push({ ...m, seq: ++seq });
      if (msgs.length > PUBSUB_KEEP) msgs.splice(0, msgs.length - PUBSUB_KEEP);
      clearTimeout(paintTimer);
      paintTimer = setTimeout(paintMsgs, 120);
    } else if (ev.type === "stopped") {
      ctx.liveEnded(liveId);
      liveId = null;
      paintBtn();
      if (ev.error) ctx.toast(`Assinatura parou: ${ev.error}`);
    }
  }

  const split = (s) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  async function start() {
    const channels = split(chInput.value);
    const patterns = split(patInput.value);
    if (!channels.length && !patterns.length) return ctx.toast("Informe ao menos um canal ou padrão");
    try {
      liveId = await ctx.liveStart(c(), { kind: "subscribe", channels, patterns, node: "", db: 0 }, onEvent, `Pub/Sub ${[...channels, ...patterns].join(", ")}`);
      paintBtn();
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  function stop() {
    if (liveId) ctx.liveStop(liveId);
  }

  async function publish(channel, message) {
    if (!channel.trim()) return ctx.toast("Informe o canal");
    const r = await ctx.exec(c(), 0, ["PUBLISH", channel.trim(), message]);
    ctx.toast(r.t === "err" ? r.v : `Publicada para ${fmtNum(respInt(r))} assinante(s)`);
  }

  async function refresh() {
    const r = await ctx.exec(c(), 0, ["PUBSUB", "CHANNELS"]);
    if (r.t === "err") throw r.v;
    const names = (r.v || []).map(respText);
    let subs = [];
    if (names.length) {
      const n = await ctx.exec(c(), 0, ["PUBSUB", "NUMSUB", ...names.slice(0, 500)]);
      subs = respPairs(n).map(([k, val]) => ({ name: respText(k), subs: respInt(val) }));
    }
    chanTable.setRows(subs);
  }

  function exportMsgs() {
    ctx.saveText(`pubsub-${Date.now()}.json`, JSON.stringify(msgs.map((m) => ({ at: new Date(m.at).toISOString(), channel: m.channel, pattern: m.pattern, payload: bulkLabel(m.payload) })), null, 2));
  }

  return {
    root: v.root,
    refresh,
    get live() {
      return !!liveId;
    },
    focusFilter: () => filter.input.focus(),
    dispose() {
      clearTimeout(paintTimer);
      stop();
    },
  };
}

// ---------- Análise de memória ----------

export function memoryView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  let runId = null;
  let snap = null;
  const opts = { pattern: tab.pattern || "", separator: c()?.separator || ":", depth: "3", limit: "", pause_ms: "0", count: "500", top: "100", db: String(tab.db || 0) };
  const inp = (k, ph, cls = "") => {
    const i = el(`input.hx-input${cls ? `.${cls}` : ""}`, { value: opts[k], placeholder: ph, spellcheck: false, oninput: () => (opts[k] = i.value) });
    return i;
  };
  const startBtn = el("button.hx-btn.primary.rmq-tool", { type: "button", onclick: () => (runId ? stop() : start()) });
  const v = viewShell({ title: "Análise de memória", iconCls: "fa-solid fa-chart-pie", tools: [toolBtn("fa-solid fa-stethoscope", "MEMORY DOCTOR e MEMORY STATS", () => doctor(), "Diagnóstico"), startBtn] });
  const form = el(
    "div.rds-mem-form",
    {},
    lbl("Banco", inp("db", "0", "hx-num")),
    lbl("Padrão (MATCH)", inp("pattern", "todas as chaves")),
    lbl("Separador", inp("separator", ":", "hx-num")),
    lbl("Níveis de prefixo", inp("depth", "3", "hx-num")),
    lbl("Limite de chaves", inp("limit", "todas", "hx-num")),
    lbl("SCAN COUNT", inp("count", "500", "hx-num")),
    lbl("Pausa entre lotes (ms)", inp("pause_ms", "0", "hx-num")),
  );
  const progress = el("div.rds-mem-progress", { hidden: true });
  const out = el("div.rds-mem-out");
  v.body.append(el("div.rmq-alert.info", {}, icon("fa-solid fa-circle-info"), el("span", {}, "Percorre as chaves com SCAN e mede cada uma com MEMORY USAGE (amostrado pelo Redis em coleções grandes). Em produção, use uma pausa entre lotes ou um limite.")), form, progress, out);

  function lbl(text, control) {
    return el("label.hx-field", {}, el("span.hx-field-label", {}, text), control);
  }

  function paintBtn() {
    startBtn.innerHTML = "";
    startBtn.append(icon(runId ? "fa-solid fa-stop" : "fa-solid fa-play"), runId ? " Parar" : " Analisar");
    startBtn.classList.toggle("danger", !!runId);
    startBtn.classList.toggle("primary", !runId);
  }
  paintBtn();

  async function start() {
    const spec = {
      db: Number(opts.db) || 0,
      pattern: opts.pattern.trim(),
      separator: opts.separator,
      depth: Number(opts.depth) || 3,
      limit: Number(opts.limit) || 0,
      count: Number(opts.count) || 500,
      pause_ms: Number(opts.pause_ms) || 0,
      top: Number(opts.top) || 100,
    };
    snap = null;
    out.innerHTML = "";
    try {
      runId = await ctx.analyzeStart(c(), spec, onEvent);
      paintBtn();
      progress.hidden = false;
      progress.textContent = "Iniciando…";
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  function stop() {
    if (runId) ctx.liveStop(runId);
  }

  function onEvent(s) {
    snap = s;
    progress.hidden = false;
    progress.textContent = `${s.done ? "Concluído" : "Analisando"}: ${fmtNum(s.scanned)} chave(s) · ${fmtBytes(s.total.bytes)} · ${(s.elapsed_ms / 1000).toFixed(1)} s${s.nodes > 1 ? ` · nós ${s.nodes_done}/${s.nodes}` : ""}${s.error ? ` · erro: ${s.error}` : ""}`;
    progress.classList.toggle("err", !!s.error);
    render(s);
    if (s.done) {
      ctx.liveEnded(runId);
      runId = null;
      paintBtn();
    }
  }

  function bar(part, total) {
    const pct = total ? (part / total) * 100 : 0;
    return `<div class="rds-bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="rmq-zero">${pct.toFixed(1)}%</span>`;
  }

  function render(s) {
    out.innerHTML = "";
    if (s.memory_unavailable) out.append(el("div.rmq-alert", {}, icon("fa-solid fa-triangle-exclamation"), el("span", {}, "MEMORY USAGE não está disponível neste servidor: as contagens de chaves valem, os bytes não.")));
    out.append(
      el(
        "div.rmq-tiles",
        {},
        tile("Chaves analisadas", fmtNum(s.scanned)),
        tile("Memória somada", fmtBytes(s.total.bytes), { cls: "accent" }),
        tile("Média por chave", s.scanned ? fmtBytes(Math.round(s.total.bytes / s.scanned)) : "—"),
        tile("Sem TTL", fmtNum(s.ttl[0]?.keys), { sub: fmtBytes(s.ttl[0]?.bytes), cls: s.ttl[0]?.keys ? "warn" : "" }),
      ),
    );
    const typeRows = Object.entries(s.by_type).map(([type, a]) => ({ type, ...a }));
    const types = createTable({
      columns: [
        { key: "type", label: "Tipo", html: (r) => `<span class="rds-type sm" style="--t:${typeInfo(r.type).color}">${esc(typeInfo(r.type).label)}</span>`, sort: (r) => r.type },
        { key: "keys", label: "Chaves", html: (r) => fmtNum(r.keys), sort: (r) => r.keys, align: "right" },
        { key: "bytes", label: "Memória", html: (r) => `${fmtBytes(r.bytes)} ${bar(r.bytes, s.total.bytes)}`, sort: (r) => r.bytes, align: "right" },
      ],
      rowKey: (r) => r.type,
      state: { sort: "bytes", dir: "desc" },
    });
    types.setRows(typeRows);
    const ttl = createTable({
      columns: [
        { key: "label", label: "TTL", html: (r) => esc(r.label) },
        { key: "keys", label: "Chaves", html: (r) => fmtNum(r.keys), align: "right" },
        { key: "bytes", label: "Memória", html: (r) => `${fmtBytes(r.bytes)} ${bar(r.bytes, s.total.bytes)}`, align: "right" },
      ],
      rowKey: (r) => r.label,
    });
    ttl.setRows(s.ttl);
    const prefixes = createTable({
      columns: [
        { key: "prefix", label: "Prefixo", html: (r) => `<span class="rds-mono">${esc(r.prefix)}*</span>`, sort: (r) => r.prefix },
        { key: "keys", label: "Chaves", html: (r) => fmtNum(r.keys), sort: (r) => r.keys, align: "right" },
        { key: "bytes", label: "Memória", html: (r) => `${fmtBytes(r.bytes)} ${bar(r.bytes, s.total.bytes)}`, sort: (r) => r.bytes, align: "right" },
      ],
      rowKey: (r) => r.prefix,
      state: { sort: "bytes", dir: "desc" },
      onOpen: (r) => ctx.filterKeys(c(), Number(opts.db) || 0, `${r.prefix}*`),
      onMenu: (list, e) =>
        ctx.showMenu(e.clientX, e.clientY, [
          { label: "Mostrar as chaves na árvore", icon: "fa-solid fa-filter", run: () => ctx.filterKeys(c(), Number(opts.db) || 0, `${list[0].prefix}*`) },
          { label: "Analisar só este prefixo", icon: "fa-solid fa-magnifying-glass-chart", run: () => ((opts.pattern = `${list[0].prefix}*`), form.querySelectorAll("input")[1].value = opts.pattern, start()) },
          { label: "Copiar padrão", icon: "fa-regular fa-copy", run: () => ctx.copy(`${list[0].prefix}*`) },
          "sep",
          { label: "Excluir as chaves do prefixo…", icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.deletePattern(c(), Number(opts.db) || 0, `${list[0].prefix}*`) },
        ]),
    });
    prefixes.setRows(s.prefixes);
    const top = createTable({
      columns: [
        { key: "key", label: "Chave", html: (r) => `<a href="#" data-open class="rds-mono">${esc(bulkLabel(r.key))}</a>`, sort: (r) => bulkLabel(r.key) },
        { key: "type", label: "Tipo", html: (r) => `<span class="rds-type sm" style="--t:${typeInfo(r.type).color}">${esc(typeInfo(r.type).short)}</span>`, sort: (r) => r.type, width: "70px" },
        { key: "ttl", label: "TTL", html: (r) => esc(fmtTtl(r.ttl)), sort: (r) => r.ttl, align: "right", width: "110px" },
        { key: "bytes", label: "Memória", html: (r) => fmtBytes(r.bytes), sort: (r) => r.bytes, align: "right", width: "100px" },
      ],
      rowKey: (r) => `${r.key.t}:${r.key.v}`,
      state: { sort: "bytes", dir: "desc" },
      onOpen: (r) => ctx.openKey(c(), Number(opts.db) || 0, r.key),
    });
    top.setRows(s.top);
    out.append(
      el("div.rmq-charts", {}, el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-shapes"), " Por tipo"), types.root), el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-regular fa-clock"), " Por TTL"), ttl.root)),
      el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-folder-tree"), ` Prefixos (separador "${esc(opts.separator)}", até ${opts.depth} níveis)`), prefixes.root),
      el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-weight-hanging"), " Maiores chaves (duplo clique abre)"), top.root),
    );
  }

  async function doctor() {
    const [d, s] = await ctx.pipeline(c(), 0, [["MEMORY", "DOCTOR"], ["MEMORY", "STATS"]]);
    const stats = s.t === "err" ? s.v : JSON.stringify(respToJs(s.t === "arr" ? { t: "map", v: respPairs(s) } : s), null, 2);
    out.prepend(el("div.rmq-card", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-stethoscope"), " MEMORY DOCTOR"), el("pre.rds-pre", {}, respText(d)), el("details", {}, el("summary", {}, "MEMORY STATS"), el("pre.rds-pre", {}, stats))));
  }

  return {
    root: v.root,
    refresh: async () => snap && render(snap),
    get live() {
      return !!runId;
    },
    dispose: () => stop(),
  };
}

// ---------- Nós do Cluster ----------

export function clusterView(ctx, tab) {
  const c = () => ctx.conn(tab.conn_id);
  const v = viewShell({ title: "Nós do Cluster", iconCls: "fa-solid fa-circle-nodes" });
  const tiles = el("div.rmq-tiles");
  const t = createTable({
    columns: [
      { key: "address", label: "Endereço", html: (r) => `<span class="rmq-state ${/fail/.test(r.flags) ? "bad" : "ok"}"></span><span class="rds-mono">${esc(r.address)}</span>`, sort: (r) => r.address },
      { key: "role", label: "Papel", html: (r) => esc(r.role === "master" ? "master" : "réplica"), sort: (r) => r.role },
      { key: "id", label: "ID", html: (r) => `<span class="rds-mono" title="${esc(r.id)}">${esc(r.id.slice(0, 10))}</span>`, sort: (r) => r.id },
      { key: "master", label: "Master de", html: (r) => `<span class="rds-mono">${esc(r.master_id.slice(0, 10))}</span>`, sort: (r) => r.master_id },
      { key: "slots", label: "Slots", html: (r) => `<span class="rds-mono">${esc(r.slots)}</span>`, sort: (r) => r.slots },
      { key: "flags", label: "Flags", html: (r) => esc(r.flags), sort: (r) => r.flags },
    ],
    rowKey: (r) => r.id,
    onMenu: (list, e) => ctx.showMenu(e.clientX, e.clientY, [{ label: "Visão geral deste nó", icon: "fa-solid fa-gauge-high", run: () => ctx.openTool(c(), "overview") }, { label: "Copiar endereço", icon: "fa-regular fa-copy", run: () => ctx.copy(list[0].address) }]),
  });
  v.body.append(tiles, t.root);

  async function refresh() {
    const [nodes, info] = await Promise.all([ctx.nodes(c()), ctx.exec(c(), 0, ["CLUSTER", "INFO"])]);
    const ci = Object.fromEntries(
      respText(info)
        .split(/\r?\n/)
        .filter((l) => l.includes(":"))
        .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
    );
    tiles.innerHTML = "";
    tiles.append(
      tile("Estado", ci.cluster_state || "?", { cls: ci.cluster_state === "ok" ? "accent" : "warn" }),
      tile("Slots atribuídos", fmtNum(Number(ci.cluster_slots_assigned)), { sub: `${fmtNum(Number(ci.cluster_slots_ok))} ok · ${fmtNum(Number(ci.cluster_slots_fail))} falha` }),
      tile("Nós", fmtNum(Number(ci.cluster_known_nodes)), { sub: `${fmtNum(Number(ci.cluster_size))} master(s) com slots` }),
      tile("Época", ci.cluster_current_epoch || "—"),
    );
    t.setRows(nodes);
    v.countEl.textContent = fmtNum(nodes.length);
    v.foot.textContent = updatedText(Date.now());
  }

  return { root: v.root, refresh, autoRefresh: true };
}

export { errorBox, commandText };
