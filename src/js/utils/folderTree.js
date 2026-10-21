// Árvore de pastas com subpastas (Notas e coleções do HTTP), sem DOM.
//
// Pastas são uma lista plana { id, name, parent_id } (0 = nível superior); a ordem da
// lista é a ordem entre irmãs. Ids são números > 0.

/** Pastas filhas de `parentId`, na ordem da lista. */
export function childrenOf(folders, parentId = 0) {
  return folders.filter((f) => (f.parent_id || 0) === parentId);
}

/** `id` e todas as subpastas dele (qualquer profundidade). */
export function descendantIds(folders, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (!out.has(f.id) && out.has(f.parent_id || 0)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Pastas do nível superior até `id` (inclusive); [] se não existe. */
export function folderChain(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain = [];
  const seen = new Set();
  for (let f = byId.get(id); f && !seen.has(f.id); f = byId.get(f.parent_id || 0)) {
    seen.add(f.id);
    chain.unshift(f);
  }
  return chain;
}

/** "Pai / Filho / Neto" */
export function folderPath(folders, id, sep = " / ") {
  return folderChain(folders, id).map((f) => f.name).join(sep);
}

/** Profundidade (0 = nível superior). */
export function folderDepth(folders, id) {
  return Math.max(0, folderChain(folders, id).length - 1);
}

/**
 * Árvore em ordem de exibição: [{ folder, depth, hasChildren }]. Subpastas de pastas em
 * `collapsed` (Set de ids) ficam de fora.
 */
export function flattenTree(folders, collapsed = null, parentId = 0) {
  const out = [];
  const walk = (pid, depth, seen) => {
    for (const f of childrenOf(folders, pid)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const hasChildren = folders.some((c) => (c.parent_id || 0) === f.id);
      out.push({ folder: f, depth, hasChildren });
      if (hasChildren && !collapsed?.has(f.id)) walk(f.id, depth + 1, seen);
    }
  };
  walk(parentId, 0, new Set());
  return out;
}

/** Pode mover `id` para dentro de `parentId`? (não para dentro dela mesma nem de uma subpasta) */
export function canMoveFolder(folders, id, parentId) {
  return id !== parentId && !descendantIds(folders, id).has(parentId);
}

/**
 * Corrige pais inexistentes e ciclos (viram nível superior). Muda as pastas no lugar e
 * devolve a mesma lista.
 */
export function normalizeFolderTree(folders) {
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    f.parent_id = Number(f.parent_id) || 0;
    if (f.parent_id && (!ids.has(f.parent_id) || f.parent_id === f.id)) f.parent_id = 0;
  }
  for (const f of folders) {
    // Subindo pelos pais, voltar a `f` = ciclo: quebra aqui.
    const seen = new Set([f.id]);
    for (let p = folders.find((x) => x.id === f.parent_id); p; p = folders.find((x) => x.id === p.parent_id)) {
      if (seen.has(p.id)) {
        f.parent_id = 0;
        break;
      }
      seen.add(p.id);
    }
  }
  return folders;
}

/** Nome livre entre as irmãs: "Nome", "Nome 2", "Nome 3"... */
export function uniqueFolderName(folders, parentId, name) {
  const taken = new Set(childrenOf(folders, parentId).map((f) => f.name.toLowerCase()));
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name} ${i}`;
  return out;
}

/**
 * Garante o caminho `names` abaixo de `parentId` (reaproveita pastas com o mesmo nome,
 * cria as que faltam com `make(name, parentId)`, que deve incluí-las em `folders`).
 * Devolve o id da última pasta (ou `parentId` se `names` estiver vazio).
 */
export function ensureFolderPath(folders, parentId, names, make) {
  let pid = parentId;
  for (const raw of names) {
    const name = String(raw).trim() || "Pasta";
    const found = childrenOf(folders, pid).find((f) => f.name.toLowerCase() === name.toLowerCase());
    pid = found ? found.id : make(name, pid).id;
  }
  return pid;
}

const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
const byName = (a, b) => collator.compare(a.name, b.name);

/**
 * Move `id` para ser irmã de `targetId`, logo antes (ou depois, com `after`). Devolve false se
 * não dá (alvo inexistente, ela mesma ou o alvo está dentro dela).
 */
export function placeFolder(folders, id, targetId, after = false) {
  const folder = folders.find((f) => f.id === id);
  const target = folders.find((f) => f.id === targetId);
  const parentId = target?.parent_id || 0;
  if (!folder || !target || folder === target || !canMoveFolder(folders, id, parentId)) return false;
  folder.parent_id = parentId;
  folders.splice(folders.indexOf(folder), 1);
  folders.splice(folders.indexOf(target) + (after ? 1 : 0), 0, folder);
  return true;
}

/**
 * Coloca `folder` (nova, renomeada ou movida; já com o parent_id certo) na posição alfabética
 * entre as irmãs: antes da 1ª irmã que vem depois dela, senão depois da última.
 */
export function insertFolderSorted(folders, folder) {
  const at = folders.indexOf(folder);
  if (at >= 0) folders.splice(at, 1);
  const siblings = childrenOf(folders, folder.parent_id || 0);
  const next = siblings.find((f) => byName(folder, f) < 0);
  if (next) folders.splice(folders.indexOf(next), 0, folder);
  else if (siblings.length) folders.splice(folders.indexOf(siblings[siblings.length - 1]) + 1, 0, folder);
  else folders.push(folder);
  return folders;
}

/** Ordena A–Z as filhas de `parentId` (e as subpastas, com `recursive`), no lugar. */
export function sortFolderChildren(folders, parentId = 0, recursive = false) {
  const parents = recursive ? [parentId, ...[...descendantIds(folders, parentId)].filter((id) => id !== parentId)] : [parentId];
  for (const pid of parents) {
    const siblings = childrenOf(folders, pid);
    // As posições ocupadas pelas irmãs recebem as mesmas pastas em ordem alfabética.
    const slots = siblings.map((f) => folders.indexOf(f));
    [...siblings].sort(byName).forEach((f, i) => (folders[slots[i]] = f));
  }
  return folders;
}

/** Remove `id` e as subpastas; devolve o Set de ids removidos. */
export function removeFolderTree(folders, id) {
  const gone = descendantIds(folders, id);
  const keep = folders.filter((f) => !gone.has(f.id));
  folders.length = 0;
  folders.push(...keep);
  return gone;
}
