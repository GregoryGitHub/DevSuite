import { el, icon } from "../utils/dom.js";
import { createModalHost, btn } from "./modal.js";
import { highlightCode } from "../utils/highlight.js";
import { normalizeConnection, connConfig, connLabel, isAzureHost, parseConnectionString, parseMongoUri, mongoFlavor, CONN_COLORS } from "../utils/dbModel.js";
import { dbApi } from "../api.js";

// Modais da aba Banco: conexão (criar/editar/testar) e revisão do SQL antes de gravar.

const modal = createModalHost(document.getElementById("db-modal"));

export const dbModal = modal;
export const isDbModalOpen = modal.isOpen;
export const closeDbModal = modal.close;
export const dbConfirm = modal.confirm;

function field(label, control, hint = "") {
  return el("label.hx-field", {}, el("span.hx-field-label", {}, label), control, hint ? el("span.hx-field-hint", {}, hint) : null);
}

function input(value, { type = "text", placeholder = "", oninput, className = "" } = {}) {
  return el(`input.hx-input${className ? `.${className}` : ""}`, { type, value: value ?? "", placeholder, spellcheck: false, autocomplete: "off", oninput });
}

function selectEl(options, value, onchange) {
  const s = el("select.hx-select", { onchange: () => onchange(s.value) });
  for (const [v, label] of options) s.append(el("option", { value: v, selected: v === value }, label));
  return s;
}

function check(label, checked, onchange, hint = "") {
  const box = el("input", { type: "checkbox", checked, onchange: () => onchange(box.checked) });
  return el("label.db-check", { title: hint }, box, el("span", {}, label));
}

/**
 * Cria/edita uma conexão. onSave(conn, password) — password undefined = não mudou.
 * hasPassword: se já existe senha salva no cofre.
 */
export function connectionDialog(initial, { isNew, hasPassword = false, onSave, onDelete }) {
  const c = normalizeConnection(structuredClone(initial));
  let password; // undefined = mantém a salva
  const status = el("div.db-test", { hidden: true });

  const hostInput = input(c.host, { placeholder: "servidor.database.windows.net ou localhost", oninput: (e) => ((c.host = e.target.value), syncKind()) });
  const portInput = input(c.port ?? "", { type: "number", placeholder: "1433", className: "hx-num", oninput: (e) => (c.port = e.target.value ? Number(e.target.value) : null) });
  const instanceInput = input(c.instance, { placeholder: "opcional (SQLEXPRESS)", oninput: (e) => (c.instance = e.target.value) });
  const dbInput = input(c.database, { placeholder: "padrão do login", oninput: (e) => (c.database = e.target.value) });
  const nameInput = input(c.name, { placeholder: "ex.: Seu Banco de Dados", oninput: (e) => (c.name = e.target.value) });
  const userInput = input(c.auth.user, { placeholder: "usuário", oninput: (e) => (c.auth.user = e.target.value) });
  const pwInput = input("", { type: "password", placeholder: hasPassword ? "•••••••• (salva no cofre do sistema)" : "senha", oninput: (e) => (password = e.target.value) });
  const tenantInput = input(c.auth.tenant, { placeholder: "organizations (padrão) ou contoso.onmicrosoft.com", oninput: (e) => (c.auth.tenant = e.target.value) });
  const clientInput = input(c.auth.client_id, { placeholder: "padrão: cliente público da Azure CLI", oninput: (e) => (c.auth.client_id = e.target.value) });
  const timeoutInput = input(c.connect_timeout_s, { type: "number", className: "hx-num", oninput: (e) => (c.connect_timeout_s = Number(e.target.value) || 15) });

  const sqlAuth = el("div.db-auth-sql", {}, el("div.db-row2", {}, field("Usuário", userInput), field("Senha", pwInput)));
  const entraAuth = el(
    "div.db-auth-entra",
    {},
    field("Conta (opcional)", userInput.cloneNode(), "Sugere a conta no login do navegador. MFA é feito na página da Microsoft."),
    el("div.db-row2", {}, field("Tenant", tenantInput), field("Client ID", clientInput)),
  );
  const entraUser = entraAuth.querySelector("input");
  entraUser.value = c.auth.user;
  entraUser.placeholder = "nome@empresa.com";
  entraUser.addEventListener("input", (e) => {
    c.auth.user = e.target.value;
    userInput.value = e.target.value;
  });
  userInput.addEventListener("input", () => (entraUser.value = userInput.value));

  function syncAuth() {
    sqlAuth.hidden = c.auth.kind !== "sql";
    entraAuth.hidden = c.auth.kind !== "entra";
  }

  const authSelect = selectEl(
    [
      ["sql", "Login SQL (usuário e senha)"],
      ["entra", "Microsoft Entra (Azure AD) — interativo/MFA"],
    ],
    c.auth.kind,
    (v) => ((c.auth.kind = v), syncAuth()),
  );

  const kindBadge = el("span.db-kind-badge");
  function syncKind() {
    const azure = isAzureHost(c.host);
    kindBadge.textContent = azure ? "Azure SQL" : "SQL Server";
    kindBadge.classList.toggle("azure", azure);
  }

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

  const connStr = el("textarea.hx-code-input.db-connstr", {
    rows: 2,
    placeholder: "Server=tcp:servidor.database.windows.net,1433;Initial Catalog=banco;User ID=...;Password=...  ou  jdbc:sqlserver://...",
    spellcheck: false,
  });
  const applyConnStr = () => {
    const { patch, password: pw } = parseConnectionString(connStr.value);
    if (!patch.host) return showStatus(false, "Não encontrei o servidor na connection string.");
    Object.assign(c, { ...patch, auth: { ...c.auth, ...(patch.auth || {}) } });
    if (pw !== undefined) {
      password = pw;
      pwInput.value = pw;
    }
    hostInput.value = c.host;
    portInput.value = c.port ?? "";
    instanceInput.value = c.instance;
    dbInput.value = c.database;
    userInput.value = entraUser.value = c.auth.user;
    authSelect.value = c.auth.kind;
    encryptSelect.value = c.encrypt;
    trustBox.querySelector("input").checked = c.trust_server_certificate;
    timeoutInput.value = c.connect_timeout_s;
    syncAuth();
    syncKind();
    connStr.value = "";
    showStatus(true, "Campos preenchidos a partir da connection string.");
  };

  const encryptSelect = selectEl(
    [
      ["on", "Obrigatória (padrão)"],
      ["strict", "Strict (TDS 8.0)"],
      ["off", "Só no login"],
    ],
    c.encrypt,
    (v) => (c.encrypt = v),
  );
  const trustBox = check("Confiar no certificado do servidor", c.trust_server_certificate, (v) => (c.trust_server_certificate = v), "TrustServerCertificate=True (servidores locais com certificado autoassinado)");

  // ---------- MongoDB ----------

  const mongoUser = input(c.auth.user, { placeholder: "usuário (se não estiver na connection string)", oninput: (e) => (c.auth.user = e.target.value) });
  const mongoPw = input("", { type: "password", placeholder: hasPassword ? "•••••••• (salva no cofre do sistema)" : "senha", oninput: (e) => (password = e.target.value) });
  const mongoDb = input(c.database, { placeholder: "padrão da connection string", oninput: (e) => (c.database = e.target.value) });
  const mongoTimeout = input(c.connect_timeout_s, { type: "number", className: "hx-num", oninput: (e) => (c.connect_timeout_s = Number(e.target.value) || 15) });
  const flavorBadge = el("span.db-kind-badge");
  const uriInput = el("textarea.hx-code-input.db-connstr", {
    rows: 2,
    value: c.uri,
    placeholder: "mongodb+srv://usuario@cluster0.xxxxx.mongodb.net/  ·  mongodb://localhost:27017  ·  connection string do Azure Cosmos DB",
    spellcheck: false,
  });
  function syncUri() {
    const parsed = parseMongoUri(uriInput.value);
    flavorBadge.textContent = mongoFlavor(uriInput.value);
    flavorBadge.classList.toggle("azure", flavorBadge.textContent !== "MongoDB");
    if (!parsed.valid) {
      c.uri = uriInput.value.trim();
      return;
    }
    // A senha nunca fica na connection string salva: vai para o cofre do sistema.
    if (parsed.password !== undefined) {
      password = parsed.password;
      mongoPw.value = parsed.password;
      uriInput.value = parsed.uri;
      showStatus(true, "A senha foi retirada da connection string e será guardada no cofre do sistema.");
    }
    c.uri = parsed.uri;
    if (parsed.user) {
      c.auth.user = parsed.user;
      mongoUser.value = parsed.user;
    }
    if (parsed.database && !c.database) {
      c.database = parsed.database;
      mongoDb.value = parsed.database;
    }
  }
  uriInput.addEventListener("input", syncUri);
  const mongoSection = el(
    "div.db-mongo",
    {},
    field(el("span", {}, "Connection string ", flavorBadge), uriInput, "Atlas (mongodb+srv://), servidor/replica set (mongodb://) ou Azure Cosmos DB (API MongoDB). Opções como authSource, replicaSet, tls e retryWrites vão na própria string."),
    el("div.db-row2", {}, field("Usuário", mongoUser), field("Senha", mongoPw)),
    el("div.db-row2", {}, field("Banco padrão", mongoDb), field("Tempo limite de conexão (s)", mongoTimeout)),
    check("Aceitar certificado TLS inválido/autoassinado", c.tls_insecure, (v) => (c.tls_insecure = v), "tlsAllowInvalidCertificates=true (servidores de teste)"),
    check("Somente leitura (bloqueia edição no grid e pede confirmação para comandos que alteram dados)", c.read_only, (v) => (c.read_only = v)),
  );

  const isMongoConn = () => c.driver === "mongo";
  const driverSwitch = el("div.db-driver-switch");
  function paintDriver() {
    driverSwitch.innerHTML = "";
    for (const [value, label, ic] of [
      ["mssql", "SQL Server / Azure SQL", "fa-solid fa-server"],
      ["mongo", "MongoDB", "fa-solid fa-leaf"],
    ]) {
      driverSwitch.append(
        el(
          "button",
          {
            type: "button",
            class: `db-driver${c.driver === value ? " on" : ""}`,
            onclick: () => {
              c.driver = value;
              paintDriver();
            },
          },
          icon(ic),
          label,
        ),
      );
    }
    sqlSection.hidden = isMongoConn();
    mongoSection.hidden = !isMongoConn();
  }

  function showStatus(ok, text) {
    status.hidden = false;
    status.className = `db-test ${ok === null ? "busy" : ok ? "ok" : "bad"}`;
    status.innerHTML = "";
    status.append(icon(ok === null ? "fa-solid fa-spinner fa-spin" : ok ? "fa-solid fa-circle-check" : "fa-solid fa-circle-exclamation"), el("span", {}, text));
  }

  function validate() {
    if (isMongoConn()) {
      if (!parseMongoUri(c.uri).valid) return "Informe a connection string (mongodb:// ou mongodb+srv://).";
    } else if (!c.host.trim()) return "Informe o servidor.";
    return "";
  }

  async function test() {
    const problem = validate();
    if (problem) return showStatus(false, problem);
    showStatus(null, !isMongoConn() && c.auth.kind === "entra" ? "Abrindo o login da Microsoft no navegador…" : "Conectando…");
    testBtn.disabled = true;
    try {
      const pw = isMongoConn() || c.auth.kind === "sql" ? (password ?? null) : null;
      const info = await dbApi.test(connConfig(isMongoConn() ? { ...c, auth: { ...c.auth, kind: "sql" } } : c), pw);
      showStatus(true, `Conectado: ${info.product} ${info.version} · banco ${info.database} · ${info.user}`);
    } catch (e) {
      showStatus(false, String(e));
    } finally {
      testBtn.disabled = false;
    }
  }

  const testBtn = btn([icon("fa-solid fa-plug-circle-check"), " Testar conexão"], test);

  const sqlSection = el(
    "div.db-sql",
    {},
    el(
      "details.db-connstr-box",
      {},
      el("summary", {}, icon("fa-solid fa-paste"), " Colar connection string (ADO.NET / JDBC)"),
      connStr,
      el("div.db-connstr-actions", {}, btn("Preencher campos", applyConnStr)),
    ),
    el("div.db-row3", {}, field(el("span", {}, "Servidor ", kindBadge), hostInput), field("Porta", portInput), field("Instância", instanceInput)),
    field("Banco padrão", dbInput, "Azure SQL: cada banco usa uma conexão própria; o Explorer lista os demais bancos do servidor."),
    field("Autenticação", authSelect),
    sqlAuth,
    entraAuth,
    el(
      "details.db-advanced",
      {},
      el("summary", {}, "Avançado"),
      el("div.db-row2", {}, field("Criptografia", encryptSelect), field("Tempo limite de conexão (s)", timeoutInput)),
      trustBox,
      check("Intenção somente leitura (ApplicationIntent=ReadOnly)", c.read_intent, (v) => (c.read_intent = v), "Direciona para réplicas de leitura do Azure SQL"),
      check("Somente leitura (bloqueia edição no grid e pede confirmação para comandos que alteram dados)", c.read_only, (v) => (c.read_only = v)),
    ),
  );
  const body = el("div.db-conn-form", {}, driverSwitch, el("div.db-row2", {}, field("Nome", nameInput), field("Cor", colorRow)), sqlSection, mongoSection, status);
  syncAuth();
  syncKind();
  syncUri();
  status.hidden = true;
  paintDriver();

  const save = () => {
    const problem = validate();
    if (problem) return showStatus(false, problem);
    if (isMongoConn()) c.auth.kind = "sql";
    modal.close();
    onSave(c, c.auth.kind === "sql" ? password : undefined);
  };

  modal.open({
    title: isNew ? "Nova conexão" : `Conexão — ${connLabel(c)}`,
    iconCls: "fa-solid fa-database",
    body,
    wide: true,
    className: "db-conn-modal",
    footer: [
      !isNew && onDelete ? btn([icon("fa-regular fa-trash-can"), " Excluir"], () => (modal.close(), onDelete()), "hx-btn.danger") : null,
      el("span.hx-flex"),
      testBtn,
      btn("Cancelar", modal.close),
      btn("Salvar", save, "hx-btn.primary"),
    ].filter(Boolean),
  });
  (isNew ? (isMongoConn() ? uriInput : hostInput) : nameInput).focus();
}

/** Mostra o SQL que será aplicado e pede confirmação. */
export function reviewChangesDialog({ statements, connection, inTransaction, mongo = false }) {
  const counts = statements.reduce((acc, s) => ((acc[s.kind] = (acc[s.kind] || 0) + 1), acc), {});
  const summary = mongo
    ? [counts.update && `${counts.update} updateOne`, counts.insert && `${counts.insert} insertOne`, counts.delete && `${counts.delete} deleteOne`, counts.replace && `${counts.replace} replaceOne`].filter(Boolean).join(" · ")
    : [counts.update && `${counts.update} UPDATE`, counts.insert && `${counts.insert} INSERT`, counts.delete && `${counts.delete} DELETE`].filter(Boolean).join(" · ");
  const code = mongo ? statements.map((s) => s.text).join("\n") : statements.map((s) => `${s.sql};`).join("\n");
  const pre = el("pre.db-sql-preview", { html: highlightCode(code, mongo ? "javascript" : "sql") });
  const note = mongo
    ? " — aplicadas em ordem, sem transação: se uma falhar, as anteriores já estarão gravadas."
    : inTransaction
      ? " — dentro da transação aberta (confirme depois com Commit)."
      : " — numa transação: se um comando falhar, nada é gravado.";
  const body = el(
    "div",
    {},
    el(
      "p.hx-modal-text",
      {},
      `${summary} em `,
      el("strong", {}, connection),
      note,
    ),
    pre,
  );
  return modal.confirm({ title: "Aplicar alterações", body, confirmLabel: "Aplicar", wide: true });
}

/** Mostra um texto SQL (DDL, comando gerado) com opção de copiar. */
export function sqlPreviewDialog({ title, sql, onCopy, onOpenInConsole, lang = "sql" }) {
  modal.open({
    title,
    iconCls: "fa-solid fa-code",
    wide: true,
    body: el("pre.db-sql-preview.tall", { html: highlightCode(sql, lang) }),
    footer: [
      onOpenInConsole ? btn([icon("fa-solid fa-terminal"), " Abrir no console"], () => (modal.close(), onOpenInConsole(sql))) : null,
      btn([icon("fa-regular fa-copy"), " Copiar"], () => onCopy(sql), "hx-btn.primary"),
    ].filter(Boolean),
  });
}
