// Cafe codetype エンコーダ。
// 各関数はコード行の配列 [[上位32bit, 下位32bit], ...] を返す。
// レイアウトは tcpgecko-codetypes-documentation (TCP Gecko 2.53) に準拠。

export const SIZE = { 8: 0, 16: 1, 32: 2 };

export const TERM_D0 = [0xd0000000, 0xdeadcafe];
export const TERM_D1 = [0xd1000000, 0xdeadc0de];
export const TERM_D2 = [0xd2000000, 0xcafebabe];

export const COND = {
  eq: 0x03,
  ne: 0x04,
  gt: 0x05,
  lt: 0x06,
  ge: 0x07,
  le: 0x08,
  and: 0x09,
  or: 0x0a,
  between: 0x0b,
};

export const INT_OP = { add: 0, sub: 1, mul: 2, div: 3, addi: 4, subi: 5, muli: 6, divi: 7, itof: 8, and: 9, or: 0xa, xor: 0xb, andi: 0xc, ori: 0xd, xori: 0xe, set: 0xf };
export const FLOAT_OP = { add: 0, sub: 1, mul: 2, div: 3, addi: 4, subi: 5, muli: 6, divi: 7, ftoi: 8, set: 0xf };

const u32 = (v) => v >>> 0;
const maskSize = (bits, v) => (bits === 32 ? u32(v) : u32(v) & ((1 << bits) - 1));
/** 8/16/32bit 値をコード行の値フィールド (000000VV / 0000VVVV / VVVVVVVV) に配置 */
const valueField = (bits, v) => maskSize(bits, v);
const sizeNibble = (bits) => SIZE[bits];

// レジスタ番号欄は 1 バイト。ドキュメント上の番号は 0〜7 (8 以上の扱いはハンドラによって異なる)
function checkReg(r) {
  if (!Number.isInteger(r) || r < 0 || r > 0xff) throw new RangeError(`register out of range: ${r}`);
}

/** バイト列を 8 バイト単位のコード行に詰める (不足分は 00 で埋める) */
export function bytesToLines(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const chunk = [...bytes.slice(i, i + 8)];
    while (chunk.length < 8) chunk.push(0);
    const hi = u32((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]);
    const lo = u32((chunk[4] << 24) | (chunk[5] << 16) | (chunk[6] << 8) | chunk[7]);
    lines.push([hi, lo]);
  }
  return lines;
}

/** 32bit ワード列をコード行に詰める (奇数個なら pad で埋める) */
export function wordsToLines(words, pad = 0) {
  const w = words.map(u32);
  if (w.length % 2) w.push(u32(pad));
  const lines = [];
  for (let i = 0; i < w.length; i += 2) lines.push([w[i], w[i + 1]]);
  return lines;
}

// ---- Memory Writes ----

/** [00] RAM Write: 00000000 LLLLLLLL / 000000VV 00000000 (16/32bit も同形式) */
export function ramWrite(bits, addr, value) {
  return [
    [u32(sizeNibble(bits) << 16), u32(addr)],
    [valueField(bits, value), 0],
  ];
}

/** [00] RAM Write (Pointer): 001SKKKK VVVVVVVV  (KKKK は 16bit 符号なしオフセット) */
export function ramWritePtr(bits, offset, value) {
  if (offset < 0 || offset > 0xffff) throw new RangeError('pointer write offset must be 0..0xFFFF');
  return [[u32(((0x10 | sizeNibble(bits)) << 16) | offset), valueField(bits, value)]];
}

/** [01] String Write: 0100NNNN LLLLLLLL / データ行... (Pointer: 0110NNNN KKKKKKKK) */
export function stringWrite(bytes, addrOrOffset, pointer = false) {
  if (bytes.length < 1 || bytes.length > 0xffff) throw new RangeError('string write length must be 1..0xFFFF');
  return [[u32(((pointer ? 0x0110 : 0x0100) << 16) | bytes.length), u32(addrOrOffset)], ...bytesToLines(bytes)];
}

/** [02] Skip Write: 02SSNNNN LLLLLLLL / VVVVVVVV YYYYYYYY / IIIIIIII 00000000 */
export function skipWrite(bits, count, addrOrOffset, value, stride, increment, pointer = false) {
  if (count < 0 || count > 0xffff) throw new RangeError('skip write count must be 0..0xFFFF');
  const s = (pointer ? 0x10 : 0x00) | sizeNibble(bits);
  return [
    [u32(0x02000000 | (s << 16) | count), u32(addrOrOffset)],
    [valueField(bits, value), u32(stride)],
    [valueField(bits, increment), 0],
  ];
}

/** [20] Memory Fill: 20000000 VVVVVVVV / LLLLLLLL MMMMMMMM (Pointer: 20100000 / KKKKKKKK) */
export function memFill(value, addrOrOffset, length, pointer = false) {
  return [
    [pointer ? 0x20100000 : 0x20000000, u32(value)],
    [u32(addrOrOffset), u32(length)],
  ];
}

/** [21] Memory Copy: 21000000 EEEEEEEE / LLLLLLLL MMMMMMMM  (E=コピー元, L=コピー先) */
export function memCopy(src, dstOrOffset, length, pointer = false) {
  return [
    [pointer ? 0x21100000 : 0x21000000, u32(src)],
    [u32(dstOrOffset), u32(length)],
  ];
}

/** [F0] Corruptor: F0000000 LLLLLLLL / EEEEEEEE VVVVVVVV / WWWWWWWW 00000000 */
export function corruptor(start, end, find, replace) {
  return [
    [0xf0000000, u32(start)],
    [u32(end), u32(find)],
    [u32(replace), 0],
  ];
}

// ---- If / Else ----

/** [03]-[0B] 条件: CCSS0000 LLLLLLLL / VVVVVVVV WWWWWWWW (Pointer: CC1S0000 KKKKKKKK) */
export function conditional(code, bits, addrOrOffset, value, value2 = 0, pointer = false) {
  if (code < 0x03 || code > 0x0b) throw new RangeError('conditional codetype must be 03..0B');
  const s = (pointer ? 0x10 : 0x00) | sizeNibble(bits);
  return [
    [u32((code << 24) | (s << 16)), u32(addrOrOffset)],
    [valueField(bits, value), code === COND.between ? valueField(bits, value2) : 0],
  ];
}

/** [0C] Add Time-Dependence: 0C000000 NNNNNNNN (D2 で終端) */
export const timeDependence = (frames) => [[0x0c000000, u32(frames)]];

/** [0D] Reset Timer: 0D00VVVV LLLLLLLL */
export function resetTimer(value16, addr) {
  return [[u32(0x0d000000 | (value16 & 0xffff)), u32(addr)]];
}

/** [0E] Input Conditional: 0E000X0Y VVVVVVVV */
export function inputConditional(controller, port, mask) {
  return [[u32(0x0e000000 | ((controller & 0xf) << 8) | (port & 0xf)), u32(mask)]];
}

/** [0F] Negate Conditional: 0F000000 00000000 */
export const negate = () => [[0x0f000000, 0]];

/** [80] Loop: 80000000 NNNNNNNN (D1 で終端) */
export const loop = (count) => [[0x80000000, u32(count)]];

/** [81] Loop Indexed: 81000R00 00000000 */
export function loopIndexed(reg) {
  checkReg(reg);
  return [[u32(0x81000000 | (reg << 8)), 0]];
}

/** [82] Break Loop: 82000000 00000000 */
export const breakLoop = () => [[0x82000000, 0]];

// ---- Perform Operations ----

function regMemOp(code, sizeField, reg, addrOrOffset, pointer) {
  checkReg(reg);
  const s = (pointer ? 0x10 : 0x00) | sizeField;
  return [[u32((code << 24) | (s << 16) | reg), u32(addrOrOffset)]];
}

/** [10] Load Integer: 100S000R LLLLLLLL (Pointer: 101S000R KKKKKKKK) */
export const loadInt = (bits, reg, a, pointer = false) => regMemOp(0x10, sizeNibble(bits), reg, a, pointer);
/** [11] Store Integer: 110S000R LLLLLLLL */
export const storeInt = (bits, reg, a, pointer = false) => regMemOp(0x11, sizeNibble(bits), reg, a, pointer);
/** [12] Load Float: 1200000R LLLLLLLL */
export const loadFloat = (reg, a, pointer = false) => regMemOp(0x12, 0, reg, a, pointer);
/** [13] Store Float: 1300000R LLLLLLLL */
export const storeFloat = (reg, a, pointer = false) => regMemOp(0x13, 0, reg, a, pointer);

/** [14] Integer Operations: 140O0R0S VVVVVVVV */
export function intOp(op, r, s = 0, value = 0) {
  checkReg(r);
  checkReg(s);
  return [[u32(0x14000000 | (op << 16) | (r << 8) | s), u32(value)]];
}

/** [15] Float Operations: 150O0R0S VVVVVVVV (V は IEEE754 単精度のビット列) */
export function floatOp(op, r, s = 0, valueBits = 0) {
  checkReg(r);
  checkReg(s);
  return [[u32(0x15000000 | (op << 16) | (r << 8) | s), u32(valueBits)]];
}

// ---- Memory Access ----

/** [30] Load Pointer: 30000000 LLLLLLLL / RANGE_ST RANGE_EN  (Pointer-in-pointer: 30100000 KKKKKKKK) */
export function loadPointer(addrOrOffset, rangeStart, rangeEnd, pointer = false) {
  return [
    [pointer ? 0x30100000 : 0x30000000, u32(addrOrOffset)],
    [u32(rangeStart), u32(rangeEnd)],
  ];
}

/** [31] Add Offset To Pointer: 31000000 QQQQQQQQ */
export const addPointer = (q) => [[0x31000000, u32(q)]];
/** [32] Add Offset To Pointer Indexed: 32000R00 QQQQQQQQ */
export function addPointerIndexed(reg, q) {
  checkReg(reg);
  return [[u32(0x32000000 | (reg << 8)), u32(q)]];
}
/** [33] Subtract Offset From Pointer: 33000000 QQQQQQQQ */
export const subPointer = (q) => [[0x33000000, u32(q)]];
/** [34] Subtract Offset From Pointer Indexed: 34000R00 QQQQQQQQ */
export function subPointerIndexed(reg, q) {
  checkReg(reg);
  return [[u32(0x34000000 | (reg << 8)), u32(q)]];
}

// ---- Execute ----

export const BLR = 0x4e800020;
export const BCTR = 0x4e800420;

/** 戻ってこない無条件分岐 (blr / bctr / b, ba) か。bl・bctrl などリンク付きは含まない */
export const isTerminalBranch = (w) => w === BLR || w === BCTR || (w >>> 26 === 18 && (w & 1) === 0);

/**
 * [C0] Execute ASM: C000NNNN XXXXXXXX / XXXXXXXX XXXXXXXX ...
 * 1 行目の下位ワードが最初の命令。末尾が blr / bctr / b でなければ blr を付加し、
 * 奇数で余れば 00000000 で埋める。
 */
export function executeAsm(words) {
  const w = words.map(u32);
  if (w.length === 0 || !isTerminalBranch(w[w.length - 1])) w.push(BLR);
  if (w.length % 2 === 0) w.push(0);
  const n = (w.length - 1) / 2;
  return [[u32(0xc0000000 | n), w[0]], ...wordsToLines(w.slice(1))];
}

/** [C1] Procedure Call: C1000000 LLLLLLLL */
export const procedureCall = (addr) => [[0xc1000000, u32(addr)]];
/** [C1] System Call: C100XXXX 00000000 */
export function systemCall(n) {
  if (n < 1 || n > 0xffff) throw new RangeError('syscall number must be 1..0xFFFF');
  return [[u32(0xc1000000 | n), 0]];
}

/** [C2]/[C3]/[C4] CC00NNNN LLLLLLLL / XXXXXXXX XXXXXXXX ... */
export function asmBlock(code, addr, words, pad = 0) {
  const lines = wordsToLines(words, pad);
  if (lines.length === 0) throw new RangeError('asm block needs at least one word');
  return [[u32((code << 24) | lines.length), u32(addr)], ...lines];
}

/** [E0] Display Message: E0000000 00RRGGBB / 文字列 (NUL 終端、8 バイト境界まで 00 埋め) */
export function displayMessage(rgb, bytes) {
  return [[0xe0000000, u32(rgb) & 0xffffff], ...bytesToLines([...bytes, 0])];
}
/** [E1] Display Pointer Message: E1000000 00RRGGBB */
export const displayPointerMessage = (rgb) => [[0xe1000000, u32(rgb) & 0xffffff]];
/** [E2] Clear Message: E2000000 00000000 */
export const clearMessage = () => [[0xe2000000, 0]];

// ---- 共通 ----

export function floatBits(f) {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, f);
  return b.getUint32(0);
}

export const hex8 = (v) => u32(v).toString(16).toUpperCase().padStart(8, '0');
export const formatLine = ([hi, lo]) => `${hex8(hi)} ${hex8(lo)}`;
