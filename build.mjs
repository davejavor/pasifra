#!/usr/bin/env node
// Použití:
//   node build.mjs                 zašifruje src-data/ do docs/data/ a zkopíruje lib/crypto.mjs do docs/crypto.js a vytvoří docs/sw.js
//   node build.mjs --verify        dešifruje celý řetěz z vygenerovaných souborů pomocí odpovědí ze zdroje
//   node build.mjs --new-token     vypíše náhodný token (144 bitů) – použij i jako sůl
//   node build.mjs --cheatsheet    vytvoří cheatsheet.html (lokální, v .gitignore)
//   node build.mjs --wordsearch-all [--seed=N] [--rounds=N] [--size=N]
//                                  přegeneruje všechny osmisměrky najednou, slova rozdělí co nejvyváženěji
//   node build.mjs --wordsearch <soubor> [--task=N] [--size=N] [--seed=N] [--reselect]
//                                  vybere slova ze zásobníku (nejsou-li v souboru), vyrobí mřížku a zapíše words, grid a underlay.cells
// Volby: --src=<složka> (výchozí src-data)  --out=<složka> (výchozí docs/data)  --base=<url> (pro cheatsheet)

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ITER, normalize, deriveKey, deriveNext, secretFromToken,
  encrypt, decrypt, fileId,
} from './lib/crypto.mjs';
import { analyze, generate, generateAuto, parsePool, checkRules, expandHint, mulberry32, preview, wsNorm } from './lib/wordsearch.mjs';

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

// Zásobník pojmů osmisměrek (shared/wordsearch-pool.json): kategorie, rodiny, pravidla. Volitelný.
let POOL = parsePool([]);
async function loadPool(warnings) {
  const file = path.join(SRC, 'shared', 'wordsearch-pool.json');
  try {
    POOL = parsePool(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (e) {
    POOL = parsePool([]);
    if (e.code === 'ENOENT') warnings.push('chybí shared/wordsearch-pool.json – cizí slova a pravidla osmisměrek se nehlídají');
    else throw new Error(`${path.relative(ROOT, file)}: ${e.message}`);
  }
}

// Vrátí { tasks, finale } s doplněnými obrázky a příznakem shared.
async function loadTeam(file, errors, warnings) {
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
    let wsContent = null;
    if (t.wordsearch) {
      const a = analyze(t.wordsearch, POOL.groups);
      a.errors.forEach((m) => err(`${where}: osmisměrka: ${m}`));
      if (POOL.entries.length && Array.isArray(t.wordsearch.words)) {
        const rc = checkRules(t.wordsearch.words, POOL);
        rc.errors.forEach((m) => err(`${where}: osmisměrka: ${m}`));
        rc.warnings.forEach((m) => warnings.push(`${name}: ${where}: ${m}`));
      }
      if (!a.errors.length) {
        wsContent = {
          size: a.n,
          grid: a.rows.map((r) => r.join('')),
          words: a.placements.map(({ r, c, dr, dc, len }) => ({ r, c, dr, dc, len })),
          underlay: t.wordsearch.underlay.cells,
        };
        const hay = wsNorm(t.item?.text);
        if (!hay.includes(wsNorm(t.wordsearch.underlay.text))) warnings.push(`${name}: ${where}: item.text neobsahuje slabiku podkresu „${t.wordsearch.underlay.text}“`);
      }
      if (t.answer && normalize(t.answer) !== normalize(t.wordsearch.solution || '')) err(`${where}: "answer" neodpovídá tajence osmisměrky`);
      t.answer = t.answer || t.wordsearch.solution;
    }
    for (const k of ['title', 'body_md', 'answer']) if (!t[k] || typeof t[k] !== 'string') err(`${where}: chybí "${k}"`);
    if (t.answer && normalize(t.answer).length < 1) err(`${where}: odpověď je po normalizaci prázdná`);
    if (!t.item || !t.item.label || !t.item.text) err(`${where}: chybí "item" (label + text)`);
    const hints = t.hints || [];
    if (hints.length !== 2) err(`${where}: očekávám 2 nápovědy, je jich ${hints.length}`);
    hints.forEach((h, j) => {
      if (typeof h.after_min !== 'number' || h.after_min < 0 || !h.text) err(`${where}: nápověda ${j + 1} je neplatná`);
      if (j > 0 && h.after_min <= hints[j - 1].after_min) err(`${where}: nápovědy musí jít časově vzestupně`);
      expandHint(h.text, t.wordsearch).errors.forEach((m) => err(`${where}: nápověda ${j + 1}: ${m}`));
    });
    try {
      tasks.push({
        id: i + 1,
        shared: t.shared,
        answer: t.answer || '',
        ws: wsContent ? { spec: t.wordsearch, analysis: analyze(t.wordsearch, POOL.groups) } : null,
        content: {
          id: i + 1,
          title: t.title,
          body_md: t.body_md,
          image: await imageToDataUrl(t.image),
          hints: hints.map((h) => ({ after_min: h.after_min, text: expandHint(h.text, t.wordsearch).text })),
          item: t.item ? { label: t.item.label, text: t.item.text, image: await imageToDataUrl(t.item.image) } : null,
          ...(wsContent ? { wordsearch: wsContent } : {}),
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

  try { await loadPool(warnings); } catch (e) { errors.push(e.message); }
  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.json') && f !== 'common.json').sort();
  const teams = [];
  for (const f of files) {
    try {
      teams.push(await loadTeam(path.join(SRC, f), errors, warnings));
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
    for (const k of t.tasks) {
      if (!k.ws) continue;
      const a = k.ws.analysis;
      console.log(`    osmisměrka (úkol ${k.id}, ${a.n}×${a.n}): ${a.placements.length} slov, tajenka „${a.leftover}“, podkres „${a.underlay}“`);
      console.log(preview(a, k.ws.spec.underlay?.cells).replace(/^/gm, '      '));
      a.infos.forEach((m) => console.log('    info:', m));
      k.content.hints.forEach((h) => console.log(`    nápověda po ${h.after_min} min: ${h.text}`));
    }
  }

  const grids = [], seenG = new Set();
  for (const t of teams) for (const k of t.tasks) {
    if (!k.ws) continue;
    const key = k.shared || `${t.team}#${k.id}`;
    if (seenG.has(key)) continue;
    seenG.add(key);
    grids.push({ label: k.shared || `${t.team} úkol ${k.id}`, words: k.ws.spec.words || [] });
  }
  if (grids.length > 1) {
    const { usage, where } = usageOf(grids);
    const reps = [...usage].filter(([, c]) => c > 1).sort((x, y) => y[1] - x[1]);
    console.log(reps.length
      ? `osmisměrky: ${reps.length} slov se opakuje napříč ${grids.length} mřížkami: ${reps.map(([k, c]) => `${k} (${c}×: ${where.get(k).join(', ')})`).join('; ')}`
      : `osmisměrky: žádné slovo se neopakuje napříč ${grids.length} mřížkami`);
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
    ${k.ws ? `<p><b>Osmisměrka:</b> tajenka <code>${esc(k.ws.analysis.leftover)}</code>, podkres <code>${esc(k.ws.analysis.underlay)}</code>, slova: ${esc(k.ws.spec.words.join(', '))}</p>` : ''}
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

// ---------- generátor osmisměrky ----------

// Slova z ostatních osmisměrek (týmové soubory, sdílené úkoly přes ref se počítají jednou).
async function collectGrids(skipKey) {
  const grids = [];
  const seen = new Set();
  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.json') && f !== 'common.json').sort();
  for (const f of files) {
    let team;
    try { team = await readJson(path.join(SRC, f)); } catch { continue; }
    for (const [i, t] of (team.tasks || []).entries()) {
      let ws, key, label;
      if (t.ref) {
        const abs = path.resolve(SRC, t.ref + '.json');
        try { ws = (await readJson(abs)).wordsearch; } catch { continue; }
        key = abs; label = t.ref;
      } else if (t.wordsearch) {
        ws = t.wordsearch; key = `${path.resolve(SRC, f)}#${i}`; label = `${team.team || f} úkol ${i + 1}`;
      }
      if (!ws || !Array.isArray(ws.words) || key === skipKey || seen.has(key)) continue;
      seen.add(key);
      grids.push({ label, words: ws.words });
    }
  }
  return grids;
}

// Počty použití slov (klíč = slovo ze zásobníku, jinak vlastní text) a kde se použila.
function usageOf(grids) {
  const usage = new Map(), where = new Map();
  for (const g of grids) {
    for (const w of g.words) {
      const t = wsNorm(w);
      const key = POOL.byWord.get(t)?.word || t;
      usage.set(key, (usage.get(key) || 0) + 1);
      where.set(key, [...(where.get(key) || []), g.label]);
    }
  }
  return { usage, where };
}

function compactArrays(text) {
  return text
    .replace(/\[\s*(\d+),\s*(\d+)\s*\]/g, '[$1,$2]')
    .replace(/("(?:words|require|exclude)": )\[\s*((?:"[^"\n]*",?\s*)+)\]/g, (_, k, body) => `${k}[${body.trim().replace(/\s*\n\s*/g, ' ')}]`);
}

function printWords(words) {
  const byCat = new Map();
  for (const w of words) {
    const cat = POOL.byWord.get(wsNorm(w))?.category || '(mimo zásobník)';
    byCat.set(cat, [...(byCat.get(cat) || []), wsNorm(w)]);
  }
  console.log(`Slova (${words.length}):`);
  for (const [cat, ws] of byCat) console.log(`  ${cat} (${ws.length}): ${ws.join(', ')}`);
}

async function wordsearchCli() {
  const file = args[args.indexOf('--wordsearch') + 1];
  if (!file || file.startsWith('--')) fail(['použití: node build.mjs --wordsearch <soubor> [--task=N] [--size=N] [--seed=N] [--reselect]']);
  const abs = path.resolve(file);
  const json = await readJson(abs);
  let target, selfKey = abs, container = null;
  if (Array.isArray(json.words) || json.solution) target = json;
  else if (json.wordsearch) { target = json.wordsearch; container = json; }
  else if (Array.isArray(json.tasks)) {
    const idx = Number(opt('task', 0)) - 1;
    const t = json.tasks[idx];
    if (!t) fail(['u týmového souboru zadejte --task=N (číslo úkolu s osmisměrkou)']);
    if (t.ref) fail([`úkol ${opt('task')} je odkaz (${t.ref}); spusťte generátor na souboru sdíleného úkolu`]);
    target = t.wordsearch;
    container = t;
    selfKey = `${abs}#${idx}`;
  }
  if (!target) fail(['v souboru jsem nenašel osmisměrku (objekt se "solution", úkol s "wordsearch" nebo týmový soubor s --task=N)']);

  await loadPool([]);
  const size = opt('size') ? Number(opt('size')) : target.size;
  const seed = Number(opt('seed', target.seed ?? 1));
  const auto = !Array.isArray(target.words) || flag('reselect');
  const grids = await collectGrids(selfKey);
  const { usage, where } = usageOf(grids);

  let r;
  if (auto) {
    // size ze souboru bereme jako pevné jen při --size=; jinak se hledá nejmenší možná
    r = generateAuto(target, { pool: POOL, usage, size: opt('size') ? Number(opt('size')) : undefined, seed });
  } else {
    r = generate(target, { pool: POOL.groups, size, seed });
    if (r.ok) r.words = target.words;
  }
  if (!r.ok) { console.error(r.report.join('\n')); process.exit(1); }

  target.size = r.size;
  target.words = r.words;
  target.grid = r.grid;
  target.underlay = { ...target.underlay, cells: r.cells };
  await fs.writeFile(abs, compactArrays(JSON.stringify(json, null, 2)) + '\n');

  console.log(`Hotovo: ${r.size}×${r.size}, ${r.attempts}. pokus, ${auto ? 'slova vybrána ze zásobníku' : 'pevný seznam slov'}. Zapsáno do ${path.relative(process.cwd(), abs)}.`);
  printWords(r.words);
  console.log(`Tajenka: ${r.analysis.leftover}\nPodkres: ${r.analysis.underlay} (v hranatých závorkách), tajenka malými písmeny\n`);
  console.log(preview(r.analysis, r.cells));
  r.analysis.infos.forEach((m) => console.log('info:', m));
  for (const h of container?.hints || []) {
    if (h.text?.includes('{{')) console.log(`Nápověda po ${h.after_min} min: ${expandHint(h.text, target).text}`);
  }

  const rules = POOL.entries.length ? checkRules(r.words, POOL) : { errors: [], warnings: [] };
  rules.warnings.forEach((m) => console.log('VAROVÁNÍ', m));
  rules.errors.forEach((m) => console.log('CHYBA pravidel:', m));
  if (r.level) console.log(`Poznámka: přísná pravidla nevyšla, použil jsem i položky „jen když jinak nevyjde“ (úroveň ${r.level}).`);
  const reps = r.words.map((w) => POOL.byWord.get(wsNorm(w))?.word || wsNorm(w)).filter((k) => usage.has(k));
  console.log(reps.length
    ? `Opakování oproti ostatním osmisměrkám (${grids.length} jiných): ${reps.map((k) => `${k} (${where.get(k).join(', ')})`).join('; ')}`
    : `Žádné slovo se neopakuje v ostatních osmisměrkách (${grids.length} jiných).`);
}

// ---------- přegenerování všech osmisměrek najednou ----------

// Všechny osmisměrky: v týmových souborech a ve sdílených úkolech (přes ref, každá jednou).
async function collectTargets() {
  const targets = [];
  const seen = new Set();
  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.json') && f !== 'common.json').sort();
  for (const f of files) {
    const abs = path.resolve(SRC, f);
    const team = await readJson(abs);
    for (const [i, t] of (team.tasks || []).entries()) {
      if (t.ref) {
        const sh = path.resolve(SRC, t.ref + '.json');
        if (seen.has(sh)) continue;
        const json = await readJson(sh);
        if (!json.wordsearch) continue;
        seen.add(sh);
        targets.push({ label: t.ref, file: sh, idx: null, spec: json.wordsearch });
      } else if (t.wordsearch) {
        targets.push({ label: `${team.team || f} úkol ${i + 1}`, file: abs, idx: i, spec: t.wordsearch });
      }
    }
  }
  return targets;
}

const shuffled = (arr, rng) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// Cena = počet dvojic mřížek, které sdílejí slovo (součet C(počet,2) přes slova). Nižší je vyváženější.
function repetitionCost(lists) {
  const counts = new Map();
  for (const words of lists) for (const w of words) {
    const k = POOL.byWord.get(wsNorm(w))?.word || wsNorm(w);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.values()].reduce((s, c) => s + (c * (c - 1)) / 2, 0);
}

async function wordsearchAll() {
  await loadPool([]);
  if (!POOL.entries.length) fail(['chybí zásobník shared/wordsearch-pool.json']);
  const targets = await collectTargets();
  if (!targets.length) fail([`v ${path.relative(ROOT, SRC)} nejsou žádné osmisměrky`]);
  const seed = Number(opt('seed', 1));
  const rounds = Number(opt('rounds', 3));
  const size = opt('size') ? Number(opt('size')) : undefined;
  const rng = mulberry32(seed);
  const cur = targets.map(() => null);
  const usageExcept = (skip) => usageOf(cur.flatMap((r, i) => (r && i !== skip ? [{ label: targets[i].label, words: r.words }] : []))).usage;
  const make = (i, usedSeed, timeMs) => generateAuto(targets[i].spec, { pool: POOL, usage: usageExcept(i), size, seed: usedSeed, timeMs });
  const costNow = () => repetitionCost(cur.filter(Boolean).map((r) => r.words));

  if (targets.every((t) => Array.isArray(t.spec.words))) {
    console.log(`Dosavadní stav: ${repetitionCost(targets.map((t) => t.spec.words))} dvojic mřížek se sdíleným slovem`);
  }
  console.log(`Osmisměrek: ${targets.length}, kol vylepšování: až ${rounds}`);

  // kolo 0: zamíchané pořadí, aby výsledek nezávisel na pořadí souborů
  for (const i of shuffled([...targets.keys()], rng)) {
    const r = make(i, seed + i * 131, 30000);
    if (!r.ok) fail([`${targets[i].label}: ${r.report.join(' | ')}`]);
    cur[i] = r;
  }
  let best = costNow();
  console.log(`kolo 0: ${best}`);

  // další kola: každou mřížku znovu vybrat proti ostatním, přijmout jen zlepšení bez zvětšení mřížky
  for (let round = 1; round <= rounds; round++) {
    let improved = false;
    for (const i of shuffled([...targets.keys()], rng)) {
      const old = cur[i];
      const r = make(i, seed + round * 10007 + i * 131, 8000);
      if (!r.ok || r.size > old.size) continue;
      cur[i] = r;
      const c = costNow();
      if (c < best) { best = c; improved = true; } else cur[i] = old;
    }
    console.log(`kolo ${round}: ${best}`);
    if (!improved || best === 0) break;
  }

  // zápis (každý soubor jednou)
  const byFile = new Map();
  targets.forEach((t, i) => byFile.set(t.file, [...(byFile.get(t.file) || []), i]));
  for (const [file, idxs] of byFile) {
    const json = await readJson(file);
    for (const i of idxs) {
      const t = targets[i], r = cur[i];
      const ws = t.idx === null ? json.wordsearch : json.tasks[t.idx].wordsearch;
      ws.size = r.size; ws.words = r.words; ws.grid = r.grid;
      ws.underlay = { ...ws.underlay, cells: r.cells };
    }
    await fs.writeFile(file, compactArrays(JSON.stringify(json, null, 2)) + '\n');
  }

  console.log('');
  targets.forEach((t, i) => console.log(`${t.label.padEnd(16)} ${cur[i].size}×${cur[i].size}, ${cur[i].words.length} slov${cur[i].level ? ' (použito „jen když jinak nevyjde“)' : ''}`));
  const { usage, where } = usageOf(targets.map((t, i) => ({ label: t.label, words: cur[i].words })));
  const reps = [...usage].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  console.log(reps.length
    ? `\nOpakující se slova (${reps.length}): ${reps.map(([k, c]) => `${k} (${c}×: ${where.get(k).join(', ')})`).join('; ')}`
    : '\nŽádné slovo se neopakuje.');
  const used = usage.size, total = [...usage.values()].reduce((a, b) => a + b, 0);
  console.log(`Použito ${used} různých slov v ${total} výskytech, nejvíc výskytů jednoho slova: ${Math.max(...usage.values())}.`);
  console.log('Zkontrolujte: node build.mjs --verify');
}

function fail(errors) {
  console.error(`\nCHYBY (${errors.length}):`);
  errors.forEach((m) => console.error(' ✗', m));
  process.exit(1);
}

if (flag('new-token')) console.log(randomBytes(18).toString('base64url'));
else if (flag('wordsearch-all')) await wordsearchAll();
else if (flag('wordsearch')) await wordsearchCli();
else if (flag('verify')) await verify();
else if (flag('cheatsheet')) await cheatsheet();
else await build();
