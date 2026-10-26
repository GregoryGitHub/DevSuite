import { el, icon } from "../utils/dom.js";
import { createModalHost, btn } from "./modal.js";
import { gitApi, openDirectoryDialogApi } from "../api.js";

// Diálogos do controle de versão das Notas: remoto, identidade, confirmação e cofre novo.

// Overlay próprio no <body>: os diálogos também abrem pelas Configurações (cofre novo).
const overlay = el("div.hx-modal-overlay.gd-overlay", { hidden: true });
document.body.append(overlay);
const modal = createModalHost(overlay);
overlay.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  modal.close();
});

export const gitModal = modal;

const field = (label, input, hint = null) =>
  el("label.gd-field", {}, el("span", {}, label), input, hint ? el("small", {}, hint) : null);

/** Remoto `origin`: URL, testar, remover. Resolve true se algo mudou. */
export function remoteDialog(currentUrl) {
  return new Promise((resolve) => {
    let changed = false;
    const input = el("input.hx-input", { type: "text", value: currentUrl || "", placeholder: "https://github.com/voce/notas.git  ou  git@github.com:voce/notas.git", spellcheck: false });
    const status = el("p.gd-dlg-status");
    const setStatus = (text, kind = "") => {
      status.textContent = text;
      status.className = `gd-dlg-status ${kind}`;
    };
    let testing = null;
    const test = btn("Testar", async () => {
      if (!input.value.trim()) return setStatus("Informe a URL.", "bad");
      testing = `t${Date.now()}`;
      setStatus("Conectando…");
      try {
        const n = await gitApi.testRemote(input.value.trim(), testing);
        setStatus(n ? `Conectou: ${n} branch(es) no remoto.` : "Conectou: o repositório remoto está vazio.", "ok");
      } catch (e) {
        setStatus(String(e), "bad");
      } finally {
        testing = null;
      }
    });
    const remove = currentUrl
      ? btn("Remover remoto", async () => {
          try {
            await gitApi.setRemote(null);
            changed = true;
            modal.close();
          } catch (e) {
            setStatus(String(e), "bad");
          }
        }, "hx-btn.danger")
      : null;
    const save = btn("Salvar", async () => {
      try {
        await gitApi.setRemote(input.value.trim() || null);
        changed = true;
        modal.close();
      } catch (e) {
        setStatus(String(e), "bad");
      }
    }, "hx-btn.primary");
    modal.open({
      title: "Repositório remoto (origin)",
      iconCls: "fa-solid fa-cloud",
      body: el("div.gd-dlg", {},
        field("URL", input),
        el("p.gd-dlg-hint", {}, "Opcional. HTTPS usa o Git Credential Manager (abre a janela de login do GitHub/Azure DevOps na primeira vez); SSH usa as suas chaves (~/.ssh)."),
        status),
      footer: [remove, el("div.gd-spacer"), test, btn("Cancelar", () => modal.close()), save].filter(Boolean),
      onClose: () => {
        if (testing) gitApi.cancel(testing);
        resolve(changed);
      },
    });
    input.addEventListener("keydown", (e) => e.key === "Enter" && save.click());
    input.focus();
  });
}

/** Nome/e-mail dos commits. Resolve true se gravou. */
export function identityDialog(info) {
  return new Promise((resolve) => {
    let ok = false;
    const name = el("input.hx-input", { type: "text", value: info?.user_name || "", placeholder: "Seu nome" });
    const email = el("input.hx-input", { type: "email", value: info?.user_email || "", placeholder: "voce@exemplo.com" });
    const global = el("input", { type: "checkbox", checked: true });
    const status = el("p.gd-dlg-status");
    const save = btn("Salvar", async () => {
      try {
        await gitApi.setIdentity(name.value, email.value, global.checked);
        ok = true;
        modal.close();
      } catch (e) {
        status.textContent = String(e);
        status.className = "gd-dlg-status bad";
      }
    }, "hx-btn.primary");
    modal.open({
      title: "Quem está commitando?",
      iconCls: "fa-solid fa-user-pen",
      body: el("div.gd-dlg", {},
        el("p.gd-dlg-hint", {}, "O git grava nome e e-mail em cada commit. Ainda não há uma identidade configurada."),
        field("Nome", name),
        field("E-mail", email),
        el("label.gd-check", {}, global, " Usar em todos os repositórios deste computador (git config --global)"),
        status),
      footer: [btn("Cancelar", () => modal.close()), save],
      onClose: () => resolve(ok),
    });
    (name.value ? email : name).focus();
  });
}

/** Nome e pasta-mãe de um cofre novo: { parent, name } ou null. */
export function newVaultDialog() {
  return new Promise((resolve) => {
    let result = null;
    let parent = "";
    const name = el("input.hx-input", { type: "text", placeholder: "Minhas notas" });
    const where = el("span.gd-path", {}, "Nenhuma pasta escolhida");
    const status = el("p.gd-dlg-status");
    const pick = btn("Escolher…", async () => {
      const dir = await openDirectoryDialogApi({ title: "Onde criar o cofre" });
      if (dir) {
        parent = dir;
        where.textContent = dir;
      }
    });
    const create = btn("Criar cofre", () => {
      if (!name.value.trim()) return (status.textContent = "Dê um nome ao cofre."), name.focus();
      if (!parent) return (status.textContent = "Escolha onde criar a pasta.");
      result = { parent, name: name.value.trim() };
      modal.close();
    }, "hx-btn.primary");
    modal.open({
      title: "Novo cofre",
      iconCls: "fa-solid fa-folder-plus",
      body: el("div.gd-dlg", {},
        field("Nome", name),
        el("div.gd-field", {}, el("span", {}, "Criar dentro de"), el("div.gd-inline", {}, where, pick)),
        el("p.gd-dlg-hint", {}, icon("fa-solid fa-code-branch"), " A pasta é criada com um repositório git (controle de versão). Ligar a um remoto (GitHub etc.) é opcional e pode ser feito depois no painel Git."),
        status),
      footer: [btn("Cancelar", () => modal.close()), create],
      onClose: () => resolve(result),
    });
    status.className = "gd-dlg-status bad";
    name.addEventListener("keydown", (e) => e.key === "Enter" && create.click());
    name.focus();
  });
}
