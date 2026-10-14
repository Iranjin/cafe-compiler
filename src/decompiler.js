// 逆コンパイラ。Cafe Code の行 (XXXXXXXX YYYYYYYY) を C 風ソースに戻す。
//
// 方針:
//   - 各コードを解読したら encoder.js で再エンコードし、元の行と完全一致するときだけ構文に戻す。
//     一致しない (未使用ビットが立っている等) コードや未知のコードタイプは raw(...) に落とす。
//     raw は同じ行をそのまま出力するので、再コンパイルしても内容は変わらない。
//   - 条件 (03-0B, 0E) / タイマー (0C) / ポインタ (30) / ループ (80, 81) はブロックとして開き、
//     D2 は直近の条件を 1 段、D0 は直近のループまでの条件とポインタをすべて、D1 はループを閉じる。
//   - 条件の直後の 0F は、比較 (03-08) なら空の then + else、それ以外は否定 (!) として扱う。

import * as E from './encoder.js';
import { CompileError } from './errors.js';
import { BUILTIN_CONSTANTS } from './constants.js';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { generate, HIGH_REG_NOTE } from './codegen.js';
import { disassemble } from './ppc.js';

const SIZE_BITS = [8, 16, 32];
const TYPE_OF_BITS = { 8: 'u8', 16: 'u16', 32: 'u32' };
const DEFAULT_RANGE = { start: 0x10000000, end: 0x50000000 };
const CMP_TEXT = { 0x03: '==', 0x04: '!=', 0x05: '>', 0x06: '<', 0x07: '>=', 0x08: '<=' };
const INT_OP_TEXT = ['+', '-', '*', '/'];
const BIT_OP_TEXT = ['&', '|', '^'];
const CONTROLLER_NAMES = ['GAMEPAD', 'WIIMOTE', 'NUNCHUK', 'CLASSIC'];
const BUTTON_PREFIXES = ['VPAD_', 'WPAD_', 'NUNCHUK_'];

const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase();
const hex8 = (v) => '0x' + E.hex8(v);
const num = (v) => ((v >>> 0) < 10 ? String(v >>> 0) : hex(v));

/** テキストからコード行を読み取る。'#' と '//' 以降はコメント。 */
export function parseCodeText(text) {
  const codes = [];
  text.split(/\r?\n/).forEach((rawLine, idx) => {
    const s = rawLine.replace(/(#|\/\/).*$/, '').trim();
    if (!s) return;
    const m = /^([0-9A-Fa-f]{8})\s*([0-9A-Fa-f]{8})$/.exec(s);
    if (!m) {
      throw new CompileError(`コード行の形式が不正です: '${s}'`, { line: idx + 1, col: 1 }, '1 行に 16 進 8 桁の値を 2 つ (XXXXXXXX YYYYYYYY) 書いてください');
    }
    codes.push({ hi: parseInt(m[1], 16) >>> 0, lo: parseInt(m[2], 16) >>> 0, line: idx + 1 });
  });
  return codes;
}

// ---------------------------------------------------------------- 表記ヘルパ

function ptrExpr(k) {
  k >>>= 0;
  if (k === 0) return 'ptr';
  if (k >= 0x80000000) return `ptr - ${hex(2 ** 32 - k)}`;
  return `ptr + ${hex(k)}`;
}

function deref(type, isPtr, a) {
  if (!isPtr) return `*(${type}*)${hex8(a)}`;
  return a === 0 ? `*(${type}*)ptr` : `*(${type}*)(${ptrExpr(a)})`;
}

const addrArg = (isPtr, a) => (isPtr ? ptrExpr(a) : hex8(a));

/** float32 のビット列を、再コンパイルで同じビット列になる最短の小数リテラルにする */
export function floatLiteral(bits) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits >>> 0);
  const f = dv.getFloat32(0);
  if (!Number.isFinite(f)) return null;
  if (Object.is(f, -0)) return '-0.0';
  for (let p = 1; p <= 9; p++) {
    const s = String(Number(f.toPrecision(p)));
    if (E.floatBits(Number(s)) === bits >>> 0) return /[.e]/.test(s) ? s : s + '.0';
  }
  return null;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

const ESCAPES = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\0': '\\0', '"': '\\"', '\\': '\\\\' };
const escByte = (b) => '\\x' + b.toString(16).toUpperCase().padStart(2, '0');

/** バイト列を文字列リテラルにする (UTF-8 として読めなければ非 ASCII を \xHH にする) */
function stringLiteral(bytes) {
  const str = decodeUtf8(bytes);
  let out = '';
  if (str !== null) {
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (ch in ESCAPES) out += ESCAPES[ch];
      else if (cp < 0x20 || cp === 0x7f) out += escByte(cp);
      else out += ch;
    }
  } else {
    for (const b of bytes) {
      const ch = String.fromCharCode(b);
      if (ch in ESCAPES) out += ESCAPES[ch];
      else if (b < 0x20 || b >= 0x7f) out += escByte(b);
      else out += ch;
    }
  }
  return `"${out}"`;
}

/** write() 用: 表示可能な文字列なら "..."、そうでなければ [0x.., ...] */
function bytesLiteral(bytes) {
  const str = decodeUtf8(bytes);
  if (str !== null && ![...str].some((ch) => (ch < ' ' && !'\n\t\r'.includes(ch)) || ch === '\x7f')) {
    return stringLiteral(bytes);
  }
  return '[' + bytes.map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ']';
}

function buttonMask(ctrl, mask) {
  if (ctrl < BUTTON_PREFIXES.length && mask !== 0) {
    const prefix = BUTTON_PREFIXES[ctrl];
    const names = [];
    let rest = mask >>> 0;
    for (const [name, v] of Object.entries(BUILTIN_CONSTANTS)) {
      if (!name.startsWith(prefix) || (rest & v) >>> 0 !== v) continue;
      names.push(name);
      rest = (rest & ~v) >>> 0;
    }
    if (rest === 0) return names.join(' | ');
  }
  return hex8(mask);
}

/** 命令ワードのブロックを 1 行 1 命令で、逆アセンブル結果をコメントに付けて書く */
function asmText(head, words) {
  const body = words.map((w, k) => `    ${hex8(w)}${k < words.length - 1 ? ',' : ' '}  // ${disassemble(w)}`);
  return [`${head} {`, ...body, '}'].join('\n');
}

function condText(c) {
  if (c.code === 0x0e) {
    const mask = buttonMask(c.ctrl, c.mask);
    const args = c.port ? `${mask}, ${CONTROLLER_NAMES[c.ctrl]}, ${c.port}` : c.ctrl ? `${mask}, ${CONTROLLER_NAMES[c.ctrl]}` : mask;
    return `${c.neg ? '!' : ''}button(${args})`;
  }
  const d = deref(TYPE_OF_BITS[c.bits], c.isPtr, c.addr);
  switch (c.code) {
    case 0x09:
      return `(${d} & ${num(c.v1)}) ${c.neg ? '!=' : '=='} ${num(c.v1)}`;
    case 0x0a:
      return `(${d} & ${num(c.v1)}) ${c.neg ? '==' : '!='} 0`;
    case 0x0b:
      return `${c.neg ? '!' : ''}between(${d}, ${num(c.v1)}, ${num(c.v2)})`;
    default:
      return `${d} ${CMP_TEXT[c.code]} ${num(c.v1)}`;
  }
}

// ---------------------------------------------------------------- 本体

/**
 * @param {string} text Cafe Code のテキスト
 * @returns {{ source: string, warnings: {message:string, pos?:object}[] }}
 */
export function decompile(text) {
  const codes = parseCodeText(text);
  const warnings = [];
  const root = { type: 'root', body: [] };
  const stack = [root];
  let rawLoopDepth = 0;

  const top = () => stack[stack.length - 1];
  const bodyOf = (b) => (b.type === 'if' ? b.else ?? b.then : b.body);
  const add = (node) => bodyOf(top()).push(node);
  const open = (block) => {
    add(block);
    stack.push(block);
  };
  const inPointer = () => stack.some((b) => b.type === 'pointer');
  const inLoop = () => stack.some((b) => b.type === 'loop');
  const pointerBlock = () => [...stack].reverse().find((b) => b.type === 'pointer');
  const warn = (message, code) => warnings.push({ message, pos: code && { line: code.line, col: 1 } });

  // 8 以上のレジスタ番号 (解読に成功したコードのみ数える)
  const highRegs = new Set();
  let pendingRegs = [];
  const noteReg = (kind, n) => {
    if (n > 7) pendingRegs.push(`${kind}${n}`);
  };
  const raw = (code, reason) => add({ type: 'stmt', text: `raw(${hex8(code.hi)}, ${hex8(code.lo)});`, comment: reason });
  const stmt = (text) => ({ stmt: text });

  /** ポインタを開ける位置か (コンパイラの「ポインタは D0 で閉じる」制約と同じ判定) */
  function pointerAllowed() {
    if (stack.some((b) => b.type === 'timer')) return false;
    const loopIdx = stack.map((b) => b.type).lastIndexOf('loop');
    return loopIdx < 0 || !stack.slice(0, loopIdx).some((b) => b.type === 'if');
  }

  /** i 行目からの 1 コードを解読する。構文に戻せなければ null */
  function decodeAt(i) {
    const { hi, lo } = codes[i];
    const cc = hi >>> 24;
    const b1 = (hi >>> 16) & 0xff;
    const isPtr = b1 >> 4 === 1;
    const bits = SIZE_BITS[b1 & 0x0f];
    const avail = codes.length - i;
    const at = (k) => codes[i + k];
    const result = (lines, res) => {
      if (lines.length > avail) return null;
      const same = lines.every(([h, l], k) => h >>> 0 === at(k).hi && l >>> 0 === at(k).lo);
      return same ? { n: lines.length, ...res } : null;
    };
    if (isPtr && !inPointer()) return null;

    switch (cc) {
      case 0x00: {
        if (!bits) return null;
        const t = TYPE_OF_BITS[bits];
        if (isPtr) return result(E.ramWritePtr(bits, hi & 0xffff, lo), stmt(`${deref(t, true, hi & 0xffff)} = ${num(lo)};`));
        if (avail < 2) return null;
        return result(E.ramWrite(bits, lo, at(1).hi), stmt(`${deref(t, false, lo)} = ${num(at(1).hi)};`));
      }
      case 0x01: {
        const n = hi & 0xffff;
        const lineCount = Math.ceil(n / 8);
        if (n === 0 || lineCount + 1 > avail) return null;
        const bytes = [];
        for (let k = 1; k <= lineCount; k++) {
          for (const w of [at(k).hi, at(k).lo]) bytes.push(w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff);
        }
        bytes.length = n;
        return result(E.stringWrite(bytes, lo, isPtr), stmt(`write(${addrArg(isPtr, lo)}, ${bytesLiteral(bytes)});`));
      }
      case 0x02: {
        if (!bits || avail < 3) return null;
        const count = hi & 0xffff;
        const [v, stride, inc] = [at(1).hi, at(1).lo, at(2).hi];
        const text = `skip_write(${deref(TYPE_OF_BITS[bits], isPtr, lo)}, ${num(v)}, ${count}, ${num(stride)}${inc ? `, ${num(inc)}` : ''});`;
        return result(E.skipWrite(bits, count, lo, v, stride, inc, isPtr), stmt(text));
      }
      case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: case 0x09: case 0x0a: case 0x0b: {
        if (!bits || avail < 2) return null;
        const [v1, v2] = [at(1).hi, at(1).lo];
        if (cc === 0x09 && v1 === 0) return null; // マスク 0 の AND は構文で表せない
        const cond = { code: cc, bits, isPtr, addr: lo, v1, v2 };
        return result(E.conditional(cc, bits, lo, v1, v2, isPtr), { open: { type: 'if', cond, then: [], else: null } });
      }
      case 0x0c:
        return result(E.timeDependence(lo), { open: { type: 'timer', frames: lo, body: [] } });
      case 0x0d:
        return result(E.resetTimer(hi & 0xffff, lo), stmt(`reset_timer(*(u16*)${hex8(lo)} == ${num(hi & 0xffff)});`));
      case 0x0e: {
        const ctrl = (hi >>> 8) & 0xff;
        const port = hi & 0xff;
        if (ctrl > 3 || port > 3) return null;
        const cond = { code: 0x0e, ctrl, port, mask: lo };
        return result(E.inputConditional(ctrl, port, lo), { open: { type: 'if', cond, then: [], else: null } });
      }
      case 0x10: case 0x11: {
        const reg = hi & 0xffff;
        if (!bits || reg > 0xff) return null;
        noteReg('r', reg);
        const d = deref(TYPE_OF_BITS[bits], isPtr, lo);
        if (cc === 0x10) return result(E.loadInt(bits, reg, lo, isPtr), stmt(`r${reg} = ${d};`));
        return result(E.storeInt(bits, reg, lo, isPtr), stmt(`${d} = r${reg};`));
      }
      case 0x12: case 0x13: {
        const reg = hi & 0xffff;
        if (reg > 0xff) return null;
        noteReg('f', reg);
        const d = deref('f32', isPtr, lo);
        if (cc === 0x12) return result(E.loadFloat(reg, lo, isPtr), stmt(`f${reg} = ${d};`));
        return result(E.storeFloat(reg, lo, isPtr), stmt(`${d} = f${reg};`));
      }
      case 0x14: {
        const op = b1;
        const r = (hi >>> 8) & 0xff;
        const s = hi & 0xff;
        if (op > 0xf) return null;
        noteReg('r', r);
        noteReg(op === 8 ? 'f' : 'r', s);
        let text;
        if (op <= 3) text = `r${r} ${INT_OP_TEXT[op]}= r${s};`;
        else if (op <= 7) {
          if (op === 7 && lo === 0) return null; // ゼロ除算はコンパイラが拒否する
          text = `r${r} ${INT_OP_TEXT[op - 4]}= ${num(lo)};`;
        } else if (op === 8) text = `f${s} = float(r${r});`;
        else if (op <= 0xb) text = `r${r} ${BIT_OP_TEXT[op - 9]}= r${s};`;
        else if (op <= 0xe) text = `r${r} ${BIT_OP_TEXT[op - 0xc]}= ${num(lo)};`;
        else text = `r${r} = ${num(lo)};`;
        return result(E.intOp(op, r, s, lo), stmt(text));
      }
      case 0x15: {
        const op = b1;
        const r = (hi >>> 8) & 0xff;
        const s = hi & 0xff;
        noteReg('f', r);
        noteReg(op === 8 ? 'r' : 'f', s);
        let text;
        if (op <= 3) text = `f${r} ${INT_OP_TEXT[op]}= f${s};`;
        else if (op <= 7 || op === 0xf) {
          const lit = floatLiteral(lo);
          if (lit === null) return null;
          text = op === 0xf ? `f${r} = ${lit};` : `f${r} ${INT_OP_TEXT[op - 4]}= ${lit};`;
        } else if (op === 8) text = `r${s} = int(f${r});`;
        else return null;
        return result(E.floatOp(op, r, s, lo), stmt(text));
      }
      case 0x20: {
        if (avail < 2) return null;
        const [a, len] = [at(1).hi, at(1).lo];
        return result(E.memFill(lo, a, len, isPtr), stmt(`memfill(${addrArg(isPtr, a)}, ${num(lo)}, ${num(len)});`));
      }
      case 0x21: {
        if (avail < 2) return null;
        const [a, len] = [at(1).hi, at(1).lo];
        return result(E.memCopy(lo, a, len, isPtr), stmt(`memcpy(${addrArg(isPtr, a)}, ${hex8(lo)}, ${num(len)});`));
      }
      case 0xf0: {
        if (avail < 3) return null;
        const text = `corrupt(${hex8(lo)}, ${hex8(at(1).hi)}, ${hex8(at(1).lo)}, ${hex8(at(2).hi)});`;
        return result(E.corruptor(lo, at(1).hi, at(1).lo, at(2).hi), stmt(text));
      }
      case 0x30: {
        if (avail < 2) return null;
        const range = { start: at(1).hi, end: at(1).lo };
        const lines = E.loadPointer(lo, range.start, range.end, isPtr);
        const rangeText = (base) => (range.start === base.start && range.end === base.end ? '' : ` in (${hex8(range.start)}, ${hex8(range.end)})`);
        if (!inPointer()) {
          if (!pointerAllowed()) return null;
          return result(lines, { open: { type: 'pointer', head: `*(u32*)${hex8(lo)}${rangeText(DEFAULT_RANGE)}`, range, body: [] } });
        }
        const src = isPtr ? deref('u32', true, lo) : `*(u32*)${hex8(lo)}`;
        return result(lines, stmt(`ptr = ${src}${rangeText(pointerBlock().range)};`));
      }
      case 0x31: case 0x32: case 0x33: case 0x34: {
        if (!inPointer()) return null;
        const reg = (hi >>> 8) & 0xff;
        const opText = cc === 0x31 || cc === 0x32 ? '+=' : '-=';
        if (cc === 0x31) return result(E.addPointer(lo), stmt(`ptr += ${num(lo)};`));
        if (cc === 0x33) return result(E.subPointer(lo), stmt(`ptr -= ${num(lo)};`));
        noteReg('r', reg);
        const lines = cc === 0x32 ? E.addPointerIndexed(reg, lo) : E.subPointerIndexed(reg, lo);
        return result(lines, stmt(`ptr ${opText} r${reg}${lo ? ` + ${num(lo)}` : ''};`));
      }
      case 0x80:
        return result(E.loop(lo), { open: { type: 'loop', head: String(lo >>> 0), body: [] } });
      case 0x81: {
        const reg = (hi >>> 8) & 0xff;
        noteReg('r', reg);
        return result(E.loopIndexed(reg), { open: { type: 'loop', head: `r${reg}`, body: [] } });
      }
      case 0x82:
        if (!inLoop()) return null;
        return result(E.breakLoop(), stmt('break;'));
      case 0xc0: {
        const n = hi & 0xffff;
        if (n + 1 > avail) return null;
        const words = [lo];
        for (let k = 1; k <= n; k++) words.push(at(k).hi, at(k).lo);
        // 末尾の 00000000 は詰め物なら落とす (コンパイラが埋め直す)。落とさない形も試す
        const candidates = words.length >= 2 && words[words.length - 1] === 0 ? [words.slice(0, -1), words] : [words];
        for (const ws of candidates) {
          const res = result(E.executeAsm(ws), stmt(asmText('asm', ws)));
          if (res) return res;
        }
        return null;
      }
      case 0xc1: {
        const x = hi & 0xffff;
        if (x === 0) return result(E.procedureCall(lo), stmt(`call(${hex8(lo)});`));
        return result(E.systemCall(x), stmt(`syscall(${hex(x)});`));
      }
      case 0xc2: case 0xc3: case 0xc4: {
        const n = hi & 0xffff;
        if (n === 0 || n + 1 > avail) return null;
        const words = [];
        for (let k = 1; k <= n; k++) words.push(at(k).hi, at(k).lo);
        if (cc !== 0xc4 && words.length > 1 && words[words.length - 1] === 0) words.pop(); // コンパイラが 0 で埋め直す
        const name = { 0xc2: 'hook_lr', 0xc3: 'hook_ctr', 0xc4: 'asm_write' }[cc];
        return result(E.asmBlock(cc, lo, words, cc === 0xc4 ? 0x60000000 : 0), stmt(asmText(`${name}(${hex8(lo)})`, words)));
      }
      case 0xe0: {
        const bytes = [];
        let k = 1;
        let terminated = false;
        for (; k < avail && !terminated; k++) {
          for (const w of [at(k).hi, at(k).lo]) {
            for (const b of [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]) {
              if (terminated) continue;
              if (b === 0) terminated = true;
              else bytes.push(b);
            }
          }
        }
        if (!terminated) return null;
        const rgb = lo & 0xffffff;
        return result(E.displayMessage(lo, bytes), stmt(`message(${stringLiteral(bytes)}${rgb ? `, 0x${rgb.toString(16).toUpperCase().padStart(6, '0')}` : ''});`));
      }
      case 0xe1: {
        if (!inPointer()) return null;
        const rgb = lo & 0xffffff;
        return result(E.displayPointerMessage(lo), stmt(`message(ptr${rgb ? `, 0x${rgb.toString(16).toUpperCase().padStart(6, '0')}` : ''});`));
      }
      case 0xe2:
        return result(E.clearMessage(), stmt('clear_message();'));
    }
    return null;
  }

  /** 構文に戻せなかったコードが何行を占めるか (データ行を別のコードとして読まないため) */
  function knownLength(i) {
    const { hi } = codes[i];
    const cc = hi >>> 24;
    const isPtr = ((hi >>> 16) & 0xf0) === 0x10;
    switch (cc) {
      case 0x00:
        return isPtr ? 1 : 2;
      case 0x01:
        return 1 + Math.ceil((hi & 0xffff) / 8);
      case 0x02:
      case 0xf0:
        return 3;
      case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: case 0x09: case 0x0a: case 0x0b:
      case 0x20: case 0x21: case 0x30:
        return 2;
      case 0xc0: case 0xc2: case 0xc3: case 0xc4:
        return 1 + (hi & 0xffff);
      case 0xe0:
        for (let k = i + 1; k < codes.length; k++) {
          const { hi: h, lo: l } = codes[k];
          const bytes = [h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, l >>> 24, (l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff];
          if (bytes.includes(0)) return k - i + 1;
        }
        return codes.length - i;
    }
    return 1;
  }

  function rawReason(code) {
    const cc = code.hi >>> 24;
    const known = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x20, 0x21, 0x30, 0x31, 0x32, 0x33, 0x34, 0x80, 0x81, 0x82, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xd0, 0xd1, 0xd2, 0xe0, 0xe1, 0xe2, 0xf0];
    const name = E.hex8(cc).slice(6);
    if (!known.includes(cc)) return `不明なコードタイプ [${name}]`;
    if (((code.hi >>> 16) & 0xf0) === 0x10 && !inPointer()) return `[${name}] ポインタ版ですがポインタが読み込まれていません`;
    return `[${name}] を構文に戻せません（書式外の値・文脈外・行不足のいずれか）`;
  }

  // 終端コードの処理
  function terminator(code) {
    const kind = code.hi >>> 24;
    const canonical = { 0xd0: E.TERM_D0, 0xd1: E.TERM_D1, 0xd2: E.TERM_D2 }[kind];
    if (code.lo !== canonical[1]) {
      warn(`${E.hex8(code.hi)} ${E.hex8(code.lo)}: 終端の下位ワードは再コンパイル時に ${E.hex8(canonical[1])} になります`, code);
    }
    if (kind === 0xd0) {
      const loopIdx = stack.map((b) => b.type).lastIndexOf('loop');
      const keep = Math.max(loopIdx, 0) + 1;
      if (stack.length <= keep) return raw(code, '閉じるブロックのない D0');
      stack.length = keep;
      return;
    }
    if (kind === 0xd1) {
      if (rawLoopDepth > 0) {
        rawLoopDepth--;
        return raw(code, '入れ子ループの終端 (入れ子ループは構文にできません)');
      }
      if (top().type !== 'loop') return raw(code, '対応するループのない D1');
      stack.pop();
      return;
    }
    if (top().type !== 'if' && top().type !== 'timer') return raw(code, '閉じる条件のない D2');
    stack.pop();
  }

  function negateCond(code) {
    const b = top();
    if (b.type !== 'if' || b.else !== null) return raw(code, '対応する条件のない 0F');
    const fresh = b.then.length === 0 && !b.cond.neg;
    if (fresh && b.cond.code !== 0x0e && (b.cond.code < 0x03 || b.cond.code > 0x08)) {
      b.cond.neg = true; // !between(...) / !button(...) / ビット判定の反転
      return;
    }
    b.else = []; // 比較の直後なら空の then + else
  }

  let i = 0;
  while (i < codes.length) {
    const code = codes[i];
    const cc = code.hi >>> 24;
    if (code.hi === 0 && code.lo === 0) {
      raw(code, 'コードリストの終端');
      i++;
      continue;
    }
    if (cc >= 0xd0 && cc <= 0xd2 && (code.hi & 0xffffff) === 0) {
      terminator(code);
      i++;
      continue;
    }
    if (code.hi === 0x0f000000 && code.lo === 0) {
      negateCond(code);
      i++;
      continue;
    }
    let res = null;
    pendingRegs = [];
    try {
      res = decodeAt(i);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
    if (!res) {
      const n = Math.min(knownLength(i), codes.length - i);
      raw(code, rawReason(code) + (n > 1 ? `（このコードは ${n} 行。続く行もそのまま出力）` : ''));
      for (let k = 1; k < n; k++) raw(codes[i + k]);
      i += n;
      continue;
    }
    if (res.open?.type === 'loop' && inLoop()) {
      rawLoopDepth++;
      raw(code, '入れ子ループ (コンパイラは入れ子ループに対応していません)');
      i++;
      continue;
    }
    pendingRegs.forEach((r) => highRegs.add(r));
    if (res.stmt) add({ type: 'stmt', text: res.stmt });
    else open(res.open);
    i += res.n;
  }
  if (highRegs.size) {
    const list = [...highRegs].sort((a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
    warn(`ドキュメント (0〜7) の範囲外のレジスタ番号が使われています: ${list.join(', ')}。${HIGH_REG_NOTE}`);
  }
  if (stack.length > 1) {
    warn(`終端コードのないブロックが ${stack.length - 1} 個あります。再コンパイル時に終端が追加されます`);
  }

  const source = render(root.body);
  verifyRoundTrip(source, codes, warnings);
  return { source, warnings };
}

// ---------------------------------------------------------------- 出力

function render(body) {
  const out = [];
  printBody(body, '', out);
  return out.join('\n') + (out.length ? '\n' : '');
}

function printBody(body, ind, out) {
  for (const node of body) printNode(node, ind, out);
}

function printNode(node, ind, out, lead = ind) {
  const inner = ind + '    ';
  switch (node.type) {
    case 'stmt': {
      const [first, ...rest] = node.text.split('\n');
      out.push(`${lead}${first}${node.comment ? `  // ${node.comment}` : ''}`);
      for (const l of rest) out.push(ind + l);
      return;
    }
    case 'if': {
      // 入れ子の if を && にまとめる (else が無く、本体がその if だけのとき)
      const conds = [condText(node.cond)];
      let cur = node;
      while (cur.else === null && cur.then.length === 1 && cur.then[0].type === 'if' && cur.then[0].else === null) {
        cur = cur.then[0];
        conds.push(condText(cur.cond));
      }
      out.push(`${lead}if (${conds.join(' && ')}) {`);
      printBody(cur.then, inner, out);
      if (cur.else !== null) {
        if (cur.else.length === 1 && cur.else[0].type === 'if') {
          printNode(cur.else[0], ind, out, `${ind}} else `);
          return;
        }
        out.push(`${ind}} else {`);
        printBody(cur.else, inner, out);
      }
      out.push(`${ind}}`);
      return;
    }
    case 'timer':
      out.push(`${lead}timer (${node.frames >>> 0}) {`);
      break;
    case 'pointer':
      out.push(`${lead}pointer ${node.head} {`);
      break;
    case 'loop':
      out.push(`${lead}loop (${node.head}) {`);
      break;
  }
  printBody(node.body, inner, out);
  out.push(`${ind}}`);
}

/** 生成したソースを再コンパイルし、元のコードと一致するか確認する */
function verifyRoundTrip(source, codes, warnings) {
  let lines;
  try {
    lines = generate(parse(tokenize(source))).lines.map((l) => E.formatLine(l.line));
  } catch (e) {
    warnings.push({ message: `生成したソースを再コンパイルできません: ${e.message}` });
    return;
  }
  const original = codes.map((c) => E.formatLine([c.hi, c.lo]));
  const n = Math.max(lines.length, original.length);
  for (let k = 0; k < n; k++) {
    if (lines[k] !== original[k]) {
      const at = codes[Math.min(k, codes.length - 1)];
      warnings.push({
        message: `再コンパイル結果が入力と ${k + 1} 行目のコードから異なります（入力: ${original[k] ?? 'なし'} / 再コンパイル: ${lines[k] ?? 'なし'}）`,
        pos: at && { line: at.line, col: 1 },
      });
      return;
    }
  }
}
