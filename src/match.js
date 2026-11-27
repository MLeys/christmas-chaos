'use strict';
/**
 * Typed-answer matching: case / punctuation / accent / leading-article insensitive,
 * number words = digits, small typos tolerated (never on numbers), "paris france" accepts "Paris".
 */

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100',
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
};
const ABBREV = { saint: 'st', mister: 'mr', mount: 'mt', doctor: 'dr' };
const ARTICLES = new Set(['the', 'a', 'an']);

function normalize(input) {
  let s = String(input == null ? '' : input);
  s = s.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
  s = s.replace(/[\u2018\u2019\u201B`\u00B4]/g, "'").replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/(\d)[,.](?=\d{3}\b)/g, '$1'); // 25,000 -> 25000
  s = s.replace(/&/g, ' and ').replace(/'/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return '';
  const tokens = s.split(' ').map((w) => NUMBER_WORDS[w] || ABBREV[w] || w);
  while (tokens.length > 1 && ARTICLES.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // transposition (Damerau)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function allowedTypos(len) {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  if (len <= 14) return 2;
  return 3;
}

const digitsOf = (s) => (s.match(/\d+/g) || []).join(' ');
const phonetic = (s) => s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/([a-z])\1+/g, '$1');

/** Variants of one official answer string ("Donner (or Donder)" -> also "Donner"). */
function variants(answer) {
  const out = new Set();
  const raw = String(answer == null ? '' : answer);
  const n = normalize(raw);
  if (n) out.add(n);
  const stripped = normalize(raw.replace(/\([^)]*\)/g, ' '));
  if (stripped) out.add(stripped);
  for (const part of raw.split(/\s\/\s|\//)) { const p = normalize(part); if (p) out.add(p); }
  return [...out];
}

function matchOne(t, c) {
  if (!t || !c) return false;
  if (t === c) return true;
  const tn = t.replace(/ /g, ''), cn = c.replace(/ /g, '');
  if (tn === cn) return true;
  const td = digitsOf(t), cd = digitsOf(c);
  if (td || cd) {
    if (td !== cd) return false;
  }
  // typo tolerance (on a lightly "phonetic" form: ph=f, ck=k, doubled letters collapsed)
  if (levenshtein(tn, cn) <= allowedTypos(cn.length)) return true;
  if (levenshtein(phonetic(tn), phonetic(cn)) <= allowedTypos(cn.length)) return true;
  // containment: "paris france" / "kevin mccallister" for "paris" / "kevin" \u2014 at most 2 extra words
  const tt = t.split(' '), ct = c.split(' ');
  if (cn.length >= 3 && tt.length > ct.length && tt.length - ct.length <= 2) {
    for (let i = 0; i + ct.length <= tt.length; i++) {
      let ok = true;
      for (let j = 0; j < ct.length; j++) {
        const a = tt[i + j], b = ct[j];
        if (a !== b && levenshtein(a, b) > allowedTypos(b.length)) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}

/** Does the typed text match the answer or any accepted alternative? */
function isMatch(text, answer, accept = []) {
  const t = normalize(text);
  if (!t) return false;
  const cands = [];
  for (const a of [answer, ...(Array.isArray(accept) ? accept : [])]) cands.push(...variants(a));
  return cands.some((c) => matchOne(t, c));
}

const POSSESSIVE = new RegExp("['\\u2019]s(?![a-z])", 'gi');
/** True if the (normalized) answer appears as whole words inside the question ("Rudolph's" counts). Content validator. */
function containsAnswer(question, answer) {
  const a = normalize(answer);
  if (a.replace(/ /g, '').length < 3) return false;
  const q = normalize(String(question).replace(POSSESSIVE, ''));
  return (' ' + q + ' ').includes(' ' + a + ' ');
}

module.exports = { normalize, levenshtein, isMatch, containsAnswer, variants };
