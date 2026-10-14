import { compile, listing, decompile, formatDiagnostic, CompileError } from '../src/index.js';
import { EXAMPLES } from './examples.js';

const STORAGE_KEY = 'cafe-compiler:v1';
const $ = (id) => document.getElementById(id);

const source = $('source');
const code = $('code');
const listingBox = $('listing');
const exampleSelect = $('example');

const panes = {
  source: { textarea: source, diag: $('source-diag'), file: 'source.cafe', errorLines: new Set() },
  code: { textarea: code, diag: $('code-diag'), file: 'code.txt', errorLines: new Set() },
};

function runCompile() {
  const text = source.value;
  try {
    const result = compile(text);
    code.value = listingBox.checked ? listing(text, result.lines) : result.text;
    showDiagnostics(panes.source, text, result.warnings);
    showDiagnostics(panes.code, '', []);
  } catch (e) {
    showDiagnostics(panes.source, text, [], e);
  }
  save();
}

function runDecompile() {
  const text = code.value;
  try {
    const result = decompile(text);
    source.value = result.source;
    showDiagnostics(panes.code, text, result.warnings);
    showDiagnostics(panes.source, '', []);
  } catch (e) {
    showDiagnostics(panes.code, text, [], e);
  }
  save();
}

function showDiagnostics(pane, text, warnings, error) {
  const items = warnings.map((w) => ({ kind: 'warning', err: w }));
  if (error) {
    if (!(error instanceof CompileError)) console.error(error);
    const err = error instanceof CompileError ? error : { message: `内部エラー: ${error.message}` };
    items.unshift({ kind: 'error', err });
  }

  pane.errorLines.clear();
  pane.diag.replaceChildren(
    ...items.map(({ kind, err }) => {
      const li = document.createElement('li');
      li.className = kind;
      li.textContent = formatDiagnostic(kind, err, text, pane.file);
      if (err.pos) {
        li.dataset.line = err.pos.line;
        li.dataset.col = err.pos.col ?? 1;
        if (kind === 'error') pane.errorLines.add(err.pos.line);
      }
      return li;
    }),
  );
  updateGutter(pane);
}

function jumpTo(textarea, line, col) {
  const lines = textarea.value.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  const lineLen = lines[line - 1]?.length ?? 0;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(offset + Math.min(col - 1, lineLen), offset + lineLen);
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
  textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

function updateGutter(pane) {
  const gutter = pane.textarea.parentElement.querySelector('.gutter');
  const count = pane.textarea.value.split('\n').length;
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= count; n++) {
    if (pane.errorLines.has(n)) {
      const span = document.createElement('span');
      span.className = 'err';
      span.textContent = n;
      frag.append(span, '\n');
    } else {
      frag.append(n + '\n');
    }
  }
  // Extra line so the gutter can scroll as far as the textarea with a horizontal scrollbar.
  frag.append('\n');
  gutter.replaceChildren(frag);
  gutter.scrollTop = pane.textarea.scrollTop;
}

async function copyText(text, button) {
  await navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = 'コピーしました';
  setTimeout(() => (button.textContent = label), 1200);
}

async function loadExample(file) {
  const res = await fetch(new URL(`../examples/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`${file} を読み込めません (${res.status})`);
  source.value = await res.text();
  runCompile();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ source: source.value, code: code.value, listing: listingBox.checked }));
  } catch {}
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s) return false;
    source.value = s.source ?? '';
    code.value = s.code ?? '';
    listingBox.checked = !!s.listing;
    return true;
  } catch {
    return false;
  }
}

const showError = (e) => showDiagnostics(panes.source, '', [], e);

for (const ex of EXAMPLES) exampleSelect.add(new Option(ex.title, ex.file));
exampleSelect.addEventListener('change', () => {
  if (!exampleSelect.value) return;
  loadExample(exampleSelect.value).catch(showError);
  exampleSelect.value = '';
});

$('copy-source').addEventListener('click', (e) => copyText(source.value, e.currentTarget));
$('copy-code').addEventListener('click', (e) => copyText(code.value, e.currentTarget));
listingBox.addEventListener('change', runCompile);

const converters = { source: runCompile, code: runDecompile };
// Shared timer so a pending conversion from one pane never overwrites edits in the other.
let timer;

for (const [name, pane] of Object.entries(panes)) {
  const ta = pane.textarea;
  const gutter = ta.parentElement.querySelector('.gutter');
  ta.addEventListener('scroll', () => (gutter.scrollTop = ta.scrollTop));
  ta.addEventListener('input', () => {
    updateGutter(pane);
    clearTimeout(timer);
    timer = setTimeout(converters[name], 300);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  pane.diag.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-line]');
    if (li) jumpTo(ta, +li.dataset.line, +li.dataset.col);
  });
}

if (restore()) {
  updateGutter(panes.source);
  updateGutter(panes.code);
} else {
  loadExample(EXAMPLES[0].file).catch(showError);
}
