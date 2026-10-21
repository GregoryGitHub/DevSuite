// Busca de texto sem maiúsculas/acentos que preserva as posições (Ctrl+F dentro da nota).

const folded = new Map();

/** Um caractere (unidade UTF-16) sem acento e em minúscula; sempre do mesmo tamanho. */
function foldChar(c) {
  let f = folded.get(c);
  if (f === undefined) {
    f = c.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    if (f.length !== 1) f = c.toLowerCase().length === 1 ? c.toLowerCase() : c;
    folded.set(c, f);
  }
  return f;
}

/** Texto comparável com o mesmo comprimento do original: o índice i casa com o i do original. */
export function foldText(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
  return out;
}

/** Inícios das ocorrências (sem sobreposição) de `needle` em `hay`, ambos já dobrados. */
export function findAll(hay, needle, max = Infinity) {
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1 && out.length < max; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}
