// コード生成器。AST を Cafe Code 行に変換する。
//
// コードハンドラ (TCP Gecko 2.5x) の条件モデル:
//   - 条件コード (03-0B, 0C, 0E) は「深さ」を 1 増やし、偽なら以降をスキップする。
//   - D2 は条件を 1 段だけ閉じる。D0 は全段の条件とロード済みポインタをまとめてリセットする。
//   - 0F は現在の段の真偽を反転する (else として利用)。
// このため、最も外側の条件ブロックは D0 で、入れ子の条件ブロックは D2 で閉じる。
// ポインタ (30) は D0 でしか解放されないので、ポインタブロックの後ろに
// 外側の条件の続きが残る位置には置けない (コンパイルエラーにする)。

import { CompileError } from './errors.js';
import { TYPES } from './parser.js';
import * as E from './encoder.js';
import { BUILTIN_CONSTANTS } from './constants.js';

const DEFAULT_RANGE = { start: 0x10000000, end: 0x50000000 };
const INT_MIN32 = -(2n ** 31n);
const UINT_MAX32 = 2n ** 32n - 1n;

/** レジスタ番号 8 以上についての注意 (ハンドラの逆アセンブルで確認) */
export const HIGH_REG_NOTE =
  '新しいハンドラ (tcpgecko code_handler.h) は番号の下位 3bit だけを使うため r8 は r0 と同じになり、古いハンドラ (codehandler.bin) は 0x10014F00 + 番号×4 をそのまま使うため r16 以上は float レジスタ領域と重なります';

const CMP_CODE = { '==': E.COND.eq, '!=': E.COND.ne, '>': E.COND.gt, '<': E.COND.lt, '>=': E.COND.ge, '<=': E.COND.le };
const CMP_SWAP = { '==': '==', '!=': '!=', '>': '<', '<': '>', '>=': '<=', '<=': '>=' };
const CMP_NEG = { '==': '!=', '!=': '==', '>': '<=', '<': '>=', '>=': '<', '<=': '>' };

const INT_REG_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '&': 'and', '|': 'or', '^': 'xor' };
const INT_IMM_OPS = { '+': 'addi', '-': 'subi', '*': 'muli', '/': 'divi', '&': 'andi', '|': 'ori', '^': 'xori' };
const FLOAT_REG_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };
const FLOAT_IMM_OPS = { '+': 'addi', '-': 'subi', '*': 'muli', '/': 'divi' };

export function generate(program) {
  const out = [];
  const warnings = [];
  const consts = new Map();
  let defaultRange = { ...DEFAULT_RANGE };
  const warnedRegs = new Set();

  const emit = (lines, pos) => {
    for (const l of lines) out.push({ line: l, pos });
  };
  const warn = (message, pos) => warnings.push({ message, pos });
  const fail = (message, pos, hint) => {
    throw new CompileError(message, pos, hint);
  };

  // ---------------------------------------------------------------- 定数評価

  /** 定数式を評価する。定数でなければ null。値: {kind:'int', v:BigInt} | {kind:'float', v:number} */
  function evalConst(e) {
    switch (e.type) {
      case 'Num':
        return e.value;
      case 'Ident': {
        if (consts.has(e.name)) return consts.get(e.name);
        if (e.name in BUILTIN_CONSTANTS) return { kind: 'int', v: BigInt(BUILTIN_CONSTANTS[e.name]) };
        if (regOf(e) || e.name === 'ptr') return null;
        return fail(`未定義の名前 '${e.name}' です`, e.pos, '定数は使用前に const で宣言してください');
      }
      case 'Unary': {
        const v = evalConst(e.operand);
        if (!v) return null;
        if (e.op === '+') return v;
        if (e.op === '-') return v.kind === 'float' ? { kind: 'float', v: -v.v } : { kind: 'int', v: -v.v };
        if (e.op === '~') {
          if (v.kind !== 'int') fail("'~' は整数にしか使えません", e.pos);
          return { kind: 'int', v: ~v.v & UINT_MAX32 };
        }
        return null; // '!' は条件式としてのみ扱う
      }
      case 'Binary': {
        if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) return null;
        const a = evalConst(e.left);
        const b = evalConst(e.right);
        if (!a || !b) return null;
        if (a.kind === 'float' || b.kind === 'float') {
          const x = Number(a.v);
          const y = Number(b.v);
          switch (e.op) {
            case '+': return { kind: 'float', v: x + y };
            case '-': return { kind: 'float', v: x - y };
            case '*': return { kind: 'float', v: x * y };
            case '/': return { kind: 'float', v: x / y };
            default: return fail(`演算子 '${e.op}' は浮動小数点数には使えません`, e.pos);
          }
        }
        const x = a.v;
        const y = b.v;
        switch (e.op) {
          case '+': return { kind: 'int', v: x + y };
          case '-': return { kind: 'int', v: x - y };
          case '*': return { kind: 'int', v: x * y };
          case '/':
            if (y === 0n) fail('定数式でゼロ除算しています', e.pos);
            return { kind: 'int', v: x / y };
          case '%':
            if (y === 0n) fail('定数式でゼロ除算しています', e.pos);
            return { kind: 'int', v: x % y };
          case '&': return { kind: 'int', v: x & y };
          case '|': return { kind: 'int', v: x | y };
          case '^': return { kind: 'int', v: x ^ y };
          case '<<': return { kind: 'int', v: (x << y) & UINT_MAX32 };
          case '>>': return { kind: 'int', v: (x & UINT_MAX32) >> y };
        }
        return null;
      }
      case 'Call':
        if (e.name === 'float_bits') {
          const v = constArg(e, 0, 1);
          return { kind: 'int', v: BigInt(E.floatBits(Number(v.v))) };
        }
        return null;
      default:
        return null;
    }
  }

  function constArg(call, i, count) {
    if (call.args.length !== count) fail(`${call.name} の引数は ${count} 個です（${call.args.length} 個指定されています）`, call.pos);
    const v = evalConst(call.args[i]);
    if (!v) fail(`${call.name} の第 ${i + 1} 引数は定数である必要があります`, call.args[i].pos);
    return v;
  }

  /** 32bit に収まる整数定数を返す (負数は 2 の補数) */
  function constU32(e, what) {
    const v = evalConst(e);
    if (!v) fail(`${what}は定数である必要があります`, e.pos, 'レジスタやメモリ値はここでは使えません');
    if (v.kind !== 'int') fail(`${what}は整数である必要があります`, e.pos);
    if (v.v < INT_MIN32 || v.v > UINT_MAX32) fail(`${what} (${v.v}) が 32bit の範囲を超えています`, e.pos);
    return Number(BigInt.asUintN(32, v.v));
  }

  function constRange(e, what, min, max) {
    const v = evalConst(e);
    if (!v || v.kind !== 'int') fail(`${what}は整数の定数である必要があります`, e.pos);
    if (v.v < BigInt(min) || v.v > BigInt(max)) {
      fail(`${what} (${v.v}) は ${min}〜0x${max.toString(16).toUpperCase()} の範囲で指定してください`, e.pos);
    }
    return Number(v.v);
  }

  /** 型サイズに合わせて値をチェックし、ビット列 (符号なし) を返す */
  function valueForType(e, typeName, what = '値') {
    const t = TYPES[typeName];
    const v = evalConst(e);
    if (!v) fail(`${what}は定数である必要があります`, e.pos);
    if (t.float) {
      return E.floatBits(Number(v.v));
    }
    if (v.kind === 'float') fail(`${typeName} に浮動小数点数 ${v.v} は書けません`, e.pos, 'f32 型を使うか、整数を指定してください');
    const bits = BigInt(t.bits);
    const min = -(1n << (bits - 1n));
    const max = (1n << bits) - 1n;
    if (v.v < min || v.v > max) {
      fail(`${what} ${v.v} は ${typeName} (${t.bits}bit) に収まりません`, e.pos);
    }
    return Number(BigInt.asUintN(t.bits, v.v));
  }

  // ---------------------------------------------------------------- 識別子

  function regOf(e) {
    if (e.type !== 'Ident') return null;
    const m = /^([rf])([0-9]+)$/.exec(e.name);
    if (!m) return null;
    const idx = Number(m[2]);
    if (idx > 0xff) fail(`レジスタ ${e.name} は使えません（番号は 0〜255。ドキュメント上は ${m[1]}0〜${m[1]}7 の 8 本です）`, e.pos);
    if (idx > 7 && !warnedRegs.has(e.name)) {
      warnedRegs.add(e.name);
      warn(`${e.name}: ドキュメントのレジスタは ${m[1]}0〜${m[1]}7 です。${HIGH_REG_NOTE}`, e.pos);
    }
    return { kind: m[1] === 'r' ? 'int' : 'float', idx, name: e.name };
  }
  const isPtr = (e) => e.type === 'Ident' && e.name === 'ptr';

  // ---------------------------------------------------------------- アドレス解決

  /**
   * アドレス式を解決する。
   *  {kind:'abs', addr}            絶対アドレス
   *  {kind:'ptr', off}             ロード済みポインタ + オフセット
   *  {kind:'chain', base, off}     *(u32*)(...) を含むポインタ連鎖 (自動でポインタを読み込む)
   */
  function resolveAddr(e, ctx) {
    const terms = [];
    collectTerms(e, 1, terms);
    let base = null;
    let off = 0n;
    for (const t of terms) {
      if (isPtr(t.e) || t.e.type === 'Deref') {
        if (base) fail('アドレス式にポインタ (ptr や *(u32*)...) を 2 つ以上含めることはできません', t.e.pos);
        if (t.sign < 0) fail('ポインタを引くアドレス式は使えません', t.e.pos);
        base = t.e;
        continue;
      }
      if (regOf(t.e)) {
        fail('アドレスにレジスタは使えません', t.e.pos, 'レジスタ分ずらす場合は pointer ブロック内で ptr += rN を使ってください');
      }
      const v = evalConst(t.e);
      if (!v) fail('アドレス式を解釈できません', t.e.pos);
      if (v.kind !== 'int') fail('アドレスは整数である必要があります', t.e.pos);
      off += t.sign > 0 ? v.v : -v.v;
    }
    if (!base) {
      if (off < 0n || off > UINT_MAX32) fail(`アドレス 0x${off.toString(16)} が 32bit の範囲外です`, e.pos);
      return { kind: 'abs', addr: Number(off) };
    }
    if (off < INT_MIN32 || off > UINT_MAX32) fail('オフセットが 32bit の範囲外です', e.pos);
    if (isPtr(base)) {
      if (!ctx.inPointer) {
        fail("'ptr' は pointer ブロックの中でしか使えません", base.pos, 'pointer *(u32*)アドレス { ... } でポインタを読み込んでください');
      }
      return { kind: 'ptr', off: Number(off) };
    }
    // *(u32*)X + off : ポインタ連鎖
    if (!['u32', 's32'].includes(base.valueType)) fail('ポインタとして読み込めるのは *(u32*) だけです', base.pos);
    const inner = resolveAddr(base.addr, ctx);
    if (inner.kind === 'ptr') {
      fail('ptr を基点にした連鎖ポインタは自動展開できません', base.pos, "ptr = *(u32*)(ptr + オフセット); でポインタを辿ってください");
    }
    const chain = { kind: 'chain', base: inner, off: Number(off) };
    if (ctx.chainKey && ctx.chainKey === chainKey(chain)) return { kind: 'ptr', off: Number(off) };
    return chain;
  }

  function collectTerms(e, sign, terms) {
    if (e.type === 'Binary' && (e.op === '+' || e.op === '-')) {
      collectTerms(e.left, sign, terms);
      collectTerms(e.right, e.op === '+' ? sign : -sign, terms);
      return;
    }
    terms.push({ e, sign });
  }

  /** ポインタ連鎖のうち「読み込むポインタ」部分の識別キー */
  const chainKey = (c) => JSON.stringify(c.base);

  /** 連鎖ポインタの読み込みコード (30 / 30100000 ...) を出力 */
  function emitPointerChain(base, range, pos) {
    if (base.kind === 'abs') {
      emit(E.loadPointer(base.addr, range.start, range.end), pos);
      return;
    }
    emitPointerChain(base.base, range, pos);
    emit(E.loadPointer(base.off, range.start, range.end, true), pos);
  }

  /** 文中で使われている連鎖ポインタをすべて集める */
  function findChains(node, ctx, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
      for (const n of node) findChains(n, ctx, found);
      return found;
    }
    if (node.type === 'Deref') {
      const a = resolveAddr(node.addr, ctx);
      if (a.kind === 'chain') found.push({ chain: a, pos: node.pos });
      return found;
    }
    for (const k of ['cond', 'left', 'right', 'operand', 'target', 'value', 'args', 'call']) {
      if (node[k]) findChains(node[k], ctx, found);
    }
    return found;
  }

  // ---------------------------------------------------------------- 文

  /**
   * ctx:
   *   condLevels  開いている条件の段数
   *   inPointer   ポインタがロードされているか
   *   inLoop      ループ内か
   *   d0Follows   この文の直後に D0 が出力されることが確定しているか
   *   chainKey    自動展開中の連鎖ポインタ
   * 戻り値: この文が D0 で終わったか
   */
  function genStatements(list, ctx) {
    let endsWithD0 = false;
    list.forEach((s, i) => {
      const last = i === list.length - 1;
      endsWithD0 = genStatement(s, { ...ctx, d0Follows: ctx.d0Follows && last });
    });
    return endsWithD0;
  }

  function genStatement(s, ctx) {
    switch (s.type) {
      case 'Empty':
        return false;
      case 'Const': {
        if (/^[rf][0-9]+$/.test(s.name) || s.name === 'ptr') fail(`'${s.name}' はレジスタ名なので定数名に使えません`, s.pos);
        if (consts.has(s.name)) fail(`定数 '${s.name}' はすでに定義されています`, s.pos);
        const v = evalConst(s.value);
        if (!v) fail('const には定数式しか指定できません', s.value.pos);
        consts.set(s.name, v);
        return false;
      }
      case 'If':
        return withChains(s, s.cond, ctx, (c) => genIf(s, c));
      case 'Assign':
        if (isPtr(s.target)) return genAssign(s, ctx);
        return withChains(s, s, ctx, (c) => genAssign(s, c));
      case 'Pointer':
        return genPointer(s, ctx);
      case 'Loop':
        return genLoop(s, ctx);
      case 'Timer':
        return genTimer(s, ctx);
      case 'Break':
        if (!ctx.inLoop) fail('break は loop の中でしか使えません', s.pos);
        emit(E.breakLoop(), s.pos);
        return false;
      case 'Asm':
        emit(E.executeAsm(s.words.map((w) => constU32(w, 'asm の命令ワード'))), s.pos);
        return false;
      case 'AsmBlock':
        return genAsmBlock(s);
      case 'CallStmt':
        return genCall(s.call, ctx);
    }
    return fail(`未対応の文です: ${s.type}`, s.pos);
  }

  /** 文に *(u32*)(*(u32*)X + K) のような連鎖ポインタがあれば pointer ブロックで包む */
  function withChains(s, scanNode, ctx, gen) {
    const chains = findChains(scanNode, ctx);
    if (chains.length === 0) return gen(ctx);
    const key = chainKey(chains[0].chain);
    for (const c of chains) {
      if (chainKey(c.chain) !== key) {
        fail('1 つの文で異なる連鎖ポインタを同時に使うことはできません', c.pos, 'pointer ブロックに分けて書いてください');
      }
    }
    checkPointerAllowed(ctx, chains[0].pos);
    emitPointerChain(chains[0].chain.base, defaultRange, chains[0].pos);
    gen({ ...ctx, inPointer: true, chainKey: key, d0Follows: true });
    emit([E.TERM_D0], s.pos);
    return true;
  }

  function checkPointerAllowed(ctx, pos) {
    if (ctx.inPointer) {
      fail('ポインタはすでにロードされています（ポインタは 1 つしか保持できません）', pos, "ポインタを辿り直すには ptr = *(u32*)(ptr + オフセット); を使ってください");
    }
    if (ctx.condLevels > 0 && !ctx.d0Follows) {
      fail(
        'ポインタは D0 でしか解放できないため、外側の条件ブロックの途中には置けません',
        pos,
        'ポインタを使う処理を条件ブロックの最後（else の無い位置）に移すか、条件をポインタブロックの内側に書いてください',
      );
    }
  }

  function genPointer(s, ctx) {
    checkPointerAllowed(ctx, s.pos);
    if (s.target.type !== 'Deref') fail('pointer にはメモリ参照 *(u32*)アドレス を指定してください', s.target.pos);
    const chain = resolveAddr({ type: 'Binary', op: '+', left: s.target, right: { type: 'Num', value: { kind: 'int', v: 0n } }, pos: s.pos }, ctx);
    const range = s.range ? { start: constU32(s.range.start, 'ポインタ範囲の開始'), end: constU32(s.range.end, 'ポインタ範囲の終了') } : defaultRange;
    if (range.start > range.end) fail('ポインタ範囲の開始が終了より大きくなっています', s.range.start.pos);
    emitPointerChain(chain.base, range, s.pos);
    if (chain.off !== 0) emit(E.addPointer(chain.off), s.pos);
    genStatements(s.body, { ...ctx, inPointer: true, chainKey: null, d0Follows: true, range });
    emit([E.TERM_D0], s.pos);
    return true;
  }

  function genLoop(s, ctx) {
    if (ctx.inLoop) {
      fail('loop の入れ子には対応していません', s.pos, 'コードハンドラのループカウンタは 1 つしかないため、入れ子にすると正しく動作しません');
    }
    const reg = regOf(s.count);
    if (reg) {
      if (reg.kind !== 'int') fail('ループ回数に使えるのは整数レジスタ r0〜r7 です', s.count.pos);
      emit(E.loopIndexed(reg.idx), s.pos);
    } else {
      emit(E.loop(constU32(s.count, 'ループ回数')), s.pos);
    }
    genStatements(s.body, { ...ctx, inLoop: true, d0Follows: false });
    emit([E.TERM_D1], s.pos);
    return false;
  }

  function genTimer(s, ctx) {
    emit(E.timeDependence(constU32(s.frames, 'フレーム数')), s.pos);
    const ends = genStatements(s.body, { ...ctx, condLevels: ctx.condLevels + 1, d0Follows: false });
    if (!ends) emit([E.TERM_D2], s.pos); // ドキュメントの通り [0C] は D2 で閉じる
    return ends;
  }

  function genIf(s, ctx) {
    const cond = compileCond(s.cond, ctx);
    if (s.otherwise && !cond.simple) {
      fail('&& を含む条件には else を付けられません', s.cond.pos, '[0F] Negate は最後の 1 段の条件しか反転できないため、if を入れ子にして書き分けてください');
    }
    emit(cond.lines, s.pos);
    const topLevel = ctx.condLevels === 0 && !ctx.inPointer;
    // この if の直後に D0 が来るか (自分が D0 を出す場合も含む)
    const d0After = ctx.d0Follows || topLevel;
    const inner = { ...ctx, condLevels: ctx.condLevels + cond.levels };
    let ends = genStatements(s.then, { ...inner, d0Follows: d0After && !s.otherwise });
    if (s.otherwise) {
      emit(E.negate(), s.pos);
      ends = genStatements(s.otherwise, { ...inner, d0Follows: d0After });
    }
    if (ends) return true;
    if (ctx.d0Follows) return false; // 外側が D0 で閉じる
    if (topLevel) {
      emit([E.TERM_D0], s.pos);
      return true;
    }
    for (let i = 0; i < cond.levels; i++) emit([E.TERM_D2], s.pos);
    return false;
  }

  // ---------------------------------------------------------------- 条件式

  /** 条件式をコンパイルする。{lines, levels, simple} */
  function compileCond(e, ctx) {
    if (e.type === 'Binary' && e.op === '&&') {
      const a = compileCond(e.left, ctx);
      const b = compileCond(e.right, ctx);
      return { lines: [...a.lines, ...b.lines], levels: a.levels + b.levels, simple: false };
    }
    if (e.type === 'Binary' && e.op === '||') {
      fail("'||' には対応していません", e.pos, 'コードハンドラは OR 結合をサポートしていません。if を分けて書くか、同じアドレスのビット判定なら (x & マスク) != 0 を使ってください');
    }
    if (e.type === 'Unary' && e.op === '!') {
      const inner = e.operand;
      if (inner.type === 'Binary' && inner.op in CMP_NEG) {
        return compileCond({ ...inner, op: CMP_NEG[inner.op] }, ctx);
      }
      const c = compileCond(inner, ctx);
      if (!c.simple) fail("'!' は && を含む条件には使えません", e.pos);
      return { lines: [...c.lines, ...E.negate()], levels: c.levels, simple: true };
    }
    if (e.type === 'Call') return compileCondCall(e, ctx);
    if (e.type === 'Binary' && e.op in CMP_CODE) return compileCompare(e, ctx);
    if (e.type === 'Binary' && e.op === '&') {
      // (x & M) を真偽値として使う → != 0
      return compileCompare({ type: 'Binary', op: '!=', left: e, right: num(0), pos: e.pos }, ctx);
    }
    if (e.type === 'Deref') {
      return compileCompare({ type: 'Binary', op: '!=', left: e, right: num(0), pos: e.pos }, ctx);
    }
    if (regOf(e)) fail('レジスタの値で分岐するコードタイプはありません', e.pos, 'レジスタを一度メモリに書き込み (*(u32*)ADDR = rN;)、そのアドレスを比較してください');
    return fail('条件式として解釈できません', e.pos, '例: *(u32*)0x10000000 == 1');
  }

  const num = (v) => ({ type: 'Num', value: { kind: 'int', v: BigInt(v) } });

  function memOperand(e, ctx, what) {
    if (e.type !== 'Deref') return null;
    const a = resolveAddr(e.addr, ctx);
    if (a.kind === 'chain') fail('この位置では連鎖ポインタを使えません', e.pos);
    return { type: e.valueType, addr: a, pos: e.pos, what };
  }

  function condLines(code, mem, v1, v2 = 0) {
    const t = TYPES[mem.type];
    const ptr = mem.addr.kind === 'ptr';
    return E.conditional(code, t.bits, ptr ? mem.addr.off : mem.addr.addr, v1, v2, ptr);
  }

  function compileCompare(e, ctx) {
    let op = e.op;
    let left = e.left;
    let right = e.right;
    if (evalConst(left) && !evalConst(right)) {
      [left, right] = [right, left];
      op = CMP_SWAP[op];
    }
    // ビットマスク判定: (x & M) == M → [09], (x & M) != 0 → [0A]
    if (left.type === 'Binary' && left.op === '&') {
      let m = left.left;
      let maskE = left.right;
      if (evalConst(m) && !evalConst(maskE)) [m, maskE] = [maskE, m];
      const mem = memOperand(m, ctx);
      if (!mem) fail('ビット判定の左辺は *(型*)アドレス & マスク の形で書いてください', left.pos);
      if (TYPES[mem.type].float) fail('f32 にビット判定は使えません', left.pos);
      const mask = valueForType(maskE, mem.type, 'マスク');
      const rhs = valueForType(right, mem.type, '比較値');
      if (op !== '==' && op !== '!=') fail('ビット判定に使えるのは == と != だけです', e.pos);
      let code;
      let negated;
      if (rhs === mask && mask !== 0) {
        code = E.COND.and; // すべてのビットが立っている
        negated = op === '!=';
      } else if (rhs === 0) {
        code = E.COND.or; // いずれかのビットが立っている
        negated = op === '==';
      } else {
        return fail('ビット判定の比較値はマスクと同じ値か 0 にしてください', right.pos, '(x & M) == M → [09] AND, (x & M) != 0 → [0A] OR');
      }
      const lines = condLines(code, mem, mask);
      return { lines: negated ? [...lines, ...E.negate()] : lines, levels: 1, simple: true };
    }
    const mem = memOperand(left, ctx);
    if (!mem) {
      if (regOf(left)) fail('レジスタの値で分岐するコードタイプはありません', left.pos, 'レジスタを一度メモリに書き込み、そのアドレスを比較してください');
      fail('比較の片側は *(型*)アドレス である必要があります', left.pos);
    }
    if (!evalConst(right)) fail('比較の相手は定数である必要があります', right.pos, 'メモリ同士の比較を行うコードタイプはありません');
    const t = TYPES[mem.type];
    if (t.float && op !== '==' && op !== '!=') {
      fail('f32 の大小比較はできません（コードハンドラは整数として比較します）', e.pos, '== / != のみ使えます');
    }
    const v = valueForType(right, mem.type, '比較値');
    if (t.signed && t.bits < 32 && !t.float && op !== '==' && op !== '!=' && Number(evalConst(right).v) < 0) {
      warn(`${mem.type} の負数との大小比較: コードハンドラは 8/16bit 値を符号なしで読むため、期待通りにならない可能性があります`, e.pos);
    }
    if (t.bits === 32 && !t.signed && op !== '==' && op !== '!=' && v >= 0x80000000) {
      warn('32bit の大小比較はコードハンドラ上で符号付き (cmpw) として扱われます', e.pos);
    }
    return { lines: condLines(CMP_CODE[op], mem, v), levels: 1, simple: true };
  }

  function compileCondCall(e, ctx) {
    switch (e.name) {
      case 'between': {
        if (e.args.length !== 3) fail('between(*(型*)アドレス, 下限, 上限) の形で書いてください', e.pos);
        const mem = memOperand(e.args[0], ctx);
        if (!mem) fail('between の第 1 引数は *(型*)アドレス にしてください', e.args[0].pos);
        if (TYPES[mem.type].float) fail('f32 に between は使えません', e.pos);
        const lo = valueForType(e.args[1], mem.type, '下限');
        const hi = valueForType(e.args[2], mem.type, '上限');
        return { lines: condLines(E.COND.between, mem, lo, hi), levels: 1, simple: true };
      }
      case 'button': {
        if (e.args.length < 1 || e.args.length > 3) fail('button(ボタン [, コントローラ [, ポート]]) の形で書いてください', e.pos);
        const mask = constU32(e.args[0], 'ボタン値');
        const ctrl = e.args[1] ? constRange(e.args[1], 'コントローラ種別', 0, 3) : 0;
        const port = e.args[2] ? constRange(e.args[2], 'ポート番号', 0, 3) : 0;
        return { lines: E.inputConditional(ctrl, port, mask), levels: 1, simple: true };
      }
    }
    return fail(`'${e.name}' は条件式として使えません`, e.pos, '使える関数: between(), button()');
  }

  // ---------------------------------------------------------------- 代入

  function genAssign(s, ctx) {
    const t = s.target;
    if (isPtr(t)) return genPtrAssign(s, ctx);
    if (s.range) fail('in (開始, 終了) はポインタの読み込みでしか使えません', s.pos);
    const reg = regOf(t);
    if (reg) return reg.kind === 'int' ? genIntRegAssign(s, reg, ctx) : genFloatRegAssign(s, reg, ctx);
    if (t.type === 'Deref') return genMemAssign(s, ctx);
    if (t.type === 'Ident') fail(`'${t.name}' には代入できません`, t.pos, '代入先は *(型*)アドレス、r0〜r7、f0〜f7、ptr のいずれかです');
    return fail('代入先が不正です', t.pos);
  }

  function genMemAssign(s, ctx) {
    const mem = memOperand(s.target, ctx);
    const t = TYPES[mem.type];
    if (s.op !== '=') {
      fail(`メモリへの '${s.op}' は直接書けません`, s.pos, `レジスタを使ってください（例: r0 = *(${mem.type}*)ADDR; r0 ${s.op} 値; *(${mem.type}*)ADDR = r0;）`);
    }
    const ptr = mem.addr.kind === 'ptr';
    const a = ptr ? mem.addr.off : mem.addr.addr;
    const reg = regOf(s.value);
    if (reg) {
      if (reg.kind === 'float') {
        if (!t.float) fail(`float レジスタ ${reg.name} は *(f32*) にしか格納できません`, s.value.pos, `整数として書くなら r = int(${reg.name}) で変換してください`);
        emit(E.storeFloat(reg.idx, a, ptr), s.pos);
      } else {
        if (t.float) fail(`整数レジスタ ${reg.name} を *(f32*) には格納できません`, s.value.pos, `f = float(${reg.name}) で変換してから格納するか、*(u32*) を使ってください`);
        emit(E.storeInt(t.bits, reg.idx, a, ptr), s.pos);
      }
      return false;
    }
    if (s.value.type === 'Deref') fail('メモリからメモリへ直接コピーはできません', s.value.pos, 'レジスタを経由するか memcpy() を使ってください');
    const value = valueForType(s.value, mem.type);
    if (ptr) {
      if (a < 0 || a > 0xffff) {
        fail(`ポインタ書き込みのオフセット (${a}) は 0〜0xFFFF の範囲で指定してください`, s.target.pos, 'RAM Write [00] のオフセットは 16bit 符号なしです。ptr += / ptr -= でポインタ自体をずらしてください');
      }
      emit(E.ramWritePtr(t.bits, a, value), s.pos);
    } else {
      emit(E.ramWrite(t.bits, a, value), s.pos);
    }
    return false;
  }

  function genPtrAssign(s, ctx) {
    if (!ctx.inPointer) fail("'ptr' は pointer ブロックの中でしか使えません", s.pos);
    if (s.op === '=') {
      const v = s.value;
      if (v.type !== 'Deref' || !['u32', 's32'].includes(v.valueType)) {
        fail('ptr には *(u32*)アドレス の読み込みしか代入できません', v.pos, 'ポインタをずらすには ptr += オフセット を使ってください');
      }
      const a = resolveAddr(v.addr, ctx);
      const range = s.range ? { start: constU32(s.range.start, 'ポインタ範囲の開始'), end: constU32(s.range.end, 'ポインタ範囲の終了') } : ctx.range ?? defaultRange;
      if (a.kind === 'chain') {
        emitPointerChain(a.base, range, s.pos);
        emit(E.loadPointer(a.off, range.start, range.end, true), s.pos);
      } else if (a.kind === 'ptr') {
        emit(E.loadPointer(a.off, range.start, range.end, true), s.pos);
      } else {
        emit(E.loadPointer(a.addr, range.start, range.end), s.pos);
      }
      return false;
    }
    if (s.range) fail('in (開始, 終了) はポインタの読み込みでしか使えません', s.pos);
    if (s.op !== '+=' && s.op !== '-=') fail(`ptr に使える演算は =, +=, -= だけです`, s.pos);
    // ptr += c / ptr += rN / ptr += rN + c
    const terms = [];
    collectTerms(s.value, 1, terms);
    let reg = null;
    let q = 0n;
    for (const t of terms) {
      const r = regOf(t.e);
      if (r) {
        if (r.kind !== 'int' || t.sign < 0 || reg) fail('ptr += / -= に使えるのは「整数レジスタ 1 つ + 定数」までです', t.e.pos);
        reg = r;
        continue;
      }
      const v = evalConst(t.e);
      if (!v || v.kind !== 'int') fail('ptr のオフセットは整数定数かレジスタで指定してください', t.e.pos);
      q += t.sign > 0 ? v.v : -v.v;
    }
    if (q < INT_MIN32 || q > UINT_MAX32) fail('オフセットが 32bit の範囲外です', s.value.pos);
    const qq = Number(BigInt.asUintN(32, q));
    if (s.op === '+=') emit(reg ? E.addPointerIndexed(reg.idx, qq) : E.addPointer(qq), s.pos);
    else emit(reg ? E.subPointerIndexed(reg.idx, qq) : E.subPointer(qq), s.pos);
    return false;
  }

  /** 式を「先頭の値 → (演算子, 値) の列」に左から平坦化する */
  function linearize(e) {
    const c = evalConst(e);
    if (c) return { base: { const: c, pos: e.pos }, ops: [] };
    if (e.type === 'Binary' && !['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) {
      const left = linearize(e.left);
      const rc = evalConst(e.right);
      const rr = regOf(e.right);
      if (!rc && !rr) {
        fail('式が複雑すぎます。右側のオペランドは定数かレジスタにしてください', e.right.pos, '複数の文に分けて書いてください（例: r0 = r1; r0 *= r2; r0 += 4;）');
      }
      left.ops.push({ op: e.op, const: rc, reg: rr, pos: e.right.pos });
      return left;
    }
    const r = regOf(e);
    if (r) return { base: { reg: r, pos: e.pos }, ops: [] };
    if (e.type === 'Deref') return { base: { deref: e, pos: e.pos }, ops: [] };
    if (e.type === 'Call' && (e.name === 'float' || e.name === 'int')) return { base: { conv: e, pos: e.pos }, ops: [] };
    return fail('レジスタに代入できない式です', e.pos);
  }

  function genIntRegAssign(s, reg, ctx) {
    const dst = reg.idx;
    if (s.op !== '=') {
      const op = s.op[0];
      return genIntOps(dst, [{ op, const: evalConst(s.value), reg: regOf(s.value), pos: s.value.pos }], s);
    }
    const lin = linearize(s.value);
    const b = lin.base;
    if (b.deref) {
      const mem = memOperand(b.deref, ctx);
      const t = TYPES[mem.type];
      if (t.float) fail(`*(f32*) は float レジスタ (f0〜f7) に読み込んでください`, b.pos);
      const ptr = mem.addr.kind === 'ptr';
      emit(E.loadInt(t.bits, dst, ptr ? mem.addr.off : mem.addr.addr, ptr), s.pos);
    } else if (b.conv) {
      if (b.conv.name !== 'int') fail('整数レジスタへの変換は int(fN) を使ってください', b.pos);
      const src = convArg(b.conv, 'float');
      emit(E.floatOp(E.FLOAT_OP.ftoi, src.idx, dst), s.pos); // 整数R(S) = (int)浮動R(R)
    } else if (b.const) {
      if (b.const.kind !== 'int') fail(`整数レジスタ ${reg.name} に浮動小数点数は代入できません`, b.pos, 'float レジスタ f0〜f7 を使ってください');
      emit(E.intOp(E.INT_OP.set, dst, 0, toU32(b.const.v, b.pos)), s.pos);
    } else if (b.reg) {
      if (b.reg.kind !== 'int') fail(`float レジスタ ${b.reg.name} を整数レジスタに代入するには int(${b.reg.name}) を使ってください`, b.pos);
      if (b.reg.idx !== dst) {
        if (lin.ops.some((o) => o.reg && o.reg.kind === 'int' && o.reg.idx === dst)) {
          fail(`${reg.name} が右辺の途中で使われているため計算順を保てません`, s.pos, '一時レジスタを使って文を分けてください');
        }
        emit(E.intOp(E.INT_OP.set, dst, 0, 0), s.pos);
        emit(E.intOp(E.INT_OP.add, dst, b.reg.idx), s.pos);
      }
    }
    return genIntOps(dst, lin.ops, s);
  }

  function genIntOps(dst, ops, s) {
    for (const o of ops) {
      if (o.reg) {
        if (o.reg.kind !== 'int') fail(`整数演算に float レジスタ ${o.reg.name} は使えません`, o.pos);
        const name = INT_REG_OPS[o.op];
        if (!name) fail(`整数レジスタの演算子 '${o.op}' には対応していません`, o.pos, '使える演算: + - * / & | ^');
        emit(E.intOp(E.INT_OP[name], dst, o.reg.idx), s.pos);
      } else if (o.const) {
        const name = INT_IMM_OPS[o.op];
        if (!name) fail(`整数レジスタの演算子 '${o.op}' には対応していません`, o.pos, '使える演算: + - * / & | ^');
        if (o.const.kind !== 'int') fail('整数レジスタの演算に浮動小数点数は使えません', o.pos);
        if (o.op === '/' && o.const.v === 0n) fail('ゼロ除算です', o.pos);
        emit(E.intOp(E.INT_OP[name], dst, 0, toU32(o.const.v, o.pos)), s.pos);
      } else {
        fail('右辺は定数かレジスタにしてください', o.pos, 'メモリの値は一度レジスタに読み込んでください');
      }
    }
    return false;
  }

  function genFloatRegAssign(s, reg, ctx) {
    const dst = reg.idx;
    if (s.op !== '=') {
      const op = s.op[0];
      return genFloatOps(dst, [{ op, const: evalConst(s.value), reg: regOf(s.value), pos: s.value.pos }], s);
    }
    const lin = linearize(s.value);
    const b = lin.base;
    if (b.deref) {
      const mem = memOperand(b.deref, ctx);
      if (!TYPES[mem.type].float) fail('float レジスタには *(f32*) しか読み込めません', b.pos, `整数を読み込むなら r レジスタに読み込んでから float(rN) で変換してください`);
      const ptr = mem.addr.kind === 'ptr';
      emit(E.loadFloat(dst, ptr ? mem.addr.off : mem.addr.addr, ptr), s.pos);
    } else if (b.conv) {
      if (b.conv.name !== 'float') fail('float レジスタへの変換は float(rN) を使ってください', b.pos);
      const src = convArg(b.conv, 'int');
      emit(E.intOp(E.INT_OP.itof, src.idx, dst), s.pos); // 浮動R(S) = (float)整数R(R)
    } else if (b.const) {
      emit(E.floatOp(E.FLOAT_OP.set, dst, 0, E.floatBits(Number(b.const.v))), s.pos);
    } else if (b.reg) {
      if (b.reg.kind !== 'float') fail(`整数レジスタ ${b.reg.name} を float レジスタに代入するには float(${b.reg.name}) を使ってください`, b.pos);
      if (b.reg.idx !== dst) {
        if (lin.ops.some((o) => o.reg && o.reg.kind === 'float' && o.reg.idx === dst)) {
          fail(`${reg.name} が右辺の途中で使われているため計算順を保てません`, s.pos, '一時レジスタを使って文を分けてください');
        }
        emit(E.floatOp(E.FLOAT_OP.set, dst, 0, 0), s.pos);
        emit(E.floatOp(E.FLOAT_OP.add, dst, b.reg.idx), s.pos);
      }
    }
    return genFloatOps(dst, lin.ops, s);
  }

  function genFloatOps(dst, ops, s) {
    for (const o of ops) {
      if (o.reg) {
        if (o.reg.kind !== 'float') fail(`浮動小数点演算に整数レジスタ ${o.reg.name} は使えません`, o.pos, `float(${o.reg.name}) で変換してください`);
        const name = FLOAT_REG_OPS[o.op];
        if (!name) fail(`float レジスタの演算子 '${o.op}' には対応していません`, o.pos, '使える演算: + - * /');
        emit(E.floatOp(E.FLOAT_OP[name], dst, o.reg.idx), s.pos);
      } else if (o.const) {
        const name = FLOAT_IMM_OPS[o.op];
        if (!name) fail(`float レジスタの演算子 '${o.op}' には対応していません`, o.pos, '使える演算: + - * /');
        emit(E.floatOp(E.FLOAT_OP[name], dst, 0, E.floatBits(Number(o.const.v))), s.pos);
      } else {
        fail('右辺は定数かレジスタにしてください', o.pos);
      }
    }
    return false;
  }

  function convArg(call, want) {
    if (call.args.length !== 1) fail(`${call.name}() の引数は 1 つです`, call.pos);
    const r = regOf(call.args[0]);
    if (!r || r.kind !== want) fail(`${call.name}() の引数は ${want === 'int' ? '整数レジスタ r0〜r7' : 'float レジスタ f0〜f7'} にしてください`, call.args[0].pos);
    return r;
  }

  function toU32(v, pos) {
    if (v < INT_MIN32 || v > UINT_MAX32) fail(`値 ${v} が 32bit の範囲を超えています`, pos);
    return Number(BigInt.asUintN(32, v));
  }

  // ---------------------------------------------------------------- 組み込み関数

  function addrArg(call, i, ctx, what) {
    const e = call.args[i];
    if (!e) fail(`${call.name} の引数が足りません（${what}）`, call.pos);
    const a = resolveAddr(e, ctx);
    if (a.kind === 'chain') fail('この関数のアドレスに連鎖ポインタは使えません', e.pos, 'pointer ブロック内で ptr + オフセット を使ってください');
    return a;
  }

  function argCount(call, min, max = min) {
    const n = call.args.length;
    if (n < min || n > max) {
      const want = min === max ? `${min} 個` : `${min}〜${max} 個`;
      fail(`${call.name}() の引数は ${want}です（${n} 個指定されています）`, call.pos);
    }
  }

  function bytesArg(e, what) {
    if (e.type === 'Str') return e.bytes;
    if (e.type === 'Array') return e.items.map((it) => constRange(it, `${what}の各要素`, 0, 0xff));
    return fail(`${what}は文字列 "..." かバイト配列 [0x01, 0x02, ...] で指定してください`, e.pos);
  }

  function genCall(call, ctx) {
    const pos = call.pos;
    switch (call.name) {
      case 'write': {
        // write(addr, "文字列" | [bytes]) → [01] String Write
        argCount(call, 2);
        const a = addrArg(call, 0, ctx, 'アドレス');
        const bytes = bytesArg(call.args[1], '書き込むデータ');
        if (bytes.length === 0) fail('書き込むデータが空です', call.args[1].pos);
        if (bytes.length > 0xffff) fail('一度に書き込めるのは 0xFFFF バイトまでです', call.args[1].pos);
        emit(E.stringWrite(bytes, a.kind === 'ptr' ? a.off : a.addr, a.kind === 'ptr'), pos);
        return false;
      }
      case 'skip_write': {
        // skip_write(*(型*)addr, 値, 回数, 間隔 [, 増分]) → [02]
        argCount(call, 4, 5);
        const target = call.args[0];
        if (target.type !== 'Deref') fail('skip_write の第 1 引数は *(型*)アドレス にしてください', target.pos);
        const mem = memOperand(target, ctx);
        const t = TYPES[mem.type];
        if (t.float) fail('skip_write は f32 に対応していません（u32 にビット列を指定してください）', target.pos);
        const value = valueForType(call.args[1], mem.type);
        const count = constRange(call.args[2], '書き込み回数', 0, 0xffff);
        const stride = constU32(call.args[3], '書き込み間隔');
        const inc = call.args[4] ? valueForType(call.args[4], mem.type, '増分') : 0;
        const ptr = mem.addr.kind === 'ptr';
        emit(E.skipWrite(t.bits, count, ptr ? mem.addr.off : mem.addr.addr, value, stride, inc, ptr), pos);
        return false;
      }
      case 'memfill': {
        argCount(call, 3);
        const a = addrArg(call, 0, ctx, 'アドレス');
        emit(E.memFill(constU32(call.args[1], '値'), a.kind === 'ptr' ? a.off : a.addr, constU32(call.args[2], '長さ'), a.kind === 'ptr'), pos);
        return false;
      }
      case 'memcpy': {
        argCount(call, 3);
        const dst = addrArg(call, 0, ctx, 'コピー先');
        const src = addrArg(call, 1, ctx, 'コピー元');
        if (src.kind !== 'abs') fail('memcpy のコピー元は絶対アドレスで指定してください', call.args[1].pos);
        emit(E.memCopy(src.addr, dst.kind === 'ptr' ? dst.off : dst.addr, constU32(call.args[2], '長さ'), dst.kind === 'ptr'), pos);
        return false;
      }
      case 'corrupt': {
        argCount(call, 4);
        emit(E.corruptor(constU32(call.args[0], '開始アドレス'), constU32(call.args[1], '終了アドレス'), constU32(call.args[2], '検索値'), constU32(call.args[3], '置換値')), pos);
        return false;
      }
      case 'reset_timer': {
        // reset_timer(*(u16*)addr == 値)
        argCount(call, 1);
        const c = call.args[0];
        if (c.type !== 'Binary' || c.op !== '==' || c.left.type !== 'Deref' || c.left.valueType !== 'u16') {
          fail('reset_timer の引数は *(u16*)アドレス == 値 の形で書いてください', c.pos);
        }
        const a = resolveAddr(c.left.addr, ctx);
        if (a.kind !== 'abs') fail('reset_timer のアドレスは絶対アドレスで指定してください', c.left.pos);
        emit(E.resetTimer(valueForType(c.right, 'u16'), a.addr), pos);
        return false;
      }
      case 'call': {
        argCount(call, 1);
        emit(E.procedureCall(constU32(call.args[0], '関数アドレス')), pos);
        return false;
      }
      case 'syscall': {
        argCount(call, 1);
        emit(E.systemCall(constRange(call.args[0], 'システムコール番号', 1, 0xffff)), pos);
        return false;
      }
      case 'message': {
        argCount(call, 1, 2);
        const rgb = call.args[1] ? constRange(call.args[1], '背景色', 0, 0xffffff) : 0;
        if (isPtr(call.args[0])) {
          if (!ctx.inPointer) fail("'ptr' は pointer ブロックの中でしか使えません", call.args[0].pos);
          emit(E.displayPointerMessage(rgb), pos);
        } else if (call.args[0].type === 'Str') {
          emit(E.displayMessage(rgb, call.args[0].bytes), pos);
        } else {
          fail('message の第 1 引数は文字列か ptr にしてください', call.args[0].pos);
        }
        return false;
      }
      case 'clear_message':
        argCount(call, 0);
        emit(E.clearMessage(), pos);
        return false;
      case 'pointer_range':
        argCount(call, 2);
        defaultRange = { start: constU32(call.args[0], 'ポインタ範囲の開始'), end: constU32(call.args[1], 'ポインタ範囲の終了') };
        if (defaultRange.start > defaultRange.end) fail('ポインタ範囲の開始が終了より大きくなっています', pos);
        return false;
      case 'raw': {
        argCount(call, 2);
        emit([[constU32(call.args[0], 'raw の上位ワード'), constU32(call.args[1], 'raw の下位ワード')]], pos);
        return false;
      }
      case 'between':
      case 'button':
        return fail(`${call.name}() は if の条件でしか使えません`, pos);
    }
    return fail(`不明な関数 '${call.name}' です`, pos);
  }

  function genAsmBlock(s) {
    const addr = constU32(s.addr, 'フックアドレス');
    const words = s.words.map((w) => constU32(w, '命令ワード'));
    if (words.length === 0) fail(`${s.kind} の本体が空です`, s.pos);
    const code = { hook_lr: 0xc2, hook_ctr: 0xc3, asm_write: 0xc4 }[s.kind];
    if (code === 0xc4 && words.length % 2) {
      warn('asm_write のワード数が奇数のため、末尾を nop (60000000) で埋めました', s.pos);
    }
    if (code === 0xc2 && words[words.length - 1] !== E.BLR) {
      warn('hook_lr のコードは blr (4E800020) で終わる必要があります', s.pos);
    }
    emit(E.asmBlock(code, addr, words, code === 0xc4 ? 0x60000000 : 0), s.pos);
    return false;
  }

  genStatements(program.body, { condLevels: 0, inPointer: false, inLoop: false, d0Follows: false, chainKey: null });
  return { lines: out, warnings };
}
