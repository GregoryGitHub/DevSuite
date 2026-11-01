// Motor da sincronização das notas com a nuvem (app Notas). Sem DOM nem Firebase: recebe
//  - `local`: estado do aparelho (syncApi do desktop em api.js | webSyncApi no navegador);
//  - `remote`: a nuvem (firebaseRemote.js; nos testes, uma nuvem em memória);
//  - `host`: as Notas na tela (syncHost em components/notes.js).
//
// Modelo: cada nota/pasta na nuvem é um documento com `ver` (1, 2, 3…). Este aparelho guarda
// a versão que já tem; enviar = gravar `ver + 1`, e a nuvem recusa se outro aparelho gravou
// antes (concorrência otimista nas regras do Firestore: erro "stale"). Uma rodada:
//  1. grava as edições abertas (host.flush);
//  2. baixa o que mudou desde o cursor e aplica — se a mesma nota mudou aqui e lá, a da nuvem
//     fica e a daqui vira uma nota nova "… (conflito <aparelho> <data>)";
//  3. baixa as imagens que faltam; envia as imagens novas;
//  4. envia as pendências; as recusadas (stale) passam pelo passo 2 e são reenviadas.

/** Releitura de segurança: o cursor volta um pouco (relógio do servidor, gravações em voo). */
export const CURSOR_OVERLAP_MS = 60_000;
const PUSH_PAGE = 50;
const NOTE_FIELDS = ["id", "title", "preview", "content", "plain", "images", "created_at", "updated_at", "pinned", "folder_id", "deleted_at", "props", "links"];

const key = (kind, id) => `${kind}:${id}`;

/** Dados de uma nota/pasta como vão para a nuvem (só os campos conhecidos; sem undefined). */
export function toRemote(kind, item, canonical = (h) => h) {
  if (kind === "folder") return { id: item.id, name: item.name, parent_id: item.parent_id || 0, position: item.position || 0 };
  const out = {};
  for (const f of NOTE_FIELDS) out[f] = item[f] ?? null;
  out.content = canonical(out.content || "");
  out.images = Array.isArray(item.images) ? item.images : [];
  out.links = Array.isArray(item.links) ? item.links : [];
  out.pinned = out.pinned || 0;
  out.folder_id = out.folder_id || 0;
  return out;
}

/** A mesma nota nos dois lados (então não é conflito). */
export function sameNote(local, remote) {
  const props = (p) => JSON.stringify(p ?? null);
  return (
    (local.content || "") === (remote.content || "") &&
    props(local.props) === props(remote.props) &&
    (local.folder_id || 0) === (remote.folder_id || 0) &&
    (local.deleted_at ?? null) === (remote.deleted_at ?? null) &&
    (local.pinned || 0) === (remote.pinned || 0)
  );
}

/** " (conflito <aparelho> 01/11/2026 14:05)". */
export function conflictSuffix(device, date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const when = `${p(date.getDate())}/${p(date.getMonth() + 1)}/${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`;
  return ` (conflito ${device || "outro aparelho"} ${when})`;
}

export function createSyncEngine({ local, remote, host, device = "", canonical = (h) => h, normalize = (h) => h, log = () => {} }) {
  let running = null;
  let again = false;

  /**
   * Decide o que fazer com os documentos da nuvem. Devolve as mudanças para `local.apply`,
   * as pendências que deixam de existir (iguais nos dois lados) e os conflitos.
   */
  async function merge(docs) {
    const pend = new Map((await local.pending(false, 100000)).items.map((p) => [key(p.kind, p.id), p]));
    const busy = host.busyIds?.() || new Set();
    const changes = { notes: [], deleted_notes: [], folders: [], deleted_folders: [], vers: [] };
    const done = [];
    const conflicts = [];
    const ordered = [...docs].sort((a, b) => (a.kind === "note") - (b.kind === "note"));
    for (const d of ordered) {
      const p = pend.get(key(d.kind, d.id));
      const isBusy = d.kind === "note" && busy.has(d.id);
      if (p && d.ver <= p.ver) continue; // eco do próprio envio / já conhecida
      // Sendo editada agora (ainda não gravada): quando gravar, o envio é recusado (stale) e
      // a nota volta por aqui já pendente.
      if (isBusy && !p) continue;
      if (!p && !isBusy) {
        if (d.kind === "folder") (d.deleted ? changes.deleted_folders : changes.folders).push(d.deleted ? { id: d.id, ver: d.ver } : { ...d.data, id: d.id, ver: d.ver });
        else if (d.deleted) changes.deleted_notes.push({ id: d.id, ver: d.ver });
        else changes.notes.push({ ...d.data, content: normalize(d.data.content || ""), id: d.id, ver: d.ver });
        continue;
      }
      // Mudou aqui também.
      if (d.kind === "folder" || d.deleted) {
        // Pasta: vale a deste aparelho. Nota apagada lá e editada aqui: a daqui volta.
        changes.vers.push({ kind: d.kind, id: d.id, ver: d.ver });
        continue;
      }
      const mine = await host.localNote(d.id);
      if (!mine) {
        // Apagada aqui e editada lá: a edição volta.
        changes.notes.push({ ...d.data, content: normalize(d.data.content || ""), id: d.id, ver: d.ver });
        continue;
      }
      const theirs = { ...d.data, content: normalize(d.data.content || "") };
      if (sameNote(mine, theirs)) {
        changes.vers.push({ kind: "note", id: d.id, ver: d.ver });
        if (p && !isBusy) done.push({ kind: "note", id: d.id, seq: p.seq, ver: d.ver });
        continue;
      }
      conflicts.push({ id: d.id, mine });
      changes.notes.push({ ...theirs, id: d.id, ver: d.ver });
    }
    return { changes, done, conflicts };
  }

  /** Aplica no banco local e na tela; devolve os nomes de imagens das notas que chegaram. */
  async function applyDocs(docs) {
    if (!docs.length) return [];
    const { changes, done, conflicts } = await merge(docs);
    // A cópia do conflito é criada antes de a versão da nuvem sobrescrever a nota.
    for (const c of conflicts) host.conflictCopy(c.mine, conflictSuffix(device));
    if (conflicts.length) await host.flush();
    await local.apply(changes);
    if (done.length) await local.done(done);
    await host.applied?.({
      notes: changes.notes,
      replace: conflicts.map((c) => c.id),
      removed: changes.deleted_notes.map((g) => g.id),
      folders: changes.folders.length + changes.deleted_folders.length > 0,
    });
    if (conflicts.length) host.toast?.(`${conflicts.length} nota(s) mudaram aqui e em outro aparelho: a versão deste ficou numa cópia "(conflito …)".`);
    return changes.notes.flatMap((n) => n.images || []);
  }

  async function pull() {
    const cursor = Number(await local.metaGet("cursor")) || 0;
    const { docs, maxRev } = await remote.pull(Math.max(0, cursor - CURSOR_OVERLAP_MS));
    const images = await applyDocs(docs);
    if (maxRev > cursor) await local.metaSet("cursor", String(maxRev));
    return { count: docs.length, images };
  }

  async function downloadImages(names) {
    const missing = names.length ? await local.imagesMissing([...new Set(names)]) : [];
    let got = 0;
    for (const name of missing) {
      try {
        await local.imagePut(name, await remote.downloadImage(name));
        got++;
      } catch (e) {
        log(`imagem ${name} não baixou: ${e?.message || e}`);
      }
    }
    if (got) host.imagesArrived?.();
    return got;
  }

  async function uploadImages() {
    const names = await local.imagesPending();
    const sent = [];
    for (const name of names) {
      let bytes;
      try {
        bytes = await local.imageRead(name);
      } catch {
        continue; // não está neste aparelho (ainda vai chegar de outro)
      }
      try {
        await remote.uploadImage(name, bytes);
        sent.push(name);
      } catch (e) {
        // Storage indisponível (ex.: bucket ainda não criado): a imagem fica pendente e as
        // notas continuam sincronizando.
        log(`imagem ${name} não subiu: ${e?.message || e}`);
      }
    }
    if (sent.length) await local.imagesMark(sent);
    return sent.length;
  }

  /** Envia as pendências; devolve { sent, stale: [{ kind, id }] }. */
  async function push() {
    let sent = 0;
    const stale = [];
    const skip = new Set();
    for (;;) {
      const { items } = await local.pending(true, PUSH_PAGE + skip.size);
      const todo = items.filter((p) => !skip.has(key(p.kind, p.id))).slice(0, PUSH_PAGE);
      if (!todo.length) break;
      const done = [];
      for (const p of todo) {
        const doc = { kind: p.kind, id: p.id, ver: p.ver + 1, deleted: !p.item, data: p.item ? toRemote(p.kind, p.item, canonical) : null };
        try {
          await remote.push(doc);
          done.push({ kind: p.kind, id: p.id, seq: p.seq, ver: doc.ver });
        } catch (e) {
          skip.add(key(p.kind, p.id));
          if (e?.code === "stale") stale.push({ kind: p.kind, id: p.id });
          else if (e?.code === "too-big") host.toast?.(`A nota "${p.item?.title || p.id}" é grande demais para sincronizar (limite de ~1 MB de texto).`);
          else throw e;
        }
      }
      if (done.length) await local.done(done);
      sent += done.length;
    }
    return { sent, stale };
  }

  async function round() {
    await host.flush();
    const pulled = await pull();
    await downloadImages(pulled.images);
    await uploadImages();
    let { sent, stale } = await push();
    if (stale.length && remote.fetch) {
      // Outro aparelho gravou entre a leitura e o envio: resolve como no passo 2 e reenvia.
      const images = await applyDocs(await remote.fetch(stale));
      await downloadImages(images);
      sent += (await push()).sent;
    }
    const { total } = await local.pending(false, 1);
    return { pulled: pulled.count, sent, pending: total };
  }

  /** Uma rodada completa; chamadas durante uma rodada geram só mais uma, no fim. */
  function sync() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        let result;
        do {
          again = false;
          result = await round();
        } while (again);
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return { sync, isRunning: () => !!running, _merge: merge };
}
