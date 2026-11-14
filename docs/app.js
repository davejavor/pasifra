import { CONFIG } from './config.js';
import { mountWordSearch } from './wordsearch.js';
import { fileId, secretFromToken, deriveKey, deriveNext, exportKey, importKey, decrypt, normalize, unlockNext } from './crypto.js';

const params = new URLSearchParams(location.search);
const token = params.get('t');
// Testovací čas: ?now=2026-12-12T14:30 – čas pak normálně běží dál od této hodnoty.
const OFFSET = params.get('now') ? Date.parse(params.get('now')) - Date.now() : 0;
const now = () => Date.now() + OFFSET;
const $ = (id) => document.getElementById(id);
const main = $('main');

const WRONG = [
  'Tohle to ještě není. Zkuste se ještě rozhlédnout.',
  'Zatím ne – ale jste blízko. Zkontrolujte, jak je kód napsaný.',
  'Nesedí to. Nevadí, zkuste to znovu, nic se neděje.',
];
let wrongCount = 0;

// ---------- pomocné ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).split(/\n{2,}/).map((p) =>
  `<p>${p.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/\n/g, '<br>')}</p>`).join('');
const img = (src) => (/^data:image\//.test(src || '') ? `<img src="${src}" alt="">` : '');
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
};
const mem = {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
};
const utf8 = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ''; } };

// ---------- stav ----------
let id, data, meta, K, S, view = 'task', taskCtx = null;
const cache = new Map();

// S = { keys: {meta, tasks:[b64], finale:b64|null}, at:[ms odemčení] }
const saveState = () => store.set('pasifra:state:' + id, JSON.stringify({ keys: S.keys, at: S.at }));
const unlocked = () => K.tasks.length;
const finished = () => !!K.finale;
const solvedCount = () => (finished() ? meta.tasks : unlocked() - 1);

async function content(i) {
  if (!cache.has(i)) cache.set(i, await decrypt(K.tasks[i], data.tasks[i]));
  return cache.get(i);
}

// Network-first: opravy dat v den hry se dostanou k týmům, uložená kopie slouží při výpadku.
async function loadData() {
  const ck = 'pasifra:data:' + id;
  try {
    const res = await fetch(`data/${id}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('nenalezeno');
    const text = await res.text();
    const parsed = JSON.parse(text);
    store.set(ck, text);
    return parsed;
  } catch (err) {
    const cached = store.get(ck);
    if (cached) { try { return JSON.parse(cached); } catch { /* spadne níže */ } }
    throw err;
  }
}

function resetAndReload() {
  store.del('pasifra:data:' + id);
  store.del('pasifra:state:' + id);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`pasifra:ws:${id}:`)) localStorage.removeItem(k);
  } catch { /* nevadí */ }
  location.href = location.pathname + '?t=' + encodeURIComponent(token) + (params.get('now') ? '&now=' + encodeURIComponent(params.get('now')) : '');
}
window.resetAndReload = resetAndReload;

async function init() {
  if (!token) return intro();
  if (!globalThis.crypto?.subtle) return needHttps();
  try {
    id = await fileId(token);
    if (params.get('reset')) return resetAndReload();
    data = await loadData();
  } catch {
    main.innerHTML = `<div class="card"><h2>Nepodařilo se načíst data</h2><p>Zkontrolujte odkaz a připojení k internetu.</p><button onclick="location.reload()">Zkusit znovu</button></div>`;
    return;
  }
  main.innerHTML = '<p class="center">Odemykám…</p>';
  let saved = null;
  try { saved = JSON.parse(store.get('pasifra:state:' + id)); } catch { /* nový stav */ }
  if (saved && saved.keys) {
    S = saved;
  } else {
    const k1 = await deriveKey(secretFromToken(token), data.salt, 1, data.iter);
    const km = await deriveKey(secretFromToken(token), data.salt, 'meta', data.iter);
    S = { keys: { meta: await exportKey(km), tasks: [await exportKey(k1)], finale: null }, at: [null] };
  }
  K = {
    meta: await importKey(S.keys.meta),
    tasks: await Promise.all(S.keys.tasks.map(importKey)),
    finale: S.keys.finale ? await importKey(S.keys.finale) : null,
  };
  meta = await decrypt(K.meta, data.meta);
  if (!meta || !(await content(0))) return broken();
  $('team').textContent = meta.name;
  if (params.get('now')) $('testbadge').hidden = false;
  $('nav').hidden = false;
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
  await render();
  setInterval(tick, 1000);
}

function needHttps() {
  const url = 'https://' + location.host + location.pathname + location.search;
  main.innerHTML = `<div class="card"><h2>Otevřete odkaz přes https://</h2>
    <p>Hra potřebuje zabezpečené spojení a v tomto okně se nespustí.</p>
    <p class="dim" style="word-break:break-all">${esc(url)}</p>
    <a class="btn" href="${esc(url)}">Otevřít zabezpečenou verzi</a></div>`;
}

function broken() {
  main.innerHTML = `<div class="card"><h2>Něco nesedí</h2><p>Uložený postup neodpovídá aktuálním datům. Zadejte kódy znovu, nic se neztratí.</p><button onclick="resetAndReload()">Vymazat uložené a začít znovu</button></div>`;
}

function intro() {
  main.innerHTML = `<div class="card center"><h1>Pražská šifrovací hra</h1>
    <p>Sobota 12. 12. 2026, 14:30–18:00.</p>
    <p class="dim">Otevřete odkaz, který jste dostali od organizátorů.</p></div>`;
}

// ---------- vykreslování ----------
const start = () => Date.parse(CONFIG.START);

async function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  await ({ task: renderTask, solved: renderSolved, items: renderItems, contact: renderContact }[view])();
  tick();
}

async function renderTask() {
  if (finished()) {
    const f = await decrypt(K.finale, data.finale);
    main.innerHTML = `<div class="card finale"><h2>${esc(f.title)}</h2>${img(f.image)}${md(f.body_md)}</div>`;
    return;
  }
  const i = unlocked() - 1;
  if (i === 0 && now() < start()) {
    main.innerHTML = `<div class="card center"><h2>Hra ještě nezačala</h2><p>První úkol se zobrazí ve 14:30.</p><p class="timer" style="font-size:2.2rem" id="gate"></p></div>`;
    return;
  }
  if (S.at[i] == null) { S.at[i] = now(); saveState(); }
  const c = await content(i);
  if (!c) return broken();
  main.innerHTML = `
    <div class="card"><h2>${i + 1}. ${esc(c.title)}</h2>${img(c.image)}${md(c.body_md)}</div>
    ${c.wordsearch ? '<div class="card" id="wsmount"></div>' : ''}
    <form id="f" autocomplete="off">
      <label for="code" class="dim">${esc(c.code_label || 'Odpověď')}</label>
      <input id="code" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go">
      <div class="msg" id="msg" role="status"></div>
      <button type="submit" id="go">Odemknout další úkol</button>
    </form>
    ${c.hints.length ? '<div class="card"><p class="dim" id="nexthint"></p><div id="hints"></div></div>' : ''}
    <button class="stuck" id="stuck">Zasekli jsme se</button>`;
  $('stuck').onclick = () => { view = 'contact'; render(); };
  $('f').onsubmit = onSubmit;
  if (c.wordsearch) {
    const key = `pasifra:ws:${id}:${i}`;
    mountWordSearch($('wsmount'), c.wordsearch, {
      load() { try { return JSON.parse(store.get(key)) || []; } catch { return []; } },
      save(list) { store.set(key, JSON.stringify(list)); },
    });
  }
  taskCtx = { c, i };
  renderHints();
}

// Samostatně, aby odemknutí nápovědy nesmazalo rozepsaný kód ani výběr v osmisměrce.
function renderHints() {
  if (!taskCtx || !$('hints')) return;
  const { c, i } = taskCtx;
  const names = ['Malá nápověda', 'Velká nápověda'];
  $('hints').innerHTML = c.hints.map((h, j) => {
    const when = S.at[i] + h.after_min * 60000;
    return now() >= when
      ? `<div class="hint"><b>${names[j] || 'Nápověda'}</b>${md(h.text)}</div>`
      : `<div class="hint locked" data-until="${when}">${names[j] || 'Nápověda'} za <span class="timer"></span></div>`;
  }).join('');
}

async function renderSolved() {
  const n = solvedCount();
  if (!n) { main.innerHTML = '<div class="card"><p>Zatím nemáte vyřešený žádný úkol. První už je na dosah!</p></div>'; return; }
  let html = '';
  for (let i = n - 1; i >= 0; i--) {
    const c = await content(i);
    if (!c) continue;
    html += `<div class="card"><h3>✓ ${i + 1}. ${esc(c.title)}</h3>${img(c.image)}${md(c.body_md)}
      ${c.hints.map((h) => `<div class="hint">${md(h.text)}</div>`).join('')}</div>`;
  }
  main.innerHTML = html;
}

async function renderItems() {
  const n = solvedCount();
  if (!n) { main.innerHTML = '<div class="card"><h2>Nalezené předměty</h2><p class="dim">Zatím nic. Každý vyřešený úkol přidá jeden předmět.</p></div>'; return; }
  let html = '<h2>Nalezené předměty</h2>';
  for (let i = 0; i < n; i++) {
    const it = (await content(i))?.item;
    if (it) html += `<div class="card"><h3>${esc(it.label)}</h3>${img(it.image)}${md(it.text)}</div>`;
  }
  main.innerHTML = html;
}

function renderContact() {
  main.innerHTML = `<div class="card"><h2>Zasekli jste se?</h2>
    <p>To se stane i nejlepším. Napište nám na WhatsApp a rádi poradíme.</p>
    ${meta.contacts.map((c) => `<a class="btn" href="https://wa.me/${esc(c.phone)}" target="_blank" rel="noopener">${esc(c.name)}</a>`).join('')}</div>`;
}

// ---------- odpověď ----------
async function onSubmit(e) {
  e.preventDefault();
  const raw = $('code').value;
  const msg = $('msg'), go = $('go');
  if (!normalize(raw)) { msg.textContent = 'Napište odpověď.'; return; }
  go.disabled = true; msg.textContent = 'Ověřuji…';
  const cur = unlocked();
  const last = cur === meta.tasks;
  const cc = await content(cur - 1);
  const res = await unlockNext(K.tasks[cur - 1], raw, cc && cc.accept, data.salt, last ? 'finale' : cur + 1, last ? data.finale : data.tasks[cur], data.iter);
  const key = res && res.key;
  go.disabled = false;
  if (!res) { msg.textContent = WRONG[wrongCount++ % WRONG.length]; $('code').select(); return; }
  const exp = await exportKey(key);
  if (last) { K.finale = key; S.keys.finale = exp; } else { K.tasks.push(key); S.keys.tasks.push(exp); S.at.push(now()); }
  saveState();
  onSolved(cur);
  $('flash').hidden = false;
  setTimeout(() => { $('flash').hidden = true; view = 'task'; render(); }, 1000);
}

// Místo pro mapu postupu týmů (Leaflet + Supabase) – mimo MVP.
function onSolved(/* taskNo */) {}

// ---------- časovače a globální zprávy ----------
function tick() {
  if (!K) return;
  const t = now();
  const gate = $('gate');
  if (gate) { if (t >= start()) return render(); gate.textContent = mmss(start() - t); }
  let next = null, expired = false;
  document.querySelectorAll('[data-until]').forEach((el) => {
    const left = Number(el.dataset.until) - t;
    if (left <= 0) { expired = true; return; }
    el.querySelector('.timer').textContent = mmss(left);
    if (next == null) next = left;
  });
  if (expired && view === 'task' && taskCtx) { renderHints(); return tick(); }
  const nh = $('nexthint');
  if (nh) nh.innerHTML = next == null ? 'Všechny nápovědy jsou odemčené.' : `Další nápověda za <span class="timer">${mmss(next)}</span>`;
  $('banners').innerHTML = CONFIG.MESSAGES.filter((m) => t >= Date.parse(m.at)).reverse()
    .map((m) => `<div class="banner">${md(utf8(m.text))}</div>`).join('');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
init();
