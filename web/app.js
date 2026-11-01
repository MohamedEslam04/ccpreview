'use strict';
const $ = (id) => document.getElementById(id);
const ed = $('ed'), thumbs = $('thumbs');
// Where sessions come from: the local `marsad` server, or a folder you pick in the browser (see source.js)
const SRC = MarsadSource.create();
const SERVER = SRC.mode === 'server';
let sourceState = 'loading'; // ready | offline | needs-folder | needs-permission | unsupported
const LS_PAGES = 'marsad.pages.v1'; // notes pages (the only store in folder mode, a backup in server mode)
const LS_UI = 'marsad.ui.v1';       // per-browser UI state: tab, open panes, widths, scroll
const DEFAULT_W = 260;
const WIDTHS = {
  sm: { css: '720px', label: 'ضيق', hint: '720px', bar: 45 },
  md: { css: '920px', label: 'متوسط', hint: '920px', bar: 62 },
  lg: { css: '1200px', label: 'عريض', hint: '1200px', bar: 82 },
  full: { css: 'none', label: 'كامل العرض', hint: 'كل الشاشة', bar: 100 },
};
const WIDTH_ORDER = ['sm', 'md', 'lg', 'full'];

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  page: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 9.5-4.9M18 8c0 7 3 8 3 8H8M3 16s3-1 3-8M10 20a2 2 0 0 0 4 0M3 3l18 18"/></svg>',
};

let state = { pages: [{ html: '', name: '' }], cur: 0 };
let ui = { tab: 'pages', sess: null, panes: [], activePane: 0, sidew: DEFAULT_W, collapsed: false, theme: 'auto', shut: [], edScroll: {}, viewScroll: {}, openAgents: [], closedAgents: [], contentW: 'md' };

// =====================================================================
// helpers
// =====================================================================
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Paragraph direction from what most of the text is written in, ignoring links and code.
// dir="auto" only looks at the first strong character, so "https://… then an Arabic sentence"
// rendered left-to-right. Returns "rtl", "ltr" or "auto" (no letters at all).
function textDir(src) {
  const t = String(src || '').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[\w.-]+\/[\w./-]+/g, ' ');
  // count words, not letters: English terms are long, Arabic function words are short
  const ar = (t.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]+/g) || []).length;
  const la = (t.match(/[A-Za-z\u00C0-\u024F]+/g) || []).length;
  if (!ar && !la) return 'auto';
  // Arabic prose is full of English terms; it's still an Arabic paragraph when a third of its words are Arabic
  return ar * 2 >= la ? 'rtl' : 'ltr';
}
function toast(msg) {
  const t = $('toast');
  t.hidden = true;
  void t.offsetWidth; // restart the entry animation
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 1900);
}
function htmlText(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('td,th,p,div,li,h1,h2,h3,h4,br').forEach((x) => x.append(' '));
  return d.textContent.replace(/\s+/g, ' ').trim();
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'دلوقتي';
  if (s < 3600) return `من ${Math.floor(s / 60)} د`;
  if (s < 86400) return `من ${Math.floor(s / 3600)} س`;
  return `من ${Math.floor(s / 86400)} يوم`;
}
function hhmm(ts) {
  return ts ? new Date(ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
}
const uid = () => Math.random().toString(36).slice(2, 10);
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}
function throttle(fn, ms) {
  let t = null;
  return (...a) => { if (t) return; t = setTimeout(() => { t = null; fn(...a); }, ms); };
}

// =====================================================================
// Dropdowns: native <select> popups can't be styled, so each <select> gets a button + listbox.
// The <select> stays (hidden) as the source of truth: picking an option sets its value and fires
// "change", so existing listeners keep working. Keyboard: ↑ ↓ Home End Enter Space Esc, type to jump.
// =====================================================================
let openDropdown = null;
const DD_CHECK = '<svg class="dd-check" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
function syncSelect(sel) { if (sel && sel._dd) sel._dd.sync(); }
function enhanceSelect(sel, cls) {
  if (sel._dd) return sel._dd;
  sel.classList.add('dd-native');
  sel.tabIndex = -1;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn' + (cls ? ' ' + cls : '');
  btn.title = sel.title || '';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="dd-label"></span><svg class="dd-caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  sel.after(btn);
  let menu = null, items = [], active = -1, typed = '', typedT;
  const api = {
    sync() {
      const o = sel.options[sel.selectedIndex];
      btn.querySelector('.dd-label').textContent = o ? o.textContent : '';
    },
    close() {
      if (!menu) return;
      menu.remove();
      menu = null;
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('open');
      if (openDropdown === api) openDropdown = null;
    },
  };
  const highlight = (scroll = true) => {
    menu.querySelectorAll('.dd-opt').forEach((el, i) => el.classList.toggle('act', i === active));
    const a = menu.querySelector('.dd-opt.act');
    if (a && scroll) a.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    const o = items[i];
    if (!o) return;
    if (sel.value !== o.value) {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    api.sync();
    api.close();
    btn.focus();
  };
  const position = () => {
    const r = btn.getBoundingClientRect();
    menu.style.minWidth = Math.max(r.width, 160) + 'px';
    const h = menu.offsetHeight, below = innerHeight - r.bottom;
    menu.style.top = (below < h + 12 && r.top > below ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
    // RTL: line the menu up with the button's right edge, but keep it on screen
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
    if (menu.getBoundingClientRect().left < 8) { menu.style.right = 'auto'; menu.style.left = '8px'; }
  };
  const open = () => {
    if (openDropdown) openDropdown.close();
    items = [];
    let html = '';
    const add = (o) => {
      const i = items.length;
      items.push(o);
      html += `<div class="dd-opt${o.selected ? ' sel' : ''}" role="option" data-i="${i}" aria-selected="${o.selected}"><span>${esc(o.textContent)}</span>${DD_CHECK}</div>`;
    };
    [...sel.children].forEach((ch) => {
      if (ch.tagName === 'OPTGROUP') { html += `<div class="dd-group" role="presentation">${esc(ch.label)}</div>`; [...ch.children].forEach(add); }
      else add(ch);
    });
    menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = html;
    document.body.append(menu);
    position();
    active = Math.max(0, items.findIndex((o) => o.selected));
    highlight();
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('open');
    menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
    menu.addEventListener('click', (e) => { const it = e.target.closest('.dd-opt'); if (it) choose(+it.dataset.i); });
    menu.addEventListener('mousemove', (e) => {
      const it = e.target.closest('.dd-opt');
      if (it && +it.dataset.i !== active) { active = +it.dataset.i; highlight(false); }
    });
    openDropdown = api;
  };
  btn.addEventListener('click', () => (menu ? api.close() : open()));
  btn.addEventListener('blur', () => api.close());
  btn.addEventListener('keydown', (e) => {
    if (!menu) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    const last = items.length - 1;
    if (e.key === 'ArrowDown') active = Math.min(last, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'Home') active = 0;
    else if (e.key === 'End') active = last;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); return; }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); return; }
    else if (e.key === 'Tab') { api.close(); return; }
    else if (e.key.length === 1) {
      // type-ahead: jump to the first option starting with what you typed
      typed += e.key.toLowerCase();
      clearTimeout(typedT);
      typedT = setTimeout(() => { typed = ''; }, 700);
      const i = items.findIndex((o) => o.textContent.trim().toLowerCase().startsWith(typed));
      if (i >= 0) active = i;
    } else return;
    e.preventDefault();
    highlight();
  });
  sel._dd = api;
  api.sync();
  return api;
}
document.addEventListener('mousedown', (e) => { if (openDropdown && !e.target.closest('.dd-menu,.dd-btn')) openDropdown.close(); });
window.addEventListener('resize', () => openDropdown && openDropdown.close());
document.addEventListener('scroll', (e) => {
  if (openDropdown && !(e.target.closest && e.target.closest('.dd-menu'))) openDropdown.close();
}, true);

// =====================================================================
// UI state (localStorage) + URL hash, so reload lands where you were
// =====================================================================
function loadUi() {
  try { Object.assign(ui, JSON.parse(localStorage.getItem(LS_UI)) || {}); } catch (e) {}
  if (!ui.edScroll || typeof ui.edScroll !== 'object') ui.edScroll = {};
  if (!ui.viewScroll || typeof ui.viewScroll !== 'object') ui.viewScroll = {};
  if (!Array.isArray(ui.shut)) ui.shut = [];
  if (!Array.isArray(ui.openAgents)) ui.openAgents = [];
  if (!Array.isArray(ui.closedAgents)) ui.closedAgents = [];
  if (!WIDTHS[ui.contentW]) ui.contentW = 'md';
  if (!Array.isArray(ui.panes)) ui.panes = [];
  if (!Array.isArray(ui.moreProj)) ui.moreProj = [];
  if (!Array.isArray(ui.pinned)) ui.pinned = [];
  if (ui.groupBy !== 'time') ui.groupBy = 'project';
  if (!ui.dateFilter || typeof ui.dateFilter !== 'object') ui.dateFilter = { k: 'any' };
  ui.dateFilter.k = { week: 'd7', month: 'd30' }[ui.dateFilter.k] || ui.dateFilter.k;
  if (!QUICK_FILTERS.some((f) => f.k === ui.sessFilter)) ui.sessFilter = 'all';
  if (!ui.panes.length && ui.sess) ui.panes = [ui.sess]; // older single-view state
}
const saveUi = throttle(() => { try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch (e) {} }, 250);
function saveUiNow() { try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch (e) {} }

function writeHash() {
  let h;
  if (ui.tab === 'sessions') {
    const parts = (ui.panes || []).map((k) => [k.dir, k.id, k.agent].filter(Boolean).map(encodeURIComponent).join('/'));
    h = '#s' + (parts.length ? '/' + parts.join('+') : '');
  } else h = `#p/${state.cur + 1}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const raw = location.hash.slice(1);
  if (raw === 's' || raw.startsWith('s/')) {
    ui.tab = 'sessions';
    const rest = raw.slice(2);
    if (rest) {
      const old = ui.panes || [];
      ui.panes = rest.split('+').map((seg) => {
        const [dir, id, agent] = seg.split('/').map(decodeURIComponent);
        const prev = old.find((k) => k.dir === dir && k.id === id && (k.agent || '') === (agent || ''));
        return { dir, id, agent: agent || '', title: prev ? prev.title : '' };
      }).filter((k) => k.dir && k.id);
    }
  } else if (raw.startsWith('p/')) {
    ui.tab = 'pages';
    const n = parseInt(raw.slice(2), 10);
    if (n >= 1 && n <= state.pages.length) state.cur = n - 1;
  }
}

// =====================================================================
// markdown + terminal-table rendering
// =====================================================================
const isBox = (l) => /^\s*[─-╿]/.test(l);
const isRule = (l) => /^[\s─-╿]+$/.test(l) && /[─━═]/.test(l);
const isHr = (l) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isListLine = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
const isTableStart = (l, n) => l.includes('|') && !!n && n.includes('|') && n.includes('-') && /^[\s|:-]+$/.test(n);

function boxTable(lines) {
  const rows = [];
  let cur = null;
  lines.forEach((l) => {
    if (isRule(l)) { if (cur) rows.push(cur); cur = null; return; }
    // a wrapped cell spans several lines until the next border line
    const p = l.trim().split(/[│┃║]/).slice(1, -1);
    if (!cur) cur = p.map(() => []);
    p.forEach((c, i) => { c = c.trim(); if (c && cur[i]) cur[i].push(c); });
  });
  if (cur) rows.push(cur);
  return '<table>' + rows.map((r, ri) => {
    const t = ri ? 'td' : 'th';
    return '<tr>' + r.map((c) => `<${t} dir="${textDir(c.join(' '))}">${inline(c.join(' '))}</${t}>`).join('') + '</tr>';
  }).join('') + '</table>';
}

function inline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code dir="ltr">${codes[n]}</code>`);
}

function splitRow(l) {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function mdList(lines, i) {
  const items = [];
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m && !isHr(l)) { items.push({ ind: m[1].length, ord: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] }); i++; continue; }
    if (l.trim() && /^\s+/.test(l) && items.length) { items[items.length - 1].text += '\n' + l.trim(); i++; continue; }
    if (!l.trim() && i + 1 < lines.length && isListLine(lines[i + 1])) { i++; continue; }
    break;
  }
  let html = '';
  const stack = [];
  items.forEach((it) => {
    while (stack.length && it.ind < stack[stack.length - 1].ind) html += '</li></' + stack.pop().tag + '>';
    const top = stack[stack.length - 1];
    if (!top || it.ind > top.ind) {
      const tag = it.ord ? 'ol' : 'ul';
      stack.push({ ind: it.ind, tag });
      html += `<${tag} dir="${textDir(items.map((x) => x.text).join(' ')) === 'ltr' ? 'ltr' : 'rtl'}"${it.ord && it.start !== 1 ? ` start="${it.start}"` : ''}>`;
    } else {
      html += '</li>';
    }
    html += `<li dir="${textDir(it.text)}">` + it.text.split('\n').map(inline).join('<br>');
  });
  while (stack.length) html += '</li></' + stack.pop().tag + '>';
  return { html, i };
}

function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const blockStart = (l, n) => /^\s*```/.test(l) || /^\s{0,3}#{1,6}\s/.test(l) || /^\s{0,3}>/.test(l) ||
    isListLine(l) || isHr(l) || isTableStart(l, n) || isBox(l);
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre dir="ltr"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (isBox(l)) {
      const b = [];
      while (i < lines.length && isBox(lines[i])) b.push(lines[i++]);
      out.push(boxTable(b));
      continue;
    }
    if ((m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const n = m[1].length;
      out.push(`<h${n} dir="${textDir(m[2])}">${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }
    if (isHr(l)) { out.push('<hr>'); i++; continue; }
    if (isTableStart(l, lines[i + 1])) {
      const head = splitRow(l);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      // the whole table follows the language of its content; cells follow their own text
      const tdir = textDir([head, ...rows].flat().join(' '));
      out.push(`<table dir="${tdir === 'auto' ? 'rtl' : tdir}"><tr>` + head.map((c) => `<th dir="${textDir(c)}">${inline(c)}</th>`).join('') + '</tr>' +
        rows.map((r) => '<tr>' + head.map((_, j) => `<td dir="${textDir(r[j] || '')}">${inline(r[j] || '')}</td>`).join('') + '</tr>').join('') +
        '</table>');
      continue;
    }
    if (/^\s{0,3}>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (isListLine(l)) {
      const r = mdList(lines, i);
      out.push(r.html);
      i = r.i;
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !(p.length && blockStart(lines[i], lines[i + 1]))) p.push(lines[i++].trim());
    out.push(`<p dir="${textDir(p.join(' '))}">${p.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// Text copied from the Claude Code terminal is indented and may start with a bullet marker.
function dedent(t) {
  const lines = t.replace(/\r/g, '').split('\n');
  if (lines.length) lines[0] = lines[0].replace(/^\s*[●⏺]\s/, '  ');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n');
}

// =====================================================================
// pages storage
// =====================================================================
let serverOff = false;

async function loadState() {
  let saved = null;
  if (SERVER) {
    try { saved = await (await fetch('/api/pages')).json(); } catch (e) {}
  }
  if (!saved || !saved.pages) {
    try { saved = JSON.parse(localStorage.getItem(LS_PAGES)); } catch (e) {}
  }
  if (saved && saved.pages && saved.pages.length) {
    state.pages = saved.pages;
    state.cur = saved.cur || 0;
    // older saves kept UI prefs with the pages; use them once as defaults
    if (!localStorage.getItem(LS_UI)) ['theme', 'collapsed', 'shut'].forEach((k) => { if (saved[k] !== undefined) ui[k] = saved[k]; });
  }
  state.pages.forEach((p) => {
    if (typeof p.name !== 'string') p.name = '';
    if (!p.id) p.id = uid();
  });
  if (state.cur >= state.pages.length) state.cur = 0;
}

let persistTimer;
function save() {
  state.pages[state.cur].html = ed.innerHTML;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}
async function persist() {
  const body = JSON.stringify({ pages: state.pages, cur: state.cur });
  try { localStorage.setItem(LS_PAGES, body); } catch (e) {}
  if (!SERVER || serverOff) { setSave('محفوظ في المتصفح'); return; }
  try {
    const r = await fetch('/api/pages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error(r.status);
    setSave('اتحفظ');
  } catch (e) {
    setSave('محفوظ في المتصفح بس', true);
    setServerUi(false);
  }
}
function setSave(t, bad) {
  const s = $('saveState');
  s.textContent = t;
  s.classList.toggle('bad', !!bad);
  clearTimeout(setSave.t);
  if (!bad) setSave.t = setTimeout(() => { s.textContent = ''; }, 2500);
}
window.addEventListener('beforeunload', () => {
  state.pages[state.cur].html = ed.innerHTML;
  try { localStorage.setItem(LS_PAGES, JSON.stringify({ pages: state.pages, cur: state.cur })); } catch (e) {}
  saveUiNow();
});

// =====================================================================
// server start / stop (pad.socket starts the server on the first request)
// =====================================================================
function setServerUi(on) {
  const b = $('srvBtn');
  b.classList.toggle('on', on);
  if (!SERVER) {
    // folder mode: the chip is the folder connection
    b.querySelector('.lbl').textContent = SRC.ready ? SRC.folderName : 'مش متوصل';
    b.querySelector('.act').textContent = SRC.ready ? 'غيّر الفولدر' : 'وصّل';
    b.title = SRC.ready ? `بيقرا من فولدر "${SRC.folderName}" على جهازك` : 'وصّل فولدر السيشنز';
    return;
  }
  const service = SRC.info && SRC.info.service;
  b.querySelector('.lbl').textContent = on ? 'شغال' : 'مقفول';
  b.title = on ? 'Marsad شغال على الجهاز ده' : 'Marsad مقفول';
  b.querySelector('.act').textContent = on ? (service ? 'إيقاف' : 'شغال') : 'تشغيل';
}
function startServer() { location.reload(); }
async function connectFolder(again) {
  try {
    if (again) await SRC.reconnect(); else await SRC.pick();
    sourceState = 'ready';
    setServerUi(true);
    sess.list = null;
    renderSessions();
    await loadSessions();
    restorePanes(false);
    setTab(ui.tab);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // closed the picker
    toast(e && e.message === 'not-projects' ? 'الفولدر ده مفيهوش سيشنز. اختار ~/.claude/projects' : 'معرفتش أوصل للفولدر');
  }
}
$('srvBtn').onclick = async () => {
  if (!SERVER) return connectFolder(sourceState === 'needs-permission');
  if (serverOff || !$('srvBtn').classList.contains('on')) return startServer();
  if (!(SRC.info && SRC.info.service)) { toast('Marsad شغال. تقفله من التيرمينال بـ Ctrl+C'); return; }
  state.pages[state.cur].html = ed.innerHTML;
  await persist();
  serverOff = true; // stop polling/streaming, or they would wake the socket-activated server again
  panes.forEach((p) => { if (p.es) { p.es.close(); p.es = null; } });
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch (e) {}
  setServerUi(false);
  setSave('محفوظ في المتصفح');
  renderSessions();
};

// =====================================================================
// pages + thumbnails
// =====================================================================
function fillMini(li, html) {
  // Fixed virtual width so thumbnail text stays readable.
  const w = Math.min(ed.clientWidth || 640, 640);
  const m = li.querySelector('.mini');
  m.style.width = w + 'px';
  m.style.transform = `scale(${li.querySelector('.thumb').clientWidth / w})`;
  m.innerHTML = html;
}

function renderThumbs() {
  thumbs.innerHTML = '';
  state.pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.i = i;
    if (i === state.cur) li.className = 'on';
    li.innerHTML = `<span class="n">${i + 1}</span><div class="col"><div class="thumb"><div class="mini page"></div></div>` +
      `<div class="name" dir="auto" data-ph="دبل كليك لتسمية الصفحة">${esc(p.name || '')}</div>` +
      `<button class="del" title="حذف الصفحة">${ICON.x}</button></div>`;
    thumbs.append(li);
    fillMini(li, p.html);
  });
  $('pageCount').textContent = state.pages.length;
  const on = thumbs.querySelector('li.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function updateBlank() {
  const blank = !ed.textContent.trim() && !ed.querySelector('table,img,hr,pre');
  ed.classList.toggle('blank', blank);
  $('hints').style.opacity = blank && ui.tab === 'pages' ? '1' : '0';
}

function showPage(i) {
  state.cur = i;
  ed.innerHTML = state.pages[i].html;
  updateBlank();
  $('edWrap').scrollTop = ui.edScroll[state.pages[i].id] || 0;
}

function go(i) {
  if (i < 0 || i >= state.pages.length) return;
  save();
  showPage(i);
  save();
  renderThumbs();
  setTab('pages');
  ed.focus({ preventScroll: true });
}

function addPage(html, name) {
  save();
  state.pages.splice(state.cur + 1, 0, { id: uid(), html: html || '', name: name || '' });
  go(state.cur + 1);
}

function delPage(i) {
  save();
  if (htmlText(state.pages[i].html) && !confirm(`حذف الصفحة ${i + 1}؟`)) return;
  delete ui.edScroll[state.pages[i].id];
  state.pages.splice(i, 1);
  if (!state.pages.length) state.pages.push({ id: uid(), html: '', name: '' });
  if (state.cur >= i && state.cur > 0) state.cur--;
  showPage(state.cur);
  save();
  renderThumbs();
  writeHash();
}

function editName(li) {
  const el = li.querySelector('.name');
  const i = +li.dataset.i;
  el.contentEditable = 'true';
  el.focus();
  document.getSelection().selectAllChildren(el);
  const done = () => {
    el.removeAttribute('contenteditable');
    state.pages[i].name = el.textContent.trim();
    el.textContent = state.pages[i].name;
    save();
  };
  el.addEventListener('blur', done, { once: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.textContent = state.pages[i].name || ''; el.blur(); }
  });
}

thumbs.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || e.target.closest('.name[contenteditable]')) return;
  const i = +li.dataset.i;
  if (e.target.closest('.del')) delPage(i);
  else if (i !== state.cur || ui.tab !== 'pages') go(i);
});
thumbs.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li');
  if (li) editName(li);
});

let dragFrom = null;
thumbs.addEventListener('dragstart', (e) => {
  dragFrom = +e.target.closest('li').dataset.i;
  e.dataTransfer.effectAllowed = 'move';
});
thumbs.addEventListener('dragover', (e) => {
  const li = e.target.closest('li');
  if (!li || dragFrom === null) return;
  e.preventDefault();
  [...thumbs.children].forEach((x) => x.classList.toggle('over', x === li));
});
thumbs.addEventListener('drop', (e) => {
  const li = e.target.closest('li');
  if (!li || dragFrom === null) return;
  e.preventDefault();
  save();
  const curPage = state.pages[state.cur];
  const moved = state.pages.splice(dragFrom, 1)[0];
  state.pages.splice(+li.dataset.i, 0, moved);
  state.cur = state.pages.indexOf(curPage);
  dragFrom = null;
  save();
  renderThumbs();
  writeHash();
});
thumbs.addEventListener('dragend', () => {
  dragFrom = null;
  [...thumbs.children].forEach((x) => x.classList.remove('over'));
});

$('add').onclick = () => addPage();

let thumbTimer;
ed.addEventListener('input', () => {
  updateBlank();
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    save();
    const li = thumbs.children[state.cur];
    if (li) fillMini(li, ed.innerHTML);
  }, 300);
});
$('edWrap').addEventListener('scroll', throttle(() => {
  ui.edScroll[state.pages[state.cur].id] = $('edWrap').scrollTop;
  saveUi();
}, 200));

// =====================================================================
// paste: terminal tables + markdown -> formatted HTML (Ctrl+Shift+V = raw)
// =====================================================================
let rawPaste = false;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') rawPaste = true;
}, true);

ed.addEventListener('paste', (e) => {
  if (rawPaste) { rawPaste = false; return; }
  const cd = e.clipboardData;
  const txt = cd.getData('text/plain');
  const hasBox = /[│║]/.test(txt);
  const looksMd = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>\s)|\*\*[^*\n]+\*\*|`[^`\n]+`|(^|\n)\s*\|.*\|\s*\n\s*\|?[\s:|-]+\|/.test(txt);
  if (!hasBox && (!looksMd || cd.types.includes('text/html'))) return; // normal / rich paste
  e.preventDefault();
  document.execCommand('insertHTML', false, md(dedent(txt)));
});

// =====================================================================
// table copy toolbar (Markdown / Excel)
// =====================================================================
const tblbar = $('tblbar');
let barTable = null, barHide;
function tableRows(t) {
  return [...t.rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\s*\n\s*/g, ' ').trim()));
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('#ed table, .pbody table');
  if (t) {
    clearTimeout(barHide);
    barTable = t;
    const r = t.getBoundingClientRect();
    tblbar.hidden = false;
    tblbar.style.top = Math.max(6, r.top - tblbar.offsetHeight - 6) + 'px';
    tblbar.style.left = Math.max(6, r.left) + 'px';
  } else if (!e.target.closest('#tblbar')) {
    clearTimeout(barHide);
    barHide = setTimeout(() => { tblbar.hidden = true; }, 350);
  }
});
document.addEventListener('scroll', () => { tblbar.hidden = true; }, true);
tblbar.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection
tblbar.addEventListener('click', async (e) => {
  const f = e.target.closest('[data-f]') && e.target.closest('[data-f]').dataset.f;
  if (!f || !barTable) return;
  const rows = tableRows(barTable);
  let out;
  if (f === 'md') {
    const line = (r) => '| ' + r.map((c) => c.replace(/\|/g, '\\|')).join(' | ') + ' |';
    out = [line(rows[0]), '| ' + rows[0].map(() => '---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
  } else {
    out = rows.map((r) => r.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\n');
  }
  toast((await copyText(out)) ? (f === 'md' ? 'الجدول اتنسخ كـ Markdown' : 'الجدول اتنسخ، الصقه في Excel أو Sheets') : 'النسخ فشل');
});

// =====================================================================
// search (Ctrl+K)
// =====================================================================
const search = $('search'), q = $('q'), results = $('results');
let hits = [], sel = 0;
function openSearch() {
  save();
  search.hidden = false;
  q.value = '';
  renderHits();
  q.focus();
}
function closeSearch() { search.hidden = true; }
function renderHits() {
  const term = q.value.trim().toLowerCase();
  hits = [];
  state.pages.forEach((p, i) => {
    const text = htmlText(p.html);
    const name = p.name || '';
    if (!term) { hits.push({ i, name, snip: text.slice(0, 90) || 'صفحة فاضية' }); return; }
    const at = text.toLowerCase().indexOf(term);
    if (at === -1 && !name.toLowerCase().includes(term)) return;
    const from = Math.max(0, at - 40);
    hits.push({ i, name, snip: at === -1 ? text.slice(0, 90) : text.slice(from, at + term.length + 50), term });
  });
  sel = 0;
  results.innerHTML = hits.map((h, k) => {
    let snip = esc(h.snip);
    if (h.term) snip = snip.replace(new RegExp(esc(h.term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`);
    return `<li data-k="${k}"${k === 0 ? ' class="sel"' : ''}><span class="rn">${h.i + 1}${h.name ? ' · ' + esc(h.name) : ''}</span><span class="snip" dir="auto">${snip}</span></li>`;
  }).join('') || '<li class="snip">مفيش نتايج</li>';
}
function pick(k) {
  const h = hits[k];
  if (!h) return;
  closeSearch();
  go(h.i);
  const term = q.value.trim();
  if (term) {
    document.getSelection().collapse(ed, 0);
    window.find(term, false, false, true);
  }
}
q.addEventListener('input', renderHits);
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = Math.max(0, Math.min(hits.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
    [...results.children].forEach((li, k) => li.classList.toggle('sel', k === sel));
    if (results.children[sel]) results.children[sel].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  else if (e.key === 'Escape') closeSearch();
});
results.addEventListener('click', (e) => { const li = e.target.closest('li[data-k]'); if (li) pick(+li.dataset.k); });
search.addEventListener('mousedown', (e) => { if (e.target === search) closeSearch(); });
$('searchBtn').onclick = openSearch;

// =====================================================================
// export / import
// =====================================================================
$('exportBtn').onclick = () => {
  save();
  const data = JSON.stringify({ app: 'pad', version: 1, exported: new Date().toISOString(), pages: state.pages }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `pad-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`اتصدّرت ${state.pages.length} صفحة`);
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const pages = (Array.isArray(d) ? d : d.pages || [])
      .filter((p) => p && typeof p.html === 'string')
      .map((p) => ({ id: uid(), html: p.html, name: typeof p.name === 'string' ? p.name : '' }));
    if (!pages.length) throw new Error('empty');
    save();
    const first = state.pages.length;
    // replace a single empty page instead of keeping it around
    if (state.pages.length === 1 && !htmlText(state.pages[0].html)) { state.pages = pages; go(0); }
    else { state.pages.push(...pages); go(first); }
    toast(`اتضافت ${pages.length} صفحة`);
  } catch (err) {
    toast('الملف ده مش ملف صفحات صالح');
  }
};

// =====================================================================
// theme, sidebar, resize
// =====================================================================
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'تلقائي (حسب السيستم)', light: 'فاتح', dark: 'غامق' };
function applyTheme() {
  if (ui.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = ui.theme;
  $('themeBtn').innerHTML = ICON[{ auto: 'auto', light: 'sun', dark: 'moon' }[ui.theme]];
  $('themeBtn').title = 'الثيم: ' + THEME_LABEL[ui.theme];
}
$('themeBtn').onclick = () => {
  ui.theme = THEMES[(THEMES.indexOf(ui.theme) + 1) % THEMES.length];
  applyTheme();
  toast('الثيم: ' + THEME_LABEL[ui.theme]);
  saveUi();
};

function setCollapsed(v) {
  ui.collapsed = v;
  document.body.classList.toggle('collapsed', v);
  saveUi();
  if (!v) requestAnimationFrame(renderThumbs);
}
$('close').onclick = () => setCollapsed(true);
$('open').onclick = () => setCollapsed(false);

function applyWidth(w) {
  ui.sidew = Math.round(Math.max(200, Math.min(w, Math.min(560, window.innerWidth * 0.5))));
  document.documentElement.style.setProperty('--sidew', ui.sidew + 'px');
}
const rerenderThumbs = throttle(renderThumbs, 120);
$('resizer').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const r = $('resizer');
  r.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => { applyWidth(window.innerWidth - ev.clientX); rerenderThumbs(); };
  const up = () => {
    r.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    renderThumbs();
    saveUi();
  };
  r.addEventListener('pointermove', move);
  r.addEventListener('pointerup', up, { once: true });
});
$('resizer').addEventListener('dblclick', () => { applyWidth(DEFAULT_W); renderThumbs(); saveUi(); });

function setTab(tab) {
  ui.tab = tab;
  document.querySelectorAll('.seg button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  });
  $('pagesPane').hidden = tab !== 'pages';
  $('sessionsPane').hidden = tab !== 'sessions';
  $('edWrap').hidden = tab !== 'pages';
  panesEl.hidden = tab !== 'sessions' || !panes.length;
  $('vempty').hidden = tab !== 'sessions' || panes.length > 0;
  tblbar.hidden = true;
  updateBlank();
  if (tab === 'sessions') { renderSessions(); renderEmptyView(); loadSessions(); }
  writeHash();
  saveUi();
}
document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { applyWidth(ui.sidew); renderThumbs(); }, 150); });

// =====================================================================
// Claude Code sessions (live), shown in up to 4 side-by-side panes
// =====================================================================
const sess = { list: null };
const sessList = $('sessList');
const panesEl = $('panes');
const MAX_PANES = 4;
let panes = [];
let activePane = null;

async function loadSessions() {
  if (!SRC.ready || serverOff) { renderSessions(); return; }
  try {
    // a date filter / time grouping needs every session, not just the latest 15 per project
    sess.list = await SRC.list({ all: dateActive() || ui.groupBy === 'time', more: ui.moreProj || [] });
    checkTransitions();
    setServerUi(true);
  } catch (e) {
    setServerUi(false);
    sess.list = null;
  }
  renderSessions();
  renderEmptyView();
  panes.forEach((p) => p.renderHead());
}

// What the sidebar shows when there is nothing to read yet.
function connectHtml() {
  const npx = '<code dir="ltr">npx marsad</code>';
  if (SERVER) return `<div class="empty">Marsad مقفول.<br><br><button class="btn primary" data-start>تشغيل</button><p class="connect-hint">لو مش شغال، شغّله من التيرمينال: ${npx}</p></div>`;
  if (sourceState === 'unsupported') {
    return `<div class="empty connect"><b>المتصفح ده مش بيقدر يقرا فولدرات من الجهاز.</b>` +
      `<p>استخدم Chrome أو Edge، أو شغّل Marsad على جهازك:</p><pre dir="ltr">${npx.replace(/<\/?code[^>]*>/g, '')}</pre>` +
      `<p class="connect-hint">على Brave: فعّل <code dir="ltr">brave://flags/#file-system-access-api</code> وأعد تشغيل المتصفح.</p></div>`;
  }
  if (sourceState === 'needs-permission') {
    return `<div class="empty connect"><b>المتصفح محتاج إذنك تاني عشان يقرا "${esc(SRC.folderName)}".</b>` +
      `<br><br><button class="btn primary" data-reconnect>اسمح بالقراية</button></div>`;
  }
  return `<div class="empty connect"><b>وصّل فولدر سيشنز Claude Code</b>` +
    `<p>اختار فولدر <code dir="ltr">~/.claude/projects</code>. المتصفح هيقراه بس، ومفيش أي حاجة بتترفع لأي مكان.</p>` +
    `<button class="btn primary" data-pick>اختار الفولدر</button>` +
    `<p class="connect-hint">الفولدر مخفي؟ في نافذة الاختيار دوس <kbd>Ctrl</kbd>+<kbd>H</kbd> على Linux، أو <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> على Mac.</p>` +
    `<p class="connect-hint">أو شغّل ${npx} على جهازك.</p></div>`;
}

const isLive = (ms) => Date.now() - ms < 90e3;
const keyOf = (k) => (k ? `${k.dir}/${k.id}${k.agent ? '/' + k.agent : ''}` : '');
const shown = (dir, id, agent) => panes.some((p) => p.key && p.key.dir === dir && p.key.id === id && (p.key.agent || '') === (agent || ''));
function findSession(dir, id) {
  for (const p of sess.list || []) if (p.dir === dir) for (const s of p.sessions) if (s.id === id) return { p, s };
  return null;
}
function agentsOpen(s) {
  if (panes.some((p) => p.key && p.key.id === s.id && p.key.agent)) return true;
  if (ui.openAgents.includes(s.id)) return true;
  return s.agents.some((a) => isLive(a.mtime)) && !ui.closedAgents.includes(s.id);
}
function liveCount() {
  const now = Date.now();
  return (sess.list || []).reduce((n, p) => n + p.sessions.filter((s) => now - s.mtime < 90e3).length, 0);
}

const SPLIT_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';

const PIN_ICON = '<svg viewBox="0 0 24 24"><path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z"/></svg>';
const QUICK_FILTERS = [
  { k: 'all', label: 'الكل' },
  { k: 'live', label: 'شغالة' },
  { k: 'asking', label: 'مستنية ردك' },
  { k: 'open', label: 'مفتوحة' },
  { k: 'pinned', label: 'مثبتة' },
];
const sessLive = (s) => isLive(s.active || s.mtime) || (s.agents || []).some((a) => isLive(a.mtime));
const isPinned = (s) => (ui.pinned || []).includes(s.id);
function matchesQuick(p, s, k) {
  if (k === 'live') return sessLive(s);
  if (k === 'asking') return s.state === 'asking';
  if (k === 'open') return panes.some((x) => x.key && x.key.dir === p.dir && x.key.id === s.id);
  if (k === 'pinned') return isPinned(s);
  return true;
}

// ---------- date filter (by the session's last activity) ----------
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const parseDay = (v) => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
function dateActive() { const d = ui.dateFilter || {}; return !!d.k && d.k !== 'any' && (d.k !== 'custom' || d.from || d.to); }
function dateRange() {
  const d = ui.dateFilter || {}, today = dayStart(Date.now()), DAY = 864e5;
  switch (d.k) {
    case 'today': return [today, Infinity];
    case 'yesterday': return [today - DAY, today];
    case 'custom': {
      const from = parseDay(d.from), to = parseDay(d.to);
      return [from == null ? -Infinity : from, to == null ? Infinity : to + DAY];
    }
    default: {
      // "dN" = the last N calendar days, today included (d3 = today + the 2 days before)
      const n = /^d(\d+)$/.test(d.k || '') ? parseInt(d.k.slice(1), 10) : 0;
      return n ? [today - (n - 1) * DAY, Infinity] : [-Infinity, Infinity];
    }
  }
}
function inDate(s) {
  if (!dateActive()) return true;
  const [a, b] = dateRange();
  const t = s.active || s.mtime;
  return t >= a && t < b;
}
function syncDateUi() {
  const d = ui.dateFilter || { k: 'any' };
  $('dateFilter').value = d.k || 'any';
  syncSelect($('dateFilter'));
  $('dateCustom').hidden = d.k !== 'custom';
  $('dateFrom').value = d.from || '';
  $('dateTo').value = d.to || '';
  $('dateClear').hidden = !dateActive();
  document.querySelector('.date-sel').classList.toggle('on', dateActive());
}
function setDate(patch) {
  const wasActive = dateActive();
  ui.dateFilter = { k: 'any', ...(ui.dateFilter || {}), ...patch };
  saveUi();
  syncDateUi();
  renderSessions();
  if (dateActive() && !wasActive) { sess.list = null; renderSessions(); loadSessions(); } // fetch the full list
  else if (!dateActive() && wasActive) loadSessions(); // back to the latest 15 per project
}
enhanceSelect($('dateFilter'), 'date-dd');
$('dateFilter').addEventListener('change', (e) => {
  setDate({ k: e.target.value });
  if (e.target.value === 'custom') $('dateFrom').focus();
});
$('dateFrom').addEventListener('change', (e) => setDate({ from: e.target.value }));
$('dateTo').addEventListener('change', (e) => setDate({ to: e.target.value }));
$('dateClear').addEventListener('click', () => setDate({ k: 'any', from: '', to: '' }));

function renderFilters() {
  const all = (sess.list || []).flatMap((p) => p.sessions.filter(inDate).map((s) => ({ p, s })));
  const k = ui.sessFilter || 'all';
  $('sessFilters').innerHTML = QUICK_FILTERS.map((f) => {
    const n = f.k === 'all' ? 0 : all.filter(({ p, s }) => matchesQuick(p, s, f.k)).length;
    if (f.k !== 'all' && f.k !== k && !n) return ''; // hide empty filters (except the active one)
    return `<button class="qf${f.k === k ? ' on' : ''}${f.k === 'live' && n ? ' has-live' : ''}${f.k === 'asking' && n ? ' has-ask' : ''}" data-qf="${f.k}" role="tab" aria-selected="${f.k === k}">` +
      `${f.label}${n ? `<span class="qf-n">${n}</span>` : ''}</button>`;
  }).join('');
}

// Groups for "by time": today, yesterday, then one group per day for the rest of the week
// (named by weekday + date, e.g. "الخميس 29 أكتوبر"), then the rest of the month, then older.
function timeBuckets() {
  const today = dayStart(Date.now()), DAY = 864e5;
  const dayName = (t) => new Date(t).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
  const list = [
    { k: 'today', label: 'النهارده', from: today },
    { k: 'yesterday', label: 'امبارح', from: today - DAY },
  ];
  for (let i = 2; i <= 6; i++) list.push({ k: 'day' + i, label: dayName(today - i * DAY), from: today - i * DAY });
  list.push({ k: 'month', label: 'من أسبوع لشهر', from: today - 30 * DAY });
  list.push({ k: 'older', label: 'أقدم من شهر', from: -Infinity });
  return list;
}
function renderGroupBtn() {
  const time = ui.groupBy === 'time';
  const b = $('groupBy');
  b.innerHTML = time
    ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  b.title = time ? 'مقسمة حسب الوقت (اضغط للتقسيم بالبروجكت)' : 'مقسمة حسب البروجكت (اضغط للتقسيم بالوقت)';
  b.classList.toggle('on', time);
}
$('groupBy').onclick = () => {
  ui.groupBy = ui.groupBy === 'time' ? 'project' : 'time';
  saveUi();
  renderGroupBtn();
  toast(ui.groupBy === 'time' ? 'التقسيم: حسب الوقت' : 'التقسيم: حسب البروجكت');
  if (ui.groupBy === 'time' && !dateActive()) { sess.list = null; renderSessions(); }
  loadSessions();
};

// A colored initial per project (hue from the name) so groups are easy to tell apart at a glance.
function hueOf(str) { let h = 0; for (const c of str) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; }
const CAL_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
function groupHead({ key, title, tip, avatar, count, rows, shut, isStatic, icon }) {
  const live = rows.filter(({ s }) => sessLive(s)).length;
  const asking = rows.filter(({ s }) => s.state === 'asking').length;
  const last = rows.reduce((m, { s }) => Math.max(m, s.active || s.mtime), 0);
  const ava = icon
    ? `<span class="pj-ava icon">${icon}</span>`
    : `<span class="pj-ava" style="--h:${hueOf(avatar)}">${esc((avatar.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span>`;
  const sub = [`${count} ${count === 1 ? 'سيشن' : 'سيشنز'}`, last ? ago(last) : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="proj-name${isStatic ? ' static' : ''}" ${isStatic ? 'tabindex="-1"' : `aria-expanded="${!shut}"`} title="${esc(tip || title)}" data-key="${esc(key)}">` +
    ava + `<span class="pj-txt"><span class="pj-title" dir="${textDir(title)}">${esc(title)}</span><span class="pj-sub">${esc(sub)}</span></span>` +
    (asking ? `<span class="pj-badge ask" title="${asking} مستنية ردك">${asking}</span>` : '') +
    (live ? `<span class="pj-badge live" title="${live} شغالة دلوقتي">${live}</span>` : '') +
    (isStatic ? '' : `<span class="pj-chev">${ICON.chevDown}</span>`) + '</button>';
}

function sessRow(p, s, now, withProject) {
  const act = activePane && activePane.key;
  const splitBtn = `<button class="split-btn" data-split title="افتح في عمود جديد (Ctrl+كليك)">${SPLIT_ICON}</button>`;
  const agents = s.agents || [];
  const live = now - (s.active || s.mtime) < 90e3;
  const on = shown(p.dir, s.id, '');
  const isAct = on && act && act.id === s.id && !act.agent;
  const pin = isPinned(s);
  let html = `<div class="sess${on ? ' on' : ''}${isAct ? ' act' : ''}${pin ? ' pinned' : ''}" data-dir="${esc(p.dir)}" data-id="${esc(s.id)}" title="${esc(s.title)}">` +
    `<span class="dot${live ? ' live' : ''}"></span><div class="st"><div class="stt" dir="${textDir(s.title)}">${esc(s.title)}</div>` +
    `<div class="sm${live ? ' live' : ''}">${s.state === 'asking' ? '<span class="ask-badge">مستنية ردك</span>' : live ? 'شغالة دلوقتي' : ago(s.active || s.mtime)}` +
    `${withProject ? ` · <span class="sm-proj">${esc(p.name)}</span>` : ''}</div></div>` +
    `<span class="row-acts"><button class="pin-btn${pin ? ' on' : ''}" data-pin title="${pin ? 'إلغاء التثبيت' : 'ثبّتها فوق'}">${PIN_ICON}</button>${splitBtn}</span></div>`;
  if (agents.length) {
    const open = agentsOpen(s);
    const liveA = agents.filter((a) => isLive(a.mtime)).length;
    html += `<button class="agents-toggle${open ? ' open' : ''}" data-sid="${esc(s.id)}" data-open="${open ? 1 : 0}">${ICON.chev}` +
      `<span>${agents.length === 1 ? 'subagent واحد' : agents.length + ' subagents'}</span>` +
      (liveA ? `<span class="live-badge">${liveA} شغال</span>` : '') + '</button>';
    if (open) {
      html += '<div class="agents">' + agents.map((a) => {
        const al = isLive(a.mtime);
        const aon = shown(p.dir, s.id, a.id);
        const name = a.description || 'subagent';
        const meta = [a.type, a.model, al ? 'شغال دلوقتي' : ago(a.mtime)].filter(Boolean).join(' · ');
        return `<div class="sess agent${aon ? ' on' : ''}" data-dir="${esc(p.dir)}" data-id="${esc(s.id)}" data-agent="${esc(a.id)}" title="${esc(name)}">` +
          `<span class="dot${al ? ' live' : ''}"></span><div class="st"><div class="stt" dir="${textDir(name)}">${esc(name)}</div>` +
          `<div class="sm${al ? ' live' : ''}">${esc(meta)}</div></div><span class="row-acts">${splitBtn}</span></div>`;
      }).join('') + '</div>';
    }
  }
  return html;
}

function renderSessions() {
  updateFoldBtn();
  const lb = $('liveBadge');
  const n = liveCount();
  lb.className = n ? 'live-badge' : '';
  lb.textContent = n ? n : '';
  lb.title = n ? `${n} سيشن شغالة دلوقتي` : '';

  if (!SRC.ready || serverOff) {
    $('sessFilters').innerHTML = '';
    sessList.innerHTML = connectHtml();
    return;
  }
  if (!sess.list) {
    sessList.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    return;
  }
  renderFilters();
  const f = $('sessFilter').value.trim().toLowerCase();
  const qk = ui.sessFilter || 'all';
  const filtering = !!f || qk !== 'all' || dateActive();
  const now = Date.now();
  const textOk = (p, s) => inDate(s) && (!f || s.title.toLowerCase().includes(f) || p.name.toLowerCase().includes(f));
  let html = '';
  // pinned sessions first, across projects (shown only here, not again under their project)
  const pinned = sess.list.flatMap((p) => p.sessions.filter((s) => isPinned(s) && textOk(p, s) && matchesQuick(p, s, qk)).map((s) => ({ p, s })));
  if (pinned.length) {
    html += `<div class="proj pinned-group">` + groupHead({ key: 'pinned', title: 'مثبتة', avatar: '', icon: PIN_ICON, count: pinned.length, rows: pinned, isStatic: true }) +
      pinned.map(({ p, s }) => sessRow(p, s, now, true)).join('') + '</div>';
  }
  if (qk !== 'pinned' && ui.groupBy === 'time') {
    // group by when you last worked in the session
    const buckets = timeBuckets().map((b) => ({ ...b, rows: [] }));
    sess.list.forEach((p) => p.sessions.forEach((s) => {
      if (isPinned(s) || !textOk(p, s) || !matchesQuick(p, s, qk)) return;
      const t = s.active || s.mtime;
      buckets.find((b) => t >= b.from).rows.push({ p, s, t });
    }));
    buckets.forEach((b) => {
      if (!b.rows.length) return;
      b.rows.sort((x, y) => y.t - x.t);
      const key = 't:' + b.k;
      const shut = ui.shut.includes(key) && !f;
      html += `<div class="proj${shut ? ' shut' : ''}" data-dir="${key}">` +
        groupHead({ key, title: b.label, avatar: '', icon: CAL_ICON, count: b.rows.length, rows: b.rows, shut }) +
        b.rows.map(({ p, s }) => sessRow(p, s, now, true)).join('') + '</div>';
    });
  }
  if (qk !== 'pinned' && ui.groupBy !== 'time') {
    sess.list.forEach((p) => {
      const rows = p.sessions.filter((s) => !isPinned(s) && textOk(p, s) && matchesQuick(p, s, qk));
      if (!rows.length) return;
      const shut = ui.shut.includes(p.dir) && !f;
      html += `<div class="proj${shut ? ' shut' : ''}" data-dir="${esc(p.dir)}">` +
        groupHead({ key: p.dir, title: p.name, tip: p.cwd, avatar: p.name, count: filtering ? rows.length : p.total || rows.length, rows: rows.map((s) => ({ p, s })), shut });
      html += rows.map((s) => sessRow(p, s, now, false)).join('');
      const showingAll = (ui.moreProj || []).includes(p.dir);
      if (!filtering && (showingAll || (p.total || 0) > p.sessions.length)) {
        html += `<button class="more-btn" data-more="${esc(p.dir)}">${showingAll ? 'عرض آخر 15 بس' : `عرض الكل (${p.total})`}</button>`;
      }
      html += '</div>';
    });
  }
  const emptyMsg = { live: 'مفيش سيشن شغالة دلوقتي.', asking: 'مفيش سيشن مستنية ردك.', open: 'مفيش سيشن مفتوحة في الأعمدة.', pinned: 'مفيش سيشنز مثبتة. اضغط الدبوس جنب أي سيشن.' }[qk];
  const scroll = sessList.scrollTop;
  sessList.innerHTML = html || `<div class="empty">${f ? 'مفيش سيشن بالاسم ده.' : emptyMsg || (dateActive() ? 'مفيش سيشنز في الفترة دي.' : 'مفيش سيشنز لسه.')}</div>`;
  sessList.scrollTop = scroll;
}

// collapse / expand every project at once
function allDirs() {
  return ui.groupBy === 'time' ? timeBuckets().map((b) => 't:' + b.k) : (sess.list || []).map((p) => p.dir);
}
function updateFoldBtn() {
  const dirs = allDirs();
  const allShut = dirs.length && dirs.every((d) => ui.shut.includes(d));
  const b = $('foldAll');
  b.innerHTML = allShut
    ? '<svg viewBox="0 0 24 24"><path d="M7 15l5 5 5-5M7 9l5-5 5 5"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M7 20l5-5 5 5M7 4l5 5 5-5"/></svg>';
  b.title = allShut ? 'فتح كل المجموعات' : 'طي كل المجموعات';
  b.dataset.mode = allShut ? 'open' : 'shut';
}
$('foldAll').onclick = () => {
  const open = $('foldAll').dataset.mode === 'open';
  ui.shut = open ? [] : allDirs();
  ui.openAgents = [];
  // collapsing also closes every subagent list (even live ones); expanding returns them to the default
  ui.closedAgents = open ? [] : (sess.list || []).flatMap((p) => p.sessions.filter((s) => (s.agents || []).length).map((s) => s.id));
  saveUi();
  renderSessions();
};

function liveQuickList() {
  const live = [];
  (sess.list || []).forEach((p) => p.sessions.forEach((s) => { if (isLive(s.active || s.mtime)) live.push({ p, s }); }));
  return live.length ? '<div class="quick">' + live.map(({ p, s }) =>
    `<button class="btn" data-dir="${esc(p.dir)}" data-id="${esc(s.id)}"><span class="dot live"></span><span dir="auto">${esc(s.title)}</span><span class="count">${esc(p.name)}</span></button>`).join('') + '</div>' : '';
}
function renderEmptyView() {
  const box = $('vempty');
  if (!box.hidden) {
    box.innerHTML = '<div><h2>اختار سيشن</h2><p>كل سيشن بتتحدث هنا أول بأول. Ctrl+كليك أو زرار العمود بيفتحها جنب التانية.</p>' + liveQuickList() + '</div>';
  }
  panes.forEach((p) => { if (!p.key) p.renderEmpty(); });
}
$('vempty').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) openIn({ dir: b.dataset.dir, id: b.dataset.id, title: b.querySelector('[dir]').textContent });
});

$('sessFilter').addEventListener('input', renderSessions);
$('sessFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-qf]');
  if (!b) return;
  ui.sessFilter = b.dataset.qf === ui.sessFilter ? 'all' : b.dataset.qf;
  saveUi();
  renderSessions();
});
$('sessFilter').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; renderSessions(); } });

function sessTarget(el) {
  return { dir: el.dataset.dir, id: el.dataset.id, agent: el.dataset.agent || '', title: el.querySelector('.stt').textContent };
}
sessList.addEventListener('click', (e) => {
  if (e.target.closest('[data-start]')) return startServer();
  if (e.target.closest('[data-pick]')) return connectFolder(false);
  if (e.target.closest('[data-reconnect]')) return connectFolder(true);
  const pn = e.target.closest('.proj-name:not(.static)');
  if (pn) {
    const dir = pn.parentElement.dataset.dir;
    ui.shut = ui.shut.includes(dir) ? ui.shut.filter((d) => d !== dir) : [...ui.shut, dir];
    const nowShut = pn.parentElement.classList.toggle('shut');
    pn.setAttribute('aria-expanded', String(!nowShut));
    updateFoldBtn(); // keep the collapse-all / expand-all button in sync
    saveUi();
    return;
  }
  const pb = e.target.closest('[data-pin]');
  if (pb) {
    const id = pb.closest('.sess').dataset.id;
    ui.pinned = isPinned({ id }) ? ui.pinned.filter((x) => x !== id) : [...(ui.pinned || []), id];
    saveUi();
    renderSessions();
    return;
  }
  const mb = e.target.closest('[data-more]');
  if (mb) {
    const dir = mb.dataset.more;
    ui.moreProj = (ui.moreProj || []).includes(dir) ? ui.moreProj.filter((d) => d !== dir) : [...(ui.moreProj || []), dir];
    mb.textContent = 'بيحمّل…';
    saveUi();
    loadSessions();
    return;
  }
  const at = e.target.closest('.agents-toggle');
  if (at) {
    const sid = at.dataset.sid;
    const wasOpen = at.dataset.open === '1';
    ui.openAgents = ui.openAgents.filter((x) => x !== sid);
    ui.closedAgents = ui.closedAgents.filter((x) => x !== sid);
    (wasOpen ? ui.closedAgents : ui.openAgents).push(sid);
    saveUi();
    renderSessions();
    return;
  }
  const s = e.target.closest('.sess');
  if (s) openIn(sessTarget(s), { newPane: !!e.target.closest('[data-split]') || e.ctrlKey || e.metaKey });
});
sessList.addEventListener('auxclick', (e) => { // middle click = new pane
  const s = e.target.closest('.sess');
  if (s && e.button === 1) { e.preventDefault(); openIn(sessTarget(s), { newPane: true }); }
});

// ---------- line diff for Edit / MultiEdit / Write ----------
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  let mid = [];
  const n = a2.length, m = b2.length;
  if (n * m > 250000) {
    mid = [...a2.map((s) => ['-', s]), ...b2.map((s) => ['+', s])];
  } else {
    // LCS table, then walk it to emit -, +, and unchanged lines
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a2[i] === b2[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { mid.push([' ', a2[i]]); i++; j++; }
      else if (j < m && (i >= n || dp[i * (m + 1) + j + 1] >= dp[(i + 1) * (m + 1) + j])) { mid.push(['+', b2[j]]); j++; }
      else { mid.push(['-', a2[i]]); i++; }
    }
  }
  return [...A.slice(0, pre).map((s) => [' ', s]), ...mid, ...A.slice(A.length - suf).map((s) => [' ', s])];
}

function diffHtml(d) {
  let add = 0, del = 0;
  const parts = d.edits.map((e) => {
    const lines = d.write ? e.new.split('\n').map((s) => ['+', s]) : lineDiff(e.old, e.new);
    let html = '', run = [];
    const ctx = (l) => `<div class="dl"><span class="sg"> </span><span>${esc(l[1]) || ' '}</span></div>`;
    const flush = (end) => {
      // keep 3 lines of context around changes, fold the rest
      if (run.length > 7) {
        const head = html ? run.slice(0, 3) : [];
        const tail = end ? [] : run.slice(-3);
        html += head.map(ctx).join('') + `<div class="dl gap">⋯ ${run.length - head.length - tail.length} سطر من غير تغيير</div>` + tail.map(ctx).join('');
      } else html += run.map(ctx).join('');
      run = [];
    };
    const head = lines.slice(0, 600);
    head.forEach((l) => {
      if (l[0] === ' ') { run.push(l); return; }
      flush(false);
      if (l[0] === '+') add++; else del++;
      html += `<div class="dl ${l[0] === '+' ? 'add' : 'del'}"><span class="sg">${l[0] === '+' ? '+' : '−'}</span><span>${esc(l[1]) || ' '}</span></div>`;
    });
    flush(true);
    if (lines.length > head.length) html += `<div class="dl gap">⋯ و ${lines.length - head.length} سطر كمان</div>`;
    return html;
  });
  const file = d.file ? `<div class="df-file">${esc(d.file)}${d.write ? ' · ملف جديد / مكتوب من الأول' : ''}${d.all ? ' · كل التكرارات' : ''}</div>` : '';
  return {
    stat: `<span class="stat"><span class="a">+${add}</span> <span class="d">−${del}</span></span>`,
    body: `<div class="diff" dir="ltr">${file}${parts.join('<div class="df-sep"></div>')}</div>`,
  };
}

// ---------- search helpers ----------
const isAlive = (x) => (x instanceof Range ? x.startContainer.isConnected : x.isConnected);
// one shared highlight for all panes' matches, one for each pane's current match
function paintHighlights() {
  if (!window.CSS || !CSS.highlights) return;
  const all = new Highlight(), cur = new Highlight();
  panes.forEach((p) => {
    (p.hits || []).forEach((r) => all.add(r));
    if (p.hits && p.hits[p.hitIndex]) cur.add(p.hits[p.hitIndex]);
  });
  cur.priority = 1;
  CSS.highlights.set('pad-hit', all);
  CSS.highlights.set('pad-cur', cur);
}
const SEARCH_DELAY = 450; // ms of no typing before searching
const MIN_QUERY = 2;      // shorter plain queries wait for Enter
function searchOpts() { return { case: false, word: false, regex: false, scope: 'all', ...(ui.searchOpts || {}) }; }
// Plain queries are Arabic-friendly: أ/إ/آ/ا, ي/ى and ه/ة match each other, tashkeel and tatweel are
// ignored, and any run of spaces matches any whitespace. Regex mode uses the query as written.
function buildSearchRe(q, o) {
  if (!q || !q.trim()) return null;
  let src;
  if (o.regex) src = q;
  else {
    src = [...q.trim()].map((ch) => {
      if (/\s/.test(ch)) return '\\s+';
      if (/[اأإآ]/.test(ch)) return '[اأإآ]';
      if (/[يى]/.test(ch)) return '[يى]';
      if (/[هة]/.test(ch)) return '[هة]';
      return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }).join('[\\u064B-\\u0652\\u0640]*');
  }
  if (o.word) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(src, 'gu' + (o.case ? '' : 'i')); } catch (e) { return 'bad'; }
}

function imgsHtml(list) {
  return list.map((u) => `<a class="shot" href="${esc(u)}" data-img><img src="${esc(u)}" loading="lazy" alt="صورة"></a>`).join('');
}

// ---------- one pane = one live session / subagent transcript ----------
class Pane {
  constructor() {
    this.key = null;
    this.es = null;
    this.title = '';
    this.el = document.createElement('section');
    this.el.className = 'pane-v';
    this.el.innerHTML =
      '<header class="phead"><span class="dot plive"></span>' +
      '<div class="vt"><div class="ptitle" dir="auto"></div><div class="pmeta"></div></div>' +
      `<button class="icon-btn" data-a="search" title="دوّر في السيشن دي (Ctrl+F)"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button>` +
      `<button class="icon-btn" data-a="width" title="عرض المحتوى (Ctrl+Alt+← →)"><svg viewBox="0 0 24 24"><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg></button>` +
      `<button class="icon-btn" data-a="split" title="عمود جديد جنبها">${SPLIT_ICON}</button>` +
      `<button class="icon-btn" data-a="close" title="قفل العمود">${ICON.x}</button></header>` +
      '<div class="pagents" hidden></div>' +
      '<div class="psearch" hidden><div class="ps-row">' +
      '<label class="field ps-field"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="ps-q" placeholder="دوّر في السيشن دي" autocomplete="off" spellcheck="false"></label>' +
      '<span class="ps-count"></span>' +
      '<button class="icon-btn" data-s="prev" title="اللي قبلها (Shift+Enter)"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>' +
      '<button class="icon-btn" data-s="next" title="اللي بعدها (Enter)"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<span class="ps-sep"></span>' +
      '<button class="ps-opt" data-opt="case" title="فرّق بين الحروف الكبيرة والصغيرة">Aa</button>' +
      '<button class="ps-opt" data-opt="word" title="كلمة كاملة بس">ab</button>' +
      '<button class="ps-opt" data-opt="regex" title="Regex">.*</button>' +
      '<select class="ps-scope" title="دوّر فين"><option value="all">في كل حاجة</option><option value="user">رسايلي بس</option><option value="ai">ردود Claude</option><option value="tools">الأوامر ونتايجها</option></select>' +
      '<button class="icon-btn" data-s="list" title="لستة النتايج"><svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg></button>' +
      `<button class="icon-btn" data-s="close" title="قفل البحث (Esc)">${ICON.x}</button>` +
      '</div><div class="ps-list" hidden></div></div>' +
      '<div class="pmain"><div class="pscroll"><div class="ppin" hidden></div><div class="pbody page"></div></div>' +
      '<nav class="prail" aria-label="رسايلك"><div class="rail-nav">' +
      '<button class="icon-btn" data-nav="first" title="أول السيشن (Home)"><svg viewBox="0 0 24 24"><path d="M6 11l6-6 6 6M6 18l6-6 6 6"/></svg></button>' +
      '<button class="icon-btn" data-nav="prev" title="رسالتك اللي قبلها (Alt+↑)"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>' +
      '<button class="icon-btn" data-nav="next" title="رسالتك اللي بعدها (Alt+↓)"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<button class="icon-btn" data-nav="last" title="آخر السيشن (End)"><svg viewBox="0 0 24 24"><path d="M6 6l6 6 6-6M6 13l6 6 6-6"/></svg></button>' +
      '<button class="icon-btn rail-wide" data-nav="wide" title="وسّع / ضيّق لستة الرسايل"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg></button>' +
      '</div><div class="rail-count"></div><div class="rail-list"></div></nav></div>' +
      '<button class="btn primary pjump" hidden></button>';
    this.q = (s) => this.el.querySelector(s);
    this.scroll = this.q('.pscroll');
    this.body = this.q('.pbody');
    this.reset();

    this.el.addEventListener('pointerdown', () => setActive(this), true);
    this.q('.phead').addEventListener('click', (e) => this.onHead(e));
    this.q('.pagents').addEventListener('click', (e) => this.onAgents(e));
    this.q('.pjump').onclick = () => this.toBottom(true);
    this.rail = this.q('.prail');
    this.rail.classList.toggle('wide', !!ui.railWide);
    this.rail.addEventListener('click', (e) => this.onRail(e));
    this.q('.rail-list').addEventListener('scroll', () => this.railFade(), { passive: true });
    this.hits = [];
    this.hitIndex = -1;
    const box = this.q('.psearch'), qi = this.q('.ps-q');
    // Search waits until you pause typing (SEARCH_DELAY ms), skips 1-character queries (they match
    // everything) unless you press Enter, and never re-runs for a query it has already run.
    qi.addEventListener('input', (e) => {
      if (e.isComposing) return;
      this.scheduleSearch();
    });
    qi.addEventListener('compositionend', () => this.scheduleSearch());
    qi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.searchSig() !== this.lastSig) { clearTimeout(this.searchT); this.runSearch(false, true); } // run now
        else this.stepHit(e.shiftKey ? -1 : 1);
      }
      else if (e.key === 'Escape') { e.preventDefault(); this.searchClose(); }
    });
    this.q('.ps-scope').addEventListener('change', (e) => { ui.searchOpts = { ...searchOpts(), scope: e.target.value }; saveUi(); this.scheduleSearch(); });
    box.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-opt]');
      if (opt) {
        const o = searchOpts();
        o[opt.dataset.opt] = !o[opt.dataset.opt];
        ui.searchOpts = o;
        saveUi();
        panes.forEach((p) => p.syncSearchOpts());
        this.scheduleSearch();
        return;
      }
      const b = e.target.closest('[data-s]');
      if (b) {
        if (b.dataset.s === 'close') this.searchClose();
        else if (b.dataset.s === 'list') { const l = this.q('.ps-list'); l.hidden = !l.hidden; b.classList.toggle('on', !l.hidden); this.renderHitList(); }
        else this.stepHit(b.dataset.s === 'next' ? 1 : -1);
        return;
      }
      const it = e.target.closest('.ps-item');
      if (it) this.goHit(+it.dataset.i);
    });
    enhanceSelect(this.q('.ps-scope'), 'ps-dd');
    this.syncSearchOpts();
    this.body.addEventListener('click', (e) => this.onBody(e));
    // images load after layout; keep following the bottom if that's where the reader was
    this.body.addEventListener('load', (e) => {
      if (e.target.tagName !== 'IMG') return;
      if (this.anchor && Date.now() < this.anchor.until && isAlive(this.anchor.el)) this.align();
      else if (this.stick !== false && !this.restoring) this.scroll.scrollTop = this.scroll.scrollHeight;
    }, true);
    this.scroll.addEventListener('wheel', () => { this.anchor = null; this.stopAnimation(); }, { passive: true });
    this.scroll.addEventListener('scroll', throttle(() => {
      if (!this.key) return;
      const bottom = this.atBottom();
      ui.viewScroll[keyOf(this.key)] = bottom ? null : this.scroll.scrollTop;
      this.stick = bottom;
      if (bottom) { this.unseen = 0; this.q('.pjump').hidden = true; }
      this.spy();
      saveUi();
    }, 150));
  }

  // ---------- message rail: your prompts in order, click to jump ----------
  prompts() { return [...this.body.querySelectorAll('.msg.user')]; }
  posOf(el) {
    if (el instanceof Range) {
      let host = el.startContainer.parentElement, closed = null;
      for (let d = host && host.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) closed = d;
      if (closed) el = closed; // hidden inside a collapsed block: use the block's position
    }
    return el.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop;
  }
  jumpTo(el) {
    this.stick = false;
    this.anchor = { el, mode: 'top', until: Date.now() + 2000 };
    this.animateTo(() => this.anchorTop(), () => this.flash(el));
  }
  // where the current anchor wants the pane scrolled to
  anchorTop() {
    const { el, mode } = this.anchor;
    const pin = this.q('.ppin');
    const off = (pin.hidden ? 0 : pin.offsetHeight) + 12;
    return mode === 'center' ? this.posOf(el) - this.scroll.clientHeight / 2 : Math.max(0, this.posOf(el) - off);
  }
  // re-apply the last jump after late layout changes (lazy images above it)
  align() {
    if (!this.animating) this.scroll.scrollTop = this.anchorTop();
  }
  // Eased scroll (ease-out-quart). Long jumps stay short (max ~650ms) but you still see the motion.
  // The target is re-read every frame, so images loading on the way don't make it miss.
  animateTo(getTarget, done) {
    cancelAnimationFrame(this.animId);
    const start = this.scroll.scrollTop;
    const dist = Math.abs(getTarget() - start);
    if (dist < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.scroll.scrollTop = getTarget();
      if (done) done();
      return;
    }
    const dur = Math.min(650, 240 + Math.sqrt(dist) * 3.2);
    const t0 = performance.now();
    this.animating = true;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      this.scroll.scrollTop = start + (getTarget() - start) * e;
      if (p < 1) this.animId = requestAnimationFrame(step);
      else { this.animating = false; if (done) done(); }
    };
    this.animId = requestAnimationFrame(step);
  }
  stopAnimation() {
    cancelAnimationFrame(this.animId);
    this.animating = false;
  }
  // brief glow on the message you landed on
  flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove('flash'), 1300);
  }
  renderRail() {
    const list = this.prompts();
    // narrow rail: just the number; wide rail: number + word
    const word = list.length === 1 ? 'رسالة' : 'رسايل';
    this.q('.rail-count').innerHTML = list.length ? `<b>${list.length}</b><span class="rc-w"> ${word}</span><span class="rc-cap">${word}</span>` : '';
    this.q('.rail-count').title = `بعتّ ${list.length} رسالة في السيشن دي`;
    this.q('.rail-list').innerHTML = list.map((el, i) => {
      const text = (el._raw || '').replace(/\s+/g, ' ').trim() || '[صورة]';
      return `<button class="rail-item" data-i="${i}" title="${esc(text.slice(0, 300))}">` +
        `<span class="ri-n">${i + 1}</span><span class="ri-body"><span class="ri-t" dir="${textDir(text)}">${esc(text.slice(0, 200))}</span>` +
        `<span class="ri-time">${esc(el._time || '')}</span></span></button>`;
    }).join('');
    this.cur = -1;
    this.spy();
    this.railFade();
  }
  railFade() {
    const l = this.q('.rail-list');
    l.classList.toggle('fade-top', l.scrollTop > 8);
    l.classList.toggle('fade-bottom', l.scrollTop + l.clientHeight < l.scrollHeight - 2);
  }
  // highlight the prompt you're currently reading
  spy() {
    const list = this.prompts();
    const line = this.scroll.scrollTop + 90;
    let cur = -1;
    for (let i = 0; i < list.length; i++) { if (this.posOf(list[i]) <= line) cur = i; else break; }
    if (this.atBottom() && list.length) cur = Math.max(cur, 0);
    if (cur === this.cur) return;
    this.cur = cur;
    this.q('.rail-list').querySelectorAll('.rail-item').forEach((b, i) => b.classList.toggle('cur', i === cur));
    const on = this.q('.rail-item.cur');
    if (on) { on.scrollIntoView({ block: 'nearest' }); this.railFade(); }
  }
  nav(where) {
    const list = this.prompts();
    // stop following the bottom, or lazy images loading at the new spot would pull us back down
    this.stick = where === 'last';
    // big jumps are instant: smooth-scrolling a long session takes seconds
    if (where === 'first') { this.anchor = null; this.animateTo(() => 0); return; }
    if (where === 'last') { this.toBottom(true); return; }
    if (!list.length) return;
    const pin = this.q('.ppin');
    const anchor = this.scroll.scrollTop + (pin.hidden ? 0 : pin.offsetHeight) + 12; // where jumpTo() puts a message
    let i;
    if (where === 'prev') {
      i = -1;
      list.forEach((el, k) => { if (this.posOf(el) < anchor - 8) i = k; });
      if (i < 0) { this.anchor = null; this.animateTo(() => 0); return; }
    } else {
      i = list.findIndex((el) => this.posOf(el) > anchor + 8);
      if (i < 0) { this.toBottom(true); return; }
    }
    this.jumpTo(list[i]);
  }
  onRail(e) {
    const it = e.target.closest('.rail-item');
    if (it) { this.jumpTo(this.prompts()[+it.dataset.i]); return; }
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    if (b.dataset.nav === 'wide') {
      ui.railWide = !ui.railWide;
      panes.forEach((p) => p.rail.classList.toggle('wide', ui.railWide));
      saveUi();
      return;
    }
    this.nav(b.dataset.nav);
  }

  atBottom() { return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 120; }
  toBottom(smooth) {
    this.anchor = null;
    this.stick = true;
    const bottom = () => this.scroll.scrollHeight - this.scroll.clientHeight;
    if (smooth) this.animateTo(bottom);
    else this.scroll.scrollTop = bottom();
  }

  reset() {
    this.tools = {};
    this.group = null;
    this.pendingUser = null;
    this.unseen = 0;
    this.todos = null;
    this.plan = null;
    this.renderPin();
    this.cur = -1;
    if (this.hits && this.hits.length) { this.hits = []; this.hitIndex = -1; this.lastSig = null; paintHighlights(); }
    if (this.rail) { this.q('.rail-list').innerHTML = ''; this.q('.rail-count').textContent = ''; }
    this.body.innerHTML = this.key ? '<div class="vskel"><div style="width:40%"></div><div></div><div style="width:85%"></div><div style="width:70%"></div></div>' : '';
    this.q('.pjump').hidden = true;
  }

  open(k, restoring) {
    if (this.es) { this.es.close(); this.es = null; }
    this.key = { dir: k.dir, id: k.id, agent: k.agent || '' };
    this.title = k.title || '';
    this.restoring = !!restoring;
    this.q('.ptitle').textContent = this.title;
    this.q('.pmeta').textContent = '';
    this.rail.hidden = false;
    this.reset();
    this.renderHead();
    if (!SRC.ready || serverOff) return;
    this.es = SRC.open(this.key, {
      reset: () => this.reset(), // the whole file is replayed on every (re)connect
      events: (ev) => this.append(ev),
      ready: () => this.onReady(),
    });
  }

  onReady() {
    const skel = this.body.querySelector('.vskel');
    if (skel) skel.remove();
    const saved = ui.viewScroll[keyOf(this.key)];
    // restore where you were reading after a reload; otherwise jump to the latest message
    const restoreMid = typeof saved === 'number' && this.restoring;
    this.scroll.scrollTop = restoreMid ? saved : this.scroll.scrollHeight;
    this.stick = !restoreMid;
    this.restoring = false;
    this.renderRail();
  }

  destroy() {
    if (this.es) { this.es.close(); this.es = null; }
    this.hits = [];
    this.el.remove();
  }

  // empty pane: pick a session from the sidebar or a live one here
  renderEmpty() {
    this.rail.hidden = true;
    this.q('.ptitle').textContent = 'عمود فاضي';
    this.q('.pmeta').textContent = 'اختار سيشن من الشريط وهتتفتح هنا';
    this.q('.plive').classList.remove('live');
    this.q('.pagents').hidden = true;
    this.body.innerHTML = `<div class="vempty-in"><p>اضغط على أي سيشن في الشريط تتفتح في العمود ده.</p>${liveQuickList()}</div>`;
  }

  renderHead() {
    if (!this.key) { this.renderEmpty(); return; }
    const f = findSession(this.key.dir, this.key.id);
    const bar = this.q('.pagents');
    if (!f) { bar.hidden = true; return; }
    const { p, s } = f;
    const a = this.key.agent ? (s.agents || []).find((x) => x.id === this.key.agent) : null;
    const ms = a ? a.mtime : s.mtime;
    const live = isLive(ms);
    this.q('.plive').classList.toggle('live', live);
    const status = s.state === 'asking' && !a ? '<span class="ask-badge">مستنية ردك</span>'
      : live ? '<span class="live-badge">مباشر</span>' : `<span>آخر تحديث ${ago(ms)}</span>`;
    if (a) {
      const kind = ['subagent', a.type, a.model].filter(Boolean).join(' · ');
      this.q('.pmeta').innerHTML = `<span>${esc(kind)}</span><span>·</span><button class="parent-link" data-parent>من: ${esc(s.title.slice(0, 50))}</button><span>·</span>${status}`;
      if (!this.title) { this.title = a.description || 'subagent'; this.q('.ptitle').textContent = this.title; }
    } else {
      this.q('.pmeta').innerHTML = `<span>${esc(p.name)}</span><span>·</span>${status}`;
      if (!this.title) { this.title = s.title; this.q('.ptitle').textContent = this.title; }
    }
    // subagents of this session, live ones first: click to open here, Ctrl+click for a new pane
    const agents = (s.agents || []).slice().sort((x, y) => (isLive(y.mtime) - isLive(x.mtime)) || (y.born - x.born));
    if (!agents.length) { bar.hidden = true; return; }
    const liveN = agents.filter((x) => isLive(x.mtime)).length;
    bar.innerHTML = `<span class="pa-label">${agents.length === 1 ? 'subagent' : agents.length + ' subagents'}${liveN ? ` · <b>${liveN} شغال</b>` : ''}</span>` +
      (a ? `<button class="chip pa" data-parent>${ICON.chev}السيشن الأساسية</button>` : '') +
      agents.map((x) => `<button class="chip pa${a && a.id === x.id ? ' cur' : ''}" data-agent="${esc(x.id)}" title="${esc([x.description, x.type, x.model].filter(Boolean).join(' · '))}">` +
        `<span class="dot${isLive(x.mtime) ? ' live' : ''}"></span><span class="pa-t" dir="auto">${esc(x.description || 'subagent')}</span></button>`).join('');
    bar.hidden = false;
  }

  onHead(e) {
    const b = e.target.closest('[data-a],[data-parent]');
    if (!b) return;
    if (b.dataset.parent !== undefined) { this.open({ dir: this.key.dir, id: this.key.id }); afterPaneChange(); return; }
    const a = b.dataset.a;
    if (a === 'close') closePane(this);
    else if (a === 'bottom') this.toBottom(true);
    else if (a === 'split') { const p = addPane(); setActive(p); afterPaneChange(); }
    else if (a === 'width') openWidthMenu(b);
    else if (a === 'search') { if (this.q('.psearch').hidden) this.searchOpen(); else this.searchClose(); }
  }

  onAgents(e) {
    const b = e.target.closest('[data-agent],[data-parent]');
    if (!b) return;
    const target = b.dataset.agent
      ? { dir: this.key.dir, id: this.key.id, agent: b.dataset.agent, title: b.querySelector('.pa-t').textContent }
      : { dir: this.key.dir, id: this.key.id };
    if (e.ctrlKey || e.metaKey) openIn(target, { newPane: true });
    else { this.open(target); afterPaneChange(); }
  }

  async onBody(e) {
    const quick = e.target.closest('.quick [data-id]');
    if (quick) { this.open({ dir: quick.dataset.dir, id: quick.dataset.id, title: quick.querySelector('[dir]').textContent }); afterPaneChange(); return; }
    const shot = e.target.closest('[data-img]');
    if (shot) { e.preventDefault(); lbShow(this.body, [...this.body.querySelectorAll('[data-img]')].indexOf(shot)); return; }
    const oa = e.target.closest('[data-open-agent]');
    if (oa) {
      e.preventDefault(); // don't toggle the <details>
      const target = { dir: this.key.dir, id: this.key.id, agent: oa.dataset.openAgent, title: oa.closest('details.tool').dataset.sum };
      if (e.ctrlKey || e.metaKey) openIn(target, { newPane: true });
      else { this.open(target); afterPaneChange(); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const raw = b.closest('.msg')._raw;
    if (b.dataset.act === 'copy') { toast((await copyText(raw)) ? 'الرسالة اتنسخت' : 'النسخ فشل'); return; }
    save();
    state.pages.push({ id: uid(), html: md(raw), name: this.title.slice(0, 40) });
    save();
    renderThumbs();
    toast(`اتضافت كصفحة ${state.pages.length}`);
  }

  // ---------- search inside this session ----------
  syncSearchOpts() {
    const o = searchOpts();
    this.q('.psearch').querySelectorAll('[data-opt]').forEach((b) => b.classList.toggle('on', !!o[b.dataset.opt]));
    this.q('.ps-scope').value = o.scope || 'all';
    syncSelect(this.q('.ps-scope'));
  }
  searchOpen() {
    const box = this.q('.psearch'), qi = this.q('.ps-q');
    box.hidden = false;
    qi.focus();
    qi.select();
    if (qi.value) { this.lastSig = null; this.scheduleSearch(); }
  }
  searchClose() {
    this.q('.psearch').hidden = true;
    this.clearHits();
    this.hits = [];
    this.hitIndex = -1;
    this.lastSig = null;
    this.markRail();
  }
  searchSig() { return this.q('.ps-q').value + '\u0000' + JSON.stringify(searchOpts()); }
  scheduleSearch() {
    clearTimeout(this.searchT);
    const q = this.q('.ps-q').value;
    const o = searchOpts();
    const count = this.q('.ps-count');
    if (this.searchSig() === this.lastSig) { this.q('.ps-field').classList.remove('pending'); return; }
    if (!q.trim() || (!o.regex && q.trim().length < MIN_QUERY)) {
      // too short to be useful: clear right away instead of painting thousands of marks
      this.q('.ps-field').classList.remove('pending');
      if (this.hits.length || this.lastSig) this.runSearch(false, false, true);
      count.textContent = q.trim() ? 'Enter للبحث' : '';
      return;
    }
    this.q('.ps-field').classList.add('pending');
    count.textContent = '…';
    this.searchT = setTimeout(() => this.runSearch(false), SEARCH_DELAY);
  }
  clearHits() {
    this.hits = [];
    this.hitIndex = -1;
    paintHighlights();
  }
  // Matches are Range objects painted with the CSS Custom Highlight API: nothing is inserted into the
  // page, so searching and clearing stay fast even on very long sessions.
  runSearch(keepPlace, force, clearOnly) {
    const qi = this.q('.ps-q'), count = this.q('.ps-count');
    const t0 = performance.now();
    this.q('.ps-field').classList.remove('pending');
    this.lastSig = clearOnly ? null : this.searchSig();
    const prev = this.hits[this.hitIndex];
    const prevTop = prev && isAlive(prev) ? this.posOf(prev) : this.scroll.scrollTop;
    this.hits = [];
    this.hitIndex = -1;
    const o = searchOpts();
    const re = clearOnly ? null : buildSearchRe(qi.value, o);
    qi.parentElement.classList.toggle('bad', re === 'bad');
    if (!re || re === 'bad') {
      paintHighlights();
      count.textContent = re === 'bad' ? 'Regex غلط' : '';
      this.renderHitList();
      this.markRail();
      return;
    }
    const sel = { user: '.msg.user', ai: '.msg.ai', tools: 'details.tool' }[o.scope];
    const roots = sel ? [...this.body.querySelectorAll(sel)] : [this.body];
    const LIMIT = 5000;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('.msg-actions,.who,button,.vskel,.ri-n') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      while (walker.nextNode() && this.hits.length < LIMIT) {
        const node = walker.currentNode, text = node.nodeValue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) && this.hits.length < LIMIT) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const r = new Range();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          this.hits.push(r);
        }
      }
    }
    if (!this.hits.length) {
      paintHighlights();
      count.textContent = 'مفيش';
      this.renderHitList();
      this.markRail();
      return;
    }
    // start from where you are (or from the previous hit when results refresh): binary search on position
    const from = keepPlace ? prevTop - 1 : this.scroll.scrollTop;
    let lo = 0, hi = this.hits.length - 1, i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.posOf(this.hits[mid]) >= from) { i = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (i < 0) i = this.hits.length - 1;
    this.goHit(i, !keepPlace || !prev);
    this.renderHitList();
    this.markRail();
    count.title = `${this.hits.length} نتيجة في ${Math.round(performance.now() - t0)}ms`;
  }
  stepHit(d) {
    if (!this.hits.length) { if (this.q('.ps-q').value) this.runSearch(false, true); return; }
    this.goHit((this.hitIndex + d + this.hits.length) % this.hits.length, true);
  }
  goHit(i, scroll = true) {
    this.hitIndex = i;
    const r = this.hits[i];
    paintHighlights();
    this.q('.ps-count').textContent = `${i + 1} / ${this.hits.length}${this.hits.length >= 5000 ? '+' : ''}`;
    if (scroll) {
      const host = r.startContainer.parentElement;
      // open collapsed tool groups / outputs that hold the match
      for (let d = host.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
      this.stick = false;
      this.anchor = { el: r, mode: 'center', until: Date.now() + 2000 };
      requestAnimationFrame(() => {
        // reveal it inside an inner scroller (long command output) without jumping the pane itself
        const inner = host.closest('pre, .diff, table');
        if (inner && inner.scrollHeight > inner.clientHeight) {
          inner.scrollTop += r.getBoundingClientRect().top - inner.getBoundingClientRect().top - inner.clientHeight / 2;
        }
        this.animateTo(() => this.anchorTop());
      });
    }
    const li = this.q('.ps-list').querySelector('.ps-item.cur');
    if (li) li.classList.remove('cur');
    const now = this.q(`.ps-item[data-i="${i}"]`);
    if (now) { now.classList.add('cur'); now.scrollIntoView({ block: 'nearest' }); }
  }
  renderHitList() {
    const list = this.q('.ps-list');
    if (list.hidden) return;
    if (!this.hits.length) { list.innerHTML = '<div class="ps-empty">مفيش نتايج</div>'; return; }
    list.innerHTML = this.hits.slice(0, 300).map((h, i) => {
      const host = h.startContainer.parentElement;
      const tool = host.closest('details.tool');
      const kind = host.closest('.msg.user') ? 'إنت' : host.closest('.msg.ai') ? 'Claude' : tool ? tool.dataset.name : host.closest('details.tools') ? 'أوامر' : '';
      const block = host.closest('p,li,td,th,pre,summary,.dl,h1,h2,h3,h4,blockquote') || host;
      const r = document.createRange();
      r.setStart(block, 0);
      r.setEnd(h.startContainer, h.startOffset);
      const off = r.toString().length;
      const word = h.toString();
      const full = block.textContent;
      const a = Math.max(0, off - 50), b = Math.min(full.length, off + word.length + 60);
      const snip = (a ? '…' : '') + esc(full.slice(a, off)) + '<b>' + esc(word) + '</b>' + esc(full.slice(off + word.length, b)) + (b < full.length ? '…' : '');
      return `<button class="ps-item${i === this.hitIndex ? ' cur' : ''}" data-i="${i}"><span class="ps-kind">${esc(kind)}</span><span class="ps-snip" dir="${textDir(full.slice(a, b))}">${snip.replace(/\s+/g, ' ')}</span></button>`;
    }).join('') + (this.hits.length > 300 ? `<div class="ps-empty">أول 300 من ${this.hits.length}</div>` : '');
  }
  // dot the prompts on the rail whose part of the conversation has matches
  markRail() {
    const items = this.q('.rail-list').querySelectorAll('.rail-item');
    items.forEach((x) => x.classList.remove('has-hit'));
    if (!this.hits.length) return;
    const prompts = this.prompts();
    const counts = new Array(prompts.length).fill(0);
    let k = -1;
    const AFTER = Node.DOCUMENT_POSITION_FOLLOWING;
    // hits and prompts are both in document order, so one forward pass assigns each hit to its prompt
    for (const h of this.hits) {
      const n = h.startContainer;
      while (k + 1 < prompts.length && (prompts[k + 1].contains(n) || prompts[k + 1].compareDocumentPosition(n) & AFTER)) k++;
      if (k >= 0) counts[k]++;
    }
    items.forEach((x, j) => {
      if (counts[j]) { x.classList.add('has-hit'); x.dataset.hits = counts[j]; }
    });
  }

  renderPin() {
    const box = this.q('.ppin');
    const todos = this.todos, plan = this.plan;
    if (!todos && !plan) { box.hidden = true; box.innerHTML = ''; return; }
    let sum, body;
    if (todos) {
      const done = todos.filter((t) => t.status === 'completed').length;
      const now = todos.find((t) => t.status === 'in_progress');
      sum = `<span class="pin-k">المهام</span><span class="pbar"><i style="width:${todos.length ? (done / todos.length) * 100 : 0}%"></i></span>` +
        `<span class="count">${done}/${todos.length}</span><span class="pin-now" dir="auto">${now ? esc(now.text) : done === todos.length ? 'كله خلص' : ''}</span>`;
      body = todos.map((t) => `<div class="todo ${esc(t.status)}"><span class="ti">${t.status === 'completed' ? ICON.check : t.status === 'in_progress' ? '<span class="spin"></span>' : '<span class="ring"></span>'}</span><span dir="auto">${esc(t.text)}</span></div>`).join('');
    } else {
      const first = (plan.match(/^#+\s*(.+)$/m) || plan.match(/^(.+)$/m) || ['', ''])[1];
      sum = `<span class="pin-k">الخطة</span><span class="pin-now" dir="auto">${esc(first)}</span>`;
      body = md(plan);
    }
    box.innerHTML = `<details${ui.pinOpen ? ' open' : ''}><summary>${ICON.chev}${sum}</summary><div class="pin-body page">${body}</div></details>`;
    box.hidden = false;
    box.querySelector('details').addEventListener('toggle', (e) => { ui.pinOpen = e.target.open; saveUi(); });
  }

  toolGroup(frag) {
    if (this.group) return this.group;
    const g = document.createElement('details');
    g.className = 'tools';
    g.innerHTML = '<summary></summary><div class="tlist"></div>';
    frag.append(g);
    this.group = g;
    return g;
  }

  append(evs) {
    const skel = this.body.querySelector('.vskel');
    if (skel) skel.remove();
    const wasBottom = this.atBottom();
    const frag = document.createDocumentFragment();
    let added = 0;
    const touched = new Set();
    let userAdded = false;
    evs.forEach((ev) => {
      let el = null;
      if (ev.k === 'title') {
        if (!this.key.agent) { this.title = ev.text; this.q('.ptitle').textContent = ev.text; persistPanes(); }
        return;
      }
      if (ev.k === 'result' && this.tools[ev.id] && this.tools[ev.id].classList.contains('ask-card')) {
        markAnswers(this.tools[ev.id], ev);
        return;
      }
      if (ev.k === 'result') {
        const t = this.tools[ev.id];
        if (t) {
          t.querySelector('.res').innerHTML = ev.text ? `<pre dir="auto"${ev.err ? ' class="err"' : ''}>${esc(ev.text)}</pre>` : '';
          if (ev.images) {
            // screenshots stay visible under the (collapsed) tool group
            const g = t.closest('details.tools');
            if (!g._imgs) {
              g._imgs = document.createElement('div');
              g._imgs.className = 'imgs tool-imgs';
              g.after(g._imgs);
            }
            g._imgs.insertAdjacentHTML('beforeend', imgsHtml(ev.images));
          }
          t.classList.remove('pending');
          t.classList.add(ev.err ? 'bad' : 'ok');
          t.querySelector('.st-ico').innerHTML = ev.err ? ICON.x : ICON.check;
          if (ev.agent && !t.querySelector('.open-agent')) {
            t.querySelector('summary').insertAdjacentHTML('beforeend',
              `<button class="btn open-agent" data-open-agent="${esc(ev.agent)}" title="افتح سيشن الـ subagent (Ctrl+كليك في عمود جديد)">افتح</button>`);
          }
          touched.add(t.closest('details.tools'));
        }
        return;
      }
      if (ev.k === 'tool' && ev.ask) {
        // a question Claude asked you: shown as its own card, not folded into the tool run
        this.pendingUser = null;
        this.group = null;
        const card = document.createElement('div');
        card.className = 'ask-card pending';
        card.dataset.name = ev.name;
        card.dataset.sum = ev.ask.map((q) => q.question).join(' · ');
        card.innerHTML = askHtml(ev.ask);
        this.tools[ev.id] = card;
        frag.append(card);
        added++;
        return;
      }
      if (ev.k === 'tool') {
        this.pendingUser = null;
        const g = this.toolGroup(frag);
        const t = document.createElement('details');
        t.className = 'tool pending';
        t.dataset.name = ev.name;
        t.dataset.sum = ev.sum;
        const d = ev.diff ? diffHtml(ev.diff) : null;
        t.innerHTML = `<summary><span class="st-ico"><span class="spin"></span></span><span class="t-name">${esc(ev.name)}</span>` +
          `<span class="t-sum" dir="auto">${esc(ev.sum)}</span>${d ? d.stat : ''}</summary>` +
          (d ? d.body : `<pre dir="ltr">${esc(ev.input)}</pre>`) + '<div class="res"></div>';
        if (ev.todos) { this.todos = ev.todos; this.renderPin(); }
        if (ev.plan) { this.plan = ev.plan; this.renderPin(); }
        g.querySelector('.tlist').append(t);
        this.tools[ev.id] = t;
        touched.add(g);
        added++;
        return;
      }
      this.group = null; // anything else ends the current run of tool calls
      if (ev.k === 'user') {
        // an edited or resent prompt shows up twice; keep only the latest version
        if (this.pendingUser && ev.text.startsWith(this.pendingUser._raw.trim())) this.pendingUser.remove();
        el = document.createElement('div');
        el.className = 'msg user';
        el.innerHTML = `<div class="who">${this.key.agent ? 'المهمة اللي اتبعتت للـ subagent' : ev.queued ? 'إنت (وهو شغال)' : 'إنت'} · ${hhmm(ev.ts)}</div>${md(ev.text)}${ev.images ? `<div class="imgs">${imgsHtml(ev.images)}</div>` : ''}`;
        el._raw = ev.text;
        el._time = hhmm(ev.ts);
        this.pendingUser = el;
        userAdded = true;
      } else if (ev.k === 'text') {
        this.pendingUser = null;
        el = document.createElement('div');
        el.className = 'msg ai';
        el.innerHTML = md(ev.text) + `<div class="msg-actions"><button class="icon-btn" data-act="copy" title="نسخ الرسالة (Markdown)">${ICON.copy}</button>` +
          `<button class="icon-btn" data-act="page" title="حطها في صفحة جديدة">${ICON.page}</button></div>`;
        el._raw = ev.text;
      } else if (ev.k === 'thinking') {
        el = document.createElement('details');
        el.className = 'thinking';
        el.innerHTML = `<summary>تفكير</summary><div class="th-body">${md(ev.text)}</div>`;
      } else if (ev.k === 'note') {
        el = document.createElement('div');
        el.className = 'note';
        el.textContent = ev.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      } else if (ev.k === 'divider') {
        el = document.createElement('div');
        el.className = 'divider';
        el.textContent = 'المحادثة اتضغطت هنا';
      }
      if (el) { frag.append(el); added++; }
    });
    this.body.append(frag);
    touched.forEach((g) => g && updateGroup(g));
    if (userAdded) this.renderRail();
    if (!this.q('.psearch').hidden && this.q('.ps-q').value) {
      clearTimeout(this.reSearch);
      this.reSearch = setTimeout(() => { this.lastSig = null; this.runSearch(true); }, 1500);
    }
    if (wasBottom && !this.restoring) this.scroll.scrollTop = this.scroll.scrollHeight;
    else if (added && !this.restoring && this.body.children.length) {
      this.unseen += added;
      const j = this.q('.pjump');
      j.textContent = `↓ ${this.unseen} جديد`;
      j.hidden = false;
    }
  }
}

// ---------- AskUserQuestion ----------
function askHtml(questions) {
  return `<div class="ask-head"><span class="ask-ico">?</span><span class="ask-title">Claude سألك</span><span class="ask-state">مستني ردك في التيرمينال</span></div>` +
    questions.map((q, qi) => `<div class="ask-q" data-q="${qi}">` +
      (q.header ? `<span class="ask-chip">${esc(q.header)}</span>` : '') +
      `<div class="ask-text" dir="${textDir(q.question)}">${inline(q.question)}${q.multi ? ' <span class="ask-multi">(اختيار متعدد)</span>' : ''}</div>` +
      `<div class="ask-opts">` + q.options.map((o) => `<div class="ask-opt" data-label="${esc(o.label)}">` +
        `<span class="ask-mark"></span><span class="ask-o"><b dir="${textDir(o.label)}">${esc(o.label)}</b>` +
        (o.description ? `<span dir="${textDir(o.description)}">${esc(o.description)}</span>` : '') + `</span></div>`).join('') +
      `</div><div class="ask-custom" hidden></div></div>`).join('');
}
// Mark what you picked. Newer transcripts carry an `answers` map; older ones only the result text:
//   User has answered your questions: "Question?"="Answer", "Other?"="A, B". You can now continue…
function markAnswers(card, ev) {
  card.classList.remove('pending');
  const state = card.querySelector('.ask-state');
  if (ev.err) { card.classList.add('declined'); state.textContent = 'اتلغى من غير رد'; return; }
  card.classList.add('answered');
  state.textContent = 'اتجاوب';
  let answers = ev.answers && typeof ev.answers === 'object' ? ev.answers : null;
  if (!answers) {
    answers = {};
    const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(ev.text || ''))) answers[m[1]] = m[2];
  }
  const values = Object.values(answers);
  card.querySelectorAll('.ask-q').forEach((qEl, qi) => {
    const qText = qEl.querySelector('.ask-text').textContent.replace(/\s*\(اختيار متعدد\)$/, '').trim();
    const ans = String(answers[qText] != null ? answers[qText] : values[qi] != null ? values[qi] : '');
    const picked = new Set(ans.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean));
    let matched = false;
    qEl.querySelectorAll('.ask-opt').forEach((o) => {
      const on = picked.has(o.dataset.label) || ans === o.dataset.label;
      o.classList.toggle('picked', on);
      if (on) matched = true;
    });
    const custom = qEl.querySelector('.ask-custom');
    if (ans && !matched) { custom.hidden = false; custom.innerHTML = `<b>ردك:</b> <span dir="${textDir(ans)}">${esc(ans)}</span>`; }
  });
}

function updateGroup(g) {
  const tools = g.querySelectorAll('details.tool');
  const pending = g.querySelectorAll('details.tool.pending').length;
  const bad = g.querySelectorAll('details.tool.bad').length;
  const last = tools[tools.length - 1];
  const n = tools.length;
  const status = pending ? '<span class="st-ico"><span class="spin"></span></span>' : bad ? `<span class="st-ico bad">${ICON.x}</span>` : `<span class="st-ico ok">${ICON.check}</span>`;
  const label = n === 1 ? 'أمر واحد' : n === 2 ? 'أمرين' : `${n} أوامر`;
  g.querySelector('summary').innerHTML = `${ICON.chev}${status}<span>${label}</span>` +
    (last ? `<span class="g-last" dir="auto"><b>${esc(last.dataset.name)}</b> ${esc(last.dataset.sum)}</span>` : '');
}

// ---------- pane management ----------
function layoutPanes() {
  panesEl.dataset.n = panes.length;
  panes.forEach((p) => p.el.classList.toggle('active', p === activePane && panes.length > 1));
}
function addPane() {
  if (panes.length >= MAX_PANES) { toast(`أقصى عدد ${MAX_PANES} أعمدة`); return activePane; }
  const p = new Pane();
  const i = activePane ? panes.indexOf(activePane) + 1 : panes.length;
  panes.splice(i, 0, p);
  panesEl.insertBefore(p.el, panesEl.children[i] || null);
  p.renderEmpty();
  layoutPanes();
  return p;
}
function setActive(p) {
  if (activePane === p) return;
  activePane = p;
  layoutPanes();
  persistPanes();
  renderSessions();
}
function closePane(p) {
  const i = panes.indexOf(p);
  p.destroy();
  panes.splice(i, 1);
  paintHighlights();
  if (activePane === p) activePane = panes[Math.min(i, panes.length - 1)] || null;
  layoutPanes();
  afterPaneChange();
}
// open a session/subagent in the active pane, or in a new pane next to it
function openIn(target, opts = {}) {
  let p = activePane;
  if (!p || (opts.newPane && p.key)) p = addPane();
  p.open(target, opts.restoring);
  activePane = p;
  layoutPanes();
  afterPaneChange();
}
function afterPaneChange() {
  persistPanes();
  renderFilters();
  setTab('sessions');
  renderSessions();
}
function persistPanes() {
  ui.panes = panes.filter((p) => p.key).map((p) => ({ ...p.key, title: p.title }));
  ui.activePane = Math.max(0, panes.filter((p) => p.key).indexOf(activePane));
  writeHash();
  saveUi();
}

// ---------- lightbox ----------
let lbIndex = -1, lbScope = null;
function lbShots() { return lbScope ? [...lbScope.querySelectorAll('[data-img]')] : []; }
function lbShow(scope, i) {
  if (scope) lbScope = scope;
  const shots = lbShots();
  if (!shots.length) return;
  lbIndex = (i + shots.length) % shots.length;
  const url = shots[lbIndex].getAttribute('href');
  $('lightbox').querySelector('img').src = url;
  $('lbOpen').href = url;
  $('lbCount').textContent = `${lbIndex + 1} / ${shots.length}`;
  $('lightbox').hidden = false;
}
function lbClose() { $('lightbox').hidden = true; lbIndex = -1; }
$('lightbox').addEventListener('click', (e) => { if (!e.target.closest('a')) lbClose(); });
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); lbClose(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); lbShow(null, lbIndex + 1); } // RTL: left = next
  else if (e.key === 'ArrowRight') { e.preventDefault(); lbShow(null, lbIndex - 1); }
}, true);

// keep polling in a background tab when notifications are on, so they can fire
setInterval(() => { if ((document.visibilityState === 'visible' || ui.notify) && !serverOff && SRC.ready) loadSessions(); }, 4000);

// =====================================================================
// notifications: a session finished its turn, or is waiting on you
// =====================================================================
let prevStates = null;
function checkTransitions() {
  const states = {};
  let waiting = 0;
  sess.list.forEach((p) => p.sessions.forEach((s) => {
    states[s.id] = s.state;
    if (s.state === 'asking') waiting++;
    const prev = prevStates && prevStates[s.id];
    if (!prev || prev === s.state) return;
    if (prev === 'working' && s.state === 'idle') notify(p, s, 'خلّصت');
    else if (s.state === 'asking') notify(p, s, 'مستنية ردك');
  }));
  prevStates = states;
  document.title = waiting ? `(${waiting}) Pad` : 'Pad';
}
function notify(p, s, what) {
  if (!ui.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const watching = document.visibilityState === 'visible' && document.hasFocus() && ui.tab === 'sessions' && panes.some((x) => x.key && x.key.id === s.id);
  if (watching) return;
  const n = new Notification(`${what}: ${s.title}`, { body: p.name, tag: `${s.id}:${s.state}`, silent: false });
  n.onclick = () => {
    window.focus();
    const existing = panes.find((x) => x.key && x.key.id === s.id && !x.key.agent);
    if (existing) { setActive(existing); setTab('sessions'); } else openIn({ dir: p.dir, id: s.id, title: s.title });
    n.close();
  };
}
function renderNotifyBtn() {
  const b = $('notifyBtn');
  const on = ui.notify && 'Notification' in window && Notification.permission === 'granted';
  b.classList.toggle('on', on);
  b.innerHTML = on ? ICON.bell : ICON.bellOff;
  b.title = on ? 'الإشعارات شغالة: لما سيشن تخلّص أو تستنى ردك' : 'شغّل إشعارات السيشنز';
}
$('notifyBtn').onclick = async () => {
  if (!('Notification' in window)) { toast('المتصفح ده مش بيدعم الإشعارات'); return; }
  if (ui.notify) { ui.notify = false; toast('الإشعارات اتقفلت'); }
  else {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') { toast('المتصفح رافض الإشعارات، فعّلها من إعدادات الموقع'); ui.notify = false; }
    else { ui.notify = true; toast('هيوصلك إشعار لما سيشن تخلّص أو تستنى ردك'); }
  }
  saveUi();
  renderNotifyBtn();
};

// =====================================================================
// content width (session panes)
// =====================================================================
function applyContentWidth() {
  document.documentElement.style.setProperty('--vw', WIDTHS[ui.contentW].css);
  renderWidthMenu();
}
function renderWidthMenu() {
  $('widthMenu').innerHTML = WIDTH_ORDER.map((k) => {
    const w = WIDTHS[k];
    return `<button data-w="${k}" class="${k === ui.contentW ? 'on' : ''}"><span class="bar"><i style="width:${w.bar}%"></i></span>${w.label}<span class="k">${w.hint}</span></button>`;
  }).join('');
}
function setContentWidth(k) {
  ui.contentW = k;
  applyContentWidth();
  saveUi();
}
function openWidthMenu(btn) {
  const m = $('widthMenu');
  if (!m.hidden) { m.hidden = true; return; }
  const r = btn.getBoundingClientRect();
  m.style.top = r.bottom + 6 + 'px';
  m.style.left = Math.max(8, r.left) + 'px';
  m.hidden = false;
}
$('widthMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  setContentWidth(b.dataset.w);
  $('widthMenu').hidden = true;
});
document.addEventListener('click', (e) => { if (!e.target.closest('#widthMenu,[data-a="width"]')) $('widthMenu').hidden = true; });
function stepWidth(d) {
  const i = Math.max(0, Math.min(WIDTH_ORDER.length - 1, WIDTH_ORDER.indexOf(ui.contentW) + d));
  setContentWidth(WIDTH_ORDER[i]);
  toast('عرض المحتوى: ' + WIDTHS[WIDTH_ORDER[i]].label);
}

// =====================================================================
// keyboard
// =====================================================================
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'k') { e.preventDefault(); search.hidden ? openSearch() : closeSearch(); return; }
  if (e.key === 'Escape' && ui.tab === 'sessions' && $('lightbox').hidden) {
    const open = panes.find((x) => x === activePane && !x.q('.psearch').hidden) || panes.find((x) => !x.q('.psearch').hidden);
    if (open) { e.preventDefault(); open.searchClose(); return; }
  }
  if (ui.tab === 'sessions' && activePane && activePane.key && ((e.ctrlKey && k === 'f') || e.key === 'F3')) {
    e.preventDefault();
    if (e.key === 'F3') activePane.stepHit(e.shiftKey ? -1 : 1);
    else activePane.searchOpen();
    return;
  }
  if (!search.hidden) return;
  if (e.key === '/' && ui.tab === 'sessions' && !e.ctrlKey && !e.altKey && !e.target.closest('input,textarea,select,[contenteditable]')) {
    e.preventDefault();
    if (ui.collapsed) setCollapsed(false);
    $('sessFilter').focus();
    $('sessFilter').select();
    return;
  }
  if (e.ctrlKey && e.key === '\\') { e.preventDefault(); setCollapsed(!ui.collapsed); }
  else if (e.altKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); setTab(e.key === '1' ? 'pages' : 'sessions'); }
  else if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && ui.tab === 'sessions') {
    e.preventDefault();
    stepWidth(e.key === 'ArrowLeft' ? 1 : -1);
  }
  else if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); addPage(); }
  else if (e.altKey && e.key === 'ArrowUp' && ui.tab === 'pages') { e.preventDefault(); go(state.cur - 1); }
  else if (e.altKey && e.key === 'ArrowDown' && ui.tab === 'pages') { e.preventDefault(); go(state.cur + 1); }
  else if (ui.tab === 'sessions' && activePane && activePane.key && !e.target.closest('input,[contenteditable]') &&
           (e.key === 'End' || e.key === 'Home' || (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')))) {
    e.preventDefault();
    activePane.nav(e.key === 'End' ? 'last' : e.key === 'Home' ? 'first' : e.key === 'ArrowUp' ? 'prev' : 'next');
  }
});
window.addEventListener('hashchange', () => {
  const before = { panes: JSON.stringify((ui.panes || []).map(keyOf)), cur: state.cur };
  readHash();
  if (ui.tab === 'sessions' && JSON.stringify((ui.panes || []).map(keyOf)) !== before.panes) restorePanes(false);
  else if (ui.tab === 'pages' && state.cur !== before.cur) { const c = state.cur; state.cur = before.cur; go(c); }
  else setTab(ui.tab);
});

function restorePanes(restoring) {
  panes.forEach((p) => p.destroy());
  panes = [];
  activePane = null;
  (ui.panes || []).slice(0, MAX_PANES).forEach((k) => {
    const p = new Pane();
    panes.push(p);
    panesEl.append(p.el);
    p.open(k, restoring);
  });
  activePane = panes[ui.activePane] || panes[0] || null;
  layoutPanes();
  persistPanes();
}

// =====================================================================
// init: restore pages, tab, open session, widths and scroll
// =====================================================================
(async () => {
  loadUi();
  await loadState();
  readHash();
  applyWidth(ui.sidew);
  applyTheme();
  document.body.classList.toggle('collapsed', !!ui.collapsed);
  sourceState = await SRC.init();
  setServerUi(sourceState === 'ready');
  showPage(state.cur);
  renderThumbs();
  applyContentWidth();
  renderNotifyBtn();
  syncDateUi();
  renderGroupBtn();
  restorePanes(true);
  setTab(ui.tab);
  if (ui.tab === 'pages') ed.focus({ preventScroll: true });
  loadSessions();
})();
