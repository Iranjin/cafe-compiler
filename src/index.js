// コンパイラの公開 API。

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { generate } from './codegen.js';
import { formatLine } from './encoder.js';

export { CompileError, formatDiagnostic } from './errors.js';
export { decompile, parseCodeText } from './decompiler.js';

/**
 * ソースをコンパイルする。
 * @returns {{ lines: {line:[number,number], pos:object}[], text: string, warnings: {message:string,pos:object}[] }}
 * @throws {CompileError}
 */
export function compile(source) {
  const ast = parse(tokenize(source));
  const { lines, warnings } = generate(ast);
  const text = lines.map((l) => formatLine(l.line)).join('\n') + (lines.length ? '\n' : '');
  return { lines, text, warnings };
}

/** 各コード行の後ろにソース行をコメントとして付けたリストを作る */
export function listing(source, lines) {
  const srcLines = source.split(/\r?\n/);
  let lastLine = -1;
  return (
    lines
      .map((l) => {
        const code = formatLine(l.line);
        const n = l.pos?.line;
        if (n === undefined || n === lastLine) return code;
        lastLine = n;
        return `${code}    # ${n}: ${srcLines[n - 1].trim()}`;
      })
      .join('\n') + (lines.length ? '\n' : '')
  );
}
