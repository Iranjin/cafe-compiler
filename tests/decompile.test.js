// 逆コンパイラのテスト: compile → decompile → compile で同一のコードになること、
// 構文に戻せないコードは raw(...) に落ちることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { compile, decompile, CompileError } from '../src/index.js';

function roundTrip(src) {
  const first = compile(src).text;
  const { source, warnings } = decompile(first);
  assert.deepEqual(warnings, [], `警告が出ました:\n${source}`);
  const second = compile(source).text;
  assert.equal(second, first, `再コンパイル結果が一致しません。逆コンパイル結果:\n${source}`);
  return source;
}

const sources = [];
for (const dir of ['../examples/', './fixtures/']) {
  const url = new URL(dir, import.meta.url);
  for (const f of readdirSync(url).filter((n) => n.endsWith('.cafe'))) sources.push([dir + f, readFileSync(new URL(f, url), 'utf8')]);
}
for (const [name, src] of sources) {
  test(`round-trip: ${name}`, () => roundTrip(src));
}

test('README の例を逆コンパイル', () => {
  const out = decompile('03020000 10000000\n00000001 00000000\n00010000 10000004\n00000063 00000000\nD0000000 DEADCAFE\n').source;
  assert.equal(out, 'if (*(u32*)0x10000000 == 1) {\n    *(u16*)0x10000004 = 0x63;\n}\n');
});

test('round-trip: 条件の各形', () => {
  const cases = [
    'if (*(u32*)0x10 == 1) { } else { *(u8*)0x20 = 1; }',
    'if (!button(VPAD_A)) { *(u8*)0x20 = 1; } else { *(u8*)0x20 = 2; }',
    'if (!between(*(u8*)0x10, 1, 5)) { *(u8*)0x20 = 1; }',
    'if ((*(u32*)0x10 & 6) != 6) { *(u8*)0x20 = 1; }',
    'if (*(u32*)0x10 == 1) { if (*(u32*)0x14 == 2) { *(u8*)0x20 = 1; } *(u8*)0x21 = 1; } *(u8*)0x22 = 1;',
    'if (*(u32*)0x10 == 1) { if (*(u32*)0x14 == 2) { *(u8*)0x20 = 1; } else { *(u8*)0x20 = 3; } }',
    'if (*(u32*)0x10 == 1) { pointer *(u32*)0x30 { if (*(u8*)(ptr + 1) == 2) { *(u8*)ptr = 1; } *(u8*)ptr = 2; } }',
    'loop (4) { if (*(u32*)0x10 == 1) { *(u8*)0x20 = 1; } pointer *(u32*)0x30 { *(u8*)ptr = 1; } r0 += 1; }',
    'timer (30) { if (*(u8*)0x10 > 1) { *(u8*)0x10 = 1; } }',
    'pointer *(u32*)0x30 in (0x20000000, 0x30000000) { ptr = *(u32*)(ptr - 8); ptr = *(u32*)0x10000000 in (1, 2); message(ptr); }',
    'f0 = -0.0; f1 = 0.1; f2 = 3.4028234663852886e38; f3 /= 1e-7; r0 = 0xFFFFFFFF; r1 /= r2;',
    'write(0x10, "日本語\\n\\"x\\""); write(0x20, [0, 1, 0xFF]); message("é\\x01");',
    'hook_ctr(0x02000000) { 1, 2, 3 } asm_write(0x02000000) { 1 } asm { 0x60000000 }',
    'if (button(PRO_A, PRO, 3)) { r0 = 1; } if (button(NUNCHUK_C | NUNCHUK_Z, NUNCHUK)) { r0 = 2; }',
  ];
  for (const c of cases) roundTrip(c);
});

test('不明・書式外のコードは raw(...) になり、内容は保たれる', () => {
  const text = [
    '77000000 12345678', // 不明なコードタイプ
    '00100004 00000001', // ポインタ未読込のポインタ書き込み
    '00000000 10000000', // 8bit 書き込みだが値フィールドの上位ビットが立っている
    '0000FFFF 00000000',
    '82000000 00000000', // ループ外の break
    'D2000000 CAFEBABE', // 閉じる条件のない D2
  ].join('\n');
  const { source, warnings } = decompile(text);
  assert.deepEqual(warnings, []);
  assert.match(source, /raw\(0x77000000, 0x12345678\);\s+\/\/ 不明なコードタイプ \[77\]/);
  assert.match(source, /raw\(0x00100004, 0x00000001\);\s+\/\/ \[00\] ポインタ版/);
  assert.equal((source.match(/raw\(/g) || []).length, 6);
  assert.equal(compile(source).text.trim(), text);
});

test('入れ子ループは raw に落とし、構造を壊さない', () => {
  const text = '80000000 00000002\n80000000 00000003\n14040000 00000001\nD1000000 DEADC0DE\nD1000000 DEADC0DE';
  const { source, warnings } = decompile(text);
  assert.deepEqual(warnings, []);
  assert.match(source, /^loop \(2\) \{/);
  assert.equal(compile(source).text.trim(), text);
});

test('手書きコード: 終端の省略形や不足は警告付きで変換', () => {
  // 下位ワード 00000000 の D0 (ドキュメント上は許される)
  let r = decompile('03020000 10000000\n00000001 00000000\nD0000000 00000000');
  assert.match(r.source, /if \(\*\(u32\*\)0x10000000 == 1\) \{\n\}/);
  assert.ok(r.warnings.some((w) => /DEADCAFE/.test(w.message)));
  // 終端の無い条件
  r = decompile('03020000 10000000\n00000001 00000000\n00020000 10000004\n00000001 00000000');
  assert.ok(r.warnings.some((w) => /終端コードのないブロック/.test(w.message)));
  // 行が足りない
  r = decompile('00020000 10000000');
  assert.match(r.source, /raw\(0x00020000, 0x10000000\)/);
});

test('入力形式: コメント・空行・区切りなしを許容し、不正な行はエラー', () => {
  const r = decompile('# comment\n\n00000000 10000000  # write\n000000ff00000000\n');
  assert.equal(r.source, '*(u8*)0x10000000 = 0xFF;\n');
  assert.throws(() => decompile('00000000 1000\n'), (e) => e instanceof CompileError && e.pos.line === 1 && /形式が不正/.test(e.message));
});

// 乱数で文を組み合わせたプログラムで round-trip を確認する
test('round-trip: ランダム生成プログラム', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const pick = (a) => a[rnd(a.length)];
  const types = ['u8', 'u16', 'u32'];
  const addr = () => `0x${(0x10000000 + rnd(0x1000) * 4).toString(16)}`;
  const val = (t) => rnd({ u8: 256, u16: 65536, u32: 2 ** 31 }[t]);
  const mem = (inPtr) => {
    const t = pick(types);
    return [t, inPtr && rnd(2) ? `*(${t}*)(ptr + ${rnd(0x100)})` : `*(${t}*)${addr()}`];
  };
  const cond = (inPtr) => {
    const [t, m] = mem(inPtr);
    switch (rnd(5)) {
      case 0: return `between(${m}, ${val(t)}, ${val(t)})`;
      case 1: return `(${m} & ${val(t) || 1}) != 0`;
      case 2: return `button(VPAD_A | VPAD_X)`;
      default: return `${m} ${pick(['==', '!=', '<', '>', '<=', '>='])} ${val(t)}`;
    }
  };
  const simple = (inPtr) => {
    const [t, m] = mem(inPtr);
    switch (rnd(8)) {
      case 0: return `r${rnd(8)} = ${m};`;
      case 1: return `${m} = r${rnd(8)};`;
      case 2: return `r${rnd(8)} ${pick(['+', '-', '*', '&', '|', '^'])}= ${rnd(1000)};`;
      case 3: return `f${rnd(8)} ${pick(['+', '-', '*', '/'])}= f${rnd(8)};`;
      case 4: return inPtr ? `ptr += ${rnd(64)};` : `write(${addr()}, "abc");`;
      default: return `${m} = ${val(t)};`;
    }
  };
  const block = (depth, inPtr, inLoop) => {
    const out = [];
    const n = 1 + rnd(4);
    for (let k = 0; k < n; k++) {
      const r = depth > 2 ? 9 : rnd(10);
      if (r < 3) {
        const els = rnd(3) === 0 ? ` else { ${block(depth + 1, inPtr, inLoop)} }` : '';
        out.push(`if (${cond(inPtr)}) { ${block(depth + 1, inPtr, inLoop)} }${els}`);
      } else if (r === 3 && !inLoop) out.push(`loop (${1 + rnd(5)}) { ${block(depth + 1, inPtr, true)} }`);
      else if (r === 4) out.push(`timer (${rnd(1000)}) { ${block(depth + 1, inPtr, inLoop)} }`);
      else out.push(simple(inPtr));
    }
    return out.join(' ');
  };
  let tried = 0;
  for (let k = 0; k < 300; k++) {
    const src = rnd(3) === 0 ? `pointer *(u32*)${addr()} { ${block(1, true, false)} }` : block(0, false, false);
    try {
      compile(src);
    } catch (e) {
      if (e instanceof CompileError) continue; // 生成器が作った不正な組み合わせは対象外
      throw e;
    }
    tried++;
    roundTrip(src);
  }
  assert.ok(tried > 200, `有効なプログラムが少なすぎます: ${tried}`);
});

test('C0: bctr で終わる実際のコードを asm に戻す (blr を足さない)', () => {
  const text = readFileSync(new URL('./fixtures/c0_bctr.txt', import.meta.url), 'utf8');
  const { source, warnings } = decompile(text);
  assert.deepEqual(warnings, []);
  assert.doesNotMatch(source, /raw\(/);
  assert.match(source, /^asm \{\n    0x60000000,  \/\/ nop\n    0x9421FFE0,  \/\/ stwu r1, -0x20\(r1\)/);
  assert.match(source, /    0x4E800420   \/\/ bctr\n\}\n$/);
  assert.equal(compile(source).text, text);
});

test('C0/C2: 逆アセンブル結果をコメントに付ける', () => {
  const src = decompile('C2000001 02001000\n38600001 4E800020').source;
  assert.equal(src, 'hook_lr(0x02001000) {\n    0x38600001,  // li r3, 1\n    0x4E800020   // blr\n}\n');
});

test('構文に戻せない複数行コードは、データ行ごと raw にする', () => {
  // 末尾が分岐でない C0 (コンパイラは blr を足すので構文で表せない)
  const text = 'C0000001 38600001\nD0000000 00000000\n00020000 10000000\n00000001 00000000';
  const { source, warnings } = decompile(text);
  assert.deepEqual(warnings, []);
  assert.match(source, /raw\(0xC0000001, 0x38600001\);  \/\/ \[C0\] .*このコードは 2 行/);
  assert.match(source, /raw\(0xD0000000, 0x00000000\);\n/); // データ行を D0 として扱わない
  assert.match(source, /\*\(u32\*\)0x10000000 = 1;/);
  assert.equal(compile(source).text.trim(), text);
});

test('レジスタ番号 8 以上も構文に戻す (警告付き)', () => {
  const text = '30000000 10A00000\n10000000 50000000\n10120008 000001F8\n10120019 0000029C\n11120008 00000010\nD0000000 DEADCAFE';
  const { source, warnings } = decompile(text);
  assert.doesNotMatch(source, /raw\(/);
  assert.match(source, /r8 = \*\(u32\*\)\(ptr \+ 0x1F8\);/);
  assert.match(source, /r25 = \*\(u32\*\)\(ptr \+ 0x29C\);/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /r8, r25/);
  assert.equal(compile(source).text.trim(), text);
});
