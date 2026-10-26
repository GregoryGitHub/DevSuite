import { el, icon } from "../utils/dom.js";
import { createModalHost, btn } from "./modal.js";
import { redisApi, openFileDialogApi } from "../api.js";
import { normalizeConnection, connConfig, connLabel, parseRedisUrl, buildRedisUrl, MODES, CONN_COLORS, TYPES, parseTtl, fmtTtl } from "../utils/redisModel.js";

// Modais do app Redis: conexão (standalone/Cluster/Sentinel, TLS, SSH), nova chave, TTL,
// formulários simples e confirmações (ambiente sensível = digitar o nome).

const modal = createModalHost(document.getElementById("rds-modal"));

export const isRdsModalOpen = modal.isOpen;
export const closeRdsModal = modal.close;
export const rdsConfirm = modal.confirm;
export const rdsModal = modal;

export function field(label, control, hint = "") {
  return el("label.hx-field", {}, el("span.hx-field-label", {}, label), control, hint ? el("span.hx-field-hint", {}, hint) : null);
}

export function input(value, { type = "text", placeholder = "", oninput, className = "", list, min, max } = {}) {
  return el(`input.hx-input${className ? `.${className}` : ""}`, { type, value: value ?? "", placeholder, spellcheck: false, autocomplete: "off", oninput, list, min, max });
}

export function selectEl(options, value, onchange) {
  const s = el("select.hx-select", { onchange: () => onchange(s.value) });
  for (const [v, label] of options) s.append(el("option", { value: v, selected: String(v) === String(value) }, label));
  return s;
}

export function check(label, checked, onchange, hint = "") {
  const box = el("input", { type: "checkbox", checked, onchange: () => onchange(box.checked) });
  return el("label.db-check", { title: hint }, box, el("span", {}, label));
}

export function statusBox() {
  const box = el("div.db-test", { hidden: true });
  box.show = (ok, text) => {
    box.hidden = false;
    box.className = `db-test ${ok === null ? "busy" : ok ? "ok" : "bad"}`;
    box.innerHTML = "";
    box.append(icon(ok === null ? "fa-solid fa-spinner fa-spin" : ok ? "fa-solid fa-circle-check" : "fa-solid fa-circle-exclamation"), el("span", {}, text));
  };
  return box;
}

function textarea(value, { rows = 3, placeholder = "", oninput, className = "" } = {}) {
  const t = el(`textarea.hx-code-input${className ? `.${className}` : ""}`, { rows, placeholder, spellcheck: false });
  t.value = value ?? "";
  if (oninput) t.addEventListener("input", oninput);
  return t;
}

// ---------- Confirmações ----------

/** Confirmação de ação destrutiva; em conexões sensíveis exige digitar o nome. */
export function dangerConfirm({ title, message, name = "", confirmLabel = "Confirmar", requireName = false, body = null }) {
  if (!requireName || !name) return modal.confirm({ title, message, body, confirmLabel, danger: true });
  return new Promise((resolve) => {
    let answered = false;
    const typed = input("", { placeholder: name });
    const ok = btn(confirmLabel, () => {
      if (typed.value !== name) return;
      answered = true;
      resolve(true);
      modal.close();
    }, "hx-btn.danger");
    ok.disabled = true;
    typed.addEventListener("input", () => (ok.disabled = typed.value !== name));
    typed.addEventListener("keydown", (e) => e.key === "Enter" && !ok.disabled && ok.click());
    modal.open({
      title,
      body: el("div", {}, body || el("p.hx-modal-text", {}, message), field(el("span", {}, "Ambiente sensível: digite ", el("code", {}, name), " para confirmar"), typed)),
      footer: [btn("Cancelar", () => modal.close()), ok],
      onClose: () => !answered && resolve(false),
    });
    typed.focus();
  });
}

export function promptDialog({ title, label, value = "", placeholder = "", hint = "" }) {
  return new Promise((resolve) => {
    let answered = false;
    const inp = input(value, { placeholder });
    const done = (v) => {
      answered = true;
      resolve(v);
      modal.close();
    };
    inp.addEventListener("keydown", (e) => e.key === "Enter" && done(inp.value));
    modal.open({ title, body: field(label, inp, hint), footer: [btn("Cancelar", () => modal.close()), btn("OK", () => done(inp.value), "hx-btn.primary")], onClose: () => !answered && resolve(null) });
    inp.focus();
    inp.select();
  });
}

/**
 * Formulário genérico. fields: [{ name, label, value, type: text|number|textarea|select|check, options, placeholder, hint, rows }]
 * validate(values) → mensagem de erro ou "". Resolve com os valores ou null.
 */
export function formDialog({ title, iconCls = "", fields, confirmLabel = "OK", validate, wide = false, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const values = Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === "check" ? false : "")]));
    const status = statusBox();
    let first = null;
    const controls = fields.map((f) => {
      let c;
      if (f.type === "textarea") c = textarea(values[f.name], { rows: f.rows || 4, placeholder: f.placeholder, oninput: (e) => (values[f.name] = e.target.value), className: f.mono === false ? "" : "rds-mono" });
      else if (f.type === "select") c = selectEl(f.options, values[f.name], (v) => (values[f.name] = v));
      else if (f.type === "check") return check(f.label, values[f.name], (v) => (values[f.name] = v), f.hint || "");
      else c = input(values[f.name], { type: f.type === "number" ? "number" : "text", placeholder: f.placeholder, oninput: (e) => (values[f.name] = e.target.value), className: f.type === "number" ? "hx-num" : "" });
      first ||= c;
      return field(f.label, c, f.hint || "");
    });
    const ok = () => {
      const problem = validate?.(values);
      if (problem) return status.show(false, problem);
      answered = true;
      modal.close();
      resolve(values);
    };
    const body = el("div.db-conn-form", {}, ...controls, status);
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target.tagName === "INPUT" || e.ctrlKey)) {
        e.preventDefault();
        ok();
      }
    });
    modal.open({ title, iconCls, body, wide, footer: [btn("Cancelar", () => modal.close()), btn(confirmLabel, ok, danger ? "hx-btn.danger" : "hx-btn.primary")], onClose: () => !answered && resolve(null) });
    first?.focus();
  });
}

// ---------- TTL ----------

/** Resolve com segundos (> 0), 0 = remover expiração, ou null (cancelou). */
export function ttlDialog({ key, currentMs }) {
  return new Promise((resolve) => {
    let answered = false;
    const status = statusBox();
    const inp = input(currentMs > 0 ? String(Math.ceil(currentMs / 1000)) : "", { placeholder: "ex.: 3600, 30min, 1h30m, 7d" });
    const done = (v) => {
      answered = true;
      modal.close();
      resolve(v);
    };
    const apply = () => {
      const s = parseTtl(inp.value);
      if (s === null) return status.show(false, "Informe a duração em segundos ou com unidade (s, min, h, d).");
      done(s);
    };
    const presets = el(
      "div.rds-ttl-presets",
      {},
      ...[["1 min", 60], ["10 min", 600], ["1 h", 3600], ["1 dia", 86400], ["7 dias", 604800]].map(([l, s]) => el("button.rmq-chip", { type: "button", onclick: () => ((inp.value = String(s)), inp.focus()) }, l)),
    );
    inp.addEventListener("keydown", (e) => e.key === "Enter" && apply());
    modal.open({
      title: `TTL de ${key}`,
      iconCls: "fa-regular fa-clock",
      body: el("div", {}, el("p.hx-modal-text", {}, `Atual: ${fmtTtl(currentMs)}`), field("Expirar em", inp), presets, status),
      footer: [currentMs > 0 ? btn([icon("fa-solid fa-infinity"), " Remover expiração"], () => done(0)) : null, el("span.hx-flex"), btn("Cancelar", () => modal.close()), btn("Aplicar", apply, "hx-btn.primary")].filter(Boolean),
      onClose: () => !answered && resolve(null),
    });
    inp.focus();
    inp.select();
  });
}

// ---------- Nova chave ----------

/** Resolve com { type, key, ttl, value, field, score, id, fields } ou null. */
export function newKeyDialog({ prefix = "", hasJson = false }) {
  const types = Object.entries(TYPES)
    .filter(([t]) => ["string", "hash", "list", "set", "zset", "stream"].includes(t) || (t === "ReJSON-RL" && hasJson))
    .map(([t, info]) => [t, info.label]);
  return new Promise((resolve) => {
    let answered = false;
    const v = { type: "string", key: prefix, ttl: "", value: "", field: "", score: "0", fields: "campo=valor" };
    const status = statusBox();
    const keyInput = input(v.key, { placeholder: "ex.: usuario:42:perfil", oninput: (e) => (v.key = e.target.value) });
    const ttlInput = input("", { placeholder: "sem expiração (ou 3600, 1h, 7d)", oninput: (e) => (v.ttl = e.target.value) });
    const valueBox = textarea("", { rows: 6, className: "rds-mono", placeholder: "valor", oninput: (e) => (v.value = e.target.value) });
    const fieldInput = input("", { placeholder: "campo", oninput: (e) => (v.field = e.target.value) });
    const scoreInput = input("0", { type: "number", className: "hx-num", oninput: (e) => (v.score = e.target.value) });
    const fieldsBox = textarea(v.fields, { rows: 5, className: "rds-mono", placeholder: "campo=valor (um por linha)", oninput: (e) => (v.fields = e.target.value) });
    const fieldRow = field("Campo", fieldInput);
    const scoreRow = field("Score", scoreInput);
    const valueRow = field("Valor", valueBox);
    const fieldsRow = field("Campos da entrada", fieldsBox, "Um por linha: campo=valor. O id é gerado pelo servidor (*).");
    function sync() {
      fieldRow.hidden = v.type !== "hash";
      scoreRow.hidden = v.type !== "zset";
      fieldsRow.hidden = v.type !== "stream";
      valueRow.hidden = v.type === "stream";
      valueBox.placeholder = v.type === "ReJSON-RL" ? '{ "exemplo": true }' : v.type === "list" || v.type === "set" ? "um elemento por linha" : "valor";
    }
    const typeSel = selectEl(types, v.type, (t) => ((v.type = t), sync()));
    sync();
    const ok = () => {
      if (!v.key) return status.show(false, "Informe o nome da chave.");
      if (v.ttl.trim() && parseTtl(v.ttl) === null) return status.show(false, "TTL inválido.");
      if (v.type === "hash" && !v.field) return status.show(false, "Informe o campo.");
      if (v.type === "zset" && !Number.isFinite(Number(v.score))) return status.show(false, "Score inválido.");
      if (v.type === "ReJSON-RL") {
        try {
          JSON.parse(v.value);
        } catch (e) {
          return status.show(false, `JSON inválido: ${e.message}`);
        }
      }
      if (v.type === "stream" && !v.fields.split(/\r?\n/).some((l) => l.includes("="))) return status.show(false, "Informe ao menos um campo=valor.");
      answered = true;
      modal.close();
      resolve({ ...v, ttl: v.ttl.trim() ? parseTtl(v.ttl) : 0 });
    };
    modal.open({
      title: "Nova chave",
      iconCls: "fa-solid fa-key",
      wide: true,
      body: el("div.db-conn-form", {}, el("div.db-row2", {}, field("Tipo", typeSel), field("TTL", ttlInput)), field("Chave", keyInput), fieldRow, scoreRow, valueRow, fieldsRow, status),
      footer: [btn("Cancelar", () => modal.close()), btn("Criar", ok, "hx-btn.primary")],
      onClose: () => !answered && resolve(null),
    });
    keyInput.focus();
    keyInput.setSelectionRange(v.key.length, v.key.length);
  });
}

// ---------- Conexão ----------

/**
 * onSave(conn, secrets) — secrets: { password?, sentinel_password?, ssh_password?, ssh_passphrase? }
 * (ausente = mantém o do cofre; "" = apaga).
 */
export function connectionDialog(initial, { isNew, saved = {}, onSave, onDelete, onCopy }) {
  const c = normalizeConnection(structuredClone(initial));
  const secrets = {};
  const status = statusBox();
  const pwPlaceholder = (kind, fallback) => (saved[kind] ? "•••••••• (salva no cofre do sistema)" : fallback);

  const colorRow = el("div.db-colors");
  function paintColors() {
    colorRow.innerHTML = "";
    for (const color of CONN_COLORS) {
      colorRow.append(
        el("button.db-color", {
          type: "button",
          title: color ? "Cor da conexão" : "Sem cor",
          style: color ? `--c:${color}` : "",
          class: `db-color${color === c.color ? " on" : ""}${color ? "" : " none"}`,
          onclick: () => ((c.color = color), paintColors()),
        }),
      );
    }
  }
  paintColors();

  const modeSwitch = el("div.db-driver-switch");
  function paintMode() {
    modeSwitch.innerHTML = "";
    for (const [value, label] of MODES) {
      modeSwitch.append(el("button.db-driver", { type: "button", class: `db-driver${c.mode === value ? " on" : ""}`, onclick: () => ((c.mode = value), paintMode(), syncMode()) }, label));
    }
  }

  const hostInput = input(c.host, { placeholder: "localhost ou cache.exemplo.com", oninput: (e) => (c.host = e.target.value.trim()) });
  const portInput = input(c.port, { type: "number", className: "hx-num", oninput: (e) => (c.port = Number(e.target.value) || 6379) });
  const nodesBox = textarea(c.nodes.join("\n"), { rows: 3, className: "rds-mono", oninput: (e) => (c.nodes = e.target.value.split(/[\s,;]+/).filter(Boolean)) });
  const userInput = input(c.username, { placeholder: "default (ACL)", oninput: (e) => (c.username = e.target.value) });
  const pwInput = input("", { type: "password", placeholder: pwPlaceholder("password", "senha (requirepass / ACL)"), oninput: (e) => (secrets.password = e.target.value) });
  const masterInput = input(c.master_name, { placeholder: "mymaster", oninput: (e) => (c.master_name = e.target.value) });
  const sUserInput = input(c.sentinel_username, { placeholder: "opcional", oninput: (e) => (c.sentinel_username = e.target.value) });
  const sPwInput = input("", { type: "password", placeholder: pwPlaceholder("sentinel_password", "opcional"), oninput: (e) => (secrets.sentinel_password = e.target.value) });

  const hostRow = el("div.db-row3.rds-row-hp", {}, field("Host", hostInput), field("Porta", portInput));
  const nodesRow = field("Nós", nodesBox);
  const sentinelRows = el("div", {}, field("Nome do master", masterInput), el("div.db-row2", {}, field("Usuário do Sentinel", sUserInput), field("Senha do Sentinel", sPwInput)));
  function syncMode() {
    hostRow.hidden = c.mode === "sentinel";
    nodesRow.hidden = c.mode === "standalone";
    sentinelRows.hidden = c.mode !== "sentinel";
    nodesRow.querySelector(".hx-field-label").textContent = c.mode === "sentinel" ? "Sentinels" : "Nós iniciais (opcional)";
    nodesBox.placeholder = c.mode === "sentinel" ? "sentinel-1:26379\nsentinel-2:26379" : "10.0.0.1:7000\n10.0.0.2:7000";
  }

  // TLS
  const caInput = input(c.ca_path, { placeholder: "certificados do sistema", oninput: (e) => (c.ca_path = e.target.value) });
  const caPick = btn([icon("fa-regular fa-folder-open")], async () => {
    const p = await openFileDialogApi({ title: "CA (PEM)", filters: [{ name: "Certificado", extensions: ["pem", "crt", "cer"] }] });
    if (p) caInput.value = c.ca_path = p;
  });
  const tlsBox = el("div.rds-tls", {}, check("Não verificar o certificado do servidor", c.tls_insecure, (v) => (c.tls_insecure = v)), field("CA própria (PEM)", el("div.rds-file", {}, caInput, caPick)));
  const tlsCheck = check("TLS (rediss://) — Azure Cache, ElastiCache, Upstash, Redis Cloud…", c.tls, (v) => ((c.tls = v), (tlsBox.hidden = !v)));
  tlsBox.hidden = !c.tls;

  // SSH
  const ssh = c.ssh ? { ...c.ssh } : { host: "", port: 22, user: "", auth: "password", key_path: "" };
  let useSsh = !!c.ssh;
  const sshPw = input("", { type: "password", placeholder: pwPlaceholder("ssh_password", "senha do SSH"), oninput: (e) => (secrets.ssh_password = e.target.value) });
  const keyPath = input(ssh.key_path, { placeholder: "~/.ssh/id_ed25519", oninput: (e) => (ssh.key_path = e.target.value) });
  const keyPick = btn([icon("fa-regular fa-folder-open")], async () => {
    const p = await openFileDialogApi({ title: "Chave privada SSH" });
    if (p) keyPath.value = ssh.key_path = p;
  });
  const passphrase = input("", { type: "password", placeholder: pwPlaceholder("ssh_passphrase", "se a chave tiver senha"), oninput: (e) => (secrets.ssh_passphrase = e.target.value) });
  const pwRow = field("Senha", sshPw);
  const keyRows = el("div", {}, field("Chave privada", el("div.rds-file", {}, keyPath, keyPick)), field("Senha da chave", passphrase));
  const syncSshAuth = () => {
    pwRow.hidden = ssh.auth !== "password";
    keyRows.hidden = ssh.auth !== "key";
  };
  const sshBox = el(
    "div.rds-ssh",
    {},
    el("div.db-row3.rds-row-hp", {}, field("Host SSH (bastion)", input(ssh.host, { placeholder: "bastion.exemplo.com", oninput: (e) => (ssh.host = e.target.value.trim()) })), field("Porta", input(ssh.port, { type: "number", className: "hx-num", oninput: (e) => (ssh.port = Number(e.target.value) || 22) }))),
    el("div.db-row2", {}, field("Usuário", input(ssh.user, { placeholder: "ubuntu", oninput: (e) => (ssh.user = e.target.value) })), field("Autenticação", selectEl([["password", "Senha"], ["key", "Chave privada"]], ssh.auth, (v) => ((ssh.auth = v), syncSshAuth())))),
    pwRow,
    keyRows,
    el("p.hx-field-hint", {}, "O host/porta do Redis são os vistos a partir do bastion (ex.: o endpoint privado). A chave do host SSH é conferida no known_hosts."),
  );
  syncSshAuth();
  sshBox.hidden = !useSsh;
  const sshCheck = check("Conectar por túnel SSH", useSsh, (v) => ((useSsh = v), (sshBox.hidden = !v)));

  const urlBox = input("", { placeholder: "redis://usuario:senha@host:6379/0  ·  rediss://…  ·  redis-cli -h host -p 6379 -a senha" });
  const applyUrl = () => {
    const r = parseRedisUrl(urlBox.value);
    if (!r) return status.show(false, "Não reconheci a URL. Formatos: redis://, rediss://, host:porta ou argumentos do redis-cli.");
    Object.assign(c, r.patch);
    if (r.password !== undefined) {
      secrets.password = r.password;
      pwInput.value = r.password;
    }
    hostInput.value = c.host;
    portInput.value = c.port;
    userInput.value = c.username;
    dbInput.value = c.db;
    tlsCheck.querySelector("input").checked = c.tls;
    tlsBox.hidden = !c.tls;
    paintMode();
    syncMode();
    status.show(true, "Campos preenchidos a partir da URL.");
  };
  urlBox.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), applyUrl()));
  urlBox.addEventListener("paste", () => setTimeout(applyUrl, 0));

  const dbInput = input(c.db, { type: "number", className: "hx-num", min: 0, oninput: (e) => (c.db = Math.max(0, Number(e.target.value) || 0)) });
  const sepInput = input(c.separator, { placeholder: ":", oninput: (e) => (c.separator = e.target.value) });

  function current() {
    return { ...c, ssh: useSsh && ssh.host ? { ...ssh } : null };
  }
  function validate() {
    const x = current();
    if (x.mode === "standalone" && !x.host) return "Informe o host.";
    if (x.mode === "cluster" && !x.host && !x.nodes.length) return "Informe o host ou os nós iniciais.";
    if (x.mode === "sentinel" && (!x.nodes.length || !x.master_name.trim())) return "Informe os sentinels e o nome do master.";
    if (useSsh && !ssh.host) return "Informe o host SSH (ou desmarque o túnel).";
    if (useSsh && ssh.auth === "key" && !ssh.key_path.trim()) return "Informe o arquivo da chave privada.";
    return "";
  }

  async function test() {
    const problem = validate();
    if (problem) return status.show(false, problem);
    status.show(null, "Conectando…");
    testBtn.disabled = true;
    try {
      const info = await redisApi.test(connConfig(normalizeConnection(current())), secrets);
      const extra = [info.mode, info.role, info.address, info.modules.length ? `módulos: ${info.modules.join(", ")}` : ""].filter(Boolean).join(" · ");
      status.show(true, `Conectado: Redis ${info.version || "?"} · ${extra}`);
    } catch (e) {
      status.show(false, String(e));
    } finally {
      testBtn.disabled = false;
    }
  }
  const testBtn = btn([icon("fa-solid fa-plug-circle-check"), " Testar conexão"], test);

  const body = el(
    "div.db-conn-form.rds-conn-form",
    {},
    el("details.db-connstr-box", { open: isNew }, el("summary", {}, icon("fa-solid fa-paste"), " Colar URL / comando do redis-cli"), urlBox, el("div.db-connstr-actions", {}, btn("Preencher campos", applyUrl))),
    el("div.db-row2", {}, field("Nome", input(c.name, { placeholder: "ex.: Cache produção", oninput: (e) => (c.name = e.target.value) })), field("Cor", colorRow)),
    field("Modo", modeSwitch),
    hostRow,
    nodesRow,
    sentinelRows,
    el("div.db-row2", {}, field("Usuário", userInput), field("Senha", pwInput)),
    tlsCheck,
    tlsBox,
    sshCheck,
    sshBox,
    el(
      "details.db-advanced",
      {},
      el("summary", {}, "Avançado"),
      el("div.db-row3.rds-row-adv", {}, field("Banco padrão", dbInput), field("Separador da árvore", sepInput), field("Tempo limite (s)", input(c.timeout_s, { type: "number", className: "hx-num", oninput: (e) => (c.timeout_s = Number(e.target.value) || 10) }))),
      check("Somente leitura (recusa comandos com a flag write, como no COMMAND INFO)", c.read_only, (v) => (c.read_only = v)),
    ),
    check("Ambiente sensível: exigir digitar o nome para FLUSH, excluir por padrão, CLIENT KILL e afins", c.protected, (v) => (c.protected = v)),
    el("div.db-test-row", {}, testBtn),
    status,
  );
  paintMode();
  syncMode();

  const save = btn(isNew ? "Criar" : "Salvar", async () => {
    const problem = validate();
    if (problem) return status.show(false, problem);
    modal.close();
    await onSave(normalizeConnection(current()), secrets);
  }, "hx-btn.primary");
  modal.open({
    title: isNew ? "Nova conexão Redis" : `Conexão: ${connLabel(c)}`,
    iconCls: "fa-solid fa-cubes-stacked",
    body,
    wide: true,
    className: "db-conn-modal",
    footer: [
      onDelete ? btn([icon("fa-regular fa-trash-can"), " Excluir"], () => (modal.close(), onDelete()), "hx-btn.danger") : null,
      el("span.hx-flex"),
      onCopy ? btn([icon("fa-regular fa-clipboard"), " Copiar URL"], () => onCopy(buildRedisUrl(current(), secrets.password))) : null,
      btn("Cancelar", () => modal.close()),
      save,
    ].filter(Boolean),
  });
  (isNew ? urlBox : body.querySelector("input")).focus();
}
