#!/usr/bin/env node
// Použití:
//   node build.mjs                 zašifruje src-data/ do docs/data/ a zkopíruje lib/crypto.mjs do docs/crypto.js a vytvoří docs/sw.js
//   node build.mjs --verify        dešifruje celý řetěz z vygenerovaných souborů pomocí odpovědí ze zdroje
//   node build.mjs --new-token     vypíše náhodný token (144 bitů) – použij i jako sůl
//   node build.mjs --cheatsheet    vytvoří cheatsheet.html (lokální, v .gitignore)
// Volby: --src=<složka> (výchozí src-data)  --out=<složka> (výchozí docs/data)  --base=<url> (pro cheatsheet)

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ITER, normalize, deriveKey, deriveNext, secretFromToken,
  encrypt, decrypt, fileId,
} from './lib/crypto.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const SRC = path.resolve(ROOT, opt('src', 'src-data'));
const OUT = path.resolve(ROOT, opt('out', 'docs/data'));
const BASE = opt('base', 'https://UZIVATEL.github.io/pasifra/');
const ITER = DEFAULT_ITER;

// ---------- načtení a kontrola zdrojů ----------

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.relative(ROOT, file)}: ${e.message}`);
  }
}

async function imageToDataUrl(img) {
  if (!img) return null;
  if (img.startsWith('data:')) return img;
  const file = path.resolve(SRC, img);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`neznámý typ obrázku: ${img}`);
  const buf = await fs.readFile(file);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function resolveRef(obj) {
  if (!obj || !obj.ref) return { ...obj, shared: null };
  const file = path.resolve(SRC, obj.ref + '.json');
  if (!file.startsWith(SRC + path.sep)) throw new Error(`ref mimo src-data: ${obj.ref}`);
  return { ...(await readJson(file)), shared: obj.ref };
}

// Vrátí { tasks, finale } s doplněnými obrázky a příznakem shared.
async function loadTeam(file, errors) {
  const raw = await readJson(file);
  const name = path.basename(file);
  const err = (m) => errors.push(`${name}: ${m}`);

  if (typeof raw.team !== 'string' || !raw.team) err('chybí "team"');
  if (!/^[A-Za-z0-9_-]{22,}$/.test(raw.token || '') || new Set(raw.token).size < 12) {
    err('"token" musí mít ≥22 znaků A-Za-z0-9_- (128 bitů náhody); vygeneruj: node build.mjs --new-token');
  }
  if (typeof raw.salt !== 'string' || raw.salt.length < 16) err('"salt" musí mít ≥16 znaků');
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1) { err('chybí "tasks"'); raw.tasks = []; }

  const tasks = [];
  for (const [i, t0] of raw.tasks.entries()) {
    const t = await resolveRef(t0);
    const where = `úkol ${i + 1}`;
    if (t.id !== undefined && t.id !== i + 1) err(`${where}: id=${t.id} neodpovídá pořadí`);
    for (const k of ['title', 'body_md', 'answer']) if (!t[k] || typeof t[k] !== 'string') err(`${where}: chybí "${k}"`);
    if (t.answer && normalize(t.answer).length < 1) err(`${where}: odpověď je po normalizaci prázdná`);
    if (!t.item || !t.item.label || !t.item.text) err(`${where}: chybí "item" (label + text)`);
    const hints = t.hints || [];
    if (hints.length !== 2) err(`${where}: očekávám 2 nápovědy, je jich ${hints.length}`);
    hints.forEach((h, j) => {
      if (typeof h.after_min !== 'number' || h.after_min < 0 || !h.text) err(`${where}: nápověda ${j + 1} je neplatná`);
      if (j > 0 && h.after_min <= hints[j - 1].after_min) err(`${where}: nápovědy musí jít časově vzestupně`);
    });
    try {
      tasks.push({
        id: i + 1,
        shared: t.shared,
        answer: t.answer || '',
        content: {
          id: i + 1,
          title: t.title,
          body_md: t.body_md,
          image: await imageToDataUrl(t.image),
          hints: hints.map((h) => ({ after_min: h.after_min, text: h.text })),
          item: t.item ? { label: t.item.label, text: t.item.text, image: await imageToDataUrl(t.item.image) } : null,
        },
      });
    } catch (e) {
      err(`${where}: ${e.message}`);
    }
  }

  const f = await resolveRef(raw.finale);
  if (!f.title || !f.body_md) err('chybí "finale" (title + body_md)');
  let finale = null;
  try {
    finale = { title: f.title, body_md: f.body_md, image: await imageToDataUrl(f.image) };
  } catch (e) {
    err(`finale: ${e.message}`);
  }

  return { file: name, team: raw.team, name: raw.name || raw.team, token: raw.token, salt: raw.salt, tasks, finale };
}

async function loadAll() {
  const errors = [];
  const warnings = [];
  let common;
  try {
    common = await readJson(path.join(SRC, 'common.json'));
  } catch (e) {
    return { errors: [e.message], warnings, teams: [] };
  }
  const contacts = common.contacts || [];
  if (contacts.length < 1) errors.push('common.json: chybí "contacts"');
  for (const c of contacts) {
    if (!c.name || !/^\d{9,15}$/.test(c.phone || '')) errors.push(`common.json: kontakt ${JSON.stringify(c)} – telefon jen číslice včetně předvolby, např. 420777123456`);
  }

  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.json') && f !== 'common.json').sort();
  const teams = [];
  for (const f of files) {
    try {
      teams.push(await loadTeam(path.join(SRC, f), errors));
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!teams.length) errors.push(`v ${path.relative(ROOT, SRC)} nejsou žádné týmy`);

  for (const k of ['team', 'token', 'salt']) {
    const seen = new Set();
    for (const t of teams) {
      if (seen.has(t[k])) errors.push(`${t.file}: duplicitní "${k}"`);
      seen.add(t[k]);
    }
  }
  for (const t of teams) {
    t.contacts = contacts;
    t.tasks.forEach((k) => {
      const n = normalize(k.answer);
      const bits = Math.log2(/^\d+$/.test(n) ? 10 : 36) * n.length;
      if (n && bits < 30) warnings.push(`${t.file}: úkol ${k.id}: odpověď "${n}" je krátká (~${Math.round(bits)} bitů) – jde ji offline snadno uhodnout`);
    });
  }
  return { errors, warnings, teams, contacts };
}

// ---------- šifrování ----------

// Řetěz klíčů: K1 = f(token), K(n) = f(odpověď n-1, K(n-1)), finále = f(odpověď poslední, K(poslední)).
// Úkol n jde tedy lámat jen po předchozích, ne izolovaně.
async function chainKeys(team) {
  const keys = { meta: await deriveKey(secretFromToken(team.token), team.salt, 'meta', ITER), tasks: [] };
  keys.tasks.push(await deriveKey(secretFromToken(team.token), team.salt, 1, ITER));
  for (const t of team.tasks.slice(0, -1)) {
    keys.tasks.push(await deriveNext(keys.tasks.at(-1), t.answer, team.salt, t.id + 1, ITER));
  }
  keys.finale = await deriveNext(keys.tasks.at(-1), team.tasks.at(-1).answer, team.salt, 'finale', ITER);
  return keys;
}

function metaOf(team) {
  return { team: team.team, name: team.name, contacts: team.contacts, tasks: team.tasks.length };
}

async function encryptTeam(team) {
  const keys = await chainKeys(team);
  const out = { v: 1, iter: ITER, salt: team.salt, meta: await encrypt(keys.meta, metaOf(team)), tasks: [] };
  for (const t of team.tasks) out.tasks.push(await encrypt(keys.tasks[t.id - 1], t.content));
  out.finale = await encrypt(keys.finale, team.finale);
  return out;
}

async function build() {
  const { errors, warnings, teams } = await loadAll();
  warnings.forEach((w) => console.warn('VAROVÁNÍ', w));
  if (errors.length) fail(errors);

  await fs.mkdir(OUT, { recursive: true });
  for (const f of await fs.readdir(OUT)) if (f.endsWith('.json')) await fs.rm(path.join(OUT, f));
  for (const t of teams) {
    const id = await fileId(t.token);
    await fs.writeFile(path.join(OUT, id + '.json'), JSON.stringify(await encryptTeam(t)));
    console.log(`${t.team.padEnd(14)} ${t.tasks.length} úkolů -> ${path.relative(ROOT, path.join(OUT, id))}.json`);
  }
  // Prohlížeč používá stejný kód jako build.
  const docs = path.dirname(OUT);
  await fs.mkdir(docs, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'lib/crypto.mjs'), path.join(docs, 'crypto.js'));
  const sw = await fs.readFile(path.join(ROOT, 'lib/sw.template.js'), 'utf8');
  await fs.writeFile(path.join(docs, 'sw.js'), sw.replaceAll('__BUILD__', new Date().toISOString().replace(/\D/g, '').slice(0, 14)));
  await fs.writeFile(path.join(docs, '.nojekyll'), '');
  console.log('Hotovo. Doporučuju hned spustit: node build.mjs --verify');
}

// ---------- verify ----------

async function verify() {
  const { errors, warnings, teams } = await loadAll();
  warnings.forEach((w) => console.warn('VAROVÁNÍ', w));
  const seenFiles = new Set();

  for (const t of teams) {
    const e = (m) => errors.push(`${t.team}: ${m}`);
    const id = await fileId(t.token);
    seenFiles.add(id + '.json');
    let text, data;
    try {
      text = await fs.readFile(path.join(OUT, id + '.json'), 'utf8');
      data = JSON.parse(text);
    } catch {
      e(`chybí ${id}.json – spusť nejdřív build`);
      continue;
    }
    if (data.salt !== t.salt) e('sůl v souboru nesedí se zdrojem');
    if (data.iter !== ITER) e(`iter v souboru je ${data.iter}, build používá ${ITER}`);
    if (data.tasks.length !== t.tasks.length) e(`počet úkolů v souboru ${data.tasks.length} ≠ zdroj ${t.tasks.length}`);

    // nic čitelného
    const leaks = [t.token, ...t.tasks.flatMap((k) => [k.answer, normalize(k.answer), k.content.title, k.content.body_md.slice(0, 25)])];
    for (const s of leaks) if (s && s.length >= 6 && text.includes(s)) e(`v souboru je čitelné "${s}"`);

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Průchod stejně jako v klientu: otevřeme blob aktuálním klíčem, další klíč odvodíme z kódu.
    const bogus = await deriveKey(secretFromToken(t.token + 'x'), t.salt, 'bogus', ITER);
    const meta = await decrypt(await deriveKey(secretFromToken(t.token), t.salt, 'meta', ITER), data.meta);
    if (!meta || !same(meta, metaOf(t))) e('meta se nedešifruje klíčem z tokenu');

    let key = await deriveKey(secretFromToken(t.token), t.salt, 1, ITER);
    if (await decrypt(await deriveKey(secretFromToken(t.token + 'x'), t.salt, 1, ITER), data.tasks[0])) e('úkol 1 jde otevřít špatným tokenem');
    for (const k of t.tasks) {
      const blob = data.tasks[k.id - 1];
      if (!blob) break;
      const got = await decrypt(key, blob);
      if (!got || !same(got, k.content)) { e(`úkol ${k.id} se nedešifruje správným řetězem klíčů`); break; }
      const slot = k.id === t.tasks.length ? 'finale' : k.id + 1;
      const next = k.id === t.tasks.length ? data.finale : data.tasks[k.id];
      const nextKey = await deriveNext(key, k.answer, t.salt, slot, ITER);
      // špatný kód s dobrým klíčem, správný kód se špatným klíčem (izolované lámání)
      if (await decrypt(await deriveNext(key, k.answer + 'x', t.salt, slot, ITER), next)) e(`po úkolu ${k.id} jde otevřít další špatným kódem`);
      if (await decrypt(await deriveNext(bogus, k.answer, t.salt, slot, ITER), next)) e(`po úkolu ${k.id} jde otevřít další bez předchozího klíče`);
      key = nextKey;
    }
    const fin = await decrypt(key, data.finale);
    if (!fin || !same(fin, t.finale)) e('finále se nedešifruje odpovědí na poslední úkol');
    if (!errors.some((m) => m.startsWith(t.team + ':'))) console.log(`OK  ${t.team} (${t.tasks.length} úkolů + finále)`);
  }

  try {
    for (const f of await fs.readdir(OUT)) {
      if (f.endsWith('.json') && !seenFiles.has(f)) warnings.push(`${f} v ${path.relative(ROOT, OUT)} nepatří žádnému týmu`);
    }
  } catch { /* chybějící složku už hlásí chyby výše */ }

  if (errors.length) fail(errors);
  console.log(warnings.length ? `Verify prošel, varování: ${warnings.length}` : 'Verify prošel bez chyb.');
}

// ---------- cheatsheet ----------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function cheatsheet() {
  const { errors, teams } = await loadAll();
  if (errors.length) fail(errors);
  const nl = (s) => esc(s).replace(/\n/g, '<br>');
  const sections = teams.map((t) => `
<section>
  <h2>${esc(t.name)} <small>(${esc(t.team)})</small></h2>
  <p>Odkaz: <a href="${esc(BASE)}?t=${esc(t.token)}">${esc(BASE)}?t=${esc(t.token)}</a></p>
  ${t.tasks.map((k) => `
  <article>
    <h3>${k.id}. ${esc(k.content.title)}${k.shared ? ` <em>(společné: ${esc(k.shared)})</em>` : ''}</h3>
    <p><b>Kód:</b> ${esc(k.answer)} <code>${esc(normalize(k.answer))}</code></p>
    <p><b>Zadání:</b> ${nl(k.content.body_md)}</p>
    <ul>${k.content.hints.map((h) => `<li>po ${h.after_min} min: ${nl(h.text)}</li>`).join('')}</ul>
    <p><b>Nalezený předmět:</b> ${esc(k.content.item?.label)} – ${nl(k.content.item?.text)}</p>
  </article>`).join('')}
  <article><h3>Finále: ${esc(t.finale.title)}</h3><p>${nl(t.finale.body_md)}</p></article>
</section>`).join('\n');
  const html = `<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cheatsheet pro orgy</title>
<style>body{font:16px/1.5 system-ui;max-width:50rem;margin:1rem auto;padding:0 1rem}section{border-top:3px solid #888;margin-top:2rem}article{margin:1rem 0;padding:.5rem 1rem;background:#f4f1e8}code{background:#ddd;padding:0 .3em}small,em{color:#666}</style>
<h1>Cheatsheet – jen pro orgy, nesdílet</h1>${sections}`;
  const out = path.join(ROOT, 'cheatsheet.html');
  await fs.writeFile(out, html);
  console.log('Vytvořeno', path.relative(ROOT, out));
}

function fail(errors) {
  console.error(`\nCHYBY (${errors.length}):`);
  errors.forEach((m) => console.error(' ✗', m));
  process.exit(1);
}

if (flag('new-token')) console.log(randomBytes(18).toString('base64url'));
else if (flag('verify')) await verify();
else if (flag('cheatsheet')) await cheatsheet();
else await build();
