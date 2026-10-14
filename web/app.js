import { compile, listing, decompile, formatDiagnostic, CompileError } from '../src/index.js';
import { EXAMPLES } from './examples.js';

const STORAGE_KEY = 'cafe-compiler:v1';
const $ = (id) => document.getElementById(id);

const source = $('source');
const code = $('code');
const listingBox = $('listing');
const autoBox = $('auto');
const exampleSelect = $('example');

const panes = {
  source: { textarea: source, diag: $('source-diag'), file: 'source.cafe', marks: new Map() },
  code: { textarea: code, diag: $('code-diag'), file: 'code.txt', marks: new Map() },
};

function runCompile() {
  const text = source.value;
  try {
    const result = compile(text);
    code.value = listingBox.checked ? listing(text, result.lines) : result.text;
    showDiagnostics(panes.source, text, result.warnings, null, `コンパイル成功 (${result.lines.length} 行)`);
    clearDiagnostics(panes.code);
    updateGutter(panes.code);
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
    showDiagnostics(panes.code, text, result.warnings, null, '逆コンパイル成功');
    clearDiagnostics(panes.source);
    updateGutter(panes.source);
  } catch (e) {
    showDiagnostics(panes.code, text, [], e);
  }
  save();
}

function showDiagnostics(pane, text, warnings, error, okMessage) {
  clearDiagnostics(pane);
  const items = [];
  if (error) {
    const isCompileError = error instanceof CompileError;
    const err = isCompileError ? error : { message: `内部エラー: ${error.message}` };
    if (!isCompileError) console.error(error);
    items.push({ kind: 'error', err });
  }
  for (const w of warnings) items.push({ kind: 'warning', err: w });

  for (const { kind, err } of items) {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = formatDiagnostic(kind, err, text, pane.file);
    if (err.pos) {
      li.dataset.line = err.pos.line;
      li.dataset.col = err.pos.col ?? 1;
      li.title = 'クリックで該当行へ移動';
      if (pane.marks.get(err.pos.line) !== 'err') pane.marks.set(err.pos.line, kind === 'error' ? 'err' : 'warn');
    }
    pane.diag.append(li);
  }
  if (!error && okMessage) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = warnings.length ? `${okMessage} / 警告 ${warnings.length} 件` : okMessage;
    pane.diag.prepend(li);
  }
  updateGutter(pane);
  const first = pane.diag.querySelector('li[data-line]');
  if (error && first) jumpTo(pane.textarea, +first.dataset.line, +first.dataset.col);
}

function clearDiagnostics(pane) {
  pane.diag.replaceChildren();
  pane.marks.clear();
}

function jumpTo(textarea, line, col) {
  const lines = textarea.value.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  const lineLen = lines[line - 1]?.length ?? 0;
  const start = offset + Math.min(col - 1, lineLen);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, offset + lineLen);
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
  textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

function updateGutter(pane) {
  const gutter = pane.textarea.parentElement.querySelector('.gutter');
  const count = pane.textarea.value.split('\n').length;
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= count; n++) {
    const mark = pane.marks.get(n);
    if (mark) {
      const span = document.createElement('span');
      span.className = mark;
      span.textContent = n;
      frag.append(span, '\n');
    } else {
      frag.append(n + '\n');
    }
  }
  // Extra line so the gutter can scroll as far as the textarea's horizontal scrollbar allows.
  frag.append('\n');
  gutter.replaceChildren(frag);
  gutter.scrollTop = pane.textarea.scrollTop;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ source: source.value, code: code.value, listing: listingBox.checked, auto: autoBox.checked }),
    );
  } catch {}
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s) return false;
    source.value = s.source ?? '';
    code.value = s.code ?? '';
    listingBox.checked = !!s.listing;
    autoBox.checked = !!s.auto;
    return true;
  } catch {
    return false;
  }
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

for (const ex of EXAMPLES) exampleSelect.add(new Option(ex.title, ex.file));
exampleSelect.addEventListener('change', () => {
  if (!exampleSelect.value) return;
  loadExample(exampleSelect.value).catch((e) => showDiagnostics(panes.source, '', [], e));
  exampleSelect.value = '';
});

$('compile').addEventListener('click', runCompile);
$('decompile').addEventListener('click', runDecompile);
$('copy-source').addEventListener('click', (e) => copyText(source.value, e.currentTarget));
$('copy-code').addEventListener('click', (e) => copyText(code.value, e.currentTarget));
listingBox.addEventListener('change', runCompile);
autoBox.addEventListener('change', () => {
  save();
  if (autoBox.checked) runCompile();
});

const autoCompile = debounce(() => autoBox.checked && runCompile(), 300);
const debouncedSave = debounce(save, 500);

for (const [name, pane] of Object.entries(panes)) {
  const ta = pane.textarea;
  const gutter = ta.parentElement.querySelector('.gutter');
  ta.addEventListener('scroll', () => (gutter.scrollTop = ta.scrollTop));
  ta.addEventListener('input', () => {
    updateGutter(pane);
    debouncedSave();
    if (name === 'source') autoCompile();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      name === 'source' ? runCompile() : runDecompile();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
  loadExample(EXAMPLES[0].file).catch((e) => showDiagnostics(panes.source, '', [], e));
}
