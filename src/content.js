'use strict';
/**
 * Load + validate data/*.json. Invalid items are dropped (and reported in `problems`), so the game never
 * crashes on a bad content edit. Any file that matches the schema below can be dropped in.
 *
 * Schemas (arrays of objects):
 *   trivia-christmas.json / trivia-popculture.json / trivia-movies.json
 *     {id, category:'christmas'|'popculture'|'movies', difficulty:'easy'|'medium'|'hard', question, answer, accept?:[], hint?, funFact?,
 *      topic?, decade?, movie? (movies: the film's title, shown on the TV as a sub-chip — so the answer must not be in it),
 *      year?, kind? ('quote'|'who-said-it'|'fact'|...)}
 *   songs.json      {id, title, accept?:[], artist, era?, difficulty?, hint?}
 *   lists.json      {id, prompt, answers:[>=3], note?}
 *   dares.json      {id, title, who:'one'|'pair'|'team'|'everyone', instructions, secret:null|{label, options:[>=1]}, time, props:[], judge, tags:[]}
 *   finals.json     {id, category, question, answer, accept?:[], difficulty?}
 *   showdowns.json  {id, title, instructions, time, props:[], winner, tags:[]}
 */
const fs = require('fs');
const path = require('path');
const { containsAnswer, normalize } = require('./match');

const FILES = {
  'trivia-christmas.json': 'trivia',
  'trivia-popculture.json': 'trivia',
  'trivia-movies.json': 'trivia',
  'songs.json': 'songs',
  'lists.json': 'lists',
  'dares.json': 'dares',
  'finals.json': 'finals',
  'showdowns.json': 'showdowns',
};

/** Minimum counts for a full 8-team game without running dry too fast. */
const MIN_COUNTS = {
  'trivia:christmas': 9, 'trivia:popculture': 9, 'trivia:movies': 9, // and >= 3 per difficulty
  songs: 6, lists: 6, dares: 8, finals: 2, showdowns: 6,
};

const DIFFS = ['easy', 'medium', 'hard'];
const TRIVIA_CATEGORIES = ['christmas', 'popculture', 'movies'];
const WHO = ['one', 'pair', 'team', 'everyone'];

const isStr = (v, min = 1, max = 2000) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);
const optStr = (v) => v === undefined || v === null || typeof v === 'string';

function validateItem(kind, it) {
  const e = [];
  if (!it || typeof it !== 'object' || Array.isArray(it)) return ['not an object'];
  if (!isStr(it.id, 1, 80)) e.push('id must be a non-empty string');
  switch (kind) {
    case 'trivia':
      if (!TRIVIA_CATEGORIES.includes(it.category)) e.push('category must be christmas|popculture|movies');
      if (!DIFFS.includes(it.difficulty)) e.push('difficulty must be easy|medium|hard');
      if (!isStr(it.question, 5)) e.push('question required');
      if (!isStr(it.answer, 1, 200)) e.push('answer required');
      if (it.accept !== undefined && !isStrArr(it.accept)) e.push('accept must be an array of strings');
      if (!optStr(it.hint)) e.push('hint must be a string');
      if (!optStr(it.funFact)) e.push('funFact must be a string');
      if (!optStr(it.movie) || (typeof it.movie === 'string' && it.movie.length > 120)) e.push('movie must be a string (<= 120 chars)');
      if (isStr(it.question) && isStr(it.answer) && containsAnswer(it.question, it.answer)) e.push('answer text appears in the question');
      if (isStr(it.movie) && isStr(it.answer) && containsAnswer(it.movie, it.answer)) e.push('answer text appears in the movie title (the TV shows it)');
      break;
    case 'songs':
      if (!isStr(it.title, 1, 200)) e.push('title required');
      if (it.accept !== undefined && !isStrArr(it.accept)) e.push('accept must be an array of strings');
      if (!optStr(it.artist)) e.push('artist must be a string');
      if (!optStr(it.hint)) e.push('hint must be a string');
      if (it.difficulty !== undefined && !DIFFS.includes(it.difficulty)) e.push('difficulty must be easy|medium|hard');
      break;
    case 'lists':
      if (!isStr(it.prompt, 5)) e.push('prompt required');
      if (!isStrArr(it.answers) || it.answers.length < 3) e.push('answers must be an array of >= 3 strings');
      else if (new Set(it.answers.map((a) => normalize(a))).size !== it.answers.length) e.push('duplicate answers');
      if (!optStr(it.note)) e.push('note must be a string');
      break;
    case 'dares':
      if (!isStr(it.title, 1, 120)) e.push('title required');
      if (!WHO.includes(it.who)) e.push('who must be one|pair|team|everyone');
      if (!isStr(it.instructions, 5)) e.push('instructions required');
      if (it.secret !== null && it.secret !== undefined) {
        if (typeof it.secret !== 'object' || !isStr(it.secret.label) || !isStrArr(it.secret.options) || !it.secret.options.length) e.push('secret must be null or {label, options:[...]}');
      }
      if (!Number.isInteger(it.time) || it.time < 5 || it.time > 300) e.push('time must be an integer 5..300 (seconds)');
      if (!isStrArr(it.props || [])) e.push('props must be an array of strings');
      if (!isStr(it.judge)) e.push('judge required');
      if (it.tags !== undefined && !isStrArr(it.tags)) e.push('tags must be an array of strings');
      break;
    case 'finals':
      if (!isStr(it.category, 1, 60)) e.push('category required');
      if (!isStr(it.question, 5)) e.push('question required');
      if (!isStr(it.answer, 1, 200)) e.push('answer required');
      if (it.accept !== undefined && !isStrArr(it.accept)) e.push('accept must be an array of strings');
      if (isStr(it.question) && isStr(it.answer) && containsAnswer(it.question, it.answer)) e.push('answer text appears in the question');
      break;
    case 'showdowns':
      if (!isStr(it.title, 1, 120)) e.push('title required');
      if (!isStr(it.instructions, 5)) e.push('instructions required');
      if (!Number.isInteger(it.time) || it.time < 5 || it.time > 300) e.push('time must be an integer 5..300 (seconds)');
      if (!isStrArr(it.props || [])) e.push('props must be an array of strings');
      if (!isStr(it.winner)) e.push('winner required');
      if (it.tags !== undefined && !isStrArr(it.tags)) e.push('tags must be an array of strings');
      break;
    default:
      e.push('unknown kind ' + kind);
  }
  return e;
}

function clean(kind, it) {
  const base = { ...it, id: String(it.id).trim() };
  if (kind === 'trivia' || kind === 'finals' || kind === 'songs') base.accept = Array.isArray(it.accept) ? it.accept.slice() : [];
  if (kind === 'trivia') {
    base.hint = it.hint || ''; base.funFact = it.funFact || '';
    // "Elf (2003)" -> movie "Elf", year 2003 (the TV chip shows the title, the year separately)
    let movie = typeof it.movie === 'string' ? it.movie.trim() : '';
    let year = Number.isInteger(it.year) ? it.year : null;
    const m = /^(.*\S)\s*\((\d{4})\)$/.exec(movie);
    if (m) { movie = m[1]; if (year == null) year = Number(m[2]); }
    base.movie = movie; base.year = year;
  }
  if (kind === 'songs') { base.hint = it.hint || ''; base.artist = it.artist || ''; }
  if (kind === 'dares') { base.props = it.props || []; base.tags = it.tags || []; base.secret = it.secret || null; }
  if (kind === 'showdowns') { base.props = it.props || []; base.tags = it.tags || []; }
  return base;
}

/** Built-in fallbacks so a missing/broken file never crashes a turn. */
const FALLBACK = {
  trivia: [
    { id: 'fb-xc-e', category: 'christmas', difficulty: 'easy', question: 'What colour is Rudolph\u2019s famous nose?', answer: 'Red', accept: [], hint: '', funFact: '' },
    { id: 'fb-xc-m', category: 'christmas', difficulty: 'medium', question: 'How many reindeer pull Santa\u2019s sleigh in the poem, not counting Rudolph?', answer: 'Eight', accept: ['8'], hint: '', funFact: '' },
    { id: 'fb-xc-h', category: 'christmas', difficulty: 'hard', question: 'In which country did the tradition of the Christmas tree begin?', answer: 'Germany', accept: [], hint: '', funFact: '' },
    { id: 'fb-pc-e', category: 'popculture', difficulty: 'easy', question: 'Which yellow cartoon family lives in Springfield?', answer: 'The Simpsons', accept: ['Simpsons'], hint: '', funFact: '' },
    { id: 'fb-pc-m', category: 'popculture', difficulty: 'medium', question: 'Which band sang \u201CLast Christmas\u201D in 1984?', answer: 'Wham!', accept: ['Wham'], hint: '', funFact: '' },
    { id: 'fb-pc-h', category: 'popculture', difficulty: 'hard', question: 'Which film won the first ever Academy Award for Best Animated Feature?', answer: 'Shrek', accept: [], hint: '', funFact: '' },
  ],
  songs: [{ id: 'fb-song', title: 'Jingle Bells', accept: [], artist: 'James Lord Pierpont', hint: '' }],
  lists: [{ id: 'fb-list', prompt: 'Name Santa\u2019s reindeer', answers: ['Dasher', 'Dancer', 'Prancer', 'Vixen', 'Comet', 'Cupid', 'Donner', 'Blitzen', 'Rudolph'], note: '' }],
  dares: [{ id: 'fb-dare', title: 'Santa Laugh', who: 'one', instructions: 'Do your best, longest Santa laugh for the room.', secret: null, time: 20, props: [], judge: 'The room is laughing too.', tags: [] }],
  finals: [{ id: 'fb-final', category: 'christmas', question: 'In which modern-day country was Saint Nicholas born?', answer: 'Turkey', accept: ['T\u00FCrkiye', 'Turkiye'] }],
  showdowns: [{ id: 'fb-show', title: 'Longest Santa Laugh', instructions: 'Both players laugh like Santa. Longest unbroken "Ho ho ho" wins.', time: 30, props: [], winner: 'Last one still laughing wins.', tags: [] }],
};

function loadContent(dir) {
  const content = { trivia: [], songs: [], lists: [], dares: [], finals: [], showdowns: [] };
  const problems = [];
  const seen = new Map();
  for (const [file, kind] of Object.entries(FILES)) {
    const fp = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (err) {
      problems.push({ file, id: null, error: err.code === 'ENOENT' ? 'file missing' : 'invalid JSON: ' + err.message });
      continue;
    }
    if (!Array.isArray(data)) { problems.push({ file, id: null, error: 'top level must be an array' }); continue; }
    for (const it of data) {
      const errs = validateItem(kind, it);
      const id = it && typeof it.id === 'string' ? it.id : null;
      if (id && seen.has(id)) errs.push('duplicate id (also in ' + seen.get(id) + ')');
      if (errs.length) { for (const error of errs) problems.push({ file, id, error }); continue; }
      seen.set(id, file);
      content[kind].push(clean(kind, it));
    }
  }
  // counts (a missing movies file is reported once; the game then uses Christmas questions about movies)
  for (const cat of TRIVIA_CATEGORIES) {
    const file = 'trivia-' + cat + '.json';
    const items = content.trivia.filter((q) => q.category === cat);
    if (!items.length && problems.some((p) => p.file === file && !p.id)) continue;
    if (items.length < MIN_COUNTS['trivia:' + cat]) problems.push({ file, id: null, error: `only ${items.length} valid questions (need ${MIN_COUNTS['trivia:' + cat]})` });
    for (const d of DIFFS) {
      const n = items.filter((q) => q.difficulty === d).length;
      if (n < 3) problems.push({ file, id: null, error: `only ${n} ${d} questions (need 3)` });
    }
  }
  for (const k of ['songs', 'lists', 'dares', 'finals', 'showdowns']) {
    if (content[k].length < MIN_COUNTS[k]) problems.push({ file: k + '.json', id: null, error: `only ${content[k].length} valid items (need ${MIN_COUNTS[k]})` });
  }
  // fill empty pools with fallbacks
  for (const k of Object.keys(content)) if (!content[k].length) content[k] = FALLBACK[k].map((x) => ({ ...x }));
  for (const cat of ['christmas', 'popculture']) for (const d of DIFFS) {
    if (!content.trivia.some((q) => q.category === cat && q.difficulty === d)) content.trivia.push(...FALLBACK.trivia.filter((q) => q.category === cat && q.difficulty === d));
  }
  return { ...content, problems };
}

const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
/** Hot Seat / All Play / round bonus pool: easy+medium trivia with short (<= 4 words) answers. */
const isQuickQuestion = (q) => (q.difficulty === 'easy' || q.difficulty === 'medium') && wordCount(q.answer) <= 4;

/**
 * Draw one item from `pool` that is not in `used` (a Set of ids). When the pool is exhausted, its ids are
 * released (only that pool), so content repeats only after everything in it has been seen.
 */
function drawFrom(pool, used, rng, exclude = []) {
  if (!pool.length) return null;
  const ex = new Set(exclude);
  let avail = pool.filter((x) => !used.has(x.id) && !ex.has(x.id));
  if (!avail.length) {
    for (const x of pool) used.delete(x.id);
    avail = pool.filter((x) => !ex.has(x.id));
    if (!avail.length) avail = pool;
  }
  const item = avail[Math.min(avail.length - 1, Math.floor(rng() * avail.length))];
  used.add(item.id);
  return item;
}

/**
 * The trivia pool for one wheel category + difficulty. Christmas Movies falls back to Christmas questions tagged
 * topic 'movies' (then any Christmas question) when data/trivia-movies.json is missing or thin.
 */
function triviaPool(trivia, category, difficulty) {
  let pool = trivia.filter((q) => q.category === category && q.difficulty === difficulty);
  if (!pool.length && category === 'movies') {
    pool = trivia.filter((q) => q.category === 'christmas' && q.topic === 'movies' && q.difficulty === difficulty);
    if (!pool.length) pool = trivia.filter((q) => q.category === 'christmas' && q.difficulty === difficulty);
  }
  if (!pool.length) pool = trivia.filter((q) => q.difficulty === difficulty);
  if (!pool.length) pool = trivia;
  return pool;
}

function contentStats(content, used) {
  const s = {};
  const add = (key, pool) => { s[key] = { total: pool.length, left: pool.filter((x) => !used.has(x.id)).length }; };
  for (const cat of TRIVIA_CATEGORIES) for (const d of DIFFS) add(`${cat}-${d}`, triviaPool(content.trivia, cat, d));
  add('quick', content.trivia.filter(isQuickQuestion));
  for (const k of ['songs', 'lists', 'dares', 'finals', 'showdowns']) add(k, content[k]);
  return s;
}

module.exports = { loadContent, validateItem, drawFrom, isQuickQuestion, contentStats, triviaPool, FILES, MIN_COUNTS, FALLBACK, TRIVIA_CATEGORIES };
