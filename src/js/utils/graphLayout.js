// Layout do grafo das Notas: simulação de forças (como o d3-force) sem dependências.
// Repulsão Barnes-Hut (quadtree), molas nas arestas e gravidade ao centro; `alpha` decai a cada
// passo e a simulação para sozinha (o componente só anima enquanto `active`). Sem DOM.

const THETA2 = 0.81; // (0.9)^2: célula distante o bastante vira um ponto só
const COLLIDE_PAD = 7; // folga mínima entre as bordas de dois nós
const COLLIDE_STRENGTH = 0.7;

/** Forças ajustáveis no painel do grafo (repulsão entre nós, molas das ligações, gravidade). */
export const DEFAULT_FORCES = Object.freeze({ repulsion: 130, linkDistance: 80, linkStrength: 1, gravity: 0.035 });
const VELOCITY_DECAY = 0.4;
const ALPHA_MIN = 0.004;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 320);

/**
 * nodes: [{ key }] (a posição anterior de cada key é reaproveitada via `memory`), edges: [[a, b]],
 * forces: parcial de DEFAULT_FORCES.
 * Devolve { x, y, vx, vy, fixed, n, alpha, active, step(), reheat(a), setForces(f), positions() }.
 */
export function createLayout(nodes, edges, memory = new Map(), forces = DEFAULT_FORCES) {
  const n = nodes.length;
  const F = { ...DEFAULT_FORCES, ...forces };
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const fixed = new Uint8Array(n);
  const degree = new Uint16Array(n);
  for (const [a, b] of edges) degree[a]++, degree[b]++;

  // Posições iniciais: as que já existiam; as novas perto de um vizinho conhecido ou em espiral.
  let known = 0;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const p = memory.get(nodes[i].key);
    if (p) {
      x[i] = p.x;
      y[i] = p.y;
      known++;
    } else {
      const r = 10 * Math.sqrt(0.5 + i);
      x[i] = r * Math.cos(i * golden);
      y[i] = r * Math.sin(i * golden);
    }
  }
  if (known) {
    for (const [a, b] of edges) {
      const ka = memory.has(nodes[a].key);
      const kb = memory.has(nodes[b].key);
      if (ka && !kb) (x[b] = x[a] + (Math.random() - 0.5) * 20), (y[b] = y[a] + (Math.random() - 0.5) * 20);
      else if (kb && !ka) (x[a] = x[b] + (Math.random() - 0.5) * 20), (y[a] = y[b] + (Math.random() - 0.5) * 20);
    }
  }

  // Quadtree em arrays (reaproveitados entre passos).
  let cap = Math.max(64, n * 4);
  let qx0 = new Float32Array(cap), qy0 = new Float32Array(cap), qs = new Float32Array(cap);
  let qcx = new Float32Array(cap), qcy = new Float32Array(cap), qm = new Float32Array(cap);
  let qchild = new Int32Array(cap * 4), qbody = new Int32Array(cap);
  let cells = 0;

  function grow() {
    cap *= 2;
    const g = (arr, k = 1) => {
      const next = new arr.constructor(cap * k);
      next.set(arr);
      return next;
    };
    qx0 = g(qx0); qy0 = g(qy0); qs = g(qs); qcx = g(qcx); qcy = g(qcy); qm = g(qm);
    qchild = g(qchild, 4); qbody = g(qbody);
  }

  function cell(x0, y0, s) {
    if (cells >= cap) grow();
    const c = cells++;
    qx0[c] = x0; qy0[c] = y0; qs[c] = s;
    qcx[c] = 0; qcy[c] = 0; qm[c] = 0;
    qchild[c * 4] = qchild[c * 4 + 1] = qchild[c * 4 + 2] = qchild[c * 4 + 3] = -1;
    qbody[c] = -1;
    return c;
  }

  function quadrant(c, i) {
    const h = qs[c] / 2;
    return (x[i] >= qx0[c] + h ? 1 : 0) + (y[i] >= qy0[c] + h ? 2 : 0);
  }

  function insert(c, i, depth) {
    for (;;) {
      // Centro de massa acumulado no caminho.
      const m = qm[c];
      qcx[c] = (qcx[c] * m + x[i]) / (m + 1);
      qcy[c] = (qcy[c] * m + y[i]) / (m + 1);
      qm[c] = m + 1;
      if (m === 0) {
        qbody[c] = i;
        return;
      }
      if (qbody[c] >= 0) {
        const j = qbody[c];
        qbody[c] = -1;
        if (depth > 40) return; // pontos coincidentes: fica a massa, sem subdividir mais
        const q = quadrant(c, j);
        const h = qs[c] / 2;
        const child = cell(qx0[c] + (q & 1 ? h : 0), qy0[c] + (q & 2 ? h : 0), h);
        qchild[c * 4 + q] = child;
        qm[child] = 1;
        qcx[child] = x[j];
        qcy[child] = y[j];
        qbody[child] = j;
      }
      const q = quadrant(c, i);
      let next = qchild[c * 4 + q];
      if (next < 0) {
        const h = qs[c] / 2;
        next = cell(qx0[c] + (q & 1 ? h : 0), qy0[c] + (q & 2 ? h : 0), h);
        qchild[c * 4 + q] = next;
      }
      c = next;
      depth++;
    }
  }

  const stack = new Int32Array(4096);

  function repel(alpha) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i];
      if (y[i] < minY) minY = y[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] > maxY) maxY = y[i];
    }
    cells = 0;
    const root = cell(minX - 1, minY - 1, Math.max(maxX - minX, maxY - minY) + 2);
    for (let i = 0; i < n; i++) insert(root, i, 0);

    const k = -F.repulsion * alpha;
    for (let i = 0; i < n; i++) {
      let sp = 0;
      stack[sp++] = root;
      while (sp) {
        const c = stack[--sp];
        if (!qm[c] || qbody[c] === i) continue;
        let dx = qcx[c] - x[i];
        let dy = qcy[c] - y[i];
        let l = dx * dx + dy * dy;
        const leaf = qbody[c] >= 0 || (qchild[c * 4] < 0 && qchild[c * 4 + 1] < 0 && qchild[c * 4 + 2] < 0 && qchild[c * 4 + 3] < 0);
        if (leaf || (qs[c] * qs[c]) / THETA2 < l) {
          if (l < 1e-6) {
            dx = (Math.random() - 0.5) * 1e-3;
            dy = (Math.random() - 0.5) * 1e-3;
            l = dx * dx + dy * dy;
          }
          if (l < 1) l = Math.sqrt(l);
          const f = (k * qm[c]) / l;
          vx[i] += dx * f;
          vy[i] += dy * f;
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const ch = qchild[c * 4 + q];
          if (ch >= 0 && sp < stack.length) stack[sp++] = ch;
        }
      }
    }
  }

  function springs(alpha) {
    for (const [a, b] of edges) {
      let dx = x[b] + vx[b] - x[a] - vx[a];
      let dy = y[b] + vy[b] - y[a] - vy[a];
      let l = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const strength = F.linkStrength / Math.min(degree[a], degree[b]);
      l = ((l - F.linkDistance) / l) * alpha * strength;
      dx *= l;
      dy *= l;
      const bias = degree[a] / (degree[a] + degree[b]);
      vx[b] -= dx * bias;
      vy[b] -= dy * bias;
      vx[a] += dx * (1 - bias);
      vy[a] += dy * (1 - bias);
    }
  }

  // Raio de cada nó no layout (mesma escala do desenho: nós mais ligados são maiores).
  const rad = new Float32Array(n);
  let maxRad = 0;
  for (let i = 0; i < n; i++) maxRad = Math.max(maxRad, (rad[i] = 4 + Math.sqrt(degree[i]) * 1.5));

  // Colisão: separa nós que se sobrepõem (grade uniforme; vizinhos nas 9 células).
  const cellOf = new Map();
  function collide() {
    const size = (maxRad + COLLIDE_PAD) * 2;
    cellOf.clear();
    for (let i = 0; i < n; i++) {
      const key = Math.floor(x[i] / size) * 100003 + Math.floor(y[i] / size);
      const list = cellOf.get(key);
      if (list) list.push(i);
      else cellOf.set(key, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] / size);
      const cy = Math.floor(y[i] / size);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const list = cellOf.get(gx * 100003 + gy);
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            let dx = x[j] + vx[j] - x[i] - vx[i];
            let dy = y[j] + vy[j] - y[i] - vy[i];
            const min = rad[i] + rad[j] + COLLIDE_PAD;
            let l = dx * dx + dy * dy;
            if (l >= min * min) continue;
            if (l < 1e-6) {
              dx = (Math.random() - 0.5) * 1e-2;
              dy = (Math.random() - 0.5) * 1e-2;
              l = dx * dx + dy * dy;
            }
            l = Math.sqrt(l);
            const push = ((min - l) / l) * COLLIDE_STRENGTH;
            const wi = rad[j] * rad[j] / (rad[i] * rad[i] + rad[j] * rad[j]); // o menor se move mais
            vx[i] -= dx * push * wi;
            vy[i] -= dy * push * wi;
            vx[j] += dx * push * (1 - wi);
            vy[j] += dy * push * (1 - wi);
          }
        }
      }
    }
  }

  const sim = {
    n,
    x,
    y,
    vx,
    vy,
    fixed,
    alpha: known === n && n ? 0.06 : 1, // reaberto sem nós novos: só um ajuste fino
    get active() {
      return sim.alpha >= ALPHA_MIN;
    },
    /** Um passo da simulação (chamar enquanto `active`). */
    step() {
      if (!n) {
        sim.alpha = 0;
        return;
      }
      sim.alpha += (0 - sim.alpha) * ALPHA_DECAY;
      const alpha = sim.alpha;
      repel(alpha);
      springs(alpha);
      for (let i = 0; i < n; i++) {
        vx[i] -= x[i] * F.gravity * alpha;
        vy[i] -= y[i] * F.gravity * alpha;
      }
      collide();
      for (let i = 0; i < n; i++) {
        if (fixed[i]) {
          vx[i] = vy[i] = 0;
          continue;
        }
        vx[i] *= 1 - VELOCITY_DECAY;
        vy[i] *= 1 - VELOCITY_DECAY;
        x[i] += vx[i];
        y[i] += vy[i];
      }
    },
    /** Reaquece (ao arrastar um nó, reorganizar...). */
    reheat(a = 0.3) {
      sim.alpha = Math.max(sim.alpha, a);
    },
    /** Muda as forças (sliders do painel) e reorganiza a partir das posições atuais. */
    setForces(f) {
      Object.assign(F, f);
      sim.reheat(0.5);
    },
    /** Guarda as posições em `memory` (key -> {x, y}) para a próxima abertura. */
    positions() {
      for (let i = 0; i < n; i++) memory.set(nodes[i].key, { x: x[i], y: y[i] });
      return memory;
    },
  };
  return sim;
}
