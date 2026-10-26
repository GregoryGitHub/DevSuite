// Diff de texto para o controle de versão das Notas (sem DOM).
//
// Linhas: Myers O(ND) depois de cortar prefixo/sufixo comuns. Os trechos alterados viram
// blocos como os da JetBrains: `insert` (só à direita), `delete` (só à esquerda) e `modify`
// (remoção + inserção juntas), com destaque por palavra dentro do bloco (`diffWords`).
// `merge3` combina base/minha/deles para a visão de conflitos.

const MAX_EDIT = 4000; // além disso, o trecho do meio vira um bloco só (arquivos muito diferentes)

/** Linhas do texto (CRLF/CR = LF; o "\n" final não cria linha vazia). */
export function splitLines(text) {
  const t = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!t) return [];
  const lines = t.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Fim de linha usado no texto (para regravar igual). */
export function eolOf(text) {
  return /\r\n/.test(text || "") ? "\r\n" : "\n";
}

/**
 * Myers: operações [tipo, i, j] ("=" | "-" | "+") entre as sequências de chaves `a` e `b`.
 * Acima de MAX_EDIT diferenças devolve null (quem chama trata como um bloco só).
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  // Volta pelo rastro montando as operações de trás para frente.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]; // índices: k -> k + d + 1
    const at = (k) => vd[k + d + 1];
    const k = x - y;
    let prevK;
    if (d === 0) prevK = 0;
    else prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push(["=", --x, --y]);
    if (d > 0) {
      if (x === prevX) ops.push(["+", x, --y]);
      else ops.push(["-", --x, y]);
    }
  }
  return ops.reverse();
}

/** Operações de edição entre as listas de chaves, com prefixo/sufixo comuns cortados. */
function editOps(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push(["=", i, i]);
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid = myers(midA, midB);
  if (mid) for (const [t, i, j] of mid) ops.push([t, i + pre, j + pre]);
  else {
    for (let i = 0; i < midA.length; i++) ops.push(["-", i + pre, pre]);
    for (let j = 0; j < midB.length; j++) ops.push(["+", a.length - suf, j + pre]);
  }
  for (let s = suf; s > 0; s--) ops.push(["=", a.length - s, b.length - s]);
  return ops;
}

/** Agrupa as operações em blocos { type, a0, a1, b0, b1 } (intervalos semiabertos). */
function opsToChunks(ops, n, m) {
  const chunks = [];
  let ai = 0;
  let bi = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === "=") {
      const a0 = ai;
      const b0 = bi;
      while (k < ops.length && ops[k][0] === "=") {
        ai++;
        bi++;
        k++;
      }
      chunks.push({ type: "equal", a0, a1: ai, b0, b1: bi });
      continue;
    }
    const a0 = ai;
    const b0 = bi;
    while (k < ops.length && ops[k][0] !== "=") {
      if (ops[k][0] === "-") ai++;
      else bi++;
      k++;
    }
    const type = ai === a0 ? "insert" : bi === b0 ? "delete" : "modify";
    chunks.push({ type, a0, a1: ai, b0, b1: bi });
  }
  if (!chunks.length && (n || m)) chunks.push({ type: n && m ? "modify" : n ? "delete" : "insert", a0: 0, a1: n, b0: 0, b1: m });
  return chunks;
}

const wsKey = (line) => line.replace(/\s+/g, " ").trim();

/**
 * Diff por linhas de dois textos. Devolve { left, right, chunks } (linhas e blocos).
 * `ignoreWhitespace`: linhas que só diferem em espaços contam como iguais.
 */
export function diffLines(leftText, rightText, { ignoreWhitespace = false } = {}) {
  const left = splitLines(leftText);
  const right = splitLines(rightText);
  const key = ignoreWhitespace ? wsKey : (s) => s;
  const chunks = opsToChunks(editOps(left.map(key), right.map(key)), left.length, right.length);
  return { left, right, chunks };
}

/** Só os blocos alterados. */
export const changedChunks = (chunks) => chunks.filter((c) => c.type !== "equal");

/** Palavras, espaços e pontuação (cada sinal sozinho). */
export function tokenize(text) {
  return String(text).match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) || [];
}

function mergeRanges(ranges) {
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Trechos alterados (em caracteres) entre dois textos, palavra a palavra: { a: [[s, e]], b: [[s, e]] }.
 * Espaços entre duas palavras alteradas entram no destaque (fica contínuo, como na JetBrains).
 */
export function diffWords(aText, bText) {
  const ta = tokenize(aText);
  const tb = tokenize(bText);
  const ops = editOps(ta, tb);
  const pos = (tokens) => {
    const p = [0];
    for (const t of tokens) p.push(p[p.length - 1] + t.length);
    return p;
  };
  const pa = pos(ta);
  const pb = pos(tb);
  const a = [];
  const b = [];
  for (const [t, i, j] of ops) {
    if (t === "-") a.push([pa[i], pa[i + 1]]);
    else if (t === "+") b.push([pb[j], pb[j + 1]]);
  }
  const glue = (ranges, text) => {
    const merged = mergeRanges(ranges);
    for (let i = merged.length - 1; i > 0; i--) {
      const gap = text.slice(merged[i - 1][1], merged[i][0]);
      if (/^[ \t]+$/.test(gap)) {
        merged[i - 1][1] = merged[i][1];
        merged.splice(i, 1);
      }
    }
    return merged;
  };
  return { a: glue(a, String(aText)), b: glue(b, String(bText)) };
}

/**
 * Destaque por palavra de um bloco `modify`: para cada lado, um array (uma entrada por linha
 * do bloco) com os intervalos [s, e] alterados naquela linha. null = bloco grande demais.
 */
export function chunkWordRanges(left, right, chunk, { maxChars = 20000 } = {}) {
  const aLines = left.slice(chunk.a0, chunk.a1);
  const bLines = right.slice(chunk.b0, chunk.b1);
  const aText = aLines.join("\n");
  const bText = bLines.join("\n");
  if (aText.length + bText.length > maxChars) return null;
  const { a, b } = diffWords(aText, bText);
  const perLine = (lines, ranges) => {
    const out = lines.map(() => []);
    let start = 0;
    lines.forEach((line, i) => {
      const end = start + line.length;
      for (const [s, e] of ranges) {
        const rs = Math.max(s, start);
        const re = Math.min(e, end);
        if (re > rs) out[i].push([rs - start, re - start]);
      }
      start = end + 1;
    });
    return out;
  };
  return { a: perLine(aLines, a), b: perLine(bLines, b) };
}

/**
 * Linhas exibidas com os trechos iguais longos recolhidos ("N linhas inalteradas"):
 * segmentos { chunk, fold?: { a0, a1, b0, b1 } } na ordem. `context` linhas ficam visíveis
 * em volta de cada alteração; `expanded` = Set de a0 de dobras abertas pelo usuário.
 */
export function foldSegments(chunks, { context = 3, enabled = true, expanded = new Set() } = {}) {
  const segs = [];
  chunks.forEach((c, i) => {
    const len = c.a1 - c.a0;
    const keepTop = i === 0 ? 0 : context;
    const keepBottom = i === chunks.length - 1 ? 0 : context;
    if (c.type !== "equal" || !enabled || len <= keepTop + keepBottom + 1 || expanded.has(c.a0 + keepTop)) {
      segs.push({ type: c.type, a0: c.a0, a1: c.a1, b0: c.b0, b1: c.b1 });
      return;
    }
    if (keepTop) segs.push({ type: "equal", a0: c.a0, a1: c.a0 + keepTop, b0: c.b0, b1: c.b0 + keepTop });
    const f0 = c.a0 + keepTop;
    const f1 = c.a1 - keepBottom;
    const g0 = c.b0 + keepTop;
    segs.push({ type: "fold", a0: f0, a1: f1, b0: g0, b1: g0 + (f1 - f0) });
    if (keepBottom) segs.push({ type: "equal", a0: f1, a1: c.a1, b0: c.b1 - keepBottom, b1: c.b1 });
  });
  return segs;
}

/** Texto da direita com o bloco revertido para o conteúdo da esquerda (seta ≫). */
export function revertChunk(leftLines, rightLines, chunk, eol = "\n", finalEol = true) {
  const out = [...rightLines.slice(0, chunk.b0), ...leftLines.slice(chunk.a0, chunk.a1), ...rightLines.slice(chunk.b1)];
  return out.length ? out.join(eol) + (finalEol ? eol : "") : "";
}

/** O texto termina com quebra de linha? (vazio conta como sim) */
export const endsWithEol = (text) => !text || /\n$/.test(text);

// ---------- Merge de 3 vias ----------

/**
 * Combina base/minha/deles. Blocos { type: "stable" | "ours" | "theirs" | "same" | "conflict",
 * lines, base, ours, theirs } — mudanças de um lado só entram sozinhas; os dois lados mexendo
 * no mesmo trecho com resultados diferentes viram conflito.
 */
export function merge3(baseText, oursText, theirsText) {
  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  const hunks = (side) =>
    changedChunks(opsToChunks(editOps(base, side), base.length, side.length));
  const h1 = hunks(ours).map((h) => ({ ...h, side: 1 }));
  const h2 = hunks(theirs).map((h) => ({ ...h, side: 2 }));
  const all = [...h1, ...h2].sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const blocks = [];
  let pos = 0; // linha da base já emitida
  let d1 = 0; // deslocamento base -> minha antes da posição atual
  let d2 = 0;
  let i = 0;
  const pushStable = (to) => {
    if (to > pos) blocks.push({ type: "stable", lines: base.slice(pos, to) });
  };
  while (i < all.length) {
    // Grupo de blocos que se sobrepõem (ou encostam, no caso de inserções no mesmo ponto).
    let lo = all[i].a0;
    let hi = all[i].a1;
    const group = [all[i++]];
    while (i < all.length && (all[i].a0 < hi || (all[i].a0 === hi && (all[i].a0 === all[i].a1 || group.some((g) => g.a0 === g.a1 && g.a0 === hi))))) {
      hi = Math.max(hi, all[i].a1);
      group.push(all[i++]);
    }
    pushStable(lo);
    const range = (side, delta, lines) => {
      const hs = group.filter((g) => g.side === side);
      const grow = hs.reduce((s, g) => s + (g.b1 - g.b0) - (g.a1 - g.a0), 0);
      return { lines: lines.slice(lo + delta, hi + delta + grow), grow, touched: hs.length > 0 };
    };
    const o = range(1, d1, ours);
    const t = range(2, d2, theirs);
    const baseLines = base.slice(lo, hi);
    if (o.touched && !t.touched) blocks.push({ type: "ours", lines: o.lines, base: baseLines });
    else if (t.touched && !o.touched) blocks.push({ type: "theirs", lines: t.lines, base: baseLines });
    else if (o.lines.join("\n") === t.lines.join("\n")) blocks.push({ type: "same", lines: o.lines, base: baseLines });
    else blocks.push({ type: "conflict", base: baseLines, ours: o.lines, theirs: t.lines });
    d1 += o.grow;
    d2 += t.grow;
    pos = hi;
  }
  pushStable(base.length);
  return blocks;
}

export const CONFLICT_START = "<<<<<<< Minha";
export const CONFLICT_SEP = "=======";
export const CONFLICT_END = ">>>>>>> Deles";

/** Texto inicial do resultado: tudo que se resolve sozinho + marcadores nos conflitos. */
export function mergeResultText(blocks, eol = "\n") {
  const lines = [];
  for (const b of blocks) {
    if (b.type === "conflict") lines.push(CONFLICT_START, ...b.ours, CONFLICT_SEP, ...b.theirs, CONFLICT_END);
    else lines.push(...b.lines);
  }
  return lines.length ? lines.join(eol) + eol : "";
}

/** Conflitos ainda marcados no texto: [{ start, sep, end }] (índices de linha). */
export function conflictMarkers(text) {
  const lines = splitLines(text);
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (l.startsWith("<<<<<<<")) cur = { start: i, sep: -1, end: -1 };
    else if (cur && cur.sep < 0 && l === CONFLICT_SEP) cur.sep = i;
    else if (cur && cur.sep >= 0 && l.startsWith(">>>>>>>")) {
      cur.end = i;
      out.push(cur);
      cur = null;
    }
  });
  return out;
}

/** Resolve o n-ésimo conflito marcado com "ours" | "theirs" | "both". */
export function resolveMarker(text, n, choice, eol = eolOf(text)) {
  const lines = splitLines(text);
  const m = conflictMarkers(text)[n];
  if (!m) return text;
  const ours = lines.slice(m.start + 1, m.sep);
  const theirs = lines.slice(m.sep + 1, m.end);
  const pick = choice === "ours" ? ours : choice === "theirs" ? theirs : [...ours, ...theirs];
  const out = [...lines.slice(0, m.start), ...pick, ...lines.slice(m.end + 1)];
  return out.length ? out.join(eol) + eol : "";
}
