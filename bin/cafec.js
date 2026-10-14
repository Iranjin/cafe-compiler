#!/usr/bin/env node
// コマンドライン: cafec input.cafe -o out.txt

import { readFileSync, writeFileSync } from 'node:fs';
import { compile, listing, formatDiagnostic, CompileError } from '../src/index.js';

const USAGE = `使い方: compile <入力.cafe> [-o 出力.txt] [--listing]

  -o, --output <file>  出力ファイル (省略時は標準出力)
  -l, --listing        各コード行にソース行をコメントとして付ける (確認用。TCPGecko には貼り付けないでください)
  -h, --help           このヘルプを表示`;

function main(argv) {
  let input = null;
  let output = null;
  let withListing = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    } else if (a === '-o' || a === '--output') {
      output = argv[++i];
      if (!output) return usageError('-o の後に出力ファイル名が必要です');
    } else if (a === '-l' || a === '--listing') {
      withListing = true;
    } else if (a.startsWith('-') && a !== '-') {
      return usageError(`不明なオプション: ${a}`);
    } else if (input === null) {
      input = a;
    } else {
      return usageError(`入力ファイルは 1 つだけ指定してください: ${a}`);
    }
  }
  if (input === null) return usageError('入力ファイルを指定してください');

  let source;
  try {
    source = readFileSync(input === '-' ? 0 : input, 'utf8');
  } catch (e) {
    console.error(`エラー: 入力ファイル '${input}' を読み込めません (${e.code ?? e.message})`);
    return 1;
  }

  let result;
  try {
    result = compile(source);
  } catch (e) {
    if (e instanceof CompileError) {
      console.error(formatDiagnostic('error', e, source, input));
      return 1;
    }
    throw e;
  }
  for (const w of result.warnings) console.error(formatDiagnostic('warning', w, source, input));

  const text = withListing ? listing(source, result.lines) : result.text;
  if (output) {
    try {
      writeFileSync(output, text);
    } catch (e) {
      console.error(`エラー: 出力ファイル '${output}' に書き込めません (${e.code ?? e.message})`);
      return 1;
    }
    console.error(`${input} → ${output} (${result.lines.length} 行)`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

function usageError(msg) {
  console.error(`エラー: ${msg}\n\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
