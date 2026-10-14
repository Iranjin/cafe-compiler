// 各コードタイプのエンコードを TCP Gecko 2.53 ドキュメントの書式と照合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, CompileError } from '../src/index.js';

const c = (src) => compile(src).text.trim().split('\n');
const lines = (s) => s.trim().split('\n').map((l) => l.trim());

test('RAM Writes [00] 8/16/32bit', () => {
  // 00000000 LLLLLLLL / 000000VV 00000000, 00010000 / 0000VVVV, 00020000 / VVVVVVVV
  assert.deepEqual(c('*(u8*)0x10000000 = 0xAB;'), ['00000000 10000000', '000000AB 00000000']);
  assert.deepEqual(c('*(u16*)0x10000000 = 0xABCD;'), ['00010000 10000000', '0000ABCD 00000000']);
  assert.deepEqual(c('*(u32*)0x10000000 = 0x12345678;'), ['00020000 10000000', '12345678 00000000']);
  assert.deepEqual(c('*(s16*)0x10000000 = -1;'), ['00010000 10000000', '0000FFFF 00000000']);
  assert.deepEqual(c('*(f32*)0x10000000 = 1.0;'), ['00020000 10000000', '3F800000 00000000']);
});

test('README の例: if == → [03] + [00] + D0', () => {
  assert.deepEqual(
    c('if (*(u32*)0x10000000 == 1) { *(u16*)0x10000004 = 0x63; }'),
    lines(`03020000 10000000
           00000001 00000000
           00010000 10000004
           00000063 00000000
           D0000000 DEADCAFE`),
  );
});

test('比較演算子 → [03]-[08]、サイズ S', () => {
  const cases = { '==': '03', '!=': '04', '>': '05', '<': '06', '>=': '07', '<=': '08' };
  for (const [op, cc] of Object.entries(cases)) {
    assert.equal(c(`if (*(u8*)0x10 ${op} 1) { *(u8*)0x10 = 0; }`)[0], `${cc}000000 00000010`);
    assert.equal(c(`if (*(u16*)0x10 ${op} 1) { *(u8*)0x10 = 0; }`)[0], `${cc}010000 00000010`);
    assert.equal(c(`if (*(u32*)0x10 ${op} 1) { *(u8*)0x10 = 0; }`)[0], `${cc}020000 00000010`);
  }
  // 定数が左辺なら向きを反転
  assert.equal(c('if (5 < *(u32*)0x10) { *(u8*)0x10 = 0; }')[0], '05020000 00000010');
  // ! は逆の比較に置き換える
  assert.equal(c('if (!(*(u32*)0x10 == 1)) { *(u8*)0x10 = 0; }')[0], '04020000 00000010');
});

test('値フィールドの位置: 000000VV / 0000VVVV / VVVVVVVV', () => {
  assert.equal(c('if (*(u8*)0x10 == 0x12) { *(u8*)0x10 = 0; }')[1], '00000012 00000000');
  assert.equal(c('if (*(u16*)0x10 == 0x1234) { *(u8*)0x10 = 0; }')[1], '00001234 00000000');
});

test('ビット判定 → [09] AND / [0A] OR', () => {
  assert.deepEqual(c('if ((*(u32*)0x10 & 0x41) == 0x41) { *(u8*)0x10 = 0; }').slice(0, 2), ['09020000 00000010', '00000041 00000000']);
  assert.deepEqual(c('if ((*(u32*)0x10 & 0x41) != 0) { *(u8*)0x10 = 0; }').slice(0, 2), ['0A020000 00000010', '00000041 00000000']);
  assert.deepEqual(c('if (*(u16*)0x10 & 0x41) { *(u8*)0x10 = 0; }').slice(0, 2), ['0A010000 00000010', '00000041 00000000']);
  // == 0 は OR + Negate (NOR)
  assert.deepEqual(c('if ((*(u32*)0x10 & 0x41) == 0) { *(u8*)0x10 = 0; }').slice(0, 3), ['0A020000 00000010', '00000041 00000000', '0F000000 00000000']);
});

test('If Value Between [0B]: VV と WW', () => {
  assert.deepEqual(c('if (between(*(u16*)0x10, 0x10, 0x20)) { *(u8*)0x10 = 0; }').slice(0, 2), ['0B010000 00000010', '00000010 00000020']);
});

test('else → Negate [0F]、外側は D0、入れ子は D2', () => {
  assert.deepEqual(
    c('if (*(u32*)0x10 == 1) { *(u8*)0x20 = 1; } else { *(u8*)0x20 = 2; }'),
    lines(`03020000 00000010
           00000001 00000000
           00000000 00000020
           00000001 00000000
           0F000000 00000000
           00000000 00000020
           00000002 00000000
           D0000000 DEADCAFE`),
  );
  assert.deepEqual(
    c('if (*(u32*)0x10 == 1) { if (*(u8*)0x14 > 2) { *(u8*)0x20 = 1; } *(u8*)0x21 = 1; }'),
    lines(`03020000 00000010
           00000001 00000000
           05000000 00000014
           00000002 00000000
           00000000 00000020
           00000001 00000000
           D2000000 CAFEBABE
           00000000 00000021
           00000001 00000000
           D0000000 DEADCAFE`),
  );
  // 最後の入れ子は外側の D0 がまとめて閉じる
  assert.deepEqual(c('if (*(u32*)0x10 == 1) { if (*(u8*)0x14 > 2) { *(u8*)0x20 = 1; } }').slice(-1), ['D0000000 DEADCAFE']);
  assert.equal(c('if (*(u32*)0x10 == 1) { if (*(u8*)0x14 > 2) { *(u8*)0x20 = 1; } }').length, 7);
});

test('&& は条件を並べる', () => {
  assert.deepEqual(
    c('if (*(u32*)0x10 == 1 && *(u16*)0x14 != 2) { *(u8*)0x20 = 1; }'),
    lines(`03020000 00000010
           00000001 00000000
           04010000 00000014
           00000002 00000000
           00000000 00000020
           00000001 00000000
           D0000000 DEADCAFE`),
  );
});

test('Load Pointer [30] とポインタ書き込み 001SKKKK', () => {
  assert.deepEqual(
    c('pointer *(u32*)0x10A00000 in (0x10000000, 0x20000000) { *(u8*)(ptr + 4) = 1; *(u16*)(ptr + 6) = 2; *(u32*)(ptr + 8) = 3; }'),
    lines(`30000000 10A00000
           10000000 20000000
           00100004 00000001
           00110006 00000002
           00120008 00000003
           D0000000 DEADCAFE`),
  );
});

test('ポインタ条件 [03] (Pointer) は CC1S0000 KKKKKKKK', () => {
  assert.deepEqual(c('pointer *(u32*)0x10 { if (*(u32*)(ptr + 0x24) != 7) { *(u8*)ptr = 1; } }').slice(2, 4), ['04120000 00000024', '00000007 00000000']);
});

test('pointer-in-pointer 30100000 と [31]-[34]', () => {
  assert.deepEqual(
    c('pointer *(u32*)0x10 { ptr = *(u32*)(ptr + 0x10); ptr += 8; ptr += r2 + 4; ptr -= 0x20; ptr -= r3; }').slice(2, 8),
    lines(`30100000 00000010
           10000000 50000000
           31000000 00000008
           32000200 00000004
           33000000 00000020
           34000300 00000000`),
  );
});

test('連鎖ポインタ式は自動展開される', () => {
  assert.deepEqual(
    c('*(u32*)(*(u32*)(*(u32*)0x10A00000 + 0x10) + 0x30) = 5;'),
    lines(`30000000 10A00000
           10000000 50000000
           30100000 00000010
           10000000 50000000
           00120030 00000005
           D0000000 DEADCAFE`),
  );
});

test('String Writes [01] (通常/ポインタ)', () => {
  assert.deepEqual(c('write(0x10000000, [0xAA]);'), ['01000001 10000000', 'AA000000 00000000']);
  assert.deepEqual(c('write(0x10000000, "ABCDEFGH");'), ['01000008 10000000', '41424344 45464748']);
  assert.deepEqual(c('pointer *(u32*)0x10 { write(ptr + 4, "AB"); }').slice(2, 4), ['01100002 00000004', '41420000 00000000']);
});

test('Skip Writes [02]', () => {
  assert.deepEqual(c('skip_write(*(u16*)0x10000000, 0x10, 4, 2, 1);'), ['02010004 10000000', '00000010 00000002', '00000001 00000000']);
  assert.deepEqual(c('pointer *(u32*)0x10 { skip_write(*(u32*)(ptr + 8), 1, 3, 4); }').slice(2, 5), ['02120003 00000008', '00000001 00000004', '00000000 00000000']);
});

test('Memory Fill [20] / Copy [21] / Corruptor [F0]', () => {
  assert.deepEqual(c('memfill(0x10000000, 0xFF, 0x40);'), ['20000000 000000FF', '10000000 00000040']);
  assert.deepEqual(c('memcpy(0x10000000, 0x10001000, 0x40);'), ['21000000 10001000', '10000000 00000040']);
  assert.deepEqual(c('pointer *(u32*)0x10 { memfill(ptr + 4, 1, 8); }').slice(2, 4), ['20100000 00000001', '00000004 00000008']);
  assert.deepEqual(c('corrupt(0x10000000, 0x10001000, 1, 2);'), ['F0000000 10000000', '10001000 00000001', '00000002 00000000']);
});

test('Time-Dependence [0C] + D2 / Reset Timer [0D]', () => {
  assert.deepEqual(c('timer (60) { *(u8*)0x10 = 1; }'), ['0C000000 0000003C', '00000000 00000010', '00000001 00000000', 'D2000000 CAFEBABE']);
  assert.deepEqual(c('reset_timer(*(u16*)0x10000000 == 0x1234);'), ['0D001234 10000000']);
});

test('Input Conditional [0E] 0E000X0Y', () => {
  assert.equal(c('if (button(VPAD_A)) { *(u8*)0x10 = 1; }')[0], '0E000000 00008000');
  assert.equal(c('if (button(PRO_A | PRO_B, PRO, 2)) { *(u8*)0x10 = 1; }')[0], '0E000302 00000050');
  assert.equal(c('if (button(WPAD_HOME, WIIMOTE)) { *(u8*)0x10 = 1; }')[0], '0E000100 00008000');
});

test('Loop [80] / Loop Indexed [81] / Break [82] / D1', () => {
  assert.deepEqual(c('loop (5) { r0 += 1; }'), ['80000000 00000005', '14040000 00000001', 'D1000000 DEADC0DE']);
  assert.deepEqual(c('loop (r3) { break; }'), ['81000300 00000000', '82000000 00000000', 'D1000000 DEADC0DE']);
});

test('Load/Store Integer [10]/[11] (通常/ポインタ)', () => {
  assert.deepEqual(c('r3 = *(u8*)0x10; r3 = *(u16*)0x10; r3 = *(u32*)0x10;'), ['10000003 00000010', '10010003 00000010', '10020003 00000010']);
  assert.deepEqual(c('*(u8*)0x10 = r7; *(u16*)0x10 = r7; *(u32*)0x10 = r7;'), ['11000007 00000010', '11010007 00000010', '11020007 00000010']);
  assert.deepEqual(c('pointer *(u32*)0x10 { r1 = *(u16*)(ptr + 4); *(u32*)(ptr + 8) = r1; }').slice(2, 4), ['10110001 00000004', '11120001 00000008']);
});

test('Load/Store Float [12]/[13]', () => {
  assert.deepEqual(c('f2 = *(f32*)0x10; *(f32*)0x14 = f2;'), ['12000002 00000010', '13000002 00000014']);
  assert.deepEqual(c('pointer *(u32*)0x10 { f1 = *(f32*)(ptr + 4); *(f32*)(ptr + 4) = f1; }').slice(2, 4), ['12100001 00000004', '13100001 00000004']);
});

test('Integer Operations [14] 140O0R0S', () => {
  assert.deepEqual(
    c('r1 += r2; r1 -= r2; r1 *= r2; r1 /= r2; r1 += 3; r1 -= 3; r1 *= 3; r1 /= 3; r1 &= r2; r1 |= r2; r1 ^= r2; r1 &= 3; r1 |= 3; r1 ^= 3; r1 = 3;'),
    lines(`14000102 00000000
           14010102 00000000
           14020102 00000000
           14030102 00000000
           14040100 00000003
           14050100 00000003
           14060100 00000003
           14070100 00000003
           14090102 00000000
           140A0102 00000000
           140B0102 00000000
           140C0100 00000003
           140D0100 00000003
           140E0100 00000003
           140F0100 00000003`),
  );
});

test('Float Operations [15] 150O0R0S (即値は IEEE754)', () => {
  assert.deepEqual(
    c('f1 += f2; f1 -= f2; f1 *= f2; f1 /= f2; f1 += 1.0; f1 -= 1.0; f1 *= 2.0; f1 /= 2.0; f1 = 0.5;'),
    lines(`15000102 00000000
           15010102 00000000
           15020102 00000000
           15030102 00000000
           15040100 3F800000
           15050100 3F800000
           15060100 40000000
           15070100 40000000
           150F0100 3F000000`),
  );
});

test('int/float 変換', () => {
  assert.deepEqual(c('f3 = float(r2);'), ['14080203 00000000']);
  // ドキュメントの書式 150O0R0R (同じ番号) と一致
  assert.deepEqual(c('r2 = int(f2);'), ['15080202 00000000']);
});

test('Execute ASM [C0]: ドキュメントのサンプルと一致', () => {
  assert.deepEqual(c('asm { 0x3D801100, 0x38600001, 0x906C0000, 0x4E800020 }'), ['C0000002 3D801100', '38600001 906C0000', '4E800020 00000000']);
  assert.deepEqual(c('asm { 0x3D801100, 0x38600001, 0x906C0000 }'), ['C0000002 3D801100', '38600001 906C0000', '4E800020 00000000']);
});

test('C1 / C2 / C3 / C4', () => {
  assert.deepEqual(c('call(0x02000000);'), ['C1000000 02000000']);
  assert.deepEqual(c('syscall(0x12);'), ['C1000012 00000000']);
  assert.deepEqual(c('hook_lr(0x02001000) { 0x38600001, 0x4E800020 }'), ['C2000001 02001000', '38600001 4E800020']);
  assert.deepEqual(c('hook_ctr(0x02001000) { 1, 2, 3 }'), ['C3000002 02001000', '00000001 00000002', '00000003 00000000']);
  assert.deepEqual(c('asm_write(0x02001000) { 0x38600001, 0x60000000 }'), ['C4000001 02001000', '38600001 60000000']);
});

test('E0 / E1 / E2', () => {
  assert.deepEqual(c('message("Hi", 0xFF0000);'), ['E0000000 00FF0000', '48690000 00000000']);
  assert.deepEqual(c('message("ABCDEFGH");'), ['E0000000 00000000', '41424344 45464748', '00000000 00000000']);
  assert.deepEqual(c('pointer *(u32*)0x10 { message(ptr, 0x00FF00); }').slice(2, 3), ['E1000000 0000FF00']);
  assert.deepEqual(c('clear_message();'), ['E2000000 00000000']);
});

test('const と定数式', () => {
  assert.deepEqual(c('const A = 0x10000000; const B = A + 0x10 * 2; *(u32*)(B + 4) = (1 << 4) | 1;'), ['00020000 10000024', '00000011 00000000']);
});

test('エラー: 位置とメッセージ', () => {
  const err = (src) => {
    try {
      compile(src);
    } catch (e) {
      assert.ok(e instanceof CompileError, `CompileError ではない: ${e}`);
      return e;
    }
    assert.fail(`エラーにならない: ${src}`);
  };
  assert.match(err('*(u8*)0x10 = 0x100;').message, /u8/);
  assert.deepEqual(err('\n  *(u8*)0x10 = 0x100;').pos, { line: 2, col: 16 });
  assert.match(err('if (*(u32*)0x10 == 1 || *(u32*)0x14 == 1) { *(u8*)0 = 1; }').message, /\|\|/);
  assert.match(err('r256 = 1;').message, /r256/);
  assert.match(err('*(u32*)(ptr + 4) = 1;').message, /pointer/);
  assert.match(err('if (r0 == 1) { *(u8*)0 = 1; }').message, /レジスタ/);
  assert.match(err('loop (2) { loop (2) { r0 += 1; } }').message, /入れ子/);
  assert.match(err('break;').message, /loop/);
  assert.match(err('*(u32*)0x10 += 1;').message, /\+=/);
  assert.match(err('*(u32*)0x10 = 1').message, /';'/);
  assert.match(err('if (*(u32*)0x10 == 1) { pointer *(u32*)0x20 { *(u8*)ptr = 1; } *(u8*)0 = 1; }').message, /D0/);
  assert.match(err('if (*(u32*)0x10 == 1 && *(u32*)0x14 == 1) { *(u8*)0 = 1; } else { *(u8*)0 = 2; }').message, /else/);
  assert.match(err('pointer *(u32*)0x10 { *(u32*)(ptr + 0x10000) = 1; }').message, /0xFFFF/);
  assert.match(err('const X = 1; const X = 2;').message, /すでに/);
  assert.match(err('*(u32*)UNKNOWN = 1;').message, /未定義/);
  assert.match(err('if (*(f32*)0x10 > 1.0) { *(u8*)0 = 1; }').message, /f32/);
});

test('Execute ASM [C0]: blr / bctr / b で終わるなら blr を足さない', () => {
  assert.deepEqual(c('asm { 0x7D8903A6, 0x4E800420 }'), ['C0000001 7D8903A6', '4E800420 00000000']);
  assert.deepEqual(c('asm { 0x38600001, 0x48000010 }'), ['C0000001 38600001', '48000010 00000000']);
  // bctrl / bl は戻ってくるので blr を足す
  assert.deepEqual(c('asm { 0x4E800421 }'), ['C0000001 4E800421', '4E800020 00000000']);
});

test('レジスタ番号 8 以上: バイト欄にそのまま入れ、警告を出す', () => {
  const r = compile('r8 = *(u32*)0x10; r25 += r9; f16 = float(r40); *(u32*)0x14 = r8; loop (r8) { }');
  assert.deepEqual(r.text.trim().split('\n'), ['10020008 00000010', '14001909 00000000', '14082810 00000000', '11020008 00000014', '81000800 00000000', 'D1000000 DEADC0DE']);
  assert.deepEqual(r.warnings.map((w) => w.message.split(':')[0]), ['r8', 'r25', 'r9', 'f16', 'r40']);
});
