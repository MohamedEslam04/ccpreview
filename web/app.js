'use strict';
const $ = (id) => document.getElementById(id);
const ed = $('ed'), thumbs = $('thumbs');
// Where sessions come from: the local `ccpreview` server, or a folder you pick in the browser (see source.js)
const SRC = CCPreviewSource.create();
const SERVER = SRC.mode === 'server';
let sourceState = 'loading'; // ready | offline | needs-folder | needs-permission | unsupported
const LS_PAGES = 'ccpreview.pages.v1'; // notes pages (the only store in folder mode, a backup in server mode)
const LS_UI = 'ccpreview.ui.v1';       // per-browser UI state: tab, open panes, widths, scroll
// Language first: the markup is translated before the setup below reads it.
(function () {
  let l;
  try { l = JSON.parse(localStorage.getItem(LS_UI)).lang; } catch (e) {}
  setLang(I18N[l] ? l : LANG);
  applyI18n(document);
})();
const DEFAULT_W = 260;
const WIDTHS = {
  sm: { css: '720px', label: 'width.sm', hint: '720px', bar: 45 },
  md: { css: '920px', label: 'width.md', hint: '920px', bar: 62 },
  lg: { css: '1200px', label: 'width.lg', hint: '1200px', bar: 82 },
  full: { css: 'none', label: 'width.full', hintKey: 'width.full_hint', bar: 100 },
};
const WIDTH_ORDER = ['sm', 'md', 'lg', 'full'];

const STRIP_MAX = 6; // chips a subagent / background strip shows before it folds the rest behind "+N more"
const ICON = {
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  chevUp: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  page: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 9.5-4.9M18 8c0 7 3 8 3 8H8M3 16s3-1 3-8M10 20a2 2 0 0 0 4 0M3 3l18 18"/></svg>',
};

let state = { pages: [{ html: '', name: '' }], cur: 0 };
let ui = { tab: 'sessions', sess: null, panes: [], activePane: 0, sidew: DEFAULT_W, collapsed: false, theme: 'auto', shut: [], edScroll: {}, viewScroll: {}, openAgents: [], closedAgents: [], contentW: 'md' };

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
  // Compare letters: a sentence built around English phrases with a few Arabic connectives is an English
  // paragraph (about 35-40% Arabic letters), while real Arabic prose with English terms sits at 65% or more.
  const ar = (t.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]+/g) || []).join('').length;
  const la = (t.match(/[A-Za-z\u00C0-\u024F]+/g) || []).join('').length;
  if (!ar && !la) return 'auto';
  return ar >= la * 0.8 ? 'rtl' : 'ltr';
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
  if (s < 60) return t('ago.now');
  if (s < 3600) return t('ago.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('ago.hour', { n: Math.floor(s / 3600) });
  return t('ago.day', { n: Math.floor(s / 86400) });
}
function hhmm(ts) {
  return ts ? new Date(ts).toLocaleTimeString(LOCALE[LANG], { hour: '2-digit', minute: '2-digit' }) : '';
}
// Numbers and dates in the active language's locale (ar-EG draws Arabic-Indic digits).
const num = (n, opts) => Number(n).toLocaleString(LOCALE[LANG], opts);
const whenText = (ms) => new Date(ms).toLocaleString(LOCALE[LANG], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
    // line the menu up with the button's start edge (right in RTL, left in LTR), but keep it on screen
    if (isRtl()) {
      menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
      if (menu.getBoundingClientRect().left < 8) { menu.style.right = 'auto'; menu.style.left = '8px'; }
    } else {
      menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    }
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
  if (!Array.isArray(ui.vtabs)) ui.vtabs = [];
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
    const ks = (ui.panes || []).map((k) => [k.dir, k.id, k.agent].filter(Boolean).map(encodeURIComponent).join('/'));
    const sh = validShape(ui.shape, ks.length) || ks.map(() => 1);
    let at = 0;
    const parts = sh.map((n) => ks.slice(at, (at += n)).join('~'));
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
      // "A+B~C": two columns, the second one has B above C
      const shape = [];
      ui.panes = rest.split('+').flatMap((group) => {
        const ks = group.split('~').map((seg) => {
          const [dir, id, agent] = seg.split('/').map(decodeURIComponent);
          const prev = old.find((k) => k.dir === dir && k.id === id && (k.agent || '') === (agent || ''));
          return { dir, id, agent: agent || '', title: prev ? prev.title : '' };
        }).filter((k) => k.dir && k.id);
        if (ks.length) shape.push(ks.length);
        return ks;
      });
      ui.shape = rest.includes('~') ? shape : null; // an old link has no layout: spread them out
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

// A paragraph whose lines are in different languages ("Do this.\nعشان كده…"): each line gets its own
// direction, so an English line reads left-to-right inside an Arabic message and the other way round.
function paraHtml(lines) {
  const dir = textDir(lines.join(' '));
  const dirs = lines.map(textDir);
  if (lines.length < 2 || dirs.every((d) => d === 'auto' || d === dir)) return `<p dir="${dir}">${lines.map(inline).join('<br>')}</p>`;
  return `<p dir="${dir}">${lines.map((l, j) => `<span class="pl" dir="${dirs[j] === 'auto' ? dir : dirs[j]}">${inline(l)}</span>`).join('')}</p>`;
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
    out.push(paraHtml(p));
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
  if (!SERVER || serverOff) { setSave(t('save.browser')); return; }
  try {
    const r = await fetch('/api/pages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error(r.status);
    setSave(t('save.saved'));
  } catch (e) {
    setSave(t('save.browser_only'), true);
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
    b.querySelector('.lbl').textContent = SRC.ready ? SRC.folderName : t('srv.not_connected');
    b.querySelector('.act').textContent = SRC.ready ? t('srv.change_folder') : t('srv.connect');
    b.title = SRC.ready ? t('srv.reading_tip', { name: SRC.folderName }) : t('srv.connect_tip');
    return;
  }
  const service = SRC.info && SRC.info.service;
  b.querySelector('.lbl').textContent = on ? t('srv.running') : t('srv.stopped');
  b.title = on ? t('srv.running_tip') : t('srv.stopped_tip');
  b.querySelector('.act').textContent = on ? (service ? t('srv.stop') : t('srv.running')) : t('srv.start');
}
function startServer() { location.reload(); }
async function connectFolder(again) {
  try {
    if (again) await SRC.reconnect(); else await SRC.pick();
    sourceState = 'ready';
    welcomeError = '';
    setServerUi(true);
    sess.list = null;
    renderSessions();
    await loadSessions();
    restorePanes(false);
    setTab(ui.tab);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // closed the picker
    welcomeError = e && e.message === 'not-projects' ? t('welcome.wrong_folder') : t('welcome.no_access');
    toast(welcomeError);
    renderEmptyView();
  }
}
$('srvBtn').onclick = async () => {
  if (!SERVER) return connectFolder(sourceState === 'needs-permission');
  if (serverOff || !$('srvBtn').classList.contains('on')) return startServer();
  if (!(SRC.info && SRC.info.service)) { toast(t('srv.ctrl_c')); return; }
  state.pages[state.cur].html = ed.innerHTML;
  await persist();
  serverOff = true; // stop polling/streaming, or they would wake the socket-activated server again
  allPanes().forEach((p) => { if (p.es) { p.es.close(); p.es = null; } });
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch (e) {}
  setServerUi(false);
  setSave(t('save.browser'));
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
      `<div class="name" dir="auto" data-ph="${esc(t('pages.name_ph'))}">${esc(p.name || '')}</div>` +
      `<button class="del" title="${esc(t('pages.del_tip'))}">${ICON.x}</button></div>`;
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
  if (htmlText(state.pages[i].html) && !confirm(t('pages.del_confirm', { n: i + 1 }))) return;
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
  toast((await copyText(out)) ? t(f === 'md' ? 'table.md_done' : 'table.tsv_done') : t('copy.failed'));
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
    if (!term) { hits.push({ i, name, snip: text.slice(0, 90) || t('pages.empty') }); return; }
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
  }).join('') || `<li class="snip">${t('pages.no_results')}</li>`;
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
  toast(tn('pages.exported', state.pages.length));
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
    toast(tn('pages.added', pages.length));
  } catch (err) {
    toast(t('pages.import_bad'));
  }
};

// =====================================================================
// theme, sidebar, resize
// =====================================================================
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'theme.auto', light: 'theme.light', dark: 'theme.dark' };
const themeName = () => t('theme.title', { name: t(THEME_LABEL[ui.theme]) });
function applyTheme() {
  if (ui.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = ui.theme;
  $('themeBtn').innerHTML = ICON[{ auto: 'auto', light: 'sun', dark: 'moon' }[ui.theme]];
  $('themeBtn').title = themeName();
}
$('themeBtn').onclick = () => {
  ui.theme = THEMES[(THEMES.indexOf(ui.theme) + 1) % THEMES.length];
  applyTheme();
  toast(themeName());
  saveUi();
};

// Language button: shows the other language. Switching redraws the markup and everything JS renders;
// open sessions are reopened because their transcript text was built in the old language
// (scroll position and panes come back as after a reload).
function renderLangBtn() {
  $('langBtn').textContent = t('lang.other');
  $('langBtn').title = t('lang.switch');
}
$('langBtn').onclick = () => {
  ui.lang = LANG === 'ar' ? 'en' : 'ar';
  setLang(ui.lang);
  saveUi();
  applyI18n(document);
  lbClose(); // its text and the images' captions were built in the old language
  document.querySelectorAll('.dd-native').forEach(syncSelect);
  renderLangBtn();
  applyTheme();
  renderNotifyBtn();
  renderUsage();
  renderTabs();
  renderGroupBtn();
  renderWidthMenu();
  setServerUi($('srvBtn').classList.contains('on'));
  renderThumbs();
  restoreTabs(true);
  setTab(ui.tab);
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
  const move = (ev) => { applyWidth(isRtl() ? window.innerWidth - ev.clientX : ev.clientX); rerenderThumbs(); };
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
  // nothing connected yet (hosted page): the setup guide takes the whole view, even if old panes were restored
  const setup = !SERVER && sourceState !== 'ready';
  panesHost.hidden = tab !== 'sessions' || !panes.length || setup;
  $('vempty').hidden = tab !== 'sessions' || (panes.length > 0 && !setup);
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
// Claude Code sessions (live), shown side by side in panes (they wrap to more rows, drag a header to reorder)
// =====================================================================
const sess = { list: null };
const sessList = $('sessList');
const panesHost = $('panes'); // the whole preview area: tab bar + one grid of panes per tab
const gridsEl = $('pgrids');
const tabbarEl = $('tabbar');
let panesEl = null; // the grid of the tab being shown
const MAX_PANES = 12;
const MIN_PANE_W = 300; // narrower than this and a row takes one pane fewer
let panes = []; // the panes of the tab being shown (the same array as tabs[curTab].panes)
let activePane = null;
const MAX_TABS = 10;
let tabs = []; // { panes, activePane, grid }: each tab is its own split layout; a tab with one pane is one full-size session
let curTab = 0;
const allPanes = () => tabs.flatMap((tb, i) => (i === curTab ? panes : tb.panes));
function newTabObj() {
  const grid = document.createElement('div');
  grid.className = 'pgrid';
  gridsEl.append(grid);
  wireGrid(grid);
  return { panes: [], shape: [], activePane: null, grid };
}
function bindTab(i) {
  curTab = i;
  const tb = tabs[i];
  panes = tb.panes;
  activePane = tb.activePane;
  panesEl = tb.grid;
  tabs.forEach((x, j) => x.grid.classList.toggle('cur', j === i));
}
function saveCurTab() { if (tabs[curTab]) tabs[curTab].activePane = activePane; }
tabs = [newTabObj()];
bindTab(0);

// A tab's layout is columns, each a vertical stack of panes. tab.panes is the flat list in column order and
// tab.shape says how many panes each column has, so shape = [2, 1] is a column with two panes and one with one.
const validShape = (sh, n) => (Array.isArray(sh) && sh.length && sh.every((x) => Number.isInteger(x) && x > 0) && sh.reduce((a, b) => a + b, 0) === n ? sh : null);
const fitCols = () => Math.max(1, Math.min(4, Math.floor((panesEl && panesEl.clientWidth || window.innerWidth) / MIN_PANE_W)));
// no saved layout: one column each while they fit, else spread them evenly over as many columns as fit
function autoShape(n) {
  const cols = Math.max(1, Math.min(n, fitCols()));
  return Array.from({ length: cols }, (_, i) => Math.floor(n / cols) + (i < n % cols ? 1 : 0));
}
function columns(tb) {
  const n = tb.panes.length;
  tb.shape = validShape(tb.shape, n) || (n ? autoShape(n) : []);
  let at = 0;
  return tb.shape.map((k) => tb.panes.slice(at, (at += k)));
}
// replace the layout: cols is an array of columns (arrays of panes)
function setCols(tb, cols) {
  cols = cols.filter((c) => c.length);
  tb.panes.splice(0, tb.panes.length, ...cols.flat());
  tb.shape = cols.map((c) => c.length);
}
// put the panes of a tab into its column elements (moving a pane's element loses its scroll position: keep it)
function syncDom(tb) {
  const cols = columns(tb);
  const grid = tb.grid;
  let colEls = [...grid.children].filter((e) => e.classList.contains('pcol'));
  colEls.slice(cols.length).forEach((e) => e.remove());
  colEls = colEls.slice(0, cols.length);
  while (colEls.length < cols.length) { const c = document.createElement('div'); c.className = 'pcol'; grid.append(c); colEls.push(c); }
  const moved = [];
  cols.forEach((col, ci) => {
    const ce = colEls[ci];
    col.forEach((p, k) => {
      if (ce.children[k] === p.el) return;
      moved.push([p, p.scroll ? p.scroll.scrollTop : 0]);
      ce.insertBefore(p.el, ce.children[k] || null);
    });
    while (ce.children.length > col.length) ce.lastChild.remove();
  });
  moved.forEach(([p, top]) => { if (top && p.scroll) p.scroll.scrollTop = top; });
}

async function loadSessions() {
  if (!SRC.ready || serverOff) { renderSessions(); return; }
  try {
    // a date filter / time grouping needs every session, not just the latest 15 per project
    // first load only: show projects as they are scanned (newest first) instead of skeletons until the end.
    // Later refreshes keep the list on screen and swap it once, or it would shrink while scanning.
    const onProgress = sess.list ? undefined : (partial) => { if (!serverOff) { sess.list = partial; renderSessions(); } };
    sess.list = await SRC.list({ all: dateActive() || ui.groupBy === 'time', more: ui.moreProj || [], onProgress });
    checkTransitions();
    setServerUi(true);
  } catch (e) {
    setServerUi(false);
    sess.list = null;
  }
  renderSessions();
  renderEmptyView();
  allPanes().forEach((p) => p.renderHead());
  renderTabs();
  if (!SERVER) loadUsage(); // folder mode: appears once the source is ready
}

// What the sidebar shows when there is nothing to read yet.
function connectHtml() {
  const npx = '<code dir="ltr">npx ccpreview</code>';
  if (SERVER) return `<div class="empty">${t('connect.stopped')}<br><br><button class="btn primary" data-start>${t('srv.start')}</button><p class="connect-hint">${t('connect.stopped_hint', { cmd: npx })}</p></div>`;
  // hosted page: the full guide is in the main view; the sidebar only points at it
  const btn = sourceState === 'needs-permission' ? `<button class="btn primary" data-reconnect>${t('connect.allow')}</button>`
    : sourceState === 'unsupported' ? '' : `<button class="btn primary" data-pick>${t('connect.pick')}</button>`;
  return `<div class="empty connect"><p>${t('side.setup')}</p>${btn}</div>`;
}

const isLive = (ms) => Date.now() - ms < 90e3;
const keyOf = (k) => (k ? `${k.dir}/${k.id}${k.agent ? '/' + k.agent : ''}` : '');
const shown = (dir, id, agent) => allPanes().some((p) => p.key && p.key.dir === dir && p.key.id === id && (p.key.agent || '') === (agent || ''));
function findSession(dir, id) {
  for (const p of sess.list || []) if (p.dir === dir) for (const s of p.sessions) if (s.id === id) return { p, s };
  return null;
}
function agentsOpen(s) {
  if (allPanes().some((p) => p.key && p.key.id === s.id && p.key.agent)) return true;
  if (ui.openAgents.includes(s.id)) return true;
  return s.agents.some((a) => isLive(a.mtime)) && !ui.closedAgents.includes(s.id);
}
function liveCount() {
  const now = Date.now();
  return (sess.list || []).reduce((n, p) => n + p.sessions.filter((s) => now - s.mtime < 90e3).length, 0);
}

const TAB_ICON = '<svg viewBox="0 0 24 24"><path d="M3 8V6a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>';
const SPLIT_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';

const PIN_ICON = '<svg viewBox="0 0 24 24"><path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z"/></svg>';
const QUICK_FILTERS = [
  { k: 'all', label: 'filter.all' },
  { k: 'live', label: 'filter.live' },
  { k: 'asking', label: 'filter.asking' },
  { k: 'open', label: 'filter.open' },
  { k: 'pinned', label: 'filter.pinned' },
];
const sessLive = (s) => isLive(s.active || s.mtime) || (s.agents || []).some((a) => isLive(a.mtime));
const isPinned = (s) => (ui.pinned || []).includes(s.id);
function matchesQuick(p, s, k) {
  if (k === 'live') return sessLive(s);
  if (k === 'asking') return s.state === 'asking';
  if (k === 'open') return allPanes().some((x) => x.key && x.key.dir === p.dir && x.key.id === s.id);
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
      `${t(f.label)}${n ? `<span class="qf-n">${n}</span>` : ''}</button>`;
  }).join('');
}

// Groups for "by time": today, yesterday, then one group per day for the rest of the week
// (named by weekday + date, e.g. "Thursday, October 29"), then the rest of the month, then older.
function timeBuckets() {
  const today = dayStart(Date.now()), DAY = 864e5;
  const dayName = (ms) => new Date(ms).toLocaleDateString(LOCALE[LANG], { weekday: 'long', day: 'numeric', month: 'long' });
  const list = [
    { k: 'today', label: t('time.today'), from: today },
    { k: 'yesterday', label: t('time.yesterday'), from: today - DAY },
  ];
  for (let i = 2; i <= 6; i++) list.push({ k: 'day' + i, label: dayName(today - i * DAY), from: today - i * DAY });
  list.push({ k: 'month', label: t('time.month'), from: today - 30 * DAY });
  list.push({ k: 'older', label: t('time.older'), from: -Infinity });
  return list;
}
function renderGroupBtn() {
  const time = ui.groupBy === 'time';
  const b = $('groupBy');
  b.innerHTML = time
    ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  b.title = t(time ? 'group.by_time_tip' : 'group.by_project_tip');
  b.classList.toggle('on', time);
}
$('groupBy').onclick = () => {
  ui.groupBy = ui.groupBy === 'time' ? 'project' : 'time';
  saveUi();
  renderGroupBtn();
  toast(t(ui.groupBy === 'time' ? 'group.toast_time' : 'group.toast_project'));
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
  const sub = [tn('sessions.count', count), last ? ago(last) : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="proj-name${isStatic ? ' static' : ''}" ${isStatic ? 'tabindex="-1"' : `aria-expanded="${!shut}"`} title="${esc(tip || title)}" data-key="${esc(key)}">` +
    ava + `<span class="pj-txt"><span class="pj-title" dir="${textDir(title)}">${esc(title)}</span><span class="pj-sub">${esc(sub)}</span></span>` +
    (asking ? `<span class="pj-badge ask" title="${esc(t('sessions.badge_asking', { n: asking }))}">${asking}</span>` : '') +
    (live ? `<span class="pj-badge live" title="${esc(t('sessions.badge_live', { n: live }))}">${live}</span>` : '') +
    (isStatic ? '' : `<span class="pj-chev">${ICON.chevDown}</span>`) + '</button>';
}

function sessRow(p, s, now, withProject) {
  const act = activePane && activePane.key;
  const splitBtn = `<button class="split-btn tab-btn" data-tab title="${esc(t('sessions.tab_tip'))}">${TAB_ICON}</button>` +
    `<button class="split-btn" data-split title="${esc(t('sessions.split_tip'))}">${SPLIT_ICON}</button>`;
  const agents = s.agents || [];
  const live = now - (s.active || s.mtime) < 90e3;
  const on = shown(p.dir, s.id, '');
  const isAct = on && act && act.id === s.id && !act.agent;
  const pin = isPinned(s);
  let html = `<div class="sess${on ? ' on' : ''}${isAct ? ' act' : ''}${pin ? ' pinned' : ''}" data-dir="${esc(p.dir)}" data-id="${esc(s.id)}" title="${esc(s.title)}">` +
    `<span class="dot${live ? ' live' : ''}"></span><div class="st"><div class="stt" dir="${textDir(s.title)}">${esc(s.title)}</div>` +
    `<div class="sm${live ? ' live' : ''}">${s.state === 'asking' ? `<span class="ask-badge">${t('state.asking')}</span>` : live ? t('state.live') : ago(s.active || s.mtime)}` +
    `${withProject ? ` · <span class="sm-proj">${esc(p.name)}</span>` : ''}</div></div>` +
    `<span class="row-acts"><button class="pin-btn${pin ? ' on' : ''}" data-pin title="${esc(t(pin ? 'sessions.unpin' : 'sessions.pin'))}">${PIN_ICON}</button>${splitBtn}</span></div>`;
  if (agents.length) {
    const open = agentsOpen(s);
    const liveA = agents.filter((a) => isLive(a.mtime)).length;
    html += `<button class="agents-toggle${open ? ' open' : ''}" data-sid="${esc(s.id)}" data-open="${open ? 1 : 0}">${ICON.chev}` +
      `<span>${tn('agents.count', agents.length)}</span>` +
      (liveA ? `<span class="live-badge">${t('agents.live', { n: liveA })}</span>` : '') + '</button>';
    if (open) {
      html += '<div class="agents">' + agents.map((a) => {
        const al = isLive(a.mtime);
        const aon = shown(p.dir, s.id, a.id);
        const name = a.description || 'subagent';
        const meta = [a.type, a.model, al ? t('state.live_agent') : a.finished ? t('agents.finished_ago', { ago: ago(a.mtime) }) : ago(a.mtime)].filter(Boolean).join(' · ');
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
  lb.title = n ? tn('sessions.live_title', n) : '';

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
    html += `<div class="proj pinned-group">` + groupHead({ key: 'pinned', title: t('filter.pinned'), avatar: '', icon: PIN_ICON, count: pinned.length, rows: pinned, isStatic: true }) +
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
        html += `<button class="more-btn" data-more="${esc(p.dir)}">${showingAll ? t('sessions.show_15') : t('sessions.show_all', { n: p.total })}</button>`;
      }
      html += '</div>';
    });
  }
  const emptyMsg = ['live', 'asking', 'open', 'pinned'].includes(qk) ? t('sessions.empty.' + qk) : '';
  const scroll = sessList.scrollTop;
  sessList.innerHTML = html || `<div class="empty">${f ? t('sessions.empty.name') : emptyMsg || (dateActive() ? t('sessions.empty.period') : t('sessions.empty.none'))}</div>`;
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
  b.title = t(allShut ? 'sessions.unfold' : 'sessions.fold');
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
// ---------- first run: a step-by-step guide for people who never used a terminal ----------
const OS = (() => {
  // every hint the browser gives, so one missing or frozen field does not decide it
  const p = [navigator.userAgentData && navigator.userAgentData.platform, navigator.platform, navigator.userAgent].join(' ').toLowerCase();
  return /\bwin/.test(p) ? 'win' : /\bmac|darwin/.test(p) ? 'mac' : 'linux';
})();
let IS_BRAVE = false;
const IS_PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
// a Chromium browser without the folder API is just too old (it arrived in Chrome / Edge 86)
const IS_CHROMIUM = /\b(Chrome|Chromium|Edg|OPR|Vivaldi)\//.test(navigator.userAgent || '') || !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand)));
let welcomeError = '';
const BRAVE_FLAG = 'brave://flags/#file-system-access-api';
const copyRow = (text, label) => `<span class="w-copy" dir="ltr"><code>${esc(text)}</code><button class="btn" data-copy-text="${esc(text)}">${ICON.copy}<span>${esc(label || t('welcome.copy'))}</span></button></span>`;
function welcomeHtml() {
  const head = `<header class="w-head"><img src="logo.svg" alt="" width="44" height="44"><div><h1>${t('welcome.title')}</h1><p>${t('welcome.sub')}</p></div></header>`;
  const safe = `<p class="w-safe">${ICON.lock || ''}${t('welcome.safe')}</p>`;
  const dev = `<details class="w-dev"><summary>${t('welcome.dev')}</summary><p>${t('welcome.dev_text')}</p>${copyRow('npx ccpreview')}</details>`;
  let body;
  if (sourceState === 'needs-permission') {
    body = `<h2>${t('welcome.back')}</h2><p>${t('welcome.back_text', { name: `<b dir="auto">${esc(SRC.folderName || '')}</b>` })}</p>` +
      `<button class="btn primary big" data-reconnect>${t('connect.allow')}</button>`;
  } else if (sourceState === 'unsupported' && IS_PHONE) {
    body = `<h2>${t('welcome.phone_title')}</h2><p>${t('welcome.phone_text')}</p>${copyRow(location.href.split('#')[0], t('welcome.copy_link'))}`;
  } else if (sourceState === 'unsupported' && IS_BRAVE) {
    body = `<h2>${t('welcome.brave_title')}</h2><ol class="w-steps">` +
      `<li><p>${t('welcome.brave_1')}</p>${copyRow(BRAVE_FLAG)}</li>` +
      `<li><p>${t('welcome.brave_2')}</p></li>` +
      `<li><p>${t('welcome.brave_3', { on: `<b>${t('welcome.enabled')}</b>` })}</p></li>` +
      `<li><p>${t('welcome.brave_4', { btn: `<b>${t('welcome.relaunch')}</b>` })}</p></li></ol>` +
      `<p class="w-alt">${t('welcome.or_chrome')}</p>${copyRow(location.href.split('#')[0], t('welcome.copy_link'))}`;
  } else if (sourceState === 'unsupported' && IS_CHROMIUM) {
    body = `<h2>${t('welcome.old_title')}</h2><p>${t('welcome.old_text')}</p>` +
      `<p class="w-alt">${t('welcome.or_chrome')}</p>${copyRow(location.href.split('#')[0], t('welcome.copy_link'))}`;
  } else if (sourceState === 'unsupported') {
    body = `<h2>${t('welcome.browser_title')}</h2><p>${t('welcome.browser_text')}</p>${copyRow(location.href.split('#')[0], t('welcome.copy_link'))}` +
      `<p class="w-alt"><a href="https://www.google.com/chrome/" target="_blank" rel="noopener">${t('welcome.get_chrome')}</a></p>`;
  } else {
    const path = OS === 'win' ? '%USERPROFILE%\\.claude' : '~/.claude';
    body = `<h2>${t('welcome.steps_title')}</h2><ol class="w-steps">` +
      `<li><p>${t('welcome.step_copy')}</p>${copyRow(path)}</li>` +
      `<li><p>${t('welcome.step_open')}</p><button class="btn primary big" data-pick>${t('connect.pick')}</button></li>` +
      `<li><p>${t('welcome.step_paste_' + OS)}</p></li>` +
      `<li><p>${t('welcome.step_allow')}</p></li></ol>` +
      (welcomeError ? `<p class="w-err" role="alert">${welcomeError}</p>` : '') +
      // the usual reasons the folder is not where step 1 says
      `<details class="w-help"${welcomeError ? ' open' : ''}><summary>${t('welcome.help')}</summary><ul>` +
      `<li>${t('welcome.help_hidden_' + OS)}</li>` +
      `<li>${t('welcome.help_never')}</li>` +
      (OS === 'win' ? `<li>${t('welcome.help_wsl', { path: '<code dir="ltr">\\\\wsl.localhost</code>' })}</li>` : '') +
      `<li>${t('welcome.help_custom', { v: '<code dir="ltr">CLAUDE_CONFIG_DIR</code>' })}</li></ul></details>`;
  }
  return `<div class="welcome">${head}<section class="w-body">${body}</section>${safe}${dev}</div>`;
}

function renderEmptyView() {
  const box = $('vempty');
  box.classList.toggle('is-welcome', !SERVER && sourceState !== 'ready');
  document.body.classList.toggle('needs-setup', !SERVER && sourceState !== 'ready');
  if (!box.hidden && !SERVER && sourceState !== 'ready') { box.innerHTML = welcomeHtml(); return; }
  if (!box.hidden) {
    box.innerHTML = `<div><h2>${t('sessions.pick_title')}</h2><p>${t('sessions.pick_text')}</p>` + liveQuickList() + '</div>';
  }
  allPanes().forEach((p) => { if (!p.key) p.renderEmpty(); });
}
$('vempty').addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy-text]');
  if (c) {
    copyText(c.dataset.copyText).then((ok) => {
      toast(ok ? t('welcome.copied') : t('welcome.copy_failed'));
      if (ok) { c.classList.add('done'); setTimeout(() => c.classList.remove('done'), 1500); }
    });
    return;
  }
  if (e.target.closest('[data-pick]')) return connectFolder(false);
  if (e.target.closest('[data-reconnect]')) return connectFolder(true);
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
    mb.textContent = t('sessions.loading');
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
  if (s) openIn(sessTarget(s), { newTab: !!e.target.closest('[data-tab]') || e.shiftKey, newPane: !!e.target.closest('[data-split]') || e.ctrlKey || e.metaKey });
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
      // on a tie take the removal first, so a replaced line reads "- old" then "+ new"
      else if (i < n && (j >= m || dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1])) { mid.push(['-', a2[i]]); i++; }
      else { mid.push(['+', b2[j]]); j++; }
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
        html += head.map(ctx).join('') + `<div class="dl gap">${tn('diff.unchanged', run.length - head.length - tail.length)}</div>` + tail.map(ctx).join('');
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
    if (lines.length > head.length) html += `<div class="dl gap">${tn('diff.more', lines.length - head.length)}</div>`;
    return html;
  });
  const file = d.file ? `<div class="df-file">${esc(d.file)}${d.write ? t('diff.new_file') : ''}${d.all ? t('diff.all') : ''}</div>` : '';
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

// from = where the image came from (shown in the viewer's properties), ts = when
function imgsHtml(list, from, ts) {
  return list.map((u) => `<a class="shot" href="${esc(u)}" data-img data-from="${esc(from || '')}" data-ts="${esc(ts || '')}"><img src="${esc(u)}" loading="lazy" alt="${esc(t('msg.image_alt'))}"></a>`).join('');
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
      '<header class="phead" draggable="true" data-i18n-title="pane.drag_tip"><span class="dot plive"></span>' +
      '<div class="vt"><div class="ptitle" dir="auto"></div><div class="pmeta"></div></div>' +
      `<button class="icon-btn" data-a="info" data-i18n-title="info.tip"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg></button>` +
      `<button class="icon-btn" data-a="search" data-i18n-title="pane.search_tip"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button>` +
      `<button class="icon-btn" data-a="width" data-i18n-title="pane.width_tip"><svg viewBox="0 0 24 24"><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg></button>` +
      `<button class="icon-btn" data-a="split" data-i18n-title="pane.split_tip">${SPLIT_ICON}</button>` +
      `<button class="icon-btn" data-a="close" data-i18n-title="pane.close_tip">${ICON.x}</button></header>` +
      '<div class="pagents" hidden></div>' +
      '<div class="pbg" hidden></div><div class="pbg-view" hidden></div>' +
      '<div class="pinfo" hidden></div>' +
      '<div class="psearch" hidden><div class="ps-row">' +
      '<label class="field ps-field"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="ps-q" data-i18n-placeholder="pane.search_ph" autocomplete="off" spellcheck="false"></label>' +
      '<span class="ps-count"></span>' +
      '<button class="icon-btn" data-s="prev" data-i18n-title="pane.prev"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>' +
      '<button class="icon-btn" data-s="next" data-i18n-title="pane.next"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<span class="ps-sep"></span>' +
      '<button class="ps-opt" data-opt="case" data-i18n-title="pane.case">Aa</button>' +
      '<button class="ps-opt" data-opt="word" data-i18n-title="pane.word">ab</button>' +
      '<button class="ps-opt" data-opt="regex" data-i18n-title="pane.regex">.*</button>' +
      '<select class="ps-scope" data-i18n-title="pane.scope"><option value="all" data-i18n="pane.scope.all"></option><option value="user" data-i18n="pane.scope.user"></option><option value="ai" data-i18n="pane.scope.ai"></option><option value="tools" data-i18n="pane.scope.tools"></option></select>' +
      '<button class="icon-btn" data-s="list" data-i18n-title="pane.hit_list"><svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg></button>' +
      `<button class="icon-btn" data-s="close" data-i18n-title="pane.search_close">${ICON.x}</button>` +
      '</div><div class="ps-list" hidden></div></div>' +
      '<div class="pmain"><div class="pscroll"><div class="ppin" hidden></div><div class="pbody page"></div><div class="pwait" hidden></div></div>' +
      '<nav class="prail" data-i18n-aria-label="rail.aria"><div class="rail-nav">' +
      '<button class="icon-btn" data-nav="first" data-i18n-title="rail.first"><svg viewBox="0 0 24 24"><path d="M6 11l6-6 6 6M6 18l6-6 6 6"/></svg></button>' +
      '<button class="icon-btn" data-nav="prev" data-i18n-title="rail.prev"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>' +
      '<button class="icon-btn" data-nav="next" data-i18n-title="rail.next"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<button class="icon-btn" data-nav="last" data-i18n-title="rail.last"><svg viewBox="0 0 24 24"><path d="M6 6l6 6 6-6M6 13l6 6 6-6"/></svg></button>' +
      '<button class="icon-btn rail-wide" data-nav="wide" data-i18n-title="rail.wide"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg></button>' +
      '</div><div class="rail-count"></div><div class="rail-list"></div></nav></div>' +
      '<button class="btn primary pjump" hidden></button>';
    applyI18n(this.el); // before enhanceSelect below, which copies the select's title
    this.q = (s) => this.el.querySelector(s);
    this.scroll = this.q('.pscroll');
    this.body = this.q('.pbody');
    this.reset();

    this.el.addEventListener('pointerdown', () => setActive(this), true);
    this.q('.phead').addEventListener('click', (e) => this.onHead(e));
    this.q('.pagents').addEventListener('click', (e) => this.onAgents(e));
    this.q('.pinfo').addEventListener('click', (e) => this.onInfoClick(e));
    this.q('.pbg').addEventListener('click', (e) => this.onBg(e));
    this.q('.pagents').addEventListener('input', (e) => this.onStripInput('agents', e, () => this.renderHead()));
    this.q('.pbg').addEventListener('input', (e) => this.onStripInput('bg', e, () => this.renderBg(true)));
    this.q('.pbg-view').addEventListener('click', (e) => this.onBgView(e));
    if (ui.infoOpen) { this.q('.pinfo').hidden = false; this.q('[data-a="info"]').classList.add('on'); }
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
        allPanes().forEach((p) => p.syncSearchOpts());
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
    const word = tn('rail.word', list.length);
    this.q('.rail-count').innerHTML = list.length ? `<b>${list.length}</b><span class="rc-w"> ${word}</span><span class="rc-cap">${word}</span>` : '';
    this.q('.rail-count').title = tn('rail.count_tip', list.length);
    this.q('.rail-list').innerHTML = list.map((el, i) => {
      const text = (el._raw || '').replace(/\s+/g, ' ').trim() || t('rail.image');
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
      allPanes().forEach((p) => p.rail.classList.toggle('wide', ui.railWide));
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
    this.stats = newStats();
    this.bg = new Map(); // tool id -> background command / watcher started by this session
    this.bgSel = null;
    this.stopBgPoll();
    if (this.el) this.renderBg(true);
    this.waiting = null;
    if (this.el) this.renderWait();
    if (this.el) this.renderInfo();
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
    this.strip = {};
    this.git = null;
    this.gitAt = 0;
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
    this.stopBgPoll();
    if (this.es) { this.es.close(); this.es = null; }
    this.hits = [];
    this.el.remove();
  }

  // empty pane: pick a session from the sidebar or a live one here
  renderEmpty() {
    this.rail.hidden = true;
    this.q('.ptitle').textContent = t('pane.empty_title');
    this.q('.pmeta').textContent = t('pane.empty_meta');
    this.q('.plive').classList.remove('live');
    this.q('.pagents').hidden = true;
    this.body.innerHTML = `<div class="vempty-in"><p>${t('pane.empty_body')}</p>${liveQuickList()}</div>`;
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
    this.agentInfo = a || null;
    this.sessInfo = s;
    const status = s.state === 'asking' && !a ? `<span class="ask-badge">${t('state.asking')}</span>`
      : live ? `<span class="live-badge">${t('pane.live')}</span>` : `<span>${t('pane.updated', { ago: ago(ms) })}</span>`;
    if (a) {
      const kind = ['subagent', a.type, a.model].filter(Boolean).join(' · ');
      this.q('.pmeta').innerHTML = `<span>${esc(kind)}</span><span>·</span><button class="parent-link" data-parent>${esc(t('pane.from', { title: s.title.slice(0, 50) }))}</button><span>·</span>${status}`;
      if (!this.title) { this.title = a.description || 'subagent'; this.q('.ptitle').textContent = this.title; }
    } else {
      this.q('.pmeta').innerHTML = `<span>${esc(p.name)}</span><span>·</span>${status}`;
      if (!this.title) { this.title = s.title; this.q('.ptitle').textContent = this.title; }
    }
    this.renderSummary();
    this.renderInfo();
    this.renderBg(true);
    // subagents of this session, live ones first: click to open here, Ctrl+click for a new pane
    const agents = (s.agents || []).slice().sort((x, y) => (isLive(y.mtime) - isLive(x.mtime)) || (y.born - x.born));
    if (!agents.length) { bar.hidden = true; return; }
    // Each subagent is: done (its meta says finished), running (not finished and active in the last 30 min;
    // "live" when it wrote something in the last 90s, otherwise busy in a long command), or stopped.
    const stateOf = (x) => (x.finished ? 'done' : isLive(x.mtime) ? 'live' : Date.now() - x.mtime < 30 * 60e3 ? 'busy' : 'stopped');
    const isRunning = (x) => ['live', 'busy'].includes(stateOf(x));
    const liveN = agents.filter(isRunning).length;
    const doneN = agents.filter((x) => stateOf(x) === 'done').length;
    const stoppedN = agents.length - liveN - doneN;
    const chip = (x) => {
      const st = stateOf(x);
      const icon = st === 'done' ? ICON.check : st === 'busy' ? '<span class="spin"></span>' : `<span class="dot${st === 'live' ? ' live' : ''}"></span>`;
      const tip = [x.description, x.type, x.model, `${t('agents.st.' + st)}${st === 'live' ? '' : ' · ' + t('agents.last', { ago: ago(x.mtime) })}`].filter(Boolean).join(' · ');
      return `<button class="chip pa ${st}${a && a.id === x.id ? ' cur' : ''}" data-agent="${esc(x.id)}" title="${esc(tip)}">` +
        `<span class="pa-st">${icon}</span><span class="pa-t" dir="auto">${esc(x.description || 'subagent')}</span>` +
        (x.type ? `<span class="pa-type">${esc(x.type)}</span>` : '') + '</button>';
    };
    const group = (x) => (isRunning(x) ? 'run' : stateOf(x) === 'done' ? 'done' : 'other');
    const items = agents.slice().sort((x, y) => (group(x) === 'run' ? 0 : 1) - (group(y) === 'run' ? 0 : 1)).map((x) => ({
      g: group(x), hay: [x.description, x.type, x.model].join(' ').toLowerCase(), html: chip(x) }));
    this.paintStrip('agents', bar, t('agents.title'), items, [['run', 'live', 'agents.n_live'], ['done', 'done', 'agents.n_done'], ['other', 'done', 'agents.n_stopped']],
      a ? `<button class="chip pa parent" data-parent>${ICON.chev}${t('pane.parent')}</button>` : '');
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
    else if (a === 'info') this.toggleInfo();
    else if (a === 'search') { if (this.q('.psearch').hidden) this.searchOpen(); else this.searchClose(); }
  }

  onAgents(e) {
    if (this.onStrip('agents', e, () => this.renderHead())) return;
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
    if (b.dataset.act === 'copy') { toast((await copyText(raw)) ? t('msg.copied') : t('copy.failed')); return; }
    save();
    state.pages.push({ id: uid(), html: md(raw), name: this.title.slice(0, 40) });
    save();
    renderThumbs();
    toast(t('pages.added_as', { n: state.pages.length }));
  }

  // ---------- long chip strips (subagents, background tasks) ----------
  // Up to STRIP_MAX chips sit in one row. Past that, the row keeps the first STRIP_MAX (running ones first, then the
  // latest) and adds "+N more"; opening it wraps every chip over several rows and gives a search box, and
  // the counts turn into filters (running / done / failed or stopped).
  stripUi(kind) { const m = this.strip || (this.strip = {}); return m[kind] || (m[kind] = { open: false, f: '', q: '' }); }
  paintStrip(kind, bar, label, items, groups, lead, force) {
    const u = this.stripUi(kind);
    const big = items.length > STRIP_MAX;
    if (!big) { u.open = false; u.f = ''; u.q = ''; }
    const q = u.q.trim().toLowerCase();
    let shown = items.filter((i) => (!u.f || i.g === u.f) && (!q || i.hay.includes(q)));
    let more = 0;
    if (big && !u.open && !u.f && !q) {
      more = shown.length - STRIP_MAX; // the list is sorted running first, so those are the ones that stay
      shown = shown.slice(0, STRIP_MAX);
    }
    const counts = groups.map(([g, cls, key]) => {
      const n = items.filter((i) => i.g === g).length;
      if (!n) return '';
      const tip = esc(t(key + '_tip', { n: num(n) }));
      return big ? `<button class="pa-count ${cls}${u.f === g ? ' on' : ''}" data-flt="${g}" title="${tip}">${t(key, { n: num(n) })}</button>`
        : `<span class="pa-count ${cls}" title="${tip}">${t(key, { n: num(n) })}</span>`;
    }).join('');
    const tools = big ? `<span class="sx-tools"><label class="sx-field"><input class="sx-q" type="search" value="${esc(u.q)}" placeholder="${esc(t('strip.filter'))}" autocomplete="off" spellcheck="false"></label>` +
      `<button class="icon-btn sx-toggle${u.open ? ' on' : ''}" data-sx="toggle" title="${esc(t(u.open ? 'strip.less' : 'strip.all', { n: num(items.length) }))}">${u.open ? ICON.chevUp : ICON.chevDown}</button></span>` : '';
    const body = shown.map((i, k) => (k && !u.open && shown[k - 1].g === 'run' && i.g !== 'run' ? '<span class="pa-sep"></span>' : '') + i.html).join('') +
      (!shown.length ? `<span class="sx-none">${t('strip.none')}</span>` : '');
    // "+N more" sits before the chips: at the end of a scrolling row it would be off-screen
    const moreBtn = more ? `<button class="chip pa more" data-sx="more" title="${esc(t('strip.all', { n: num(items.length) }))}">${t('strip.more', { n: num(more) })}</button>` : '';
    const html = `<span class="pa-label"${kind === 'bg' ? ` title="${esc(t('bg.tip'))}"` : ''}>${label}${counts}</span>${tools}${moreBtn}${lead || ''}${body}`;
    bar.classList.toggle('open', big && u.open);
    if (!force && bar._html === html) return;
    bar._html = html;
    const a = document.activeElement, typing = a && a.classList && a.classList.contains('sx-q') && bar.contains(a);
    const at = typing ? a.selectionStart : 0;
    bar.innerHTML = html;
    if (typing) { const i = bar.querySelector('.sx-q'); i.focus(); i.setSelectionRange(at, at); }
  }
  // clicks and typing on a strip's own controls; true when handled
  onStrip(kind, e, repaint) {
    const u = this.stripUi(kind);
    const f = e.target.closest('[data-flt]'), x = e.target.closest('[data-sx]');
    if (f) { u.f = u.f === f.dataset.flt ? '' : f.dataset.flt; u.open = u.open || !!u.f; }
    else if (x) u.open = x.dataset.sx === 'more' ? true : !u.open;
    else return false;
    repaint();
    return true;
  }
  onStripInput(kind, e, repaint) {
    if (!e.target.classList.contains('sx-q')) return;
    const u = this.stripUi(kind);
    u.q = e.target.value;
    if (u.q) u.open = true;
    repaint();
  }

  // ---------- background commands and watchers ----------
  // What the session left running: Bash run_in_background and Monitor calls. The transcript gives the command, the
  // task id (from the result of the call) and how it ended (the <task-notification> / a TaskStop); the live output
  // is the tail of the file Claude Code writes it to, which the server reads (see /api/task).
  trackBg(ev) {
    if (ev.k === 'tool' && ev.bg) this.bg.set(ev.id, { tool: ev.id, ...ev.bg, ts: ev.ts, task: '', status: '', exit: null, event: '' });
    else if (ev.k === 'result' && ev.task) { const e = this.bg.get(ev.id); if (e) { e.task = ev.task; e.out = ev.out || ''; } }
    else if (ev.k === 'task' && ev.taskId) {
      const e = this.bgOf(ev.taskId);
      if (e) { if (ev.status) { e.status = ev.status; e.endTs = ev.ts; } if (ev.detail) e.event = ev.detail; }
    } else if (ev.k === 'tool' && ev.stop) {
      const e = this.bgOf(ev.stop);
      if (e && !e.status) { e.status = 'stopped'; e.endTs = ev.ts; }
    }
  }
  bgOf(task) { for (const e of this.bg.values()) if (e.task === task) return e; return null; }
  renderBg(force) {
    const bar = this.q('.pbg');
    if (!bar) return;
    const list = [...this.bg.values()];
    if (!list.length) { bar.hidden = true; this._bgHtml = ''; this.closeBg(); return; }
    const rank = (e) => (bgState(e) === 'running' ? 0 : 1);
    const chip = (e) => {
      const st = bgState(e);
      const icon = st === 'running' ? '<span class="spin"></span>' : st === 'done' ? ICON.check : st === 'failed' ? ICON.x : '<span class="dot"></span>';
      const label = e.desc || e.cmd.split('\n')[0] || e.task;
      return `<button class="chip pa bgc ${st}${this.bgSel === e.tool ? ' cur' : ''}" data-bg="${esc(e.tool)}" title="${esc(`${t('bg.st.' + st)} · ${e.cmd.slice(0, 300)}`)}">` +
        `<span class="pa-st">${icon}</span><span class="pa-t" dir="auto">${esc(label)}</span>` +
        (e.monitor ? `<span class="pa-type">${esc(t('bg.monitor'))}</span>` : '') + '</button>';
    };
    const group = (e) => ({ running: 'run', done: 'done' }[bgState(e)] || 'other');
    const items = list.slice().sort((a, b) => rank(a) - rank(b) || Date.parse(b.ts || 0) - Date.parse(a.ts || 0)).map((e) => ({
      g: group(e), hay: [e.desc, e.cmd, e.task].join(' ').toLowerCase(), html: chip(e) }));
    this.paintStrip('bg', bar, t('bg.title'), items, [['run', 'live', 'bg.n_run'], ['done', 'done', 'bg.n_done'], ['other', 'done', 'bg.n_other']], '', force);
    bar.hidden = false;
    if (this.bgSel) this.paintBgHead();
  }
  onBg(e) {
    if (this.onStrip('bg', e, () => this.renderBg(true))) return;
    const b = e.target.closest('[data-bg]');
    if (!b) return;
    if (this.bgSel === b.dataset.bg) this.closeBg(); else this.openBg(b.dataset.bg);
    this.renderBg(true);
  }
  closeBg() {
    this.bgSel = null;
    this.stopBgPoll();
    const v = this.q('.pbg-view');
    if (v) { v.hidden = true; v.innerHTML = ''; }
  }
  openBg(tool) {
    const e = this.bg.get(tool);
    if (!e) return;
    this.stopBgPoll();
    this.bgSel = tool;
    this.bgSig = '';
    const files = cmdPaths(e.cmd);
    const copy = (txt, tip) => `<button class="icopy" data-copy="${esc(txt)}" title="${esc(t(tip))}">${ICON.copy}</button>`;
    const v = this.q('.pbg-view');
    v.innerHTML = '<div class="bgv-head"><span class="bgv-st"></span><span class="bgv-meta"></span>' +
        `<button class="icon-btn" data-bgv="close" title="${esc(t('bg.close'))}">${ICON.x}</button></div>` +
      `<div class="bgv-sec"><div class="bgv-k">${t('bg.command')}<button class="icopy" data-copy="${esc(e.cmd)}" title="${esc(t('bg.copy_cmd'))}">${ICON.copy}</button></div>` +
        `<pre class="bgv-cmd" dir="ltr">${esc(e.cmd)}</pre></div>` +
      (files.length ? `<div class="bgv-sec"><div class="bgv-k">${t('bg.files')}</div><div class="bgv-files">` + files.map((f) =>
        `<span class="bgp ${f.mode}">${f.mode ? `<b>${t('bg.' + f.mode)}</b>` : ''}<span class="ipath" dir="ltr" title="${esc(f.path)}">${esc(f.path)}</span>${copy(f.path, 'info.copy')}</span>`).join('') + '</div></div>' : '') +
      (e.event ? `<div class="bgv-sec"><div class="bgv-k">${t('bg.last_event')}</div><pre class="bgv-ev" dir="auto">${esc(e.event)}</pre></div>` : '') +
      `<div class="bgv-sec"><div class="bgv-k">${t('bg.output')}<span class="bgv-om"></span></div><pre class="bgv-out" dir="ltr"></pre><div class="bgv-note" hidden></div><div class="bgv-file"></div></div>`;
    v.hidden = false;
    this.paintBgHead();
    this.pollBg();
    this.bgT = setInterval(() => this.pollBg(), 2000);
  }
  paintBgHead() {
    const e = this.bg.get(this.bgSel), v = this.q('.pbg-view');
    if (!e || !v || v.hidden) return;
    const st = bgState(e);
    v.querySelector('.bgv-st').innerHTML = `<span class="ichip ${st === 'failed' ? 'bad' : st === 'running' ? 'live' : 'ok'}">${esc(t('bg.st.' + st))}</span>` +
      (e.desc ? `<b dir="auto">${esc(e.desc)}</b>` : '');
    v.querySelector('.bgv-meta').textContent = [e.ts ? t('bg.started', { when: hhmm(e.ts) }) : '', e.task].filter(Boolean).join(' · ');
  }
  // folder mode: the output files are in the temp folder, which the page can read once the user connects it
  connectHint(e, need) {
    const v = this.q('.pbg-view');
    const dir = ((e.out || [...this.bg.values()].map((x) => x.out).find(Boolean) || '').match(/^(.*?[\\/]claude-[^\\/]+)[\\/]/) || [])[1] || '/tmp/claude-<uid>';
    v.querySelector('.bgv-out').hidden = true;
    v.querySelector('.bgv-om').textContent = '';
    v.querySelector('.bgv-file').innerHTML = '';
    const n = v.querySelector('.bgv-note');
    n.hidden = false;
    n.innerHTML = `<p dir="auto">${esc(t(need === 'needs-permission' ? 'bg.connect_again' : 'bg.connect_text'))}</p>` +
      `<p class="bgv-dir"><span class="ipath" dir="ltr" title="${esc(dir)}">${esc(dir)}</span><button class="icopy" data-copy="${esc(dir)}" title="${esc(t('info.copy'))}">${ICON.copy}</button></p>` +
      `<div class="bgv-actions"><button class="btn primary" data-bgv="connect">${esc(t(need === 'needs-permission' ? 'bg.connect_allow' : 'bg.connect_pick'))}</button>` +
      `<small dir="auto">${esc(t('bg.connect_note'))}</small></div>`;
  }
  async connectTmp() {
    try {
      await (SRC.tmpState === 'needs-permission' ? SRC.reconnectTmp() : SRC.pickTmp());
    } catch (err) {
      if (err && err.name !== 'AbortError') toast(t('bg.connect_failed'));
      return;
    }
    if (this.bgSel) { this.bgSig = ''; this.pollBg(); this.stopBgPoll(); this.bgT = setInterval(() => this.pollBg(), 2000); }
  }
  stopBgPoll() { if (this.bgT) { clearInterval(this.bgT); this.bgT = null; } }
  async pollBg() {
    const tool = this.bgSel, key = this.key, e = this.bg.get(tool);
    if (!e || !key || document.hidden) return;
    const v = this.q('.pbg-view'), out = v.querySelector('.bgv-out'), om = v.querySelector('.bgv-om');
    const note = v.querySelector('.bgv-note');
    const say = (msg) => { out.hidden = false; note.hidden = true; out.textContent = msg; out.classList.add('none'); om.textContent = ''; };
    if (!e.task) { say(t('bg.empty')); return; } // the call has not been answered yet
    const r = serverOff || !SRC.ready ? { unsupported: true } : await SRC.task(key, e.task, this.bgSig);
    if (this.bgSel !== tool || this.key !== key || !r) return;
    if (r.unsupported) { this.stopBgPoll(); if (r.need) this.connectHint(e, r.need); else say(t('bg.unsupported')); return; }
    out.hidden = false;
    note.hidden = true;
    if (!r.found) { say(t('bg.missing')); if (bgState(e) !== 'running') this.stopBgPoll(); return; }
    if (!r.same) {
      this.bgSig = r.sig;
      this.bgAt = r.mtime;
      this.bgInfo = { size: r.size, cut: r.cut, file: r.file };
      const text = outText(r.text);
      const exit = text.match(/\[exited with code (-?\d+)\]\s*$/);
      if (exit && e.exit == null) { e.exit = +exit[1]; this.paintBgHead(); this.renderBg(); }
      const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.classList.toggle('none', !text);
      out.textContent = text || t('bg.empty');
      if (stick) out.scrollTop = out.scrollHeight;
      v.querySelector('.bgv-file').innerHTML = `<span class="ipath" dir="ltr" title="${esc(r.file)}">${esc(r.file)}</span>` +
        `<button class="icopy" data-copy="${esc(r.file)}" title="${esc(t('info.copy'))}">${ICON.copy}</button>`;
    }
    if (this.bgInfo) {
      const i = this.bgInfo;
      om.textContent = [fmtBytes(i.size), this.bgAt ? t('bg.updated', { ago: ago(this.bgAt) }) : '', i.cut ? t('bg.tail', { n: fmtBytes(i.size - i.cut), total: fmtBytes(i.size) }) : ''].filter(Boolean).join(' · ');
    }
    if (bgState(e) !== 'running') this.stopBgPoll(); // finished: this was the last read
  }
  onBgView(e) {
    const c = e.target.closest('[data-copy]');
    if (c) { copyText(c.dataset.copy).then((ok) => toast(t(ok ? 'info.copied' : 'copy.failed'))); return; }
    if (e.target.closest('[data-bgv="close"]')) { this.closeBg(); this.renderBg(true); }
    else if (e.target.closest('[data-bgv="connect"]')) this.connectTmp();
  }

  // ---------- info panel: model, duration, tokens, folder, activity ----------
  toggleInfo(force) {
    const box = this.q('.pinfo');
    const open = force != null ? force : box.hidden;
    box.hidden = !open;
    this.q('[data-a="info"]').classList.toggle('on', open);
    ui.infoOpen = open;
    saveUi();
    if (open) this.renderInfo();
  }
  scheduleInfo() {
    if (this.infoT) return;
    this.infoT = setTimeout(() => { this.infoT = null; this.renderInfo(); this.renderSummary(); this.renderBg(); }, 400);
  }
  renderSummary() {
    // compact "model · duration · tokens" next to the title
    const meta = this.q('.pmeta');
    let el = meta.querySelector('.psum');
    const sum = statSummary(this.stats);
    if (!sum) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'psum'; meta.append(el); }
    el.textContent = sum;
  }
  renderInfo() {
    const box = this.q('.pinfo');
    if (!box || box.hidden) return;
    box.innerHTML = infoHtml(this.stats, this.agentInfo, this.sessInfo, this.git);
    this.loadGit();
  }
  loadGit() {
    // git status of the session's folder, at most every 10s and only while the panel is visible
    if (serverOff || !SRC.ready || !this.key || this.gitBusy || Date.now() - (this.gitAt || 0) < 10e3) return;
    const k = this.key;
    this.gitBusy = true;
    this.gitAt = Date.now();
    SRC.git(k).then((g) => {
      this.gitBusy = false;
      if (this.key !== k) return;
      this.git = g || { failed: true };
      const box = this.q('.pinfo');
      if (box && !box.hidden) box.innerHTML = infoHtml(this.stats, this.agentInfo, this.sessInfo, this.git);
    });
  }
  onInfoClick(e) {
    const c = e.target.closest('[data-copy]');
    if (c) { copyText(c.dataset.copy).then((ok) => toast(t(ok ? 'info.copied' : 'copy.failed'))); return; }
    const f = e.target.closest('[data-file]');
    if (f) {
      // jump to the last edit of that file and open it
      const edits = [...this.body.querySelectorAll('details.tool')].filter((d) => d.dataset.file === f.dataset.file);
      const last = edits[edits.length - 1];
      if (!last) return;
      for (let d = last; d; d = d.parentElement.closest('details')) d.open = true;
      this.jumpTo(last);
    }
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
      count.textContent = q.trim() ? t('search.enter') : '';
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
      count.textContent = re === 'bad' ? t('search.bad_regex') : '';
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
      count.textContent = t('search.none');
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
    count.title = tn('search.count_tip', this.hits.length, { ms: Math.round(performance.now() - t0) });
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
    if (!this.hits.length) { list.innerHTML = `<div class="ps-empty">${t('search.no_results')}</div>`; return; }
    list.innerHTML = this.hits.slice(0, 300).map((h, i) => {
      const host = h.startContainer.parentElement;
      const tool = host.closest('details.tool');
      const kind = host.closest('.msg.user') ? t('search.kind_you') : host.closest('.msg.ai') ? 'Claude' : tool ? tool.dataset.name : host.closest('details.tools') ? t('search.kind_tools') : '';
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
    }).join('') + (this.hits.length > 300 ? `<div class="ps-empty">${t('search.first_n', { n: this.hits.length })}</div>` : '');
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
      sum = `<span class="pin-k">${t('pin.tasks')}</span><span class="pbar"><i style="width:${todos.length ? (done / todos.length) * 100 : 0}%"></i></span>` +
        `<span class="count">${done}/${todos.length}</span><span class="pin-now" dir="auto">${now ? esc(now.text) : done === todos.length ? t('pin.all_done') : ''}</span>`;
      body = todos.map((t) => `<div class="todo ${esc(t.status)}"><span class="ti">${t.status === 'completed' ? ICON.check : t.status === 'in_progress' ? '<span class="spin"></span>' : '<span class="ring"></span>'}</span><span dir="auto">${esc(t.text)}</span></div>`).join('');
    } else {
      const first = (plan.match(/^#+\s*(.+)$/m) || plan.match(/^(.+)$/m) || ['', ''])[1];
      sum = `<span class="pin-k">${t('pin.plan')}</span><span class="pin-now" dir="auto">${esc(first)}</span>`;
      body = md(plan);
    }
    box.innerHTML = `<details${ui.pinOpen ? ' open' : ''}><summary>${ICON.chev}${sum}</summary><div class="pin-body page">${body}</div></details>`;
    box.hidden = false;
    box.querySelector('details').addEventListener('toggle', (e) => { ui.pinOpen = e.target.open; saveUi(); });
  }

  // A question / plan Claude is waiting on right now (server mode with the optional hook). Older
  // Claude Code writes it to the transcript only once answered; newer versions write the question
  // right away, and then its own card already says it is waiting. Folder mode never receives one.
  renderWait(stick) {
    const box = this.q('.pwait');
    const tools = this.tools || {};
    const unanswered = new Set(Object.keys(tools).filter((id) => tools[id].classList.contains('ask-card') && tools[id].classList.contains('pending')));
    const w = this.waiting && !window.CCPreviewCore.pendingInTranscript(this.waiting, unanswered) ? this.waiting : null;
    box.hidden = !w;
    if (!w) { box.innerHTML = ''; return; }
    const plan = w.tool === 'ExitPlanMode';
    let h = `<div class="pw-head"><span class="pw-dot"></span><b>${t(plan ? 'wait.plan' : 'wait.question')}</b><small>${t('wait.terminal')} · ${hhmm(new Date(w.at).toISOString())}</small></div>`;
    const input = w.input || {};
    if (plan) h += `<div class="pw-plan">${md(String(input.plan || ''))}</div>`;
    else {
      for (const q of Array.isArray(input.questions) ? input.questions : []) {
        const qd = textDir([q.question, ...(q.options || []).map((o) => o.label)].join(' '));
        h += `<div class="pw-q" dir="${qd === 'auto' ? 'rtl' : qd}">${q.header ? `<span class="ask-chip">${esc(q.header)}</span>` : ''}<div class="pw-qt" dir="${textDir(q.question)}">${esc(q.question || '')}</div>` +
          (q.multiSelect ? `<small>${t('wait.multi')}</small>` : '') +
          `<ol class="pw-opts">${(q.options || []).map((o) => `<li><b dir="${textDir(o.label)}">${esc(o.label || '')}</b>${o.description ? `<span dir="${textDir(o.description)}">${esc(o.description)}</span>` : ''}</li>`).join('')}</ol></div>`;
      }
    }
    box.innerHTML = h;
    if (stick && !this.restoring) this.scroll.scrollTop = this.scroll.scrollHeight;
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
      trackStats(this.stats, ev);
      this.trackBg(ev);
      if (ev.k === 'usage' || ev.k === 'ctx') return; // stats only, nothing to draw
      if (ev.k === 'pending') { this.waiting = ev.p; this.renderWait(wasBottom); return; }
      if (ev.k === 'title') {
        if (!this.key.agent) { this.title = ev.text; this.q('.ptitle').textContent = ev.text; persistPanes(); }
        return;
      }
      if (ev.k === 'result' && this.tools[ev.id] && this.tools[ev.id].classList.contains('ask-card')) {
        markAnswers(this.tools[ev.id], ev);
        return;
      }
      if (ev.k === 'result') {
        const tl = this.tools[ev.id];
        if (tl) {
          tl.querySelector('.res').innerHTML = ev.text ? `<pre dir="auto"${ev.err ? ' class="err"' : ''}>${esc(ev.text)}</pre>` : '';
          if (ev.images) {
            // screenshots stay visible under the (collapsed) tool group
            const g = tl.closest('details.tools');
            if (!g._imgs) {
              g._imgs = document.createElement('div');
              g._imgs.className = 'imgs tool-imgs';
              g.after(g._imgs);
            }
            g._imgs.insertAdjacentHTML('beforeend', imgsHtml(ev.images, `${tl.dataset.name}: ${tl.dataset.sum || ''}`, ''));
          }
          tl.classList.remove('pending');
          tl.classList.add(ev.err ? 'bad' : 'ok');
          tl.querySelector('.st-ico').innerHTML = ev.err ? ICON.x : ICON.check;
          if (ev.agent && !tl.querySelector('.open-agent')) {
            tl.querySelector('summary').insertAdjacentHTML('beforeend',
              `<button class="btn open-agent" data-open-agent="${esc(ev.agent)}" title="${esc(t('agents.open_tip'))}">${t('agents.open')}</button>`);
          }
          touched.add(tl.closest('details.tools'));
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
        if (ev.diff && ev.diff.file) t.dataset.file = ev.diff.file;
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
        el.innerHTML = `<div class="who">${t(this.key.agent ? 'msg.agent_task' : ev.queued ? 'msg.you_queued' : 'msg.you')} · ${hhmm(ev.ts)}</div>${md(ev.text)}${ev.images ? `<div class="imgs">${imgsHtml(ev.images, t(this.key.agent ? 'lightbox.from_task' : 'lightbox.from_you'), ev.ts)}</div>` : ''}`;
        el._raw = ev.text;
        el._time = hhmm(ev.ts);
        this.pendingUser = el;
        userAdded = true;
      } else if (ev.k === 'text') {
        this.pendingUser = null;
        el = document.createElement('div');
        el.className = 'msg ai';
        el.innerHTML = md(ev.text) + `<div class="msg-actions"><button class="icon-btn" data-act="copy" title="${esc(t('msg.copy_tip'))}">${ICON.copy}</button>` +
          `<button class="icon-btn" data-act="page" title="${esc(t('msg.to_page_tip'))}">${ICON.page}</button></div>`;
        el._raw = ev.text;
      } else if (ev.k === 'thinking') {
        el = document.createElement('details');
        el.className = 'thinking';
        el.innerHTML = `<summary>${t('msg.thinking')}</summary><div class="th-body">${md(ev.text)}</div>`;
      } else if (ev.k === 'task') {
        // a finished background command / agent / monitor event: one line like the terminal, details folded
        const head = `<span class="task-dot"></span><span class="task-sum" dir="auto">${esc(ev.summary || ev.status || ev.taskId)}</span><span class="task-time">${hhmm(ev.ts)}</span>`;
        el = document.createElement(ev.detail ? 'details' : 'div');
        el.className = 'task ' + ({ completed: 'ok', failed: 'bad', killed: 'bad', stopped: 'stop' }[ev.status] || '');
        el.innerHTML = ev.detail ? `<summary>${head}</summary><div class="task-body" dir="auto">${md(ev.detail)}</div>` : head;
      } else if (ev.k === 'agentmsg') {
        // a subagent's final report / a peer session's message: one muted line, the text folded under it
        const label = t(ev.sub ? 'msg.subagent_report' : 'msg.agent_message');
        el = document.createElement('details');
        el.className = 'task agentmsg';
        el.innerHTML = `<summary><span class="task-dot"></span><span class="task-sum" dir="auto">${esc(label)}${ev.from ? ` <code>${esc(ev.from.slice(0, 8))}</code>` : ''}</span><span class="task-time">${hhmm(ev.ts)}</span></summary><div class="task-body" dir="auto">${md(ev.detail)}</div>`;
      } else if (ev.k === 'note') {
        el = document.createElement('div');
        el.className = 'note';
        el.textContent = ev.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      } else if (ev.k === 'divider') {
        el = document.createElement('div');
        el.className = 'divider';
        el.textContent = t('msg.compacted');
      }
      if (el) { frag.append(el); added++; }
    });
    this.body.append(frag);
    if (this.waiting && added) this.renderWait(false); // the transcript may now show that question itself
    touched.forEach((g) => g && updateGroup(g));
    this.scheduleInfo();
    if (userAdded) this.renderRail();
    if (!this.q('.psearch').hidden && this.q('.ps-q').value) {
      clearTimeout(this.reSearch);
      this.reSearch = setTimeout(() => { this.lastSig = null; this.runSearch(true); }, 1500);
    }
    if (wasBottom && !this.restoring) this.scroll.scrollTop = this.scroll.scrollHeight;
    else if (added && !this.restoring && this.body.children.length) {
      this.unseen += added;
      const j = this.q('.pjump');
      j.textContent = t('pane.jump', { n: this.unseen });
      j.hidden = false;
    }
  }
}

// ---------- AskUserQuestion ----------
// ---------- session stats (model, tokens, duration, activity) for the info panel ----------
function newStats() {
  return { msgs: new Map(), first: 0, last: 0, cwd: '', branches: [], tools: new Map(), files: new Map(), prompts: 0, errors: 0, compactions: 0, results: 0,
    ctx: 0, ctxTs: '', ctxModel: '', maxCtx: 0, eff: '', pmode: '', compacts: [] };
}
function trackStats(st, ev) {
  if (ev.ts) {
    const ms = Date.parse(ev.ts);
    if (ms) { if (!st.first || ms < st.first) st.first = ms; if (ms > st.last) st.last = ms; }
  }
  if (ev.k === 'usage') {
    st.msgs.set(ev.mid, { model: ev.model, u: ev.u }); // one message repeats on several lines
    // what the model saw on its latest request = the context right now
    const c = ev.u.i + ev.u.cr + ev.u.cw;
    if (c && ev.model !== '<synthetic>' && (!st.ctxTs || (ev.ts || '') >= st.ctxTs)) { st.ctx = c; st.ctxTs = ev.ts || st.ctxTs; st.ctxModel = ev.model; }
    if (c > st.maxCtx) st.maxCtx = c;
    if (ev.eff) st.eff = ev.eff;
  } else if (ev.k === 'pmode') st.pmode = ev.v;
  else if (ev.k === 'ctx') {
    st.cwd = ev.cwd;
    if (ev.branch && st.branches[st.branches.length - 1] !== ev.branch) st.branches = [...st.branches.filter((b) => b !== ev.branch), ev.branch];
  } else if (ev.k === 'tool') {
    st.tools.set(ev.name, (st.tools.get(ev.name) || 0) + 1);
    if (ev.diff && ev.diff.file) st.files.set(ev.diff.file, (st.files.get(ev.diff.file) || 0) + 1);
  } else if (ev.k === 'user') st.prompts++;
  else if (ev.k === 'result') { st.results++; if (ev.err) st.errors++; }
  else if (ev.k === 'divider') {
    st.compactions++;
    if (ev.pre) st.compacts.push({ pre: ev.pre, post: ev.post, trigger: ev.trigger, ts: ev.ts });
    // right after a compaction the context is the summary, until the next request reports the real size
    if (ev.post && (!st.ctxTs || (ev.ts || '') >= st.ctxTs)) { st.ctx = ev.post; st.ctxTs = ev.ts || st.ctxTs; }
  }
}
// the context window is not in the transcript: 1M for the models that ship with it, or when the session already went past 200K
const ctxWindow = (st) => (st.maxCtx > 200e3 || /\[1m\]|opus-(4-[6-9]|5)|sonnet-5|fable/.test(st.ctxModel) ? 1e6 : 200e3);
const tOpt = (key) => { const s = t(key); return s === key ? '' : s; }; // a label for known values only
function tokenTotals(st) {
  const tk = { i: 0, o: 0, cr: 0, cw: 0 };
  st.msgs.forEach(({ u }) => { tk.i += u.i; tk.o += u.o; tk.cr += u.cr; tk.cw += u.cw; });
  tk.all = tk.i + tk.o + tk.cr + tk.cw;
  return tk;
}
function modelCounts(st) {
  const m = new Map();
  st.msgs.forEach(({ model }) => { if (model && model !== '<synthetic>') m.set(model, (m.get(model) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function fmtTok(n) {
  const f = (v, big) => num(v, { maximumFractionDigits: big ? 0 : 1, useGrouping: false });
  if (n >= 1e6) return t('tok.m', { n: f(n / 1e6, n >= 1e7) });
  if (n >= 1e3) return t('tok.k', { n: f(n / 1e3, n >= 1e4) });
  return num(n);
}
function fmtDur(ms) {
  const m = Math.round(ms / 60e3);
  if (ms < 60e3) return t('dur.s', { n: num(Math.max(1, Math.round(ms / 1e3))) });
  if (m < 60) return t('dur.m', { n: num(m) });
  return m % 60 ? t('dur.hm', { h: num(Math.floor(m / 60)), m: num(m % 60) }) : t('dur.h', { n: num(m / 60) });
}
// how a background task stands: its notification / TaskStop wins, then the exit line at the end of its output
const bgState = (e) => (e.status ? ({ completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }[e.status] || 'done')
  : e.exit != null ? (e.exit === 0 ? 'done' : 'failed') : 'running');
// terminal output for a <pre>: colour codes dropped, a progress line rewritten with \r keeps its last state
const outText = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').split('\n').map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() || '' : l)).join('\n');
const fmtBytes = (n) => (n >= 1048576 ? `${num(n / 1048576, { maximumFractionDigits: 1 })} MB` : n >= 1024 ? `${num(n / 1024, { maximumFractionDigits: 1 })} KB` : `${num(n)} B`);
const cmdPaths = (cmd) => CCPreviewCore.cmdPaths(cmd);
const shortModel = (m) => m.replace(/^claude-/, '');
function statSummary(st) {
  const models = modelCounts(st), tk = tokenTotals(st);
  const parts = [];
  if (models.length) parts.push(shortModel(models[0][0]));
  if (st.first && st.last > st.first) parts.push(fmtDur(st.last - st.first));
  if (st.ctx) parts.push(t('info.ctx_summary', { n: fmtTok(st.ctx) }));
  else if (tk.all) parts.push(t('info.tokens_n', { n: fmtTok(tk.all) }));
  return parts.join(' · ');
}
function infoHtml(st, agent, sess, g) {
  const tk = tokenTotals(st), models = modelCounts(st);
  const row = (k, v) => `<div class="ii"><div class="ik">${k}</div><div class="iv">${v}</div></div>`;
  const chip = (txt, tip) => `<span class="ichip"${tip ? ` title="${esc(t(tip))}"` : ''}>${txt}</span>`;
  const path = (p) => `<span class="ipath" dir="ltr" title="${esc(p)}">${esc(p)}</span><button class="icopy" data-copy="${esc(p)}" title="${esc(t('info.copy'))}">${ICON.copy}</button>`;
  let h = '<div class="info-grid">';
  h += row(t('info.model'), models.length
    ? models.map(([m, n]) => `<span class="ichip mono">${esc(m)}</span><small>${tn('info.replies', n, { n: num(n) })}</small>`).join(' ')
    : agent && agent.model ? `<span class="ichip mono">${esc(agent.model)}</span>` : '—');
  h += row(t('info.duration'), st.first
    ? `<b>${fmtDur(Math.max(0, st.last - st.first))}</b> <small>${t('info.from_to', { from: whenText(st.first), to: whenText(st.last) })}</small>` : '—');
  if (st.ctx) {
    const win = ctxWindow(st), pct = Math.min(100, Math.round((st.ctx / win) * 100));
    const lc = st.compacts[st.compacts.length - 1];
    const by = lc && (lc.trigger === 'manual' ? t('info.compact_manual') : lc.trigger === 'auto' ? t('info.compact_auto') : '');
    h += row(t('info.ctx'), `<b title="${esc(t('info.ctx_tip'))}">${fmtTok(st.ctx)}</b> <small>${t('info.ctx_of', { n: fmtTok(win) })}</small>` +
      `<span class="imeter ${pct >= 80 ? 'high' : pct >= 50 ? 'mid' : ''}" title="${num(pct)}%"><i style="inline-size:${pct}%"></i></span><b>${num(pct)}%</b>` +
      (lc ? ` <small>${esc(t('info.compact_last', { when: whenText(Date.parse(lc.ts)), pre: fmtTok(lc.pre), post: fmtTok(lc.post) }) + by)}</small>` : ''));
  }
  if (st.pmode || st.eff) {
    h += row(t('info.mode'), (st.pmode ? `<span class="ichip mono" title="${esc(t('info.pmode_tip'))}">${esc(st.pmode)}</span><small>${esc(tOpt('pmode.' + st.pmode))}</small> ` : '') +
      (st.eff ? `<span class="ichip mono" title="${esc(t('info.effort_tip'))}">${esc(t('info.effort', { v: st.eff }))}</span><small>${esc(tOpt('effort.' + st.eff))}</small>` : ''));
  }
  h += row(t('info.tokens'), tk.all
    ? `<b>${fmtTok(tk.all)}</b> ${chip(t('info.tok_in', { n: fmtTok(tk.i) }), 'info.tok_in_tip')}${chip(t('info.tok_out', { n: fmtTok(tk.o) }), 'info.tok_out_tip')}` +
      `${chip(t('info.tok_cr', { n: fmtTok(tk.cr) }), 'info.tok_cr_tip')}${chip(t('info.tok_cw', { n: fmtTok(tk.cw) }), 'info.tok_cw_tip')} <small>${tn('info.requests', st.msgs.size, { n: num(st.msgs.size) })}</small>` +
      `<small style="width:100%">${t('info.tokens_note')}</small>`
    : '—');
  const dir = (agent && agent.worktree) || st.cwd;
  h += row(t('info.folder'), dir ? path(dir) : '—');
  // the git row already names the branch; keep this row when the session moved between branches
  if ((st.branches.length || (agent && agent.worktreeBranch)) && !(g && g.repo && st.branches.length <= 1)) {
    const brs = st.branches.length ? st.branches : [agent.worktreeBranch];
    h += row(t('info.branch'), brs.map((b) => `<span class="ichip mono">${esc(b)}</span>`).join(' '));
  }
  h += gitRow(g, row);
  if (agent) {
    const flags = [agent.type && `<span class="ichip mono">${esc(agent.type)}</span>`, agent.background && chip(t('info.background')),
      agent.worktree && chip(t('info.worktree')), agent.finished ? `<span class="ichip ok">${t('info.finished')}</span>` : `<span class="ichip live">${t('info.running')}</span>`].filter(Boolean);
    h += row(t('info.subagent'), flags.join(' '));
  } else if (sess && sess.agents && sess.agents.length) {
    h += row(t('info.subagents'), `${num(sess.agents.length)} <small>${t('info.subs_running', { n: num(sess.agents.filter((x) => !x.finished).length) })}</small>`);
  }
  const tools = [...st.tools.entries()].sort((a, b) => b[1] - a[1]);
  const totalTools = tools.reduce((n, [, c]) => n + c, 0);
  h += row(t('info.activity'), chip(tn(agent ? 'info.prompts' : 'info.prompts_you', st.prompts, { n: num(st.prompts) })) + chip(tn('info.cmds', totalTools, { n: num(totalTools) })) +
    (st.errors ? `<span class="ichip bad">${t('info.failed', { n: num(st.errors) })}</span>` : '') + (st.compactions ? chip(t('info.compacted', { n: num(st.compactions) })) : '') +
    (tools.length ? `<div class="itools">${tools.slice(0, 10).map(([n, c]) => `<span class="ichip mono">${esc(n)} <b>${num(c)}</b></span>`).join('')}</div>` : ''));
  if (st.files.size) {
    const files = [...st.files.entries()].sort((a, b) => b[1] - a[1]);
    h += row(`${t('info.files')} <small>(${num(files.length)})</small>`, '<div class="ifiles">' + files.slice(0, 40).map(([f, c]) => {
      const parts = f.split('/'), name = parts.pop();
      return `<button class="ifile" data-file="${esc(f)}" title="${esc(f)}"><span class="mono">${esc(name)}</span><small dir="ltr">${esc(parts.slice(-2).join('/'))}</small>${c > 1 ? `<b>×${num(c)}</b>` : ''}</button>`;
    }).join('') + (files.length > 40 ? `<small>${t('info.more_files', { n: num(files.length - 40) })}</small>` : '') + '</div>');
  }
  return h + '</div>';
}

function gitRow(g, row) {
  const label = t('info.git');
  if (!g) return serverOff || !SRC.ready ? '' : row(label, `<small>${t('git.loading')}</small>`);
  if (g.unsupported) return ''; // a web page cannot run git: no row at all rather than a nag (the branch row still shows)
  if (g.failed) return row(label, `<small>${t('git.failed')}</small>`);
  if (!g.repo) return row(label, `<small>${t(g.gone ? 'git.gone' : 'git.not_repo')}</small>`);
  const counts = { staged: 0, changed: 0, untracked: 0, conflict: 0 };
  g.files.forEach(({ x, y }) => {
    if (x === '?') counts.untracked++;
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) counts.conflict++;
    else { if (x !== ' ') counts.staged++; if (y !== ' ') counts.changed++; }
  });
  const chip = (cls, txt, tip) => `<span class="ichip${cls ? ' ' + cls : ''}"${tip ? ` title="${esc(t(tip))}"` : ''}>${txt}</span>`;
  let v = `<span class="ichip mono">${esc(g.branch || 'HEAD')}</span>` + (g.upstream ? `<small dir="ltr">${esc(g.upstream)}</small>` : `<small>${t('git.no_upstream')}</small>`);
  if (g.ahead) v += chip('warn', t('git.ahead', { n: num(g.ahead) }), 'git.ahead_tip');
  if (g.behind) v += chip('warn', t('git.behind', { n: num(g.behind) }), 'git.behind_tip');
  if (!g.total) v += chip('ok', t('git.clean'));
  else {
    if (counts.conflict) v += chip('bad', t('git.conflict', { n: num(counts.conflict) }));
    if (counts.staged) v += chip('', t('git.staged', { n: num(counts.staged) }));
    if (counts.changed) v += chip('warn', t('git.modified', { n: num(counts.changed) }));
    if (counts.untracked) v += chip('', t('git.untracked', { n: num(counts.untracked) }));
  }
  if (g.stash) v += chip('', t('git.stash', { n: num(g.stash) }));
  if (g.last) v += `<small style="width:100%" dir="auto">${t('git.last', { sha: `<span class="mono">${esc(g.last.sha)}</span>`, subject: esc(g.last.subject), ago: ago(g.last.at) })}</small>`;
  if (g.total) {
    const cls = (x, y) => (x === '?' ? 'gQ' : x === 'D' || y === 'D' ? 'gD' : x === 'A' ? 'gA' : 'gM');
    v += '<div class="igit">' + g.files.slice(0, 30).map(({ x, y, f }) =>
      `<div class="${cls(x, y)}" title="${esc(f)}"><b>${esc((x + y).replace(/ /g, '·'))}</b><span>${esc(f)}</span></div>`).join('') +
      (g.total > 30 ? `<div><span>${t('git.more', { n: num(g.total - 30) })}</span></div>` : '') + '</div>';
  }
  return row(label, v);
}

function askHtml(questions) {
  return `<div class="ask-head"><span class="ask-ico">?</span><span class="ask-title">${t('ask.title')}</span><span class="ask-state">${t('ask.waiting')}</span></div>` +
    questions.map((q, qi) => `<div class="ask-q" data-q="${qi}">` +
      (q.header ? `<span class="ask-chip">${esc(q.header)}</span>` : '') +
      `<div class="ask-text" dir="${textDir(q.question)}">${inline(q.question)}${q.multi ? ` <span class="ask-multi">${t('ask.multi')}</span>` : ''}</div>` +
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
  if (ev.err) { card.classList.add('declined'); state.textContent = t('ask.declined'); return; }
  card.classList.add('answered');
  state.textContent = t('ask.answered');
  let answers = ev.answers && typeof ev.answers === 'object' ? ev.answers : null;
  if (!answers) {
    answers = {};
    const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(ev.text || ''))) answers[m[1]] = m[2];
  }
  const values = Object.values(answers);
  card.querySelectorAll('.ask-q').forEach((qEl, qi) => {
    const textEl = qEl.cloneNode(true).querySelector('.ask-text');
    const multi = textEl.querySelector('.ask-multi');
    if (multi) multi.remove();
    const qText = textEl.textContent.trim();
    const ans = String(answers[qText] != null ? answers[qText] : values[qi] != null ? values[qi] : '');
    const picked = new Set(ans.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean));
    let matched = false;
    qEl.querySelectorAll('.ask-opt').forEach((o) => {
      const on = picked.has(o.dataset.label) || ans === o.dataset.label;
      o.classList.toggle('picked', on);
      if (on) matched = true;
    });
    const custom = qEl.querySelector('.ask-custom');
    if (ans && !matched) { custom.hidden = false; custom.innerHTML = `<b>${t('ask.your_answer')}</b> <span dir="${textDir(ans)}">${esc(ans)}</span>`; }
  });
}

function updateGroup(g) {
  const tools = g.querySelectorAll('details.tool');
  const pending = g.querySelectorAll('details.tool.pending').length;
  const bad = g.querySelectorAll('details.tool.bad').length;
  const last = tools[tools.length - 1];
  const n = tools.length;
  const status = pending ? '<span class="st-ico"><span class="spin"></span></span>' : bad ? `<span class="st-ico bad">${ICON.x}</span>` : `<span class="st-ico ok">${ICON.check}</span>`;
  const label = tn('tools.count', n);
  g.querySelector('summary').innerHTML = `${ICON.chev}${status}<span>${label}</span>` +
    (last ? `<span class="g-last" dir="auto"><b>${esc(last.dataset.name)}</b> ${esc(last.dataset.sum)}</span>` : '');
}

// ---------- pane management ----------
function layoutPanes() {
  const tb = tabs[curTab];
  syncDom(tb);
  panesEl.dataset.n = panes.length;
  panesEl.dataset.cols = Math.min(4, tb.shape.length); // the compact text rules follow the number of columns
  panesEl.style.setProperty('--cols', tb.shape.length);
  panes.forEach((p) => p.el.classList.toggle('active', p === activePane && panes.length > 1));
}
// A new pane goes in a new column after the active one while columns fit, then under the active pane.
function addPane() {
  if (panes.length >= MAX_PANES) { toast(t('pane.max', { n: MAX_PANES })); return activePane; }
  const p = new Pane();
  const tb = tabs[curTab];
  const cols = columns(tb);
  const ci = activePane ? cols.findIndex((c) => c.includes(activePane)) : cols.length - 1;
  if (ci < 0) cols.push([p]);
  else if (cols.length < fitCols()) cols.splice(ci + 1, 0, [p]);
  else cols[ci].splice(cols[ci].indexOf(activePane) + 1, 0, p);
  setCols(tb, cols);
  p.renderEmpty();
  layoutPanes();
  p.el.scrollIntoView({ block: 'nearest' }); // a pane that lands on the part below the fold
  return p;
}
// ---------- drag a pane by its header to move it ----------
const PANE_DRAG = 'application/x-ccpreview-pane';
let dragPane = null;
// Where a dragged pane would land on the pane under the pointer, like VS Code: the outer thirds beside it make a
// new column there; the middle goes above (upper half) or below (lower half) it, in the same column.
function dropSpot(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const over = el && el.closest('.pane-v');
  const target = over && panes.find((p) => p.el === over);
  if (!target || target === dragPane) return null;
  const r = over.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const rtl = getComputedStyle(panesEl).direction === 'rtl';
  let zone;
  if (fx < 0.3) zone = rtl ? 'after' : 'before';
  else if (fx > 0.7) zone = rtl ? 'before' : 'after';
  else zone = fy < 0.5 ? 'top' : 'bottom';
  const shows = { before: rtl ? 'drop-r' : 'drop-l', after: rtl ? 'drop-l' : 'drop-r', top: 'drop-t', bottom: 'drop-b' };
  return { target, zone, cls: shows[zone] };
}
const DROP_CLASSES = ['drop-l', 'drop-r', 'drop-t', 'drop-b'];
function clearDrop() { allPanes().forEach((p) => p.el.classList.remove(...DROP_CLASSES)); }
function movePane(p, target, zone) {
  const tb = tabs[curTab];
  const cols = columns(tb).map((c) => c.filter((x) => x !== p)).filter((c) => c.length);
  const ci = cols.findIndex((c) => c.includes(target));
  if (zone === 'top' || zone === 'bottom') cols[ci].splice(cols[ci].indexOf(target) + (zone === 'bottom' ? 1 : 0), 0, p);
  else cols.splice(ci + (zone === 'after' ? 1 : 0), 0, [p]);
  setCols(tb, cols);
  layoutPanes();
  persistPanes();
  p.el.scrollIntoView({ block: 'nearest' });
}
function wireGrid(grid) {
  new ResizeObserver(() => { if (grid === panesEl && panes.length) layoutPanes(); }).observe(grid);
  grid.addEventListener('dragstart', (e) => {
    const head = e.target.closest && e.target.closest('.phead');
    const p = head && panes.find((x) => x.el === head.parentElement);
    if (!p) return;
    dragPane = p;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(PANE_DRAG, String(panes.indexOf(p)));
    e.dataTransfer.setDragImage(head, 20, 16);
    setTimeout(() => { if (dragPane === p) p.el.classList.add('dragging'); }); // after the browser took its drag image
  });
  grid.addEventListener('dragover', (e) => {
    if (!dragPane) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDrop();
    const spot = dropSpot(e);
    if (spot) spot.target.el.classList.add(spot.cls);
    // rows below the fold: scroll while the pointer rests near the top or bottom edge
    const r = grid.getBoundingClientRect();
    if (e.clientY > r.bottom - 60) grid.scrollTop += 18;
    else if (e.clientY < r.top + 60) grid.scrollTop -= 18;
  });
  grid.addEventListener('drop', (e) => {
    if (!dragPane) return;
    e.preventDefault();
    const spot = dropSpot(e);
    if (spot) movePane(dragPane, spot.target, spot.zone);
  });
}
document.addEventListener('dragend', () => {
  if (!dragPane) return;
  dragPane.el.classList.remove('dragging');
  dragPane = null;
  clearDrop();
});

// A plain mouse wheel over a strip that only scrolls sideways (the subagent chips, the tab bar) scrolls it
// sideways, so Shift is not needed. A strip with nothing to scroll leaves the wheel to the page.
document.addEventListener('wheel', (e) => {
  const strip = e.target.closest && e.target.closest('.pagents, #tabbar');
  if (!strip || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || strip.scrollWidth <= strip.clientWidth) return;
  const rtl = getComputedStyle(strip).direction === 'rtl';
  const d = (e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY) * (rtl ? -1 : 1); // in RTL the end of the strip is at scrollLeft <= 0
  const max = strip.scrollWidth - strip.clientWidth;
  const next = Math.max(rtl ? -max : 0, Math.min(rtl ? 0 : max, strip.scrollLeft + d));
  if (next === strip.scrollLeft) return; // already at the end: let the page scroll on
  e.preventDefault();
  strip.scrollLeft = next;
}, { passive: false });

// ---------- tabs: each one is its own split layout (usually one session at full size) ----------
const tabLead = (tb, i) => {
  const ps = i === curTab ? panes : tb.panes;
  const act = i === curTab ? activePane : tb.activePane;
  return (act && act.key ? act : ps.find((p) => p.key)) || null;
};
let tabsHtml = '';
function renderTabs() {
  tabbarEl.hidden = tabs.length < 2;
  if (tabs.length < 2) { tabsHtml = ''; return; }
  const html = tabs.map((tb, i) => {
    const ps = i === curTab ? panes : tb.panes;
    const lead = tabLead(tb, i);
    const title = lead ? lead.title || lead.key.id.slice(0, 8) : t('tab.new');
    const live = ps.some((p) => p.el.querySelector('.plive.live'));
    return `<div class="vtab${i === curTab ? ' cur' : ''}" draggable="true" data-i="${i}" title="${esc(title)}"><span class="dot${live ? ' live' : ''}"></span>` +
      `<span class="vt-t" dir="${textDir(title)}">${esc(title)}</span>${ps.length > 1 ? `<span class="vt-n">${num(ps.length)}</span>` : ''}` +
      `<button class="vt-x" data-close title="${esc(t('tab.close_tip'))}">${ICON.x}</button></div>`;
  }).join('') + `<button class="vtab-add" data-add title="${esc(t('tab.add_tip'))}"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
  // The list refreshes every few seconds: rebuilding it while a tab is being dragged would cancel the drag,
  // and an unchanged bar is left alone.
  if (dragTab >= 0 || html === tabsHtml) return;
  tabsHtml = html;
  tabbarEl.innerHTML = html;
  const cur = tabbarEl.querySelector('.vtab.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function selectTab(i) {
  if (i === curTab || !tabs[i]) return;
  saveCurTab();
  bindTab(i);
  layoutPanes();
  afterPaneChange();
}
function addTab(target) {
  if (tabs.length >= MAX_TABS) { toast(t('tab.max', { n: MAX_TABS })); return null; }
  saveCurTab();
  tabs.splice(curTab + 1, 0, newTabObj()); // next to the current one, like a browser
  bindTab(curTab + 1);
  const p = new Pane();
  panes.push(p);
  activePane = p;
  if (target) p.open(target); else p.renderEmpty();
  layoutPanes();
  afterPaneChange();
  return p;
}
function closeTab(i) {
  const tb = tabs[i];
  if (!tb) return;
  if (tabs.length === 1) { [...panes].forEach(closePane); return; } // the last tab just empties
  const wasCur = i === curTab;
  saveCurTab();
  tb.panes.forEach((p) => p.destroy());
  tb.grid.remove();
  tabs.splice(i, 1);
  bindTab(wasCur ? Math.min(i, tabs.length - 1) : i < curTab ? curTab - 1 : curTab);
  paintHighlights();
  layoutPanes();
  afterPaneChange();
}
function moveTab(from, to) {
  saveCurTab();
  const cur = tabs[curTab];
  const [m] = tabs.splice(from, 1);
  tabs.splice(to, 0, m);
  curTab = tabs.indexOf(cur);
  persistPanes();
}
// go to the tab that holds this pane and make it the active one
function focusPane(p) {
  const i = tabs.findIndex((tb, j) => (j === curTab ? panes : tb.panes).includes(p));
  if (i >= 0) selectTab(i);
  setActive(p);
  p.el.scrollIntoView({ block: 'nearest' }); // a column on a row below the fold
}
const sameKey = (p, k) => p.key && p.key.dir === k.dir && p.key.id === k.id && (p.key.agent || '') === (k.agent || '');
let dragTab = -1;
tabbarEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-add]')) { addTab(); return; }
  const tab = e.target.closest('.vtab');
  if (!tab) return;
  if (e.target.closest('[data-close]')) closeTab(+tab.dataset.i);
  else selectTab(+tab.dataset.i);
});
tabbarEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
tabbarEl.addEventListener('auxclick', (e) => {
  const tab = e.target.closest('.vtab');
  if (tab && e.button === 1) { e.preventDefault(); closeTab(+tab.dataset.i); }
});
const clearTabDrop = () => tabbarEl.querySelectorAll('.vtab').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'dragging'));
tabbarEl.addEventListener('dragstart', (e) => {
  const tab = e.target.closest && e.target.closest('.vtab');
  if (!tab) return;
  dragTab = +tab.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-ccpreview-tab', String(dragTab));
  setTimeout(() => { if (dragTab >= 0) tab.classList.add('dragging'); });
});
// where a dragged tab would land: before or after the tab under the pointer (the end half is the left one in RTL)
function tabSpot(e) {
  const tab = e.target.closest && e.target.closest('.vtab');
  if (!tab || +tab.dataset.i === dragTab) return null;
  const r = tab.getBoundingClientRect();
  const left = e.clientX < r.left + r.width / 2;
  const rtl = getComputedStyle(tabbarEl).direction === 'rtl';
  return { tab, i: +tab.dataset.i, after: rtl ? left : !left };
}
tabbarEl.addEventListener('dragover', (e) => {
  if (dragTab < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearTabDrop();
  tabbarEl.querySelector(`.vtab[data-i="${dragTab}"]`)?.classList.add('dragging');
  const sp = tabSpot(e);
  if (sp) sp.tab.classList.add(sp.after ? 'drop-after' : 'drop-before');
});
tabbarEl.addEventListener('drop', (e) => {
  if (dragTab < 0) return;
  e.preventDefault();
  const sp = tabSpot(e);
  if (sp) {
    let to = sp.i + (sp.after ? 1 : 0);
    if (dragTab < to) to--; // the tab itself leaves its old slot first
    if (to !== dragTab) moveTab(dragTab, to);
  }
});
document.addEventListener('dragend', () => { if (dragTab >= 0) { dragTab = -1; clearTabDrop(); } });

function setActive(p) {
  if (activePane === p) return;
  activePane = p;
  layoutPanes();
  persistPanes();
  renderSessions();
}
function closePane(p) {
  if (panes.length === 1 && tabs.length > 1) { closeTab(curTab); return; } // a tab with nothing in it goes away
  const i = panes.indexOf(p);
  const tb = tabs[curTab];
  p.destroy();
  setCols(tb, columns(tb).map((c) => c.filter((x) => x !== p)));
  paintHighlights();
  if (activePane === p) activePane = panes[Math.min(i, panes.length - 1)] || null;
  layoutPanes();
  afterPaneChange();
}
// open a session/subagent in the active pane, or in a new pane next to it
function openIn(target, opts = {}) {
  if (!opts.restoring) { // a session is open once: if it already is, in any tab or column, go there
    const there = allPanes().find((x) => sameKey(x, target));
    if (there) { focusPane(there); return; }
  }
  if (opts.newTab && !opts.restoring) { addTab(target); return; }
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
  saveCurTab();
  ui.panes = panes.filter((p) => p.key).map((p) => ({ ...p.key, title: p.title }));
  ui.activePane = Math.max(0, panes.filter((p) => p.key).indexOf(activePane));
  // the layout counts only panes that hold a session (an empty one is not saved)
  const keyedShape = (tb) => columns(tb).map((c) => c.filter((p) => p.key).length).filter((n) => n > 0);
  ui.shape = keyedShape(tabs[curTab]);
  ui.vtabs = tabs.map((tb) => {
    const ps = columns(tb).flat().filter((p) => p.key);
    return { panes: ps.map((p) => ({ ...p.key, title: p.title })), shape: keyedShape(tb), active: Math.max(0, ps.indexOf(tb.activePane)) };
  });
  ui.vtab = curTab;
  renderTabs();
  writeHash();
  saveUi();
}

// ---------- image viewer: zoom (wheel, buttons, keys), pan (drag), properties, thumbnail strip ----------
const lb = { i: -1, scope: null, s: 1, x: 0, y: 0, fit: 1, w: 0, h: 0, blob: null };
function lbShots() { return lb.scope ? [...lb.scope.querySelectorAll('[data-img]')] : []; }
function lbApply(animate) {
  const img = $('lbImg');
  img.classList.toggle('animating', !!animate);
  img.style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.s})`;
  img.classList.toggle('pixel', lb.s >= 2); // crisp pixels instead of blur when blown up
  $('lbZoom').textContent = num(Math.round(lb.s * 100)) + '%';
  const zv = $('lbZoomVal'); // the properties panel shows the live zoom too
  if (zv) zv.textContent = $('lbZoom').textContent;
}
// fit the whole image in the stage; small images are enlarged too (up to 8x) so they are actually visible
function lbFit(animate) {
  const st = $('lbStage').getBoundingClientRect();
  if (!lb.w) return;
  lb.fit = Math.min((st.width - 48) / lb.w, (st.height - 48) / lb.h, 8);
  lb.s = lb.fit;
  lb.x = (st.width - lb.w * lb.s) / 2;
  lb.y = (st.height - lb.h * lb.s) / 2;
  lbApply(animate);
}
// zoom to `s`, keeping the point under (cx, cy) (stage coordinates) in place
function lbZoomTo(z, cx, cy, animate) {
  const st = $('lbStage').getBoundingClientRect();
  if (cx == null) { cx = st.width / 2; cy = st.height / 2; }
  z = Math.min(64, Math.max(0.05, z));
  lb.x = cx - ((cx - lb.x) * z) / lb.s;
  lb.y = cy - ((cy - lb.y) * z) / lb.s;
  lb.s = z;
  lbApply(animate);
}
async function lbShowInfo() {
  const box = $('lbInfo');
  if (box.hidden) return;
  const a = lbShots()[lb.i];
  if (!a) return;
  const url = a.getAttribute('href');
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  let size = '…', type = '…';
  box.innerHTML = `<h4>${t('lightbox.props')}</h4><dl id="lbDl"></dl>`;
  const render = () => {
    const ts = a.dataset.ts && Date.parse(a.dataset.ts) ? whenText(Date.parse(a.dataset.ts)) : '';
    const gcd = (x, y) => { while (y) [x, y] = [y, x % y]; return x; };
    const d = lb.w && lb.h ? gcd(lb.w, lb.h) : 1;
    $('lbDl').innerHTML =
      row(t('lightbox.dim'), `<span class="mono" dir="ltr">${num(lb.w)} × ${num(lb.h)} px</span>`) + // dir="ltr": digits, units and symbols keep their order in Arabic
      row(t('lightbox.ratio'), lb.w ? `<span class="mono" dir="ltr">${num(lb.w / d)}:${num(lb.h / d)}</span>` : '—') +
      row(t('lightbox.size'), `<span class="mono" dir="ltr">${size}</span>`) +
      row(t('lightbox.type'), `<span class="mono" dir="ltr">${esc(type)}</span>`) +
      row(t('lightbox.zoom'), `<span class="mono" dir="ltr" id="lbZoomVal">${num(Math.round(lb.s * 100))}%</span>`) +
      (a.dataset.from ? row(t('lightbox.from'), esc(a.dataset.from)) : '') +
      (ts ? row(t('lightbox.time'), ts) : '') +
      row(t('lightbox.url'), `<span class="mono" dir="ltr">${esc(url.length > 60 ? url.slice(0, 60) + '…' : url)}</span>`);
  };
  render();
  try {
    const blob = await (await fetch(url)).blob();
    const dec = { maximumFractionDigits: blob.size >= 1048576 ? 2 : 1, minimumFractionDigits: blob.size >= 1048576 ? 2 : 1 };
    size = blob.size >= 1048576 ? `${num(blob.size / 1048576, dec)} MB` : `${num(blob.size / 1024, dec)} KB`;
    type = blob.type || '—';
    lb.blob = blob;
  } catch (e) { size = '—'; type = '—'; }
  if (lbShots()[lb.i] === a) render();
}
function lbShow(scope, i) {
  if (scope) lb.scope = scope;
  const shots = lbShots();
  if (!shots.length) return;
  lb.i = (i + shots.length) % shots.length;
  const a = shots[lb.i];
  const url = a.getAttribute('href');
  const box = $('lightbox');
  box.hidden = false;
  box.classList.toggle('single', shots.length < 2);
  $('lbCount').textContent = `${num(lb.i + 1)} / ${num(shots.length)}`;
  $('lbTitle').textContent = a.dataset.from || '';
  $('lbOpen').href = url;
  $('lbDownload').href = url;
  $('lbDownload').setAttribute('download', `ccpreview-image-${lb.i + 1}`);
  lb.blob = null;
  $('lbInfo').hidden = !ui.lbInfo; // keep the properties panel as you left it
  box.classList.toggle('info', !!ui.lbInfo);
  box.querySelector('[data-lb="info"]').classList.toggle('on', !!ui.lbInfo);
  const img = $('lbImg');
  img.onload = () => { lb.w = img.naturalWidth; lb.h = img.naturalHeight; lbFit(false); lbShowInfo(); };
  img.src = url;
  if (img.complete && img.naturalWidth) img.onload();
  $('lbStrip').innerHTML = shots.length > 1 ? shots.map((sh, k) => `<button data-k="${k}" class="${k === lb.i ? 'on' : ''}"><img src="${esc(sh.getAttribute('href'))}" alt=""></button>`).join('') : '';
  // center the current thumbnail in the strip (after layout, without scrolling the page)
  requestAnimationFrame(() => {
    const strip = $('lbStrip'), on = strip.querySelector('.on');
    if (on) strip.scrollLeft += on.getBoundingClientRect().left + on.offsetWidth / 2 - (strip.getBoundingClientRect().left + strip.clientWidth / 2);
  });
}
$('lbStrip').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); $('lbStrip').scrollLeft += isRtl() ? -e.deltaY : e.deltaY; }
}, { passive: false });
// hover a thumbnail: quick look above the strip (which image it is, where it came from)
(function () {
  const strip = $('lbStrip');
  const peek = document.createElement('div');
  peek.className = 'lb-peek';
  peek.hidden = true;
  peek.innerHTML = '<img alt=""><div class="lb-peek-cap"><b></b><span></span></div>';
  $('lightbox').append(peek);
  let showT = null, cur = null;
  const hide = () => { clearTimeout(showT); showT = null; cur = null; peek.hidden = true; };
  const show = (btn) => {
    const k = +btn.dataset.k, a = lbShots()[k];
    if (!a) return;
    peek.querySelector('img').src = a.getAttribute('href');
    peek.querySelector('b').textContent = `${k + 1} / ${lbShots().length}`;
    peek.querySelector('span').textContent = a.dataset.from || '';
    peek.classList.toggle('is-current', k === lb.i);
    peek.hidden = false;
    // centered above the thumbnail, kept inside the window
    const r = btn.getBoundingClientRect(), w = peek.offsetWidth, h = peek.offsetHeight;
    peek.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    peek.style.top = Math.max(8, r.top - h - 10) + 'px';
  };
  strip.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('[data-k]');
    if (!btn || btn === cur) return;
    cur = btn;
    clearTimeout(showT);
    // first hover waits a beat (no flicker while crossing the strip); moving along it updates instantly
    if (peek.hidden) showT = setTimeout(() => show(btn), 140); else show(btn);
  });
  strip.addEventListener('mouseleave', hide);
  strip.addEventListener('click', hide);
  strip.addEventListener('scroll', hide, { passive: true });
  $('lightbox').addEventListener('pointerdown', (e) => { if (!e.target.closest('.lb-strip')) hide(); });
})();

function lbClose() { $('lightbox').hidden = true; lb.i = -1; }
async function lbCopy() {
  try {
    let blob = lb.blob || await (await fetch($('lbImg').src)).blob();
    if (blob.type !== 'image/png') {
      // the clipboard only takes PNG reliably: redraw through a canvas
      const c = document.createElement('canvas');
      c.width = lb.w; c.height = lb.h;
      c.getContext('2d').drawImage($('lbImg'), 0, 0);
      blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(t('lightbox.copied'));
  } catch (e) { toast(t('lightbox.copy_failed')); }
}
$('lightbox').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lb]');
  if (b) {
    const a = b.dataset.lb;
    if (a === 'close') lbClose();
    else if (a === 'in') lbZoomTo(lb.s * 1.5, null, null, true);
    else if (a === 'out') lbZoomTo(lb.s / 1.5, null, null, true);
    else if (a === 'fit') lbFit(true);
    else if (a === 'actual') lbZoomTo(1, null, null, true);
    else if (a === 'next') lbShow(null, lb.i + 1);
    else if (a === 'prev') lbShow(null, lb.i - 1);
    else if (a === 'copy') lbCopy();
    else if (a === 'info') {
      const box = $('lbInfo');
      box.hidden = !box.hidden;
      b.classList.toggle('on', !box.hidden);
      $('lightbox').classList.toggle('info', !box.hidden);
      ui.lbInfo = !box.hidden;
      saveUi();
      lbShowInfo();
      requestAnimationFrame(() => lbFit(false));
    }
    return;
  }
  const th = e.target.closest('.lb-strip [data-k]');
  if (th) { lbShow(null, +th.dataset.k); return; }
  // a plain click on the dark backdrop (not the image, not a drag, not the panels) closes
  const st = $('lbStage');
  if (e.target === st && st._down === st && !st._moved) lbClose();
});
// wheel = zoom around the cursor; trackpad pinch arrives as ctrl+wheel and works the same
$('lbStage').addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = $('lbStage').getBoundingClientRect();
  lbZoomTo(lb.s * Math.pow(1.0018, -e.deltaY * (e.ctrlKey ? 4 : 1)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
// drag = pan
$('lbStage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const st = $('lbStage');
  st.setPointerCapture(e.pointerId);
  st.classList.add('dragging');
  st._down = e.target; // the capture redirects the click to the stage, so remember what was really pressed
  st._moved = false;
  const start = { x: e.clientX, y: e.clientY, ox: lb.x, oy: lb.y };
  const move = (ev) => {
    if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) st._moved = true;
    lb.x = start.ox + ev.clientX - start.x;
    lb.y = start.oy + ev.clientY - start.y;
    lbApply(false);
  };
  const up = () => {
    st.removeEventListener('pointermove', move);
    st.classList.remove('dragging');
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up, { once: true });
  st.addEventListener('pointercancel', up, { once: true });
});
// double click: fit <-> 2x (or 1:1 if that's bigger) at the cursor
$('lbStage').addEventListener('dblclick', (e) => {
  const r = $('lbStage').getBoundingClientRect();
  const target = Math.abs(lb.s - lb.fit) < 0.01 ? Math.max(1, lb.fit * 2) : null;
  if (target) lbZoomTo(target, e.clientX - r.left, e.clientY - r.top, true);
  else lbFit(true);
});
window.addEventListener('resize', () => { if (!$('lightbox').hidden) lbFit(false); });
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser zoom and friends alone
  const k = e.key;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  const next = isRtl() ? 'ArrowLeft' : 'ArrowRight', prev = isRtl() ? 'ArrowRight' : 'ArrowLeft'; // next points the way text runs
  if (k === 'Escape') { handled(); lbClose(); }
  else if (k === next) { handled(); lbShow(null, lb.i + 1); }
  else if (k === prev) { handled(); lbShow(null, lb.i - 1); }
  else if (k === '+' || k === '=') { handled(); lbZoomTo(lb.s * 1.5, null, null, true); }
  else if (k === '-' || k === '_') { handled(); lbZoomTo(lb.s / 1.5, null, null, true); }
  else if (k === '0') { handled(); lbFit(true); }
  else if (k === '1') { handled(); lbZoomTo(1, null, null, true); }
  else if (k.toLowerCase() === 'i') { handled(); $('lightbox').querySelector('[data-lb="info"]').click(); }
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
    if (prev === 'working' && s.state === 'idle') notify(p, s, t('notify.finished'));
    else if (s.state === 'asking') notify(p, s, t('state.asking'));
  }));
  prevStates = states;
  document.title = waiting ? `(${waiting}) ccpreview` : 'ccpreview';
}
function notify(p, s, what) {
  if (!ui.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const watching = document.visibilityState === 'visible' && document.hasFocus() && ui.tab === 'sessions' && panes.some((x) => x.key && x.key.id === s.id);
  if (watching) return;
  const n = new Notification(`${what}: ${s.title}`, { body: p.name, tag: `${s.id}:${s.state}`, silent: false });
  n.onclick = () => {
    window.focus();
    const existing = allPanes().find((x) => x.key && x.key.id === s.id && !x.key.agent);
    if (existing) { focusPane(existing); setTab('sessions'); } else openIn({ dir: p.dir, id: s.id, title: s.title });
    n.close();
  };
}
function renderNotifyBtn() {
  const b = $('notifyBtn');
  const on = ui.notify && 'Notification' in window && Notification.permission === 'granted';
  b.classList.toggle('on', on);
  b.innerHTML = on ? ICON.bell : ICON.bellOff;
  b.title = t(on ? 'notify.on_tip' : 'notify.off_tip');
}
$('notifyBtn').onclick = async () => {
  if (!('Notification' in window)) { toast(t('notify.unsupported')); return; }
  if (ui.notify) { ui.notify = false; toast(t('notify.turned_off')); }
  else {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') { toast(t('notify.denied')); ui.notify = false; }
    else { ui.notify = true; toast(t('notify.turned_on')); }
  }
  saveUi();
  renderNotifyBtn();
};

// =====================================================================
// plan usage: 5-hour session and weekly limits, as recorded by the optional statusline tap
// =====================================================================
let usage = null; // { five_hour: {pct, resets_at}, seven_day: {...}, ts } or null
const usageLevel = (pct) => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '');
// A window whose reset time has passed has started over: what was recorded no longer counts.
const usageWin = (w) => (w ? (w.resets_at && w.resets_at * 1000 <= Date.now() ? { ...w, pct: 0, done: true } : w) : null);
function usageIn(epochSec) {
  const min = Math.max(0, Math.floor((epochSec * 1000 - Date.now()) / 60000));
  const h = Math.floor(min / 60);
  if (h >= 24) return t('usage.d', { d: num(Math.floor(h / 24)), h: num(h % 24) });
  return h ? t('usage.h', { h: num(h), m: num(min % 60) }) : t('usage.m', { m: num(min) });
}
function usageRow(label, w) {
  if (!w) return '';
  const lv = usageLevel(w.pct);
  const at = w.resets_at ? new Date(w.resets_at * 1000).toLocaleString(LOCALE[LANG], { weekday: w.resets_at * 1000 - Date.now() > 864e5 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' }) : '';
  const reset = w.done ? t('usage.reset_done') : w.resets_at ? t('usage.resets_in', { t: usageIn(w.resets_at), at }) : '';
  return `<div class="u-row ${lv}"><div class="u-head"><span>${esc(label)}</span><span class="u-pct">${num(Math.round(w.pct))}%</span></div>` +
    `<div class="u-bar"><i style="width:${Math.round(w.pct)}%"></i></div><div class="u-reset">${esc(reset)}</div></div>`;
}
function renderUsage() {
  const b = $('usageBtn');
  b.hidden = !SERVER && !SRC.ready; // folder mode reads the recorded numbers from ~/.ccpreview once it is connected
  const five = usage && usageWin(usage.five_hour), week = usage && usageWin(usage.seven_day);
  const top = Math.max(five ? five.pct : 0, week ? week.pct : 0);
  b.className = `icon-btn usage-btn ${usage ? usageLevel(top) : ''}`;
  b.title = t('usage.tip');
  b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4.5 16a8 8 0 1 1 15 0M12 14l4-5"/><circle cx="12" cy="14" r="1.2"/></svg>' +
    (usage ? `<span class="up">${num(Math.round(top))}%</span>` : '');
  const m = $('usageMenu');
  if (m.hidden) return;
  const stale = usage && Date.now() - usage.ts > 3600e3;
  if (!SERVER && SRC.dataState !== 'ready') { m.innerHTML = dataConnectHtml(); return; }
  m.innerHTML = usage
    ? usageRow(t('usage.session'), five) + usageRow(t('usage.week'), week) +
      `<div class="u-foot">${esc(t(stale ? 'usage.stale' : 'usage.updated', { ago: ago(usage.ts) }))}</div>`
    : `<div class="u-foot" style="margin:0;padding:0;border:0">${t('usage.setup', { cmd: '<code>npx ccpreview usage install</code>' })}</div>`;
}
async function loadUsage() {
  if (serverOff || !SRC.ready) return;
  if (!SERVER && SRC.dataState !== 'ready') { usage = null; renderUsage(); return; } // shows the "connect the folder" card
  usage = await SRC.usage();
  renderUsage();
}
// folder mode: usage numbers and waiting questions are files in ~/.ccpreview, which the page reads once connected
function dataConnectHtml() {
  const again = SRC.dataState === 'needs-permission';
  return `<p class="u-note" dir="auto">${esc(t(again ? 'data.connect_again' : 'data.connect_text'))}</p>` +
    `<p class="bgv-dir"><span class="ipath" dir="ltr">~/.ccpreview</span><button class="icopy" data-copy="~/.ccpreview" title="${esc(t('info.copy'))}">${ICON.copy}</button></p>` +
    `<div class="bgv-actions"><button class="btn primary" data-data-connect>${esc(t(again ? 'data.allow' : 'data.pick'))}</button></div>` +
    `<small class="u-note" dir="auto">${esc(t('data.note'))}</small>`;
}
async function connectData() {
  try {
    await (SRC.dataState === 'needs-permission' ? SRC.reconnectData() : SRC.pickData());
  } catch (err) {
    if (err && err.name !== 'AbortError') toast(t('data.failed'));
    return;
  }
  await loadUsage();
  loadSessions(); // sessions waiting on a question show up in the list
}
$('usageMenu').addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) copyText(c.dataset.copy).then((ok) => toast(t(ok ? 'info.copied' : 'copy.failed')));
  else if (e.target.closest('[data-data-connect]')) connectData();
});
$('usageBtn').onclick = async (e) => {
  e.stopPropagation();
  const m = $('usageMenu');
  if (!m.hidden) { m.hidden = true; return; }
  m.hidden = false;
  renderUsage();
  const r = $('usageBtn').getBoundingClientRect();
  m.style.top = Math.max(8, r.top - m.offsetHeight - 8) + 'px'; // the button sits at the bottom of the sidebar
  m.style.left = Math.max(8, Math.min(isRtl() ? r.right - m.offsetWidth : r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  loadUsage();
};
document.addEventListener('click', (e) => { if (!e.target.closest('#usageMenu')) $('usageMenu').hidden = true; });
setInterval(() => { if (document.visibilityState === 'visible') loadUsage(); }, 30000);
setInterval(() => { if (usage) renderUsage(); }, 60000); // countdowns and a window that just reset

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
    return `<button data-w="${k}" class="${k === ui.contentW ? 'on' : ''}"><span class="bar"><i style="width:${w.bar}%"></i></span>${t(w.label)}<span class="k">${w.hintKey ? t(w.hintKey) : w.hint}</span></button>`;
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
  m.hidden = false;
  // open toward the side with room: the width button sits at the pane's end edge
  const left = isRtl() ? r.left : r.right - m.offsetWidth;
  m.style.left = Math.max(8, Math.min(left, innerWidth - m.offsetWidth - 8)) + 'px';
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
  toast(t('width.toast', { name: t(WIDTHS[WIDTH_ORDER[i]].label) }));
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
  if (ui.tab === 'sessions' && activePane && activePane.key && k === 'i' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.target.closest('input,textarea,select,[contenteditable]')) {
    e.preventDefault();
    activePane.toggleInfo();
    return;
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
    stepWidth(e.key === (isRtl() ? 'ArrowLeft' : 'ArrowRight') ? 1 : -1); // wider = toward the start side
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

// The panes of the tab being shown, from ui.panes (a changed URL hash lands here).
function fillPanes(keys, restoring) {
  keys.slice(0, MAX_PANES).forEach((k) => {
    const p = new Pane();
    panes.push(p);
    p.open(k, restoring);
  });
}
function restorePanes(restoring) {
  panes.forEach((p) => p.destroy());
  panes.length = 0;
  activePane = null;
  fillPanes(ui.panes || [], restoring);
  tabs[curTab].shape = validShape(ui.shape, panes.length) || autoShape(panes.length);
  activePane = panes[ui.activePane] || panes[0] || null;
  layoutPanes();
  persistPanes();
}
// All tabs, as saved. The URL (ui.panes) is the tab being shown, so it wins over the saved copy of that tab.
function restoreTabs(restoring) {
  tabs.forEach((tb) => { tb.panes.forEach((p) => p.destroy()); tb.grid.remove(); });
  tabs = [];
  let saved = (ui.vtabs || []).slice(0, MAX_TABS).map((tb) => (tb && Array.isArray(tb.panes) ? tb : { panes: [], shape: [], active: 0 }));
  let cur = Math.max(0, Math.min(ui.vtab || 0, saved.length - 1));
  if (!saved.length) saved = [{ panes: ui.panes || [], shape: ui.shape, active: ui.activePane || 0 }];
  else if (ui.panes && ui.panes.length) saved[cur] = { panes: ui.panes, shape: ui.shape, active: ui.activePane || 0 }; // the URL is the tab being shown
  // a session is open once: drop copies left by older versions (the same session in several tabs or columns),
  // keeping the ones in the tab being shown; tabs left empty go
  const seen = new Set();
  const uniq = saved.map(() => []);
  const shapes = saved.map(() => []); // the layout, with the dropped copies taken out of their columns
  [cur, ...saved.map((_, i) => i).filter((i) => i !== cur)].forEach((i) => {
    const sh = validShape(saved[i].shape, saved[i].panes.length);
    let at = 0;
    (sh || [saved[i].panes.length]).forEach((n, ci) => {
      const col = saved[i].panes.slice(at, (at += n)).filter((k) => k && k.dir && k.id && !seen.has(keyOf(k)) && seen.add(keyOf(k)));
      uniq[i].push(...col);
      if (col.length) shapes[i].push(col.length);
    });
    if (!sh) shapes[i] = null; // no saved layout: spread them out
  });
  const keep = saved.map((_, i) => i).filter((i) => uniq[i].length);
  const was = keep.map((i) => ({ panes: uniq[i], shape: shapes[i], active: Math.min(saved[i].active || 0, uniq[i].length - 1) }));
  const wasCur = keep.indexOf(cur);
  saved = was.length ? was : [{ panes: [], active: 0 }];
  cur = Math.max(0, wasCur);
  saved.forEach((sv, i) => {
    tabs.push(newTabObj());
    bindTab(i);
    fillPanes(sv.panes, restoring);
    tabs[i].shape = validShape(sv.shape, panes.length) || autoShape(panes.length);
    activePane = panes[sv.active] || panes[0] || null;
    saveCurTab();
    syncDom(tabs[i]); // every tab gets its panes in place now, shown or not
  });
  bindTab(Math.min(cur, tabs.length - 1));
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
  renderLangBtn();
  document.body.classList.toggle('collapsed', !!ui.collapsed);
  try { IS_BRAVE = !!(navigator.brave && (await navigator.brave.isBrave())); } catch (e) {}
  sourceState = await SRC.init();
  setServerUi(sourceState === 'ready');
  showPage(state.cur);
  renderThumbs();
  applyContentWidth();
  renderNotifyBtn();
  loadUsage();
  syncDateUi();
  renderGroupBtn();
  restoreTabs(true);
  setTab(ui.tab);
  if (ui.tab === 'pages') ed.focus({ preventScroll: true });
  loadSessions();
})();
