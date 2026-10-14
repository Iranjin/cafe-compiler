// PowerPC (Espresso) 命令の簡易逆アセンブラ。逆コンパイル結果のコメント用。
// よく使う整数・ロード/ストア・分岐・SPR・浮動小数点命令に対応し、それ以外は .long とする。

const r = (n) => `r${n}`;
// D 形式・X 形式のベースレジスタ欄の 0 は r0 ではなく値 0 を意味する
const base = (n) => (n === 0 ? '0' : r(n));
const f = (n) => `f${n}`;

const sext16 = (v) => (v & 0x8000 ? v - 0x10000 : v);
const imm = (v) => (v > -10 && v < 10 ? String(v) : (v < 0 ? '-0x' : '0x') + Math.abs(v).toString(16).toUpperCase());
const uhex = (v) => (v < 10 ? String(v) : '0x' + v.toString(16).toUpperCase());
const target = (off, abs) => (abs ? '0x' + (off >>> 0).toString(16).toUpperCase().padStart(8, '0') : (off < 0 ? '-0x' : '+0x') + Math.abs(off).toString(16).toUpperCase());

const LOAD_STORE = {
  32: ['lwz', r], 33: ['lwzu', r], 34: ['lbz', r], 35: ['lbzu', r], 36: ['stw', r], 37: ['stwu', r],
  38: ['stb', r], 39: ['stbu', r], 40: ['lhz', r], 41: ['lhzu', r], 42: ['lha', r], 43: ['lhau', r],
  44: ['sth', r], 45: ['sthu', r], 46: ['lmw', r], 47: ['stmw', r],
  48: ['lfs', f], 49: ['lfsu', f], 50: ['lfd', f], 51: ['lfdu', f], 52: ['stfs', f], 53: ['stfsu', f], 54: ['stfd', f], 55: ['stfdu', f],
};
const IMM_ARITH = { 7: 'mulli', 8: 'subfic', 12: 'addic', 13: 'addic.' };
const IMM_LOGIC = { 24: 'ori', 25: 'oris', 26: 'xori', 27: 'xoris', 28: 'andi.', 29: 'andis.' };
// opcode 31, XO 形式 (9bit XO + OE)
const XO_ARITH = { 266: 'add', 40: 'subf', 8: 'subfc', 10: 'addc', 136: 'subfe', 138: 'adde', 235: 'mullw', 75: 'mulhw', 11: 'mulhwu', 491: 'divw', 459: 'divwu' };
// opcode 31, X 形式の論理・シフト (rA, rS, rB)
const X_LOGIC = { 28: 'and', 60: 'andc', 444: 'or', 412: 'orc', 316: 'xor', 476: 'nand', 124: 'nor', 284: 'eqv', 24: 'slw', 536: 'srw', 792: 'sraw' };
const X_UNARY = { 26: 'cntlzw', 954: 'extsb', 922: 'extsh' };
const X_INDEXED = { 23: ['lwzx', r], 55: ['lwzux', r], 151: ['stwx', r], 183: ['stwux', r], 87: ['lbzx', r], 215: ['stbx', r], 279: ['lhzx', r], 343: ['lhax', r], 407: ['sthx', r], 535: ['lfsx', f], 663: ['stfsx', f], 599: ['lfdx', f], 727: ['stfdx', f], 983: ['stfiwx', f] };
const X_CACHE = { 86: 'dcbf', 54: 'dcbst', 278: 'dcbt', 1014: 'dcbz', 470: 'dcbi', 982: 'icbi' };
const X_NOARG = { 598: 'sync', 854: 'eieio' };
const SPR_NAMES = { 1: 'xer', 8: 'lr', 9: 'ctr' };
const CR_BITS = ['lt', 'gt', 'eq', 'so'];
const CR_NEG = ['ge', 'le', 'ne', 'ns'];

/** 1 命令を逆アセンブルする */
export function disassemble(w) {
  w >>>= 0;
  const op = w >>> 26;
  const d = (w >>> 21) & 31;
  const a = (w >>> 16) & 31;
  const b = (w >>> 11) & 31;
  const lo = w & 0xffff;
  const simm = sext16(lo);
  const rc = w & 1 ? '.' : '';

  if (op in LOAD_STORE) {
    const [name, reg] = LOAD_STORE[op];
    return `${name} ${reg(d)}, ${imm(simm)}(${base(a)})`;
  }
  if (op in IMM_ARITH) return `${IMM_ARITH[op]} ${r(d)}, ${r(a)}, ${imm(simm)}`;
  if (op in IMM_LOGIC) {
    if (w === 0x60000000) return 'nop';
    return `${IMM_LOGIC[op]} ${r(a)}, ${r(d)}, ${uhex(lo)}`;
  }
  switch (op) {
    case 14:
      return a === 0 ? `li ${r(d)}, ${imm(simm)}` : `addi ${r(d)}, ${r(a)}, ${imm(simm)}`;
    case 15:
      return a === 0 ? `lis ${r(d)}, ${uhex(lo)}` : `addis ${r(d)}, ${r(a)}, ${imm(simm)}`;
    case 10:
    case 11: {
      if (d & 1) break; // L=1 (64bit 比較) は Espresso に無い
      const cr = d >> 2;
      const name = op === 10 ? 'cmplwi' : 'cmpwi';
      return `${name} ${cr ? `cr${cr}, ` : ''}${r(a)}, ${op === 10 ? uhex(lo) : imm(simm)}`;
    }
    case 18: {
      const off = ((w & 0x03fffffc) << 6) >> 6;
      return `b${w & 1 ? 'l' : ''}${w & 2 ? 'a' : ''} ${target(off, w & 2)}`;
    }
    case 16: {
      const off = ((w & 0xfffc) << 16) >> 16;
      return `${branchName(d, a, w & 1, w & 2)} ${target(off, w & 2)}`.replace('  ', ' ');
    }
    case 19: {
      const xo = (w >>> 1) & 0x3ff;
      if (xo === 16 || xo === 528) {
        const reg = xo === 16 ? 'lr' : 'ctr';
        if ((d & 0x14) === 0x14) return `b${reg}${w & 1 ? 'l' : ''}`;
        const cond = condName(d, a);
        if (cond) return `${cond.name}${reg}${w & 1 ? 'l' : ''}${cond.cr}`;
        return `bc${reg}${w & 1 ? 'l' : ''} ${d}, ${a}`;
      }
      if (xo === 150) return 'isync';
      if (xo === 50) return 'rfi';
      break;
    }
    case 20:
    case 21:
    case 23: {
      const mb = (w >>> 6) & 31;
      const me = (w >>> 1) & 31;
      if (op === 21) {
        if (mb === 0 && me === 31 - b) return `slwi${rc} ${r(a)}, ${r(d)}, ${b}`;
        if (b !== 0 && me === 31 && b === 32 - mb) return `srwi${rc} ${r(a)}, ${r(d)}, ${mb}`;
        if (b === 0 && me === 31) return `clrlwi${rc} ${r(a)}, ${r(d)}, ${mb}`;
        if (b === 0 && mb === 0) return `clrrwi${rc} ${r(a)}, ${r(d)}, ${31 - me}`;
        if (mb === 0 && me === 31) return `rotlwi${rc} ${r(a)}, ${r(d)}, ${b}`;
      }
      const name = { 20: 'rlwimi', 21: 'rlwinm', 23: 'rlwnm' }[op];
      return `${name}${rc} ${r(a)}, ${r(d)}, ${op === 23 ? r(b) : b}, ${mb}, ${me}`;
    }
    case 31:
      return op31(w, d, a, b, rc) ?? `.long 0x${hex(w)}`;
    case 59: {
      const xo = (w >>> 1) & 31;
      const c = (w >>> 6) & 31;
      const names = { 21: 'fadds', 20: 'fsubs', 18: 'fdivs' };
      if (xo in names) return `${names[xo]}${rc} ${f(d)}, ${f(a)}, ${f(b)}`;
      if (xo === 25) return `fmuls${rc} ${f(d)}, ${f(a)}, ${f(c)}`;
      if (xo === 29) return `fmadds${rc} ${f(d)}, ${f(a)}, ${f(c)}, ${f(b)}`;
      break;
    }
    case 63: {
      const xo10 = (w >>> 1) & 0x3ff;
      const unary = { 72: 'fmr', 40: 'fneg', 264: 'fabs', 136: 'fnabs', 12: 'frsp', 14: 'fctiw', 15: 'fctiwz' };
      if (xo10 in unary) return `${unary[xo10]}${rc} ${f(d)}, ${f(b)}`;
      if (xo10 === 0 || xo10 === 32) return `${xo10 ? 'fcmpo' : 'fcmpu'} cr${d >> 2}, ${f(a)}, ${f(b)}`;
      const xo = (w >>> 1) & 31;
      const names = { 21: 'fadd', 20: 'fsub', 18: 'fdiv' };
      if (xo in names) return `${names[xo]}${rc} ${f(d)}, ${f(a)}, ${f(b)}`;
      if (xo === 25) return `fmul${rc} ${f(d)}, ${f(a)}, ${f((w >>> 6) & 31)}`;
      break;
    }
    case 17:
      if (w === 0x44000002) return 'sc';
      break;
  }
  return `.long 0x${hex(w)}`;
}

const hex = (w) => w.toString(16).toUpperCase().padStart(8, '0');

function condName(bo, bi) {
  const cr = bi >> 2;
  const crText = cr ? ` cr${cr},` : '';
  if ((bo & 0x1c) === 0x0c) return { name: 'b' + CR_BITS[bi & 3], cr: crText };
  if ((bo & 0x1c) === 0x04) return { name: 'b' + CR_NEG[bi & 3], cr: crText };
  return null;
}

function branchName(bo, bi, lk, aa) {
  const suffix = (lk ? 'l' : '') + (aa ? 'a' : '');
  if ((bo & 0x14) === 0x14) return `b${suffix}`;
  if ((bo & 0x1e) === 0x10) return `bdnz${suffix}`;
  if ((bo & 0x1e) === 0x12) return `bdz${suffix}`;
  const c = condName(bo, bi);
  if (c) return `${c.name}${suffix}${c.cr}`;
  return `bc${suffix} ${bo}, ${bi},`;
}

function op31(w, d, a, b, rc) {
  const xo10 = (w >>> 1) & 0x3ff;
  const xo9 = (w >>> 1) & 0x1ff;
  const oe = w & 0x400 ? 'o' : '';
  if (xo9 in XO_ARITH) return `${XO_ARITH[xo9]}${oe}${rc} ${r(d)}, ${r(a)}, ${r(b)}`;
  if (xo9 === 104) return `neg${oe}${rc} ${r(d)}, ${r(a)}`;
  if (xo10 === 444 && d === b) return `mr${rc} ${r(a)}, ${r(d)}`;
  if (xo10 in X_LOGIC) return `${X_LOGIC[xo10]}${rc} ${r(a)}, ${r(d)}, ${r(b)}`;
  if (xo10 in X_UNARY) return `${X_UNARY[xo10]}${rc} ${r(a)}, ${r(d)}`;
  if (xo10 === 824) return `srawi${rc} ${r(a)}, ${r(d)}, ${b}`;
  if (xo10 in X_INDEXED) {
    const [name, reg] = X_INDEXED[xo10];
    return `${name} ${reg(d)}, ${base(a)}, ${r(b)}`;
  }
  if (xo10 in X_CACHE) return `${X_CACHE[xo10]} ${base(a)}, ${r(b)}`;
  if (xo10 in X_NOARG) return X_NOARG[xo10];
  if (xo10 === 0 || xo10 === 32) {
    const cr = d >> 2;
    return `${xo10 ? 'cmplw' : 'cmpw'} ${cr ? `cr${cr}, ` : ''}${r(a)}, ${r(b)}`;
  }
  if (xo10 === 339 || xo10 === 467) {
    const spr = a | (b << 5);
    const name = SPR_NAMES[spr];
    if (xo10 === 339) return name ? `mf${name} ${r(d)}` : `mfspr ${r(d)}, ${spr}`;
    return name ? `mt${name} ${r(d)}` : `mtspr ${spr}, ${r(d)}`;
  }
  if (xo10 === 19) return `mfcr ${r(d)}`;
  if (xo10 === 83) return `mfmsr ${r(d)}`;
  if (xo10 === 146) return `mtmsr ${r(d)}`;
  return null;
}
