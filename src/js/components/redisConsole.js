import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import { parseCommandLine, commandLines, commandText, classifyCommand, formatResp, respToJs, respText, respPairs } from "../utils/redisModel.js";

// Console estilo redis-cli: Enter executa (várias linhas = vários comandos, em ordem),
// Shift+Enter quebra a linha, ↑/↓ histórico (por conexão), Tab completa o comando.
// A dica de sintaxe vem do COMMAND DOCS do servidor. Cada console tem a própria sessão
// (`console:<aba>`), então BLPOP/XREAD BLOCK não travam o resto; "Cancelar" fecha a sessão.
// Locais: `use <n>` / `select <n>` (troca o banco), `clear`, `help <comando>`.

const OUTPUT_LIMIT = 200_000;
const ENTRIES_LIMIT = 500;
const docsCache = new Map(); // connId -> Promise<Map(nome -> doc)>

/** Sintaxe de um comando a partir dos argumentos do COMMAND DOCS. */
export function syntaxOf(name, doc) {
  const fmt = (a) => {
    const flags = Array.isArray(a.flags) ? a.flags : [];
    let s;
    if (a.type === "oneof") s = (a.arguments || []).map(fmt).join(" | ");
    else if (a.type === "block") s = (a.arguments || []).map(fmt).join(" ");
    else if (a.type === "pure-token") s = a.token;
    else s = a.token ? `${a.token} ${a.name}` : a.name;
    if (flags.includes("multiple")) s = `${s} [${s} ...]`;
    if (flags.includes("optional")) s = `[${s}]`;
    else if (a.type === "oneof") s = `<${s}>`;
    return s;
  };
  return [name.toUpperCase(), ...(doc?.arguments || []).map(fmt)].join(" ");
}

function docArgs(v) {
  // Cada argumento vem como mapa/lista plana; os filhos em "arguments".
  const o = {};
  for (const [k, val] of respPairs(v)) {
    const key = respText(k);
    if (key === "arguments") o.arguments = (val.v || []).map(docArgs);
    else if (key === "flags") o.flags = (val.v || []).map(respText);
    else o[key] = respText(val);
  }
  return o;
}

async function loadDocs(ctx, conn) {
  if (!docsCache.has(conn.id)) {
    docsCache.set(
      conn.id,
      (async () => {
        const map = new Map();
        try {
          const r = await ctx.exec(conn, 0, ["COMMAND", "DOCS"]);
          if (r.t !== "err") {
            for (const [k, v] of respPairs(r)) {
              const o = {};
              for (const [dk, dv] of respPairs(v)) {
                const key = respText(dk);
                if (key === "arguments") o.arguments = (dv.v || []).map(docArgs);
                else if (key !== "subcommands" && key !== "history" && key !== "doc_flags") o[key] = respText(dv);
              }
              map.set(respText(k).toLowerCase(), o);
            }
          }
        } catch {
          /* servidor antigo: sem dicas */
        }
        if (!map.size) {
          try {
            const r = await ctx.exec(conn, 0, ["COMMAND"]);
            for (const c of r.v || []) map.set(respText(c.v[0]).toLowerCase(), {});
          } catch {
            /* sem lista */
          }
        }
        return map;
      })(),
    );
  }
  return docsCache.get(conn.id);
}

export function forgetDocs(connId) {
  docsCache.delete(connId);
}

/**
 * tab: { id, conn_id, db }; text: comando inicial (opcional)
 * ctx: { conn, exec, toast, copy, showMenuBelow, history(connId), addHistory(connId, line), danger(c, opts), confirm,
 *        databases(c) → número de bancos, saveData, onTitleChange(tab), closeSession(c, session) }
 */
export function createConsoleTab(ctx, tab, text = "") {
  const conn = () => ctx.conn(tab.conn_id);
  const session = `console:${tab.id}`;
  let mode = "cli";
  let running = false;
  let cancelled = false;
  let histPos = -1;
  let draft = "";
  let docs = null;

  const out = el("div.rds-con-out", { tabindex: "0" });
  const inputEl = el("textarea.rds-con-input", { rows: 1, spellcheck: false, autocomplete: "off", placeholder: "GET chave   (Enter executa · Shift+Enter nova linha · ↑ histórico · Tab completa)" });
  inputEl.value = text;
  const prompt = el("span.rds-con-prompt");
  const hint = el("div.rds-con-hint");
  const dbBtn = el("button.dbt-db", { type: "button", title: "Banco do console", onclick: (e) => dbMenu(e.currentTarget) });
  const cancelBtn = el("button.dbt-btn", { type: "button", title: "Cancelar (fecha a conexão deste console)", disabled: true, onclick: () => cancel() }, icon("fa-solid fa-stop"));
  const modeSel = el(
    "select.dbt-tx-select",
    { title: "Formato da resposta", onchange: () => (mode = modeSel.value) },
    el("option", { value: "cli" }, "redis-cli"),
    el("option", { value: "json" }, "JSON"),
    el("option", { value: "raw" }, "Texto cru"),
  );
  const toolbar = el(
    "div.dbt-toolbar",
    {},
    el("button.dbt-run", { type: "button", title: "Executar (Enter)", onclick: () => submit() }, icon("fa-solid fa-play"), el("span", {}, "Executar")),
    cancelBtn,
    el("span.dbt-sep"),
    dbBtn,
    el("span.dbt-sep"),
    modeSel,
    el("span.hx-flex"),
    el("button.dbt-btn", { type: "button", title: "Copiar saída", onclick: () => ctx.copy(out.innerText, "Saída copiada") }, icon("fa-regular fa-copy")),
    el("button.dbt-btn", { type: "button", title: "Limpar (clear)", onclick: () => (out.innerHTML = "") }, icon("fa-solid fa-broom")),
  );
  const root = el("div.rds-con", {}, toolbar, out, el("div.rds-con-in", {}, prompt, inputEl), hint);

  function updateBar() {
    dbBtn.innerHTML = "";
    dbBtn.append(icon("fa-solid fa-database"), el("span", {}, `db${tab.db}`), icon("fa-solid fa-chevron-down"));
    prompt.textContent = `db${tab.db}>`;
    cancelBtn.disabled = !running;
    root.classList.toggle("running", running);
  }

  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(240, inputEl.scrollHeight)}px`;
  }

  function entry(cmdLine, db) {
    const box = el("div.rds-con-entry", {}, el("div.rds-con-cmd", {}, el("span.rds-con-p", {}, `db${db}>`), el("span", {}, cmdLine)));
    out.append(box);
    while (out.childElementCount > ENTRIES_LIMIT) out.firstElementChild.remove();
    return box;
  }

  function result(box, r, ms) {
    let textOut;
    if (mode === "json") textOut = JSON.stringify(respToJs(r), null, 2);
    else if (mode === "raw") textOut = respText(r);
    else textOut = formatResp(r);
    let truncated = false;
    if (textOut.length > OUTPUT_LIMIT) {
      textOut = textOut.slice(0, OUTPUT_LIMIT);
      truncated = true;
    }
    const cls = r.t === "err" ? "err" : r.t === "nil" ? "nil" : "";
    box.append(el("pre.rds-con-res", { class: `rds-con-res ${cls}` }, textOut), el("div.rds-con-meta", {}, `${ms} ms${truncated ? " · saída cortada (use SCAN/LRANGE com limites)" : ""}`));
  }

  function note(text, cls = "") {
    out.append(el("div.rds-con-note", { class: `rds-con-note ${cls}` }, text));
  }

  function scrollEnd() {
    out.scrollTop = out.scrollHeight;
  }

  async function switchDb(n) {
    const max = await ctx.databases(conn()).catch(() => 16);
    if (!Number.isInteger(n) || n < 0 || n >= max) return note(`Banco inválido (0 a ${max - 1}).`, "err");
    tab.db = n;
    ctx.saveData();
    ctx.onTitleChange(tab);
    updateBar();
    note(`Banco do console: db${n}`);
  }

  async function local(args) {
    const name = String(args[0]).toLowerCase();
    if ((name === "use" || name === "select") && args.length === 2) {
      await switchDb(Number(args[1]));
      return true;
    }
    if ((name === "clear" || name === "cls") && args.length === 1) {
      out.innerHTML = "";
      return true;
    }
    if (name === "help") {
      docs ||= await loadDocs(ctx, conn());
      const target = String(args[1] || "").toLowerCase();
      const d = target ? docs.get(target) : null;
      if (!target) note("Digite help <comando> para ver a sintaxe. Comandos locais: use <n>, clear, help.");
      else if (!d) note(`Sem documentação para ${target}.`, "err");
      else out.append(el("div.rds-con-help", {}, el("code", {}, syntaxOf(target, d)), el("p", {}, d.summary || ""), el("span", {}, [d.group, d.since ? `desde ${d.since}` : "", d.complexity || ""].filter(Boolean).join(" · "))));
      return true;
    }
    return false;
  }

  async function submit() {
    if (running) return;
    const lines = commandLines(inputEl.value);
    if (!lines.length) return;
    const c = conn();
    if (!c) return ctx.toast("Conexão removida");
    for (const l of lines) ctx.addHistory(c.id, l);
    histPos = -1;
    draft = "";
    inputEl.value = "";
    autosize();
    hint.textContent = "";
    running = true;
    cancelled = false;
    updateBar();
    try {
      for (const line of lines) {
        if (cancelled) break;
        const { args, error } = parseCommandLine(line);
        if (error) {
          entry(line, tab.db);
          note(error, "err");
          continue;
        }
        if (!args.length) continue;
        if (typeof args[0] === "string" && (await local(args))) continue;
        const cls = classifyCommand(args);
        if (cls.level === "danger") {
          const ok = await ctx.danger(c, { title: "Comando perigoso", message: `${cls.why}. Executar "${commandText(args).slice(0, 200)}"?`, name: `db${tab.db}`, confirmLabel: "Executar" });
          if (!ok) {
            entry(line, tab.db);
            note("Cancelado.", "muted");
            continue;
          }
        } else if (cls.level === "warn") {
          const ok = await ctx.confirm({ title: "Comando pesado", message: `${cls.why}. Executar mesmo assim?`, confirmLabel: "Executar", danger: true });
          if (!ok) continue;
        }
        const box = entry(line, tab.db);
        scrollEnd();
        const t0 = performance.now();
        try {
          const r = await ctx.exec(c, tab.db, args, { session });
          result(box, r, Math.round(performance.now() - t0));
          ctx.afterCommand?.(c, tab.db, args, r);
        } catch (e) {
          result(box, { t: "err", v: String(e) }, Math.round(performance.now() - t0));
        }
        scrollEnd();
      }
    } finally {
      running = false;
      updateBar();
      inputEl.focus();
    }
  }

  function cancel() {
    if (!running) return;
    cancelled = true;
    ctx.closeSession(conn(), session);
    note("Cancelado: a conexão deste console foi fechada (a próxima execução reconecta).", "muted");
  }

  async function dbMenu(anchor) {
    const max = await ctx.databases(conn()).catch(() => 16);
    ctx.showMenuBelow(anchor, [{ header: "Banco do console" }, ...Array.from({ length: max }, (_, n) => ({ label: `db${n}`, icon: n === tab.db ? "fa-solid fa-check" : "", run: () => switchDb(n) }))]);
  }

  // ---------- Entrada ----------

  async function updateHint() {
    const first = inputEl.value.split(/\r?\n/)[0].trim();
    const name = first.split(/\s+/)[0]?.toLowerCase() || "";
    if (!name) return (hint.textContent = "");
    docs ||= await loadDocs(ctx, conn());
    let d = docs.get(name);
    let full = name;
    // Subcomandos (CONFIG GET, XINFO STREAM…): "config|get".
    const sub = first.split(/\s+/)[1]?.toLowerCase();
    if (sub && docs.get(`${name}|${sub}`)) {
      d = docs.get(`${name}|${sub}`);
      full = `${name} ${sub}`;
    }
    hint.innerHTML = d ? `<code>${escapeHtml(syntaxOf(full, d))}</code>${d.summary ? ` <span>${escapeHtml(d.summary)}</span>` : ""}` : "";
  }

  async function complete() {
    const v = inputEl.value;
    if (v.includes(" ") || v.includes("\n") || !v.trim()) return false;
    docs ||= await loadDocs(ctx, conn());
    const low = v.toLowerCase();
    const names = [...docs.keys()].filter((n) => !n.includes("|") && n.startsWith(low)).sort();
    if (!names.length) return false;
    if (names.length === 1) {
      inputEl.value = `${names[0].toUpperCase()} `;
    } else {
      let prefix = names[0];
      for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length > low.length) inputEl.value = prefix.toUpperCase();
      else note(names.slice(0, 60).map((n) => n.toUpperCase()).join("  ") + (names.length > 60 ? "  …" : ""), "muted");
    }
    updateHint();
    return true;
  }

  inputEl.addEventListener("input", () => {
    autosize();
    updateHint();
  });
  inputEl.addEventListener("keydown", (e) => {
    const history = ctx.history(tab.conn_id);
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      complete();
    } else if (e.key === "ArrowUp" && !inputEl.value.slice(0, inputEl.selectionStart).includes("\n") && history.length) {
      e.preventDefault();
      if (histPos === -1) {
        draft = inputEl.value;
        histPos = history.length;
      }
      histPos = Math.max(0, histPos - 1);
      inputEl.value = history[histPos];
      autosize();
      updateHint();
    } else if (e.key === "ArrowDown" && histPos !== -1 && !inputEl.value.slice(inputEl.selectionEnd).includes("\n")) {
      e.preventDefault();
      histPos++;
      if (histPos >= history.length) {
        histPos = -1;
        inputEl.value = draft;
      } else inputEl.value = history[histPos];
      autosize();
      updateHint();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      out.innerHTML = "";
    } else if (e.key === "c" && e.ctrlKey && running && inputEl.selectionStart === inputEl.selectionEnd) {
      e.preventDefault();
      cancel();
    }
  });
  out.addEventListener("click", () => {
    if (!window.getSelection()?.toString()) inputEl.focus();
  });

  updateBar();
  note("Console Redis. Comandos locais: use <n>, clear, help <comando>. Pub/Sub e MONITOR têm abas próprias.", "muted");

  return {
    root,
    tab,
    activate() {
      autosize();
      inputEl.focus();
      if (inputEl.value) updateHint();
    },
    refresh() {},
    setText(t) {
      inputEl.value = t;
      autosize();
      updateHint();
      inputEl.focus();
    },
    get dirty() {
      return false;
    },
    get running() {
      return running;
    },
    beforeClose: async () => true,
    dispose() {
      ctx.closeSession(conn(), session);
    },
  };
}
