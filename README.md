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
lib/wordsearch.mjs   analýza a generátor osmisměrky (build, verify)
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
- **Volnější odpověď:** místo `answer` jde napsat `"answer_contains": ["karel", "karl"]` (1–4 klíčová slova, aspoň 3 znaky). Odpověď pak projde, když klíčové slovo kdekoli obsahuje („socha Karla IV.“). Pište kmeny slov kvůli skloňování. V datech jsou jen zašifrované obálky, nic čitelného.
- `code_label` (volitelné) je popisek nad polem pro odpověď, výchozí je „Odpověď“.

### Osmisměrka jako úkol

Úkol může mít navíc objekt `wordsearch`. Slova i mřížku vyrobí generátor, ve zdroji stačí tajenka a podkres:

```json
{
  "title": "Šermířská osmisměrka",
  "body_md": "…",
  "hints": [ … ],
  "wordsearch": {
    "solution": "BETLÉMSKÁ KAPLE",
    "underlay": { "text": "RIC" },
    "require": ["VORSCHLAG"],
    "exclude": ["OBERHAW"]
  },
  "item": { "label": "Indicie 3", "text": "Slabika z podkresu: RIC" }
}
```

`require` (slova, která tam musí být) a `exclude` (slova, která tam nesmí být) jsou volitelné. Po spuštění generátoru přibude `words`, `size`, `grid` a `underlay.cells` ([řádek, sloupec] od 0).

- `answer` se nemusí psát, kódem je `solution` (normalizuje se jako vždy).
- Písmena jsou velká, **diakritika se zachovává, CH jsou dvě políčka**. Velikost 8×8 až 12×12.
- `node build.mjs --wordsearch-all [--seed=N] [--rounds=N]` přegeneruje **všechny** osmisměrky najednou (týmové i sdílené, slova vybere znovu, existující `words` ignoruje a přepíše soubory). Pořadí souborů nehraje roli: začne se v náhodném pořadí a pak se každá mřížka znovu vybere proti ostatním, přijme se jen řešení, které sníží počet dvojic mřížek se sdíleným slovem (a nezvětší mřížku). Vypíše průběh a opakující se slova. Je deterministický pro stejný `--seed`.
- `node build.mjs --wordsearch <soubor>` pracuje se souborem, který je samotný objekt osmisměrky, úkol, nebo týmový soubor s `--task=N`. Sdílený úkol (`ref`) pusťte na jeho vlastním souboru v `shared/`.
  - **Bez `words` v souboru** slova vybere ze zásobníku a zvolí nejmenší možnou velikost (8–12). Slova delší než mřížka vynechá.
  - **S `words` v souboru** je bere jako pevný seznam a jen je rozmístí (`--size=` je volitelné). Znovu vybrat slova ze zásobníku: `--reselect` (nebo `words` smazat).
  - Další volby: `--size=N` (pevná velikost), `--seed=N` (jiné rozmístění).
- **Šablony nápověd:** v `text` nápovědy u osmisměrky jde použít `{{prvni_pismena}}` (první písmena slov, abecedně, např. `A, O, O, V`), `{{slova}}` (celý seznam, abecedně) a `{{pocet}}`. Doplní je build ze slov v mřížce, takže ve zdroji zůstanou šablony a nápověda vždy odpovídá aktuálním slovům (po přegenerování i po ruční úpravě `words`). Neznámá šablona nebo šablona u úkolu bez osmisměrky je chyba.
- **Počet políček musí sedět:** `size² − délka tajenky = počet obsazených políček`. Když počty nevycházejí (pevný seznam slov), generátor vypíše, kolik písmen slov chybí nebo přebývá.

### Zásobník slov: `src-data/shared/wordsearch-pool.json`

```json
{
  "rules": {
    "prefer": ["semovani", "pojmy"],
    "mec": {"min": 1, "max": 2},
    "vzdalenosti": {"max": 0, "onlyIfNeeded": true},
    "jmena": {"max": 1}
  },
  "words": [
    {"word": "OBERHAW", "category": "semovani", "family": "haw", "variants": ["OBERHAU"]},
    {"word": "ČEPEL", "category": "mec", "onlyIfNeeded": true}
  ]
}
```

- **Výběr:** přednost mají kategorie z `prefer`. Kategorie s `min`/`max` se hlídají. `onlyIfNeeded` (u kategorie i u slova) se použije, až když přísná pravidla nevyjdou, a generátor to napíše.
- **Rodina** (`family`): dvě slova ze stejné rodiny nejsou nikdy v jedné mřížce. `variants` jsou alternativní pravopisy, použije se náhodně jeden.
- **Opakování napříč mřížkami:** generátor si přečte ostatní osmisměrky v `src-data/` (týmové soubory i sdílené úkoly) a dává přednost slovům, která zatím nepoužil. Po vygenerování vypíše slova, která se opakují, a kde.
- **Cizí slova:** v mřížce se nesmí objevit žádné jiné slovo ze zásobníku (ani pozpátku). Slovo, které je jen částí slova z téže mřížky (ÚTOK v PROTIÚTOK), se vypíše jako info.
- **`--verify`** (i build) zkontroluje:
  - každé slovo je v mřížce právě jednou,
  - zbylá písmena dávají přesně `solution`,
  - podkres leží ve slovech v pořadí čtení,
  - rodiny a kategorie podle `rules` (porušení je chyba, `onlyIfNeeded` jen varování) a slova mimo zásobník (varování).
  Vypíše tajenku, podkres, mřížku (tajenka malými písmeny, podkres v `[ ]`) a opakování slov napříč mřížkami.
- Slabika podkresu se týmu ztratí, pokud ji nezapíšete do `item.text`. Build na to upozorní varováním.
- V klientu tým klepne na začátek a na konec slova (8 směrů, bez tažení), seznam slov se nezobrazuje. Postup se ukládá do `localStorage`. Po nalezení všech slov se zvýrazní zbylá písmena (tajenka) a podkres.

### Příkazy

```
node build.mjs --new-token      náhodný token (použijte i jako sůl)
node build.mjs                  zašifruje src-data/ do docs/data/ a obnoví docs/crypto.js a docs/sw.js
node build.mjs --verify         dešifruje celý řetěz všech týmů pomocí odpovědí ze zdroje
node build.mjs --wordsearch <soubor>  vybere slova a vyrobí mřížku osmisměrky (viz výše)
node build.mjs --wordsearch-all       přegeneruje všechny osmisměrky najednou, slova rozdělí vyváženě
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
