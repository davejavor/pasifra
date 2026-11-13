// Sdílený kód pro build (Node) i prohlížeč. build.mjs ho kopíruje do docs/crypto.js.
// Používá jen WebCrypto (globalThis.crypto), nic z Node API.

export const DEFAULT_ITER = 200000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

const SPECIAL = { ł: 'l', ø: 'o', đ: 'd', æ: 'ae', œ: 'oe', ß: 'ss' };

// "Karel IV." -> "kareliv"
export function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[łøđæœß]/g, (c) => SPECIAL[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Název datového souboru týmu: prvních 16 hex znaků SHA-256 tokenu.
export async function fileId(token) {
  const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(token)));
  return [...h.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// secret: "token:<token>" pro meta a úkol 1; další klíče řetězí deriveNext.
// slot: "meta" | číslo úkolu | "finale" – oddělí klíče různých částí i při shodné odpovědi.
export function secretFromToken(token) {
  return 'token:' + token;
}
export async function deriveKey(secret, salt, slot, iter = DEFAULT_ITER) {
  const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: iter, salt: enc.encode(`${salt}:${slot}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Klíč dalšího úkolu = PBKDF2(normalizovaná odpověď + předchozí klíč, sůl:slot).
export async function deriveNext(prevKey, answer, salt, slot, iter = DEFAULT_ITER) {
  return deriveKey(`ans:${normalize(answer)}|key:${await exportKey(prevKey)}`, salt, slot, iter);
}

// Pro uložení odvozených klíčů v localStorage.
export async function exportKey(key) {
  return b64encode(new Uint8Array(await subtle.exportKey('raw', key)));
}
export function importKey(b64) {
  return subtle.importKey('raw', b64decode(b64), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function encrypt(key, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

// Vrátí objekt, nebo null, když klíč nesedí (selhal GCM tag).
export async function decrypt(key, blob) {
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64decode(blob.iv) }, key, b64decode(blob.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// Volnější odpověď („obsahuje slovo“). accept = { lens: [délky klíčových slov], wraps: [obálky] }.
// Každá obálka je kanonická odpověď zašifrovaná klíčem z jednoho klíčového slova.
// Zkouší se všechny úseky zadaného textu v uložených délkách. Vrací { key, got } nebo null.
export async function unlockNext(prevKey, raw, accept, salt, slot, nextBlob, iter = DEFAULT_ITER) {
  if (!accept) {
    const key = await deriveNext(prevKey, raw, salt, slot, iter);
    const got = await decrypt(key, nextBlob);
    return got ? { key, got } : null;
  }
  const n = normalize(raw).slice(0, 80);
  const seen = new Set();
  for (const len of accept.lens) {
    for (let i = 0; i + len <= n.length; i++) {
      const sub = n.slice(i, i + len);
      if (seen.has(sub)) continue;
      seen.add(sub);
      const alt = await deriveNext(prevKey, sub, salt, `${slot}:alt`, iter);
      for (const w of accept.wraps) {
        const inner = await decrypt(alt, w);
        if (!inner) continue;
        const key = await deriveNext(prevKey, inner.a, salt, slot, iter);
        const got = await decrypt(key, nextBlob);
        if (got) return { key, got };
      }
    }
  }
  return null;
}

export async function makeAccept(prevKey, keywords, canonical, salt, slot, iter = DEFAULT_ITER) {
  const kws = [...new Set(keywords.map(normalize))];
  const wraps = [];
  for (const kw of kws) wraps.push(await encrypt(await deriveNext(prevKey, kw, salt, `${slot}:alt`, iter), { a: normalize(canonical) }));
  return { lens: [...new Set(kws.map((k) => k.length))].sort((a, b) => b - a), wraps };
}
