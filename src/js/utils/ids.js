// Ids de notas e pastas. Com o sync (app Notas), aparelhos diferentes criam ids ao mesmo
// tempo: milissegundos × 2048 + 11 bits aleatórios (ainda crescente no tempo, cabe no
// Number do JS e no u64 do Rust até o ano 2109). Ids antigos (só Date.now()) continuam valendo.

export function newId() {
  const rnd = crypto.getRandomValues(new Uint16Array(1))[0] & 2047;
  return Date.now() * 2048 + rnd;
}
