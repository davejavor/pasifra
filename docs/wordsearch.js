// Osmisměrka v klientu: výběr dvěma ťuknutími (začátek, konec), 8 směrů, žádné tažení.
// ws = { size, grid:[řádky], words:[{r,c,dr,dc,len}], underlay:[[r,c],…] }
// storage = { load(): number[], save(number[]) } – indexy nalezených slov.

const MSG_OTHER = 'Tohle mezi pojmy nepatří.';

export function mountWordSearch(el, ws, storage) {
  const n = ws.size;
  const rows = ws.grid.map((row) => Array.from(row));
  const wordCells = ws.words.map((w) => Array.from({ length: w.len }, (_, k) => (w.r + k * w.dr) * n + (w.c + k * w.dc)));
  const covered = new Set(wordCells.flat());
  const under = new Set(ws.underlay.map(([r, c]) => r * n + c));
  const found = new Set(storage.load().filter((i) => Number.isInteger(i) && i >= 0 && i < ws.words.length));
  let start = null;

  el.innerHTML = `
    <div class="ws-top"><span id="ws-count" class="timer"></span>
      <button type="button" class="ghost ws-cancel" id="ws-cancel">Zrušit výběr</button></div>
    <div class="ws-box"><div class="ws" style="--n:${n}" id="ws-grid">${rows.flat().map((ch, i) =>
      `<button type="button" class="c" data-i="${i}" aria-label="řádek ${Math.floor(i / n) + 1}, sloupec ${(i % n) + 1}, ${ch}">${ch}</button>`).join('')}</div></div>
    <div class="msg" id="ws-msg" role="status" aria-live="polite"></div>`;
  const cells = [...el.querySelectorAll('button.c')];
  const msg = el.querySelector('#ws-msg');
  const done = () => found.size === ws.words.length;
  const inFound = new Set();

  function paint() {
    inFound.clear();
    for (const wi of found) wordCells[wi].forEach((i) => inFound.add(i));
    const all = done();
    cells.forEach((b, i) => {
      b.className = 'c'
        + (inFound.has(i) ? ' found' : '')
        + (start === i ? ' start' : '')
        + (all && !covered.has(i) ? ' rest' : '')
        + (all && inFound.has(i) ? ' dim' : '')
        + (all && under.has(i) ? ' under' : '');
    });
    el.querySelector('#ws-count').textContent = `Nalezeno ${found.size} / ${ws.words.length}`;
    el.querySelector('#ws-cancel').disabled = start === null;
  }

  function say(text) { msg.textContent = text; }

  function select(i) {
    if (done()) return;
    if (start === null) { start = i; say(''); return paint(); }
    if (start === i) { start = null; return paint(); }
    const r1 = Math.floor(start / n), c1 = start % n, r2 = Math.floor(i / n), c2 = i % n;
    const dr = r2 - r1, dc = c2 - c1;
    start = null;
    if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) { say(MSG_OTHER); return paint(); }
    const steps = Math.max(Math.abs(dr), Math.abs(dc)), sr = Math.sign(dr), sc = Math.sign(dc);
    const line = Array.from({ length: steps + 1 }, (_, k) => (r1 + k * sr) * n + (c1 + k * sc));
    const set = new Set(line);
    const exact = wordCells.findIndex((wc) => wc.length === line.length && wc.every((x) => set.has(x)));
    if (exact >= 0) {
      if (found.has(exact)) say('Tohle slovo už máte.');
      else {
        found.add(exact);
        storage.save([...found]);
        say(done() ? 'Všechna slova máte! Zbylá zvýrazněná písmena čtěte po řádcích zleva doprava a shora dolů.' : 'Nalezeno!');
      }
    } else {
      const host = wordCells.findIndex((wc) => wc.length > line.length && line.every((x) => wc.includes(x)));
      if (host < 0) say(MSG_OTHER);
      else say(found.has(host) ? 'Tohle slovo už máte.' : 'Skoro! Slovo pokračuje.');
    }
    paint();
  }

  el.querySelector('#ws-grid').addEventListener('click', (e) => {
    const b = e.target.closest('button.c');
    if (b) select(Number(b.dataset.i));
  });
  el.querySelector('#ws-cancel').addEventListener('click', () => { start = null; say(''); paint(); });
  paint();
  if (done()) say('Všechna slova máte! Zbylá zvýrazněná písmena čtěte po řádcích zleva doprava a shora dolů.');
}
