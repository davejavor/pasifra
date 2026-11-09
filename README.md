# pasifra – web pro pražskou šifrovací hru

Statický web (vanilla HTML/CSS/JS) pro hru v sobotu 12. 12. 2026, 14:30–18:00. Web jen doručuje úkoly, šifry jsou v hlavě organizátorů.
Repo je **veřejné**, proto je všechno tajné jen zašifrované (AES-GCM, klíč z PBKDF2, 200 000 iterací).

## Jak to funguje

- Každý tým má vlastní soubor `docs/data/<hash tokenu>.json`. Úkol 1 se odemyká klíčem z tokenu v odkazu.
- Klíč úkolu N = PBKDF2(odpověď N-1 + klíč N-1 + sůl). Správný kód poznáme tím, že se dešifrování povede (GCM tag). Žádné hashe odpovědí nikde nejsou.
- Odpovědi se normalizují: malá písmena, bez diakritiky, mezer a interpunkce (`Karel IV.` = `kareliv`).
- Čísla na organizátory jsou v zašifrovaných datech týmů, ne ve veřejném kódu.
- Časy (start ve 14:29, globální zprávy v 17:15 a 17:30) se berou z hodin zařízení.
- Service worker je network-first, takže opravy v den hry se dostanou k týmům při dalším načtení. Offline se použije poslední uložená kopie.

## Struktura

```
build.mjs            šifrování, --verify, --cheatsheet, --new-token
lib/crypto.mjs       sdílený kód (build i prohlížeč, kopíruje se do docs/crypto.js)
lib/sw.template.js   šablona service workeru (build vyrobí docs/sw.js s verzí cache)
docs/                to, co jde na GitHub Pages
examples/src-data/   vymyšlená vzorová data
src-data/            skutečné zdroje (NENÍ v tomto repu, viz níž)
```

### `src-data/` je vlastní soukromé repo

`src-data/` je v `.gitignore`, takže do něj můžete vnořit samostatný (soukromý) git repozitář:

```
git clone <privatni-repo> src-data
```

Pak jde zálohovat a verzovat zvlášť a do veřejného repa se nikdy nedostane.

## Formát zdrojových dat

`src-data/common.json` – kontakty (telefon jen číslice včetně předvolby):

```json
{ "contacts": [ { "name": "Anna", "phone": "420777123456" }, { "name": "Petr", "phone": "420777654321" } ] }
```

`src-data/<tym>.json` – jeden soubor na tým:

```json
{
  "team": "zizka",
  "name": "Žižkovi husité",
  "token": "…z node build.mjs --new-token…",
  "salt": "…z node build.mjs --new-token…",
  "tasks": [
    {
      "title": "První úkol",
      "body_md": "Text hádanky. **tučně**, *kurzíva*, prázdný řádek = nový odstavec.",
      "image": "img/socha.jpg",
      "hints": [ { "after_min": 15, "text": "Malá nápověda" }, { "after_min": 25, "text": "Velká nápověda" } ],
      "answer": "Jan Hus",
      "item": { "label": "Indicie 1", "text": "Pergamen…", "image": null }
    },
    { "ref": "shared/ukol4-par-a" },
    { "ref": "shared/ukol5-vsichni" }
  ],
  "finale": { "ref": "shared/finale" }
}
```

- `image` je cesta k souboru relativně k `src-data/` (nebo rovnou `data:` URL). Build z ní udělá data URL, **používejte malé obrázky** (stovky kB), jinak bude soubor těžký.
- **Společné úkoly** jsou v `src-data/shared/<nazev>.json` (stejná pole jako úkol) a v týmu se odkazují přes `{ "ref": "shared/<nazev>" }`. Může být na libovolné pozici řetězu. Oba týmy páru pak zadávají stejný kód.
- `finale` je závěrečná obrazovka (`title`, `body_md`, volitelně `image`), odemkne se kódem posledního úkolu.
- Každý úkol má přesně 2 nápovědy s `after_min` vzestupně.

### Příkazy

```
node build.mjs --new-token      náhodný token (použijte i jako sůl)
node build.mjs                  zašifruje src-data/ do docs/data/ a obnoví docs/crypto.js a docs/sw.js
node build.mjs --verify         dešifruje celý řetěz všech týmů pomocí odpovědí ze zdroje
node build.mjs --cheatsheet     vytvoří cheatsheet.html (v .gitignore) s odpověďmi, nápovědami a odkazy
                                (--base=https://UZIVATEL.github.io/pasifra/ doplní adresu do odkazů)
```

Volby `--src=<složka>` a `--out=<složka>` přepíšou výchozí `src-data` a `docs/data`. Například vzorová data:
`node build.mjs --src=examples/src-data`.

Build upozorní na **krátké kódy** (např. letopočet má ~13 bitů). Kdo má veřejný soubor a chuť, takový kód offline uhodne. Šifrování chrání před zvědavostí, ne před odhodlaným útočníkem.

## Lokální test

```
npx serve docs
```

Odkaz týmu je `http://localhost:3000/?t=<token>`. Na telefonu použijte adresu počítače v síti.

- `&now=2026-12-12T14:30` posune „aktuální čas“ (dál normálně běží). Hodí se na časovače nápověd (`&now=…T14:46`) i na zprávy v 17:15 a 17:30.
- `&reset=1` smaže uložený postup tohoto týmu v zařízení.
- Postup je v `localStorage`. Když se zařízení „ztratí“, tým otevře odkaz na jiném telefonu a znovu zadá kódy.

## Nasazení (GitHub Pages z `/docs`)

1. Commitněte a pushněte `docs/` (včetně `docs/data/`).
2. GitHub → Settings → Pages → Source: **Deploy from a branch**, branch `main`, složka **/docs**.
3. Web poběží na `https://<uzivatel>.github.io/pasifra/`. Odkaz týmu je `…/pasifra/?t=<token>`.

## V den hry: co se dá opravit za provozu

Po `node build.mjs --verify`, commitu a pushi se oprava dostane k týmům při dalším načtení stránky (Pages se aktualizují za pár minut).

- **Bezpečně:** texty zadání, nápověd a indicií, obrázky, kontakty, globální zprávy (`docs/config.js`).
- **Nedělejte, když už týmy hrají:** neměňte `answer` úkolů, které týmy už vyřešily, ani `token` nebo `salt`. Týmům s postupem by přestal sedět uložený klíč a aplikace jim nabídne „začít znovu“ (zadají kódy znovu, nic jiného se neztratí).

## Checklist „před ostrým spuštěním“

- [ ] Vložit skutečný `src-data/` (soukromé repo) a **smazat vzorová data**: `docs/data/` po prvním ostrém `node build.mjs` obsahuje už jen vaše týmy (build smaže staré `*.json`). Zkontrolovat `git status`, že vzorové soubory zmizely.
- [ ] Každému týmu **vygenerovat vlastní token i sůl** (`node build.mjs --new-token`, dvakrát na tým), nepoužít vzorové.
- [ ] Do `src-data/common.json` dát skutečná čísla organizátorů a ověřit odkazy `https://wa.me/…`.
- [ ] Přepsat vzorové globální zprávy v `docs/config.js` (17:15 silná nápověda, 17:30 místo setkání; zakódovat jako base64).
- [ ] `node build.mjs` a hned `node build.mjs --verify`, bez chyb. Projít varování o krátkých kódech.
- [ ] `node build.mjs --cheatsheet --base=https://<uzivatel>.github.io/pasifra/` a vytisknout / mít po ruce `cheatsheet.html`.
- [ ] Commit + push `docs/`, zapnout Pages z `/docs`, ověřit, že se každý odkaz týmu načte.
- [ ] **Test na telefonu** (venku, na mobilních datech): projít celý řetěz jednoho týmu s `&now=`, zkusit odemknutí nápověd, špatný kód, zadání s diakritikou a velkými písmeny, obnovu postupu na druhém telefonu a načtení po vypnutí internetu.
- [ ] Rozeslat týmům odkazy (každý jen svůj) a před startem ověřit, že hodiny v telefonech jdou správně.
