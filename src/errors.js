// コンパイルエラーと診断メッセージの整形。

export class CompileError extends Error {
  /**
   * @param {string} message 日本語のエラーメッセージ
   * @param {{line:number,col:number}|undefined} pos ソース上の位置
   * @param {string} [hint] 修正のヒント
   */
  constructor(message, pos, hint) {
    super(message);
    this.name = 'CompileError';
    this.pos = pos;
    this.hint = hint;
  }
}

/**
 * エラーを `file:line:col: エラー: ...` 形式に整形し、該当行とキャレットを添える。
 */
export function formatDiagnostic(kind, err, source, file = '<input>') {
  const label = kind === 'warning' ? '警告' : 'エラー';
  const pos = err.pos;
  let out = pos ? `${file}:${pos.line}:${pos.col}: ${label}: ${err.message}` : `${file}: ${label}: ${err.message}`;
  if (pos && source != null) {
    const lineText = source.split(/\r?\n/)[pos.line - 1];
    if (lineText !== undefined) {
      const gutter = String(pos.line).padStart(4) + ' | ';
      out += '\n' + gutter + lineText;
      out += '\n' + ' '.repeat(gutter.length - 2) + '| ' + ' '.repeat(Math.max(0, pos.col - 1)) + '^';
    }
  }
  if (err.hint) out += `\n  ヒント: ${err.hint}`;
  return out;
}
