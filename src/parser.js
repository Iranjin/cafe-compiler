// 構文解析器。トークン列から AST を構築する。

import { CompileError } from './errors.js';

export const TYPES = {
  u8: { bits: 8, signed: false, float: false },
  s8: { bits: 8, signed: true, float: false },
  u16: { bits: 16, signed: false, float: false },
  s16: { bits: 16, signed: true, float: false },
  u32: { bits: 32, signed: false, float: false },
  s32: { bits: 32, signed: true, float: false },
  f32: { bits: 32, signed: true, float: true },
};

const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '&=', '|=', '^='];
const WORD_BLOCK_FUNCS = ['hook_lr', 'hook_ctr', 'asm_write'];

// 二項演算子の優先順位 (大きいほど強い)
const BINARY_PREC = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

export function parse(tokens) {
  let p = 0;
  const peek = (o = 0) => tokens[Math.min(p + o, tokens.length - 1)];
  const next = () => tokens[p++];
  const isPunct = (v, o = 0) => peek(o).type === 'punct' && peek(o).value === v;
  const isIdent = (v, o = 0) => peek(o).type === 'ident' && peek(o).value === v;

  function describe(t) {
    if (t.type === 'eof') return 'ファイル終端';
    if (t.type === 'str') return '文字列';
    if (t.type === 'num') return '数値';
    return `'${t.value}'`;
  }

  function expectPunct(v, ctx) {
    const t = peek();
    if (t.type !== 'punct' || t.value !== v) {
      throw new CompileError(`'${v}' が必要ですが ${describe(t)} があります${ctx ? `（${ctx}）` : ''}`, t.pos);
    }
    return next();
  }

  function expectIdent(ctx) {
    const t = peek();
    if (t.type !== 'ident') throw new CompileError(`識別子が必要ですが ${describe(t)} があります${ctx ? `（${ctx}）` : ''}`, t.pos);
    return next();
  }

  function parseProgram() {
    const body = [];
    while (peek().type !== 'eof') body.push(parseStatement());
    return { type: 'Program', body };
  }

  function parseBlock(what) {
    const t = peek();
    if (!isPunct('{')) {
      throw new CompileError(`${what} の本体は { } で囲んでください`, t.pos);
    }
    next();
    const body = [];
    while (!isPunct('}')) {
      if (peek().type === 'eof') throw new CompileError(`'}' が閉じられていません（${what}）`, t.pos);
      body.push(parseStatement());
    }
    next();
    return body;
  }

  function parseWordBlock(what) {
    const open = expectPunct('{', what);
    const words = [];
    while (!isPunct('}')) {
      if (peek().type === 'eof') throw new CompileError(`'}' が閉じられていません（${what}）`, open.pos);
      words.push(parseExpr());
      if (isPunct(',') || isPunct(';')) next();
    }
    next();
    return words;
  }

  function optionalSemicolon() {
    if (isPunct(';')) next();
  }

  function parseStatement() {
    const t = peek();
    if (t.type === 'punct' && t.value === ';') {
      next();
      return { type: 'Empty', pos: t.pos };
    }
    if (t.type === 'ident') {
      switch (t.value) {
        case 'const': {
          next();
          const name = expectIdent('const の名前');
          expectPunct('=', 'const 宣言');
          const value = parseExpr();
          expectPunct(';', 'const 宣言の終わり');
          return { type: 'Const', name: name.value, value, pos: t.pos };
        }
        case 'if':
          return parseIf();
        case 'else':
          throw new CompileError('対応する if のない else です', t.pos);
        case 'pointer': {
          next();
          const target = parseExpr({ noIn: true });
          let range = null;
          if (isIdent('in')) {
            next();
            range = parseRange();
          }
          const body = parseBlock('pointer');
          return { type: 'Pointer', target, range, body, pos: t.pos };
        }
        case 'loop': {
          next();
          expectPunct('(', 'loop');
          const count = parseExpr();
          expectPunct(')', 'loop');
          const body = parseBlock('loop');
          return { type: 'Loop', count, body, pos: t.pos };
        }
        case 'timer': {
          next();
          expectPunct('(', 'timer');
          const frames = parseExpr();
          expectPunct(')', 'timer');
          const body = parseBlock('timer');
          return { type: 'Timer', frames, body, pos: t.pos };
        }
        case 'break':
          next();
          expectPunct(';', 'break');
          return { type: 'Break', pos: t.pos };
        case 'asm': {
          next();
          const words = parseWordBlock('asm');
          optionalSemicolon();
          return { type: 'Asm', words, pos: t.pos };
        }
        default:
          if (WORD_BLOCK_FUNCS.includes(t.value) && isPunct('(', 1)) {
            next();
            next();
            const addr = parseExpr();
            expectPunct(')', t.value);
            const words = parseWordBlock(t.value);
            optionalSemicolon();
            return { type: 'AsmBlock', kind: t.value, addr, words, pos: t.pos };
          }
      }
    }

    // 代入文 または 関数呼び出し文
    const expr = parseExpr();
    const opTok = peek();
    if (opTok.type === 'punct' && ASSIGN_OPS.includes(opTok.value)) {
      next();
      const value = parseExpr({ noIn: true });
      let range = null;
      if (isIdent('in')) {
        next();
        range = parseRange();
      }
      expectPunct(';', '代入文の終わり');
      return { type: 'Assign', target: expr, op: opTok.value, value, range, pos: expr.pos };
    }
    if (expr.type === 'Call') {
      expectPunct(';', '関数呼び出しの終わり');
      return { type: 'CallStmt', call: expr, pos: expr.pos };
    }
    throw new CompileError(`文として解釈できません（代入 '=' か関数呼び出しが必要です）。次のトークン: ${describe(opTok)}`, opTok.pos);
  }

  function parseRange() {
    expectPunct('(', 'ポインタ範囲 in (開始, 終了)');
    const start = parseExpr();
    expectPunct(',', 'ポインタ範囲 in (開始, 終了)');
    const end = parseExpr();
    expectPunct(')', 'ポインタ範囲 in (開始, 終了)');
    return { start, end };
  }

  function parseIf() {
    const t = next(); // if
    expectPunct('(', 'if の条件');
    const cond = parseExpr();
    expectPunct(')', 'if の条件');
    const then = parseBlock('if');
    let otherwise = null;
    if (isIdent('else')) {
      next();
      if (isIdent('if')) otherwise = [parseIf()];
      else otherwise = parseBlock('else');
    }
    return { type: 'If', cond, then, otherwise, pos: t.pos };
  }

  // ---- 式 ----

  function parseExpr(opts = {}, minPrec = 1) {
    let left = parseUnary(opts);
    while (true) {
      const t = peek();
      if (t.type !== 'punct') break;
      const prec = BINARY_PREC[t.value];
      if (!prec || prec < minPrec) break;
      next();
      const right = parseExpr(opts, prec + 1);
      left = { type: 'Binary', op: t.value, left, right, pos: t.pos };
    }
    return left;
  }

  function isCastAhead() {
    return isPunct('(') && peek(1).type === 'ident' && peek(1).value in TYPES && isPunct('*', 2) && isPunct(')', 3);
  }

  function parseUnary(opts) {
    const t = peek();
    if (t.type === 'punct') {
      if (t.value === '*') {
        next();
        if (!isCastAhead()) {
          throw new CompileError('メモリ参照は *(型*)アドレス の形で書いてください（例: *(u32*)0x10000000）', t.pos);
        }
        next();
        const typeName = next().value;
        next();
        next();
        const addr = parseUnary(opts);
        return { type: 'Deref', valueType: typeName, addr, pos: t.pos };
      }
      if (t.value === '-' || t.value === '~' || t.value === '!' || t.value === '+') {
        next();
        const operand = parseUnary(opts);
        return { type: 'Unary', op: t.value, operand, pos: t.pos };
      }
      if (t.value === '(') {
        if (peek(1).type === 'ident' && peek(1).value in TYPES && isPunct(')', 2)) {
          throw new CompileError('値のキャストは使えません。メモリ参照は *(型*)アドレス、型変換は float(rN) / int(fN) を使ってください', t.pos);
        }
        next();
        const e = parseExpr();
        expectPunct(')', '括弧');
        return e;
      }
      if (t.value === '[') {
        next();
        const items = [];
        while (!isPunct(']')) {
          items.push(parseExpr());
          if (isPunct(',')) next();
          else if (!isPunct(']')) throw new CompileError(`',' または ']' が必要ですが ${describe(peek())} があります`, peek().pos);
        }
        next();
        return { type: 'Array', items, pos: t.pos };
      }
    }
    if (t.type === 'num') {
      next();
      return { type: 'Num', value: t.value, pos: t.pos };
    }
    if (t.type === 'str') {
      next();
      return { type: 'Str', text: t.value.text, bytes: t.value.bytes, pos: t.pos };
    }
    if (t.type === 'ident') {
      next();
      if (isPunct('(')) {
        next();
        const args = [];
        while (!isPunct(')')) {
          args.push(parseExpr());
          if (isPunct(',')) next();
          else if (!isPunct(')')) throw new CompileError(`',' または ')' が必要ですが ${describe(peek())} があります（${t.value} の引数）`, peek().pos);
        }
        next();
        return { type: 'Call', name: t.value, args, pos: t.pos };
      }
      return { type: 'Ident', name: t.value, pos: t.pos };
    }
    throw new CompileError(`式が必要ですが ${describe(t)} があります`, t.pos);
  }

  return parseProgram();
}
