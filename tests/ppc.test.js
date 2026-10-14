// PowerPC 逆アセンブラ (逆コンパイル結果のコメント用)。期待値は powerpc-eabi-objdump の出力に合わせている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disassemble } from '../src/ppc.js';

test('代表的な命令', () => {
  const cases = {
    0x60000000: 'nop',
    0x9421ffe0: 'stwu r1, -0x20(r1)',
    0x3d200316: 'lis r9, 0x316',
    0x61296818: 'ori r9, r9, 0x6818',
    0x7c0802a6: 'mflr r0',
    0x7c0803a6: 'mtlr r0',
    0x7d2903a6: 'mtctr r9',
    0x4e800421: 'bctrl',
    0x4e800420: 'bctr',
    0x4e800020: 'blr',
    0x80630034: 'lwz r3, 0x34(r3)',
    0x2c030000: 'cmpwi r3, 0',
    0x28030010: 'cmplwi r3, 0x10',
    0x41820028: 'beq +0x28',
    0x4082fff0: 'bne -0x10',
    0x38600000: 'li r3, 0',
    0x3863ffff: 'addi r3, r3, -1',
    0x7c7f1b78: 'mr r31, r3',
    0x7c632214: 'add r3, r3, r4',
    0x7c6321d6: 'mullw r3, r3, r4',
    0x5463103a: 'slwi r3, r3, 2',
    0x5463e8fe: 'srwi r3, r3, 3',
    0x48000011: 'bl +0x10',
    0x4bfffff0: 'b -0x10',
    0xc0230004: 'lfs f1, 4(r3)',
    0xec21102a: 'fadds f1, f1, f2',
    0xfc20081e: 'fctiwz f1, f1',
    0x7c0060ac: 'dcbf 0, r12',
    0x44000002: 'sc',
    0x00000000: '.long 0x00000000',
  };
  for (const [w, want] of Object.entries(cases)) assert.equal(disassemble(Number(w)), want, `0x${Number(w).toString(16)}`);
});
