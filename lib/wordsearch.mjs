// Osmisměrka: čistá logika bez závislostí (build, generátor, verify).
// Souřadnice jsou [řádek, sloupec] od 0. Políčko = jedno písmeno, CH jsou dvě políčka.

export const DIRS = [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1]];
export const MIN_SIZE = 8;
export const MAX_SIZE = 12;

export const letters = (s) =>
  Array.from(String(s ?? '').normalize('NFC').toLocaleUpperCase('cs')).filter((ch) => /\p{L}/u.test(ch));
export const wsNorm = (s) => letters(s).join('');

// Všechny výskyty slova v mřížce (rows[r][c] = písmeno). Výskyt čtený pozpátku na stejných políčkách se počítá jednou.
export function occurrences(rows, word) {
  const n = rows.length, w = letters(word), len = w.length, out = new Map();
  if (len < 2) return [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) for (const [dr, dc] of DIRS) {
    const er = r + (len - 1) * dr, ec = c + (len - 1) * dc;
    if (er < 0 || ec < 0 || er >= n || ec >= n) continue;
    let ok = true;
    for (let k = 0; k < len; k++) if (rows[r + k * dr][c + k * dc] !== w[k]) { ok = false; break; }
    if (!ok) continue;
    const cells = Array.from({ length: len }, (_, k) => (r + k * dr) * n + (c + k * dc));
    const key = [...cells].sort((a, b) => a - b).join(',');
    if (!out.has(key)) out.set(key, { r, c, dr, dc, len, cells });
  }
  return [...out.values()];
}

const within = (small, big) => small.every((i) => big.includes(i));
const dirName = (dr, dc) => ({ '0,1': '→', '1,0': '↓', '1,1': '↘', '-1,1': '↗', '0,-1': '←', '-1,0': '↑', '-1,-1': '↖', '1,-1': '↙' }[`${dr},${dc}`]);

// Kontrola celé osmisměrky. spec: { size?, grid, words, solution, underlay: {text, cells} }
export function analyze(spec, pool = []) {
  const errors = [], infos = [];
  const res = { errors, infos, n: 0, rows: [], placements: [], leftover: '', underlay: '' };
  if (!Array.isArray(spec.grid) || !spec.grid.length) {
    errors.push('chybí "grid" (vyrobí ho: node build.mjs --wordsearch <soubor>)');
    return res;
  }
  const rows = spec.grid.map(letters);
  const n = rows.length;
  const badRows = rows.map((r, i) => [i, r.length]).filter(([, len]) => len !== n);
  if (badRows.length) errors.push(`mřížka není čtvercová: řádků je ${n}, ale ${badRows.length}× nesedí délka (např. řádek ${badRows[0][0] + 1} má ${badRows[0][1]} políček)`);
  if (spec.size !== undefined && spec.size !== n) errors.push(`size=${spec.size}, ale mřížka má ${n} řádků`);
  if (n < MIN_SIZE || n > MAX_SIZE) errors.push(`velikost ${n}×${n} je mimo ${MIN_SIZE}×${MIN_SIZE} až ${MAX_SIZE}×${MAX_SIZE}`);
  if (errors.length) return res;
  Object.assign(res, { n, rows });

  // slova
  const words = (spec.words || []).map((raw) => ({ raw, text: wsNorm(raw) }));
  if (!words.length) errors.push('chybí "words"');
  const seen = new Set();
  for (const w of words) {
    if (w.text.length < 2) errors.push(`slovo "${w.raw}" je příliš krátké`);
    if (w.text.length > n) errors.push(`slovo ${w.text} (${w.text.length} písmen) je delší než mřížka (${n})`);
    if (seen.has(w.text)) errors.push(`slovo ${w.text} je v "words" dvakrát`);
    seen.add(w.text);
  }
  const occ = new Map(words.map((w) => [w.text, occurrences(rows, w.text)]));
  const isInside = (o, own) => words.some((w2) => w2.text !== own && occ.get(w2.text).some((o2) => o2.len > o.len && within(o.cells, o2.cells)));

  const placements = [];
  for (const w of words) {
    const all = occ.get(w.text);
    const free = all.filter((o) => !isInside(o, w.text));
    const inner = all.length - free.length;
    if (w.text.length > n) continue;
    if (free.length === 0) {
      errors.push(inner ? `slovo ${w.text} je v mřížce jen uvnitř jiného slova` : `slovo ${w.text} v mřížce není`);
    } else if (free.length > 1) {
      errors.push(`slovo ${w.text} je v mřížce ${free.length}× (má být právě jednou)`);
    } else {
      placements.push({ word: w.text, ...free[0] });
      if (inner) infos.push(`${w.text} je navíc částí jiného slova z mřížky (${inner}×)`);
    }
  }
  res.placements = placements;

  // cizí slova ze zásobníku (pool = skupiny pravopisů; skupina s už použitým slovem se přeskočí)
  for (const g of pool) {
    const group = (Array.isArray(g) ? g : [g]).map(wsNorm).filter((p) => p.length >= 2);
    if (group.some((p) => seen.has(p))) continue;
    for (const p of group) {
      for (const o of occurrences(rows, p)) {
        const host = placements.find((pl) => o.len < pl.len && within(o.cells, pl.cells));
        if (host) infos.push(`${p} je částí slova ${host.word}`);
        else errors.push(`cizí slovo ze zásobníku ${p} je v mřížce (řádek ${o.r + 1}, sloupec ${o.c + 1}, směr ${dirName(o.dr, o.dc)})`);
      }
    }
  }

  // tajenka
  const covered = new Set(placements.flatMap((p) => p.cells));
  res.leftover = rows.flat().filter((_, i) => !covered.has(i)).join('');
  const sol = wsNorm(spec.solution);
  if (!sol) errors.push('chybí "solution"');
  else if (res.leftover !== sol) {
    errors.push(`zbylá písmena (${res.leftover.length}) „${res.leftover}“ ≠ tajenka (${sol.length}) „${sol}“`);
  }

  // podkres
  const u = spec.underlay;
  if (!u || !Array.isArray(u.cells) || !u.text) {
    errors.push('chybí "underlay" (text + cells)');
  } else {
    let prev = -1, got = '';
    for (const cell of u.cells) {
      const [r, c] = cell || [];
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= n || c >= n) { errors.push(`podkres: neplatné políčko ${JSON.stringify(cell)}`); continue; }
      const idx = r * n + c;
      if (idx <= prev) errors.push(`podkres: políčko [${r},${c}] není v pořadí čtení`);
      if (!covered.has(idx)) errors.push(`podkres: políčko [${r},${c}] nepatří žádnému slovu`);
      prev = idx;
      got += rows[r][c];
    }
    res.underlay = got;
    if (got !== wsNorm(u.text)) errors.push(`podkres: políčka dávají „${got}“, má být „${wsNorm(u.text)}“`);
  }
  return res;
}

// Náhled pro terminál: tajenka malými písmeny, podkres v hranatých závorkách.
export function preview(a, underlayCells) {
  const { n, rows, placements } = a;
  const covered = new Set(placements.flatMap((p) => p.cells));
  const under = new Set((underlayCells || []).map(([r, c]) => r * n + c));
  return rows.map((row, r) => row.map((ch, c) => {
    const i = r * n + c;
    const t = covered.has(i) ? ch : ch.toLocaleLowerCase('cs');
    return under.has(i) ? `[${t}]` : ` ${t} `;
  }).join('')).join('\n');
}

// ---------- generátor ----------

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rng) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

// Zpráva, proč zadání nejde splnit (počty), nebo null, když aritmetika dovoluje aspoň jednu velikost.
export function feasibility(words, m, sizes) {
  const L = words.reduce((s, w) => s + w.length, 0);
  const longest = words.reduce((a, w) => (w.length > a.length ? w : a), []);
  const rowsOut = [];
  const viable = [];
  for (const n of sizes) {
    const need = n * n - m; // obsazených políček
    const x = L - need;     // potřebných křížení
    let verdict;
    if (longest.length > n) verdict = `nevejde se slovo ${longest.join('')} (${longest.length})`;
    else if (x < 0) verdict = `chybí ${-x} písmen ve slovech (nebo tajenka delší o ${-x})`;
    else if (x > words.length) verdict = `přebývá ${x - words.length}+ písmen (příliš mnoho křížení; zvětšete mřížku)`;
    else { verdict = `možné, ${x} křížení`; viable.push({ n, x }); }
    rowsOut.push(`  ${n}×${n}: ${n * n} políček, obsazených má být ${need}, slova mají ${L} písmen → ${verdict}`);
  }
  return { L, longest, rowsOut, viable };
}

function layout(n, ws, x, rng, limit) {
  const cells = new Array(n * n).fill('');
  const owners = Array.from({ length: n * n }, () => []);
  const chosen = [];
  let nodes = 0;

  const candidates = (wi) => {
    const w = ws[wi], len = w.length, out = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) for (const [dr, dc] of DIRS) {
      const er = r + (len - 1) * dr, ec = c + (len - 1) * dc;
      if (er < 0 || ec < 0 || er >= n || ec >= n) continue;
      let ok = true, ov = 0;
      const idxs = [], share = new Map();
      for (let k = 0; k < len; k++) {
        const idx = (r + k * dr) * n + (c + k * dc);
        if (cells[idx]) {
          if (cells[idx] !== w[k]) { ok = false; break; }
          ov++;
          for (const o of owners[idx]) share.set(o, (share.get(o) || 0) + 1);
        }
        idxs.push(idx);
      }
      if (!ok) continue;
      if ([...share.values()].some((v) => v > 1)) continue; // se stejným slovem sdílí nejvýš jedno políčko
      out.push({ idxs, ov });
    }
    return out;
  };

  const dfs = (wi, sum) => {
    if (wi === ws.length) return sum === x;
    if (++nodes > limit) return false;
    const remaining = x - sum, left = ws.length - wi;
    const cands = shuffle(candidates(wi).filter((c) => c.ov <= remaining), rng);
    const crossFirst = rng() < Math.min(1, remaining / left);
    cands.sort((a, b) => (crossFirst ? (b.ov > 0) - (a.ov > 0) : (a.ov > 0) - (b.ov > 0)));
    for (const cand of cands) {
      const prevChars = cand.idxs.map((i) => cells[i]);
      cand.idxs.forEach((i, k) => { cells[i] = ws[wi][k]; owners[i].push(wi); });
      chosen[wi] = cand;
      if (dfs(wi + 1, sum + cand.ov)) return true;
      cand.idxs.forEach((i, k) => { cells[i] = prevChars[k]; owners[i].pop(); });
      if (nodes > limit) return false;
    }
    return false;
  };
  return dfs(0, 0) ? cells : null;
}

// Vybere políčka podkresu: písmena textu v pořadí čtení, jen z obsazených políček.
function pickUnderlay(n, cells, free, text, rng) {
  const order = [];
  for (let i = 0; i < n * n; i++) if (!free.has(i)) order.push(i);
  const t = text, T = t.length, M = order.length;
  const feas = Array.from({ length: T + 1 }, () => new Array(M + 2).fill(false));
  for (let i = 0; i <= M; i++) feas[T][i] = true;
  for (let j = T - 1; j >= 0; j--) for (let i = M - 1; i >= 0; i--) feas[j][i] = feas[j][i + 1] || (cells[order[i]] === t[j] && feas[j + 1][i + 1]);
  if (!feas[0][0]) return null;
  const out = [];
  let cur = 0;
  for (let j = 0; j < T; j++) {
    const opts = [];
    for (let i = cur; i < M; i++) if (cells[order[i]] === t[j] && feas[j + 1][i + 1]) opts.push(i);
    const pick = opts[Math.floor(rng() * opts.length)];
    out.push([Math.floor(order[pick] / n), order[pick] % n]);
    cur = pick + 1;
  }
  return out;
}

// Dokončení mřížky: volná políčka = tajenka, výběr podkresu, plná kontrola. Vrátí { why } nebo { grid, cells, analysis }.
function completeGrid(n, cells, texts, sol, spec, ul, groups, rng) {
  const free = new Set();
  let k = 0;
  for (let i = 0; i < n * n; i++) if (!cells[i]) { free.add(i); cells[i] = sol[k++]; }
  const cellsU = pickUnderlay(n, cells, free, ul, rng);
  if (!cellsU) return { why: 'podkres nejde složit z písmen slov v pořadí čtení' };
  const grid = Array.from({ length: n }, (_, r) => cells.slice(r * n, r * n + n).join(''));
  const a = analyze({ size: n, grid, words: texts, solution: spec.solution, underlay: { text: spec.underlay.text, cells: cellsU } }, groups);
  if (a.errors.length) return { why: a.errors[0] };
  return { grid, cells: cellsU, analysis: a };
}

// Pevný seznam slov (spec.words). pool = skupiny pravopisů ([['OBERHAW','OBERHAU'], …]) pro hlídání cizích slov.
// Vrátí { ok:true, size, grid, cells, attempts, analysis } nebo { ok:false, report:[řádky] }.
export function generate(spec, { pool = [], size, seed = 1, timeMs = 20000 } = {}) {
  const words = (spec.words || []).map(letters);
  const sol = letters(spec.solution), ul = letters(spec.underlay?.text);
  const report = [];
  if (!words.length || !sol.length || !ul.length) return { ok: false, report: ['Vstup musí mít "words", "solution" a "underlay.text".'] };
  const sizes = size ? [size] : Array.from({ length: MAX_SIZE - MIN_SIZE + 1 }, (_, i) => MIN_SIZE + i);
  if (size && (size < MIN_SIZE || size > MAX_SIZE)) return { ok: false, report: [`Velikost musí být ${MIN_SIZE}–${MAX_SIZE}.`] };
  const f = feasibility(words, sol.length, sizes);
  report.push(`Slov: ${words.length}, písmen ve slovech: ${f.L}, tajenka: ${sol.length} písmen, nejdelší slovo: ${f.longest.join('')} (${f.longest.length}).`, ...f.rowsOut);
  if (!f.viable.length) {
    const n0 = Math.max(f.longest.length, size || MIN_SIZE);
    const need = Math.max(0, n0 * n0 - sol.length - f.L);
    report.push(`Nejde to: pro žádnou velikost nesedí počty.${need ? ` Pro ${n0}×${n0} přidejte aspoň ${need} písmen slov, nebo prodlužte tajenku aspoň o ${need} písmen (křížení potřebnou délku jen zvyšují).` : ''}`);
    return { ok: false, report };
  }

  const start = Date.now();
  let attempts = 0, why = '';
  for (const [vi, { n, x }] of f.viable.entries()) {
    const deadline = start + (timeMs * (vi + 1)) / f.viable.length;
    const sorted = [...words].sort((a, b) => b.length - a.length);
    while (Date.now() < deadline) {
      const rng = mulberry32(seed + attempts * 7919);
      attempts++;
      const cells = layout(n, sorted, x, rng, 4000);
      if (!cells) { why = 'nenašel jsem rozmístění slov'; continue; }
      const r = completeGrid(n, cells, spec.words, sol, spec, ul, pool, rng);
      if (r.why) { why = r.why; continue; }
      return { ok: true, size: n, attempts, ...r };
    }
  }
  report.push(`Za ${Math.round((Date.now() - start) / 1000)} s a ${attempts} pokusů se nepodařilo (poslední důvod: ${why}). Zkuste jiný --seed=, --size= nebo upravte slova.`);
  return { ok: false, report };
}

// ---------- zásobník, pravidla, automatický výběr slov ----------

// json: { rules, words:[{word, category, family, variants, onlyIfNeeded}] } (nebo pole řetězců).
export function parsePool(json) {
  const list = Array.isArray(json) ? json : json?.words || [];
  const entries = list.map((w) => (typeof w === 'string' ? { word: w } : w)).map((e) => {
    const spellings = [wsNorm(e.word), ...(e.variants || []).map(wsNorm)].filter((s) => s.length >= 2);
    return { word: spellings[0], category: e.category || '', family: e.family || '', onlyIfNeeded: !!e.onlyIfNeeded, spellings };
  }).filter((e) => e.spellings.length);
  const byWord = new Map();
  for (const e of entries) for (const s of e.spellings) byWord.set(s, e);
  const rules = (json && !Array.isArray(json) && json.rules) || {};
  return { entries, rules, byWord, groups: entries.map((e) => e.spellings) };
}

const isRule = (r) => r && typeof r === 'object' && !Array.isArray(r);

// Pravidla rodin a kategorií pro jednu mřížku. "Jen když jinak nevyjde" nejde zpětně ověřit, proto jen varování.
export function checkRules(words, pool) {
  const errors = [], warnings = [];
  const list = words.map((raw) => ({ text: wsNorm(raw), entry: pool.byWord.get(wsNorm(raw)) }));
  for (const w of list) if (!w.entry) warnings.push(`slovo ${w.text} není v zásobníku (kategorie a rodina se neověří)`);
  const byEntry = new Map();
  for (const w of list) if (w.entry) byEntry.set(w.entry, [...(byEntry.get(w.entry) || []), w.text]);
  for (const [e, texts] of byEntry) if (texts.length > 1) errors.push(`slovo ${e.word} je v mřížce víckrát (${texts.join(', ')})`);
  const fam = new Map();
  for (const e of byEntry.keys()) if (e.family) fam.set(e.family, [...(fam.get(e.family) || []), e.word]);
  for (const [f, ws] of fam) if (ws.length > 1) errors.push(`rodina „${f}“ je v jedné mřížce víckrát: ${ws.join(', ')}`);
  for (const [cat, rule] of Object.entries(pool.rules)) {
    if (!isRule(rule)) continue;
    const inCat = [...byEntry.keys()].filter((e) => e.category === cat);
    if (rule.max !== undefined && inCat.length > rule.max) {
      const msg = `kategorie ${cat}: ${inCat.length} slov (max ${rule.max}): ${inCat.map((e) => e.word).join(', ')}`;
      if (rule.onlyIfNeeded) warnings.push(`${msg} – povoleno jen když jinak nevyjde`);
      else errors.push(msg);
    }
    if (rule.min !== undefined && inCat.length < rule.min) errors.push(`kategorie ${cat}: ${inCat.length} slov (min ${rule.min})`);
  }
  for (const e of byEntry.keys()) if (e.onlyIfNeeded) warnings.push(`slovo ${e.word} je v zásobníku označené „jen když jinak nevyjde“`);
  return { errors, warnings };
}

function wpick(arr, weight, rng) {
  const ws = arr.map(weight);
  let r = rng() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
  return arr.at(-1);
}

// Automatický výběr slov ze zásobníku podle pravidel + rozmístění. Nejmenší možná velikost 8–12.
// spec: { solution, underlay:{text}, require?:[…], exclude?:[…] }
// usage: Map(klíč slova → počet výskytů v jiných mřížkách), klíč = pool entry.word (nebo vlastní text).
// Vrátí { ok:true, size, grid, cells, words, analysis, level, attempts, … } nebo { ok:false, report }.
export function generateAuto(spec, { pool, usage = new Map(), size, seed = 1, timeMs = 30000 } = {}) {
  const sol = letters(spec.solution), ul = letters(spec.underlay?.text);
  if (!sol.length || !ul.length) return { ok: false, report: ['Vstup musí mít "solution" a "underlay.text".'] };
  if (!pool?.entries.length) return { ok: false, report: ['Zásobník slov je prázdný nebo chybí.'] };
  if (size && (size < MIN_SIZE || size > MAX_SIZE)) return { ok: false, report: [`Velikost musí být ${MIN_SIZE}–${MAX_SIZE}.`] };

  const excluded = new Set((spec.exclude || []).map((t) => pool.byWord.get(wsNorm(t))).filter(Boolean));
  const required = (spec.require || []).map((t) => ({ text: wsNorm(t), entry: pool.byWord.get(wsNorm(t)) || null }));
  const rules = pool.rules, prefer = new Set(rules.prefer || []);
  const rule = (cat) => (isRule(rules[cat]) ? rules[cat] : {});
  const usageOf = (e) => usage.get(e.word) || 0;
  const sizes = size ? [size] : Array.from({ length: MAX_SIZE - MIN_SIZE + 1 }, (_, i) => MIN_SIZE + i);

  // level 0: přísná pravidla; 1: povolí "onlyIfNeeded" (kategorie i slova) o 1 slovo; 2: o 2 slova
  const select = (n, level, rng) => {
    const need = n * n - sol.length;
    const chosen = [], fam = new Set(), ents = new Set(), cnt = new Map();
    let L = 0;
    const cap = (cat) => { const r = rule(cat); return (r.max ?? Infinity) + (r.onlyIfNeeded ? level : 0); };
    const spellable = (e) => e.spellings.filter((s) => s.length <= n);
    const canAdd = (e) => !ents.has(e) && !excluded.has(e)
      && !(e.family && fam.has(e.family))
      && !(e.onlyIfNeeded && level < 1)
      && (cnt.get(e.category) || 0) < cap(e.category)
      && spellable(e).length > 0;
    const add = (text, e) => {
      chosen.push({ text, entry: e });
      L += Array.from(text).length;
      if (e) { ents.add(e); if (e.family) fam.add(e.family); cnt.set(e.category, (cnt.get(e.category) || 0) + 1); }
    };
    const spell = (e) => { const s = spellable(e); return s[Math.floor(rng() * s.length)]; };
    const weight = (e) => {
      let w = prefer.has(e.category) ? 4 : 1;
      if (e.category === 'jmena') w *= 0.5;
      if (rule(e.category).onlyIfNeeded || e.onlyIfNeeded) w *= 0.3;
      return w / (1 + usageOf(e)) ** 3;
    };
    const avail = () => pool.entries.filter(canAdd);

    for (const r of required) {
      if (r.text.length > n) return null;
      if (r.entry && (ents.has(r.entry) || (r.entry.family && fam.has(r.entry.family)))) return { error: `require: ${r.text} patří do stejné rodiny nebo je stejné slovo jako jiné požadované` };
      add(r.text, r.entry);
    }
    for (const [cat, r] of Object.entries(rules)) {
      if (!isRule(r) || !r.min) continue;
      const target = Math.min(cap(cat), r.min + (rng() < 0.4 ? 1 : 0));
      while ((cnt.get(cat) || 0) < target) {
        const c = avail().filter((e) => e.category === cat);
        if (!c.length) break;
        const e = wpick(c, weight, rng);
        add(spell(e), e);
      }
      if ((cnt.get(cat) || 0) < r.min) return null;
    }
    while (L < need) {
      const R = need - L;
      let c = avail();
      if (!c.length) return null;
      const fit = c.filter((e) => e.spellings[0].length >= R && e.spellings[0].length - R <= 5);
      if (R <= 13 && fit.length) c = fit; // dokončit s malým přebytkem (= počet křížení)
      const e = wpick(c, weight, rng);
      add(spell(e), e);
    }
    const x = L - need;
    return x > chosen.length ? null : { chosen, x };
  };

  const report = [];
  const perSize = size ? timeMs : timeMs / sizes.length;
  for (const n of sizes) {
    if (required.some((r) => r.text.length > n)) { report.push(`${n}×${n}: požadované slovo je delší než mřížka`); continue; }
    const t0 = Date.now();
    let attempts = 0, sets = 0, why = 'žádná sada slov nevyšla';
    while (Date.now() - t0 < perSize) {
      const level = Math.min(2, Math.floor((3 * (Date.now() - t0)) / perSize));
      const rng = mulberry32(seed + n * 1000003 + attempts * 7919);
      attempts++;
      const sel = select(n, level, rng);
      if (sel?.error) return { ok: false, report: [sel.error] };
      if (!sel) continue;
      sets++;
      const texts = sel.chosen.map((c) => c.text);
      const sorted = texts.map((t) => Array.from(t)).sort((a, b) => b.length - a.length);
      for (let k = 0; k < 2; k++) {
        const cells = layout(n, sorted, sel.x, mulberry32(seed * 31 + attempts * 131 + k), 3000);
        if (!cells) { why = 'slova se nepodařilo rozmístit'; continue; }
        const r = completeGrid(n, cells, texts, sol, spec, ul, pool.groups, rng);
        if (r.why) { why = r.why; continue; }
        const rc = checkRules(texts, pool);
        if (rc.errors.length) { why = rc.errors[0]; continue; }
        return { ok: true, size: n, words: texts, level, attempts, warnings: rc.warnings, ...r };
      }
    }
    report.push(`${n}×${n}: za ${Math.round((Date.now() - t0) / 1000)} s ${sets} sad slov, bez úspěchu (${why})`);
  }
  report.push('Nenašel jsem řešení. Zkuste jiný --seed=, delší tajenku, méně omezující "exclude", nebo rozšiřte zásobník.');
  return { ok: false, report };
}
