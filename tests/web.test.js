// index.html から辿れるモジュールがブラウザでそのまま読めることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { EXAMPLES } from '../web/examples.js';

const root = new URL('../', import.meta.url);

function moduleGraph() {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const entries = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => new URL(m[1], root));
  assert.ok(entries.length > 0, 'index.html にモジュールがありません');
  const seen = new Map();
  const visit = (url) => {
    if (seen.has(url.href)) return;
    assert.ok(existsSync(url), `${url.pathname} が見つかりません`);
    const text = readFileSync(url, 'utf8');
    seen.set(url.href, text);
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^\.\.?\//, `${url.pathname}: '${m[1]}' はブラウザで解決できません`);
      visit(new URL(m[1], url));
    }
  };
  entries.forEach(visit);
  return seen;
}

test('index.html のモジュールは相対 import のみで Node 専用 API を使わない', () => {
  const graph = moduleGraph();
  assert.ok([...graph.keys()].some((k) => k.endsWith('/src/index.js')));
  for (const [href, text] of graph) {
    const code = text.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(require\s*\(|process\.|Buffer\b|__dirname|import\.meta\.(dirname|filename))/, href);
  }
});

test('src/index.js はブラウザ用の公開 API を持つ', async () => {
  const api = await import('../src/index.js');
  for (const name of ['compile', 'listing', 'decompile', 'formatDiagnostic', 'CompileError']) {
    assert.equal(typeof api[name], 'function', name);
  }
});

test('サンプル一覧が examples/*.cafe と一致する', () => {
  const files = readdirSync(new URL('examples/', root)).filter((n) => n.endsWith('.cafe')).sort();
  assert.deepEqual(EXAMPLES.map((e) => e.file).sort(), files);
});
