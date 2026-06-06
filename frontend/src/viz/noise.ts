const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

const _p = new Uint8Array(256);
for (let i = 0; i < 256; i++) _p[i] = i;
for (let i = 255; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  const tmp = _p[i]; _p[i] = _p[j]; _p[j] = tmp;
}
const PERM = new Uint8Array(512);
for (let i = 0; i < 512; i++) PERM[i] = _p[i & 255];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export function noise2d(xin: number, yin: number): number {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  const gi0 = PERM[ii + PERM[jj]] % 8;
  const gi1 = PERM[ii + i1 + PERM[jj + j1]] % 8;
  const gi2 = PERM[ii + 1 + PERM[jj + 1]] % 8;

  let n0 = 0, n1 = 0, n2 = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (GRAD2[gi0][0] * x0 + GRAD2[gi0][1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (GRAD2[gi1][0] * x1 + GRAD2[gi1][1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (GRAD2[gi2][0] * x2 + GRAD2[gi2][1] * y2); }

  return 70 * (n0 + n1 + n2);
}

export function fbm2d(x: number, y: number, octaves = 4): number {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += a * noise2d(x * f, y * f);
    a *= 0.5; f *= 2;
  }
  return v;
}
