// 字句解析器。トークン: num / str / ident / punct / eof

import { CompileError } from './errors.js';

const PUNCTS = [
  '<<=', '>>=',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+=', '-=', '*=', '/=', '&=', '|=', '^=',
  '(', ')', '{', '}', '[', ']', ',', ';', '=', '<', '>', '!',
  '+', '-', '*', '/', '%', '&', '|', '^', '~',
];

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance();
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = { line, col };
      advance(2);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance();
      if (i >= src.length) throw new CompileError('ブロックコメント /* が閉じられていません', start);
      advance(2);
      continue;
    }

    const pos = { line, col };

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      tokens.push(lexNumber(pos));
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const text = src.slice(i, j);
      advance(j - i);
      tokens.push({ type: 'ident', value: text, pos });
      continue;
    }
    if (c === '"') {
      tokens.push(lexString(pos));
      continue;
    }
    const p = PUNCTS.find((s) => src.startsWith(s, i));
    if (p) {
      advance(p.length);
      tokens.push({ type: 'punct', value: p, pos });
      continue;
    }
    throw new CompileError(`不明な文字 '${c}' です`, pos);
  }
  tokens.push({ type: 'eof', value: '<EOF>', pos: { line, col } });
  return tokens;

  function lexNumber(pos) {
    let j = i;
    let text;
    if (src[j] === '0' && /[xX]/.test(src[j + 1] ?? '')) {
      j += 2;
      while (j < src.length && /[0-9A-Fa-f_]/.test(src[j])) j++;
      text = src.slice(i, j).replace(/_/g, '');
      if (text.length <= 2) throw new CompileError('16進数リテラルに桁がありません', pos);
      checkTail(j, pos);
      advance(j - i);
      return { type: 'num', value: { kind: 'int', v: BigInt(text) }, pos };
    }
    if (src[j] === '0' && /[bB]/.test(src[j + 1] ?? '')) {
      j += 2;
      while (j < src.length && /[01_]/.test(src[j])) j++;
      text = src.slice(i, j).replace(/_/g, '');
      if (text.length <= 2) throw new CompileError('2進数リテラルに桁がありません', pos);
      checkTail(j, pos);
      advance(j - i);
      return { type: 'num', value: { kind: 'int', v: BigInt(text) }, pos };
    }
    let isFloat = false;
    while (j < src.length && /[0-9_]/.test(src[j])) j++;
    if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
      isFloat = true;
      j++;
      while (j < src.length && /[0-9_]/.test(src[j])) j++;
    } else if (src[j] === '.' && !/[A-Za-z_.]/.test(src[j + 1] ?? '')) {
      isFloat = true; // "1." 形式
      j++;
    }
    if (/[eE]/.test(src[j] ?? '') && /[-+0-9]/.test(src[j + 1] ?? '')) {
      isFloat = true;
      j++;
      if (src[j] === '+' || src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
    }
    text = src.slice(i, j).replace(/_/g, '');
    if (src[j] === 'f' || src[j] === 'F') {
      isFloat = true;
      j++;
    }
    checkTail(j, pos);
    advance(j - i);
    if (isFloat) return { type: 'num', value: { kind: 'float', v: Number(text) }, pos };
    return { type: 'num', value: { kind: 'int', v: BigInt(text) }, pos };
  }

  function checkTail(j, pos) {
    if (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
      throw new CompileError(`数値リテラルの後に不正な文字 '${src[j]}' があります`, pos);
    }
  }

  function lexString(pos) {
    advance(); // "
    const bytes = [];
    let text = '';
    const enc = new TextEncoder();
    while (true) {
      if (i >= src.length || src[i] === '\n') throw new CompileError('文字列リテラルが閉じられていません', pos);
      const ch = src[i];
      if (ch === '"') {
        advance();
        break;
      }
      if (ch === '\\') {
        const e = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"' };
        if (e in map) {
          bytes.push(...enc.encode(map[e]));
          text += map[e];
          advance(2);
        } else if (e === 'x' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 2, i + 4))) {
          const b = parseInt(src.slice(i + 2, i + 4), 16);
          bytes.push(b);
          text += String.fromCharCode(b);
          advance(4);
        } else {
          throw new CompileError(`不明なエスケープシーケンス '\\${e ?? ''}' です`, { line, col });
        }
        continue;
      }
      const cp = src.codePointAt(i);
      const chs = String.fromCodePoint(cp);
      bytes.push(...enc.encode(chs));
      text += chs;
      advance(chs.length);
    }
    return { type: 'str', value: { text, bytes }, pos };
  }
}
