#!/usr/bin/env node
// コマンドライン: decompile codes.txt -o out.cafe

import { readFileSync, writeFileSync } from 'node:fs';
import { decompile, formatDiagnostic, CompileError } from '../src/index.js';

const USAGE = `使い方: decompile <コード.txt> [-o 出力.cafe]

  -o, --output <file>  出力ファイル (省略時は標準出力)
  -h, --help           このヘルプを表示`;

function main(argv) {
  let input = null;
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    } else if (a === '-o' || a === '--output') {
      output = argv[++i];
      if (!output) return usageError('-o の後に出力ファイル名が必要です');
    } else if (a.startsWith('-') && a !== '-') {
      return usageError(`不明なオプション: ${a}`);
    } else if (input === null) {
      input = a;
    } else {
      return usageError(`入力ファイルは 1 つだけ指定してください: ${a}`);
    }
  }
  if (input === null) return usageError('入力ファイルを指定してください');

  let text;
  try {
    text = readFileSync(input === '-' ? 0 : input, 'utf8');
  } catch (e) {
    console.error(`エラー: 入力ファイル '${input}' を読み込めません (${e.code ?? e.message})`);
    return 1;
  }

  let result;
  try {
    result = decompile(text);
  } catch (e) {
    if (e instanceof CompileError) {
      console.error(formatDiagnostic('error', e, text, input));
      return 1;
    }
    throw e;
  }
  for (const w of result.warnings) console.error(formatDiagnostic('warning', w, text, input));

  if (output) {
    try {
      writeFileSync(output, result.source);
    } catch (e) {
      console.error(`エラー: 出力ファイル '${output}' に書き込めません (${e.code ?? e.message})`);
      return 1;
    }
    console.error(`${input} → ${output}`);
  } else {
    process.stdout.write(result.source);
  }
  return 0;
}

function usageError(msg) {
  console.error(`エラー: ${msg}\n\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
