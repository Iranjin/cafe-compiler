// examples/*.cafe のコンパイル結果が同梱の .txt と一致することを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../src/index.js';

const dir = new URL('../examples/', import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith('.cafe'))) {
  test(`examples/${f}`, () => {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const expected = readFileSync(new URL(f.replace(/\.cafe$/, '.txt'), dir), 'utf8');
    assert.equal(compile(src).text, expected);
  });
}
