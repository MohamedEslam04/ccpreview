'use strict';
// web/i18n.js is a classic browser script (top-level const/function declarations), so it is
// loaded into a vm context with a minimal navigator/document and read back through globals.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(language = 'en-US') {
  const ctx = { navigator: { language }, document: { documentElement: {} } };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'i18n.js'), 'utf8');
  // top-level const/let are not properties of the context, so expose what the tests need
  vm.runInContext(`${src}\n;globalThis.__api = { I18N, LOCALE, DIR, t, tn, setLang, isRtl };`, ctx);
  return ctx.__api;
}

// agents.count.one / .other / .two are forms of the same key
const base = (k) => k.replace(/\.(one|two|other)$/, '');
const keySet = (dict) => new Set(Object.keys(dict).map(base));

test('en and ar define the same keys (ignoring plural suffixes)', () => {
  const { I18N } = load();
  const en = keySet(I18N.en), ar = keySet(I18N.ar);
  assert.deepStrictEqual([...en].filter((k) => !ar.has(k)), [], 'keys missing in ar');
  assert.deepStrictEqual([...ar].filter((k) => !en.has(k)), [], 'keys missing in en');
});

test('every plural key has an .other form in both languages', () => {
  const { I18N } = load();
  for (const lang of ['en', 'ar']) {
    const d = I18N[lang];
    for (const k of Object.keys(d)) {
      if (/\.(one|two)$/.test(k)) assert.ok(`${base(k)}.other` in d, `${lang}: ${k} has no .other`);
    }
  }
});

test('{vars} used by the English string are all present in the Arabic one', () => {
  const { I18N } = load();
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of Object.keys(I18N.en)) {
    const b = base(k);
    const arKey = k in I18N.ar ? k : `${b}.other`;
    if (!(arKey in I18N.ar)) continue;
    if (k.endsWith('.one')) continue; // "One subagent" has no {n} by design
    assert.strictEqual(vars(I18N.ar[arKey]), vars(I18N.en[k]), `vars differ for ${k}`);
  }
});

test('t / tn pick the active language and the right plural form', () => {
  const api = load('en-US');
  assert.strictEqual(api.tn('agents.count', 1), 'One subagent');
  assert.strictEqual(api.tn('agents.count', 3), '3 subagents');
  api.setLang('ar');
  assert.ok(api.isRtl());
  assert.notStrictEqual(api.t('tab.pages'), api.I18N.en['tab.pages']);
});
