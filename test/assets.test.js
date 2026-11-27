// Unit tests for the shared front-end modules in public/assets (pure helpers + wheel/connection
// behaviour driven with tiny fakes). Run: node --test test/assets.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const load = (name) => import(pathToFileURL(path.join(ASSETS, name)).href);

// Browser-ish globals some modules read at import time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const EPS = 1e-9;

/* ============================================================== wheel math ================= */

test('wheel: restRotation puts every slot centre under the pointer', async () => {
  const w = await load('wheel.js');
  for (let i = 0; i < 12; i++) {
    const r = w.restRotation(i);
    assert.ok(r >= 0 && r < 360, `rest ${r} in [0,360)`);
    assert.equal(w.indexAtRotation(r), i);
    assert.ok(Math.abs(w.offsetFromCentre(r)) < EPS);
    assert.ok(Math.abs(w.angleDiff(r, -i * 30)) < EPS);
  }
});

test('wheel: easeOutQuart shape', async () => {
  const { easeOutQuart } = await load('wheel.js');
  assert.equal(easeOutQuart(0), 0);
  assert.equal(easeOutQuart(1), 1);
  assert.equal(easeOutQuart(0.5), 0.9375);
  assert.equal(easeOutQuart(-1), 0);
  assert.equal(easeOutQuart(2), 1);
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const v = easeOutQuart(t);
    assert.ok(v >= prev, 'monotonic');
    prev = v;
  }
});

test('wheel: spinTarget lands exactly centred on every index from any start, after >= turns full turns', async () => {
  const w = await load('wheel.js');
  const starts = [0, 17.3, 359.999, 1234.5, -45, 720, w.restRotation(5), 1e6 + 0.123];
  for (const from of starts) {
    for (let i = 0; i < 12; i++) {
      for (const turns of [0, 1, 6]) {
        const to = w.spinTarget(from, i, 12, turns);
        const travel = to - from;
        assert.ok(travel >= turns * 360 - EPS && travel < (turns + 1) * 360, `travel ${travel}`);
        assert.equal(w.indexAtRotation(to), i, `from ${from} -> ${i}`);
        assert.ok(Math.abs(w.offsetFromCentre(to)) < 1e-6, `centred (${w.offsetFromCentre(to)})`);
      }
    }
  }
});

test('wheel: planSpin/rotationAt — exact landing for all 12 indices, monotonic motion', async () => {
  const w = await load('wheel.js');
  let from = 0;
  for (let i = 0; i < 12; i++) {
    const plan = w.planSpin({ from, index: i, durationMs: 5000, startedAt: 1000, now: 1000 });
    assert.equal(plan.index, i);
    let prev = -Infinity;
    for (let t = 1000; t < 6000; t += 16.67) {
      const { rotation, done } = w.rotationAt(plan, t);
      assert.equal(done, false);
      assert.ok(rotation >= prev - EPS, 'wheel never runs backwards');
      prev = rotation;
    }
    const end = w.rotationAt(plan, 6000);
    assert.equal(end.done, true);
    assert.equal(end.rotation, w.restRotation(i), 'snaps to the exact rest angle');
    assert.equal(w.indexAtRotation(end.rotation), i);
    assert.equal(w.offsetFromCentre(end.rotation), 0);
    // just before the end it is already within a hair of the centre
    const almost = w.rotationAt(plan, 5999);
    assert.ok(Math.abs(w.angleDiff(almost.rotation, w.restRotation(i))) < 0.01);
    from = end.rotation;
  }
});

test('wheel: late-joining TV (startedAt in the past) is mid-motion and still lands exactly', async () => {
  const w = await load('wheel.js');
  for (let i = 0; i < 12; i++) {
    const now = 50_000;
    const plan = w.planSpin({ from: w.restRotation((i + 5) % 12), index: i, durationMs: 5000, startedAt: now - 2500, now });
    const mid = w.rotationAt(plan, now);
    assert.equal(mid.done, false);
    assert.ok(Math.abs(mid.progress - 0.5) < EPS);
    assert.ok(Math.abs(mid.rotation - (plan.from + (plan.to - plan.from) * 0.9375)) < 1e-6);
    const end = w.rotationAt(plan, now + 2500);
    assert.equal(end.done, true);
    assert.equal(end.rotation, w.restRotation(i));
    // already over before we even joined
    const over = w.planSpin({ from: 0, index: i, durationMs: 5000, startedAt: now - 9000, now });
    assert.deepEqual(w.rotationAt(over, now), { rotation: w.restRotation(i), progress: 1, done: true });
  }
});

test('wheel: before the start the wheel holds still; zero duration lands immediately', async () => {
  const w = await load('wheel.js');
  const plan = w.planSpin({ from: 42, index: 3, durationMs: 5000, startedAt: 10_000, now: 9_000 });
  assert.equal(w.rotationAt(plan, 9_000).rotation, 42);
  const zero = w.planSpin({ from: 42, index: 3, durationMs: 0, now: 0 });
  assert.equal(w.rotationAt(zero, 0).rotation, w.restRotation(3));
});

test('wheel: tickCount increments once per slot boundary', async () => {
  const w = await load('wheel.js');
  assert.equal(w.tickCount(0), -1);
  assert.equal(w.tickCount(14.999), -1);
  assert.equal(w.tickCount(15), 0);
  assert.equal(w.tickCount(44.9), 0);
  assert.equal(w.tickCount(45), 1);
  // a full turn passes exactly 12 boundaries
  assert.equal(w.tickCount(360 + 3) - w.tickCount(3), 12);
  // from rest(2) six turns to rest(7): 6*12 + 5 boundaries
  const from = w.restRotation(2);
  const to = w.spinTarget(from, 7, 12, 6);
  assert.equal(w.tickCount(to) - w.tickCount(from), 72 + w.mod(-(7 - 2) * 30 - 0, 360) / 30);
});

test('wheel: label lines and sizes match the A6 artboard (Big Shoulders 800, 30 px); long words shrink to fit', async () => {
  const w = await load('wheel.js');
  const L = (seg) => w.labelLayout(w.labelLines(seg));
  const two = L({ lines: ['CHRISTMAS', 'TRIVIA'] });
  assert.deepEqual(two.map((l) => l.y), [-226, -194]);
  assert.ok(two[0].size >= 26 && two[0].size <= 30, `CHRISTMAS ~28 (got ${two[0].size})`);
  assert.equal(two[1].size, 30);
  const one = L({ lines: ['DARE'] });
  assert.deepEqual([one[0].y, one[0].size], [-210, 30]);
  const wide = L({ lines: ['SHOWDOWN'] });
  assert.ok(wide[0].size < 30 && wide[0].size >= 18, `SHOWDOWN shrinks (got ${wide[0].size})`);
  for (const l of [...two, ...one, ...wide]) {
    assert.ok(w.labelWidthEm(l.text) * l.size <= w.labelRoom(l.y, l.size) + 0.5, `${l.text} fits its slot`);
  }
  assert.deepEqual(w.labelLines({ label: 'Sound It Out' }), ['SOUND', 'IT OUT']);
  assert.deepEqual(w.labelLines({ label: 'Dare' }), ['DARE']);
  assert.deepEqual(w.labelLines({ label: 'Grinch Steal' }), ['GRINCH', 'STEAL']);
  // the display-face table (Fraunces 900) is wider than the marquee face, for tv.js giant-word fitting
  assert.ok(w.displayWidthEm('DOUBLE DOWN') > w.labelWidthEm('DOUBLE DOWN') * 1.3);
  assert.equal(w.textWidthEm('AB', 'marquee'), w.labelWidthEm('AB'));
});

test('wheel: DEFAULT_SEGMENTS mirror the server wheel (brief A6 fills, inks, trim and candy pattern)', async () => {
  const { DEFAULT_SEGMENTS } = await load('wheel.js');
  const { hasIcon } = await load('icons.js');
  const { SEGMENTS } = require('../src/game.js');
  assert.equal(DEFAULT_SEGMENTS.length, 12);
  const spec = [
    ['Christmas Trivia', '#C8102E', '#FFF7EA', 'tree-pine'], ['Dare', '#F6C453', '#1A1206', 'drama'], ['Pop Culture', '#2450D0', '#FFF7EA', 'clapperboard'],
    ['Hot Seat', '#FF8FB1', '#2A0A18', 'flame'], ['Christmas Movies', '#7E0B22', '#FFF7EA', 'popcorn'], ['Sound It Out', '#7B4CE0', '#FFF7EA', 'music'],
    ['Grinch Steal', '#9BD13B', '#0B1430', 'hand-coins'], ['Showdown', '#5AA9E6', '#0B1430', 'swords'], ['Dare', '#F6C453', '#1A1206', 'drama'],
    ['Rapid List', '#0E7C74', '#FFF7EA', 'list-checks'], ['All Play', '#FF9A3C', '#1A1206', 'zap'], ['Double Down', '#FFF7EA', '#0B1430', 'sparkles'],
  ];
  DEFAULT_SEGMENTS.forEach((s, i) => {
    assert.equal(s.index, i);
    assert.deepEqual([s.label, s.color, s.ink, s.icon], spec[i]);
    const g = SEGMENTS[i];
    assert.deepEqual([s.label, s.color, s.ink, s.icon, s.trim, s.pattern], [g.label, g.color, g.ink, g.icon, g.trim, g.pattern], `slot ${i} matches the server`);
    assert.deepEqual(s.lines, g.lines.map((l) => l.toUpperCase()));
    assert.ok(hasIcon(s.icon));
  });
  assert.equal(DEFAULT_SEGMENTS[4].trim, '#F6C453');
  assert.equal(DEFAULT_SEGMENTS[11].pattern, 'candy');
});

test('wheel: markup has 12 slots, 24 bulbs, hub, pointer and escapes labels', async () => {
  const w = await load('wheel.js');
  const segs = w.DEFAULT_SEGMENTS.map((s) => ({ ...s }));
  segs[3] = { ...segs[3], lines: ['<script>x</script>'], color: 'red;background:url(x)' };
  const m = w.wheelMarkup(segs);
  assert.equal((m.match(/class="wheel__slot"/g) || []).length, 12);
  assert.equal((m.match(/class="wheel__bulb"/g) || []).length, 24);
  assert.equal((m.match(/class="wheel__halo"/g) || []).length, 24);
  assert.ok(m.includes('class="wheel__hub"') && m.includes('class="wheel__pointer"'));
  assert.ok(!m.includes('<script>'));
  assert.ok(m.includes('&lt;SCRIPT&gt;'));
  assert.ok(!m.includes('url(x)'), 'unsafe colours are rejected');
  assert.ok(m.includes(`d="${w.POINTER_PATH}"`), 'gold teardrop pointer');
  assert.ok(m.includes('cy="-352" r="9.5" fill="#C8102E"'), 'cranberry jewel');
  assert.ok(m.includes('class="wheel__rim" r="328"') && m.includes('stroke-width="28"'), '28 px tinsel rim');
  assert.ok(m.includes('class="wheel__bevel" r="345" fill="none" stroke="#C9962E"'), 'brass outer bevel');
  assert.ok(m.includes('class="wheel__gutter" r="311" fill="none" stroke="#0B1430" stroke-width="6"'), '6 px night gutter');
  assert.equal((m.match(/class="wheel__lit wheel__lit--p[012]"/g) || []).length, 3, 'three bulb phase groups');
  for (const k of [0, 1, 2]) {
    const g = m.slice(m.indexOf(`wheel__lit--p${k}"`)).split('</g>')[0];
    assert.equal((g.match(/class="wheel__core"/g) || []).length, 8, `8 bulbs in phase ${k}`);
  }
  const hub = m.slice(m.indexOf('class="wheel__hubicon"')).split('</g>')[0];
  assert.equal((hub.match(/fill="#C8102E"/g) || []).length, 4, '4 cranberry peppermint blades');
  assert.equal((hub.match(/fill="#FFF7EA"/g) || []).length, 4, '4 ivory peppermint blades');
  // landed state: 45% dim + desaturate on the other slots, 4 px ivory outline on the winner
  assert.ok(m.includes('class="wheel__dim"') && m.includes('fill-opacity=".55"') && m.includes('mix-blend-mode:saturation'));
  assert.ok(m.includes('class="wheel__outline"') && m.includes('stroke="#FFF7EA" stroke-width="4"'));
  // the default wheel: candy-cane stripes + ivory pill on Double Down, gold trim arc on Christmas Movies
  const d = w.wheelMarkup(w.DEFAULT_SEGMENTS, { id: 't1' });
  assert.ok(d.includes('<pattern id="t1-cane11"') && d.includes('fill="url(#t1-cane11)"'), 'candy pattern fill');
  assert.equal((d.match(/class="wheel__pill"/g) || []).length, 1, 'ivory label pill on the candy slot only');
  assert.ok(/stroke="#F6C453" stroke-width="4" stroke-linecap="round"/.test(d), 'gold inner arc on the trimmed slot');
  assert.ok(d.includes('fill="url(#t1-velvet)"'), 'velvet folds on the trimmed slot');
  // ids are unique per wheel so two wheels on one page never share gradients
  const idOf = (x) => x.match(/id="(ccw\d+)-rim"/)[1];
  assert.notEqual(idOf(w.wheelMarkup()), idOf(w.wheelMarkup()));
  const evil = w.wheelMarkup(segs.map((x, i) => (i === 2 ? { ...x, trim: 'url(x)', pattern: 'candy', stripe: 'javascript:x' } : x)));
  assert.ok(!evil.includes('javascript') && !evil.includes('url(x)'), 'trim/stripe are sanitised');
  const mini = w.miniWheelMarkup();
  assert.ok(mini.startsWith('<svg class="mini-wheel"'));
});

test('wheel: chase rate follows the wheel speed', async () => {
  const w = await load('wheel.js');
  assert.ok(w.chaseRate(1) > w.chaseRate(0.5) && w.chaseRate(0.5) > w.chaseRate(0));
  assert.ok(w.chaseRate(0) > 0, 'never fully stops while spinning');
  assert.equal(w.chaseRate(5), w.chaseRate(1));
  assert.equal(w.HIT_STOP_MS, 150);
});

/* ============================================================== live wheel (fake DOM + clock) */

class FakeEl {
  constructor() {
    this.attrs = {};
    this.dataset = {};
    this.children = {};
    this.lists = {};
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ?? !cls.has(c) ? cls.add(c) : cls.delete(c)) };
    this._html = '';
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  set innerHTML(v) {
    this._html = v;
    this.children = {};
    this.lists = {};
  }
  get innerHTML() {
    return this._html;
  }
  querySelector(sel) {
    return (this.children[sel] ||= new FakeEl());
  }
  querySelectorAll(sel) {
    if (sel === '.wheel__bulb' || sel === '.wheel__halo') return (this.lists[sel] ||= Array.from({ length: 24 }, () => new FakeEl()));
    return [];
  }
}

function fakeTime(t) {
  const saved = { now: Date.now, perf: Object.getOwnPropertyDescriptor(globalThis, 'performance'), raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  let clock = 1_000_000;
  let perf = 0;
  let queue = [];
  let id = 0;
  Date.now = () => clock;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => perf }, configurable: true, writable: true });
  globalThis.requestAnimationFrame = (cb) => {
    queue.push({ id: ++id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (x) => {
    queue = queue.filter((q) => q.id !== x);
  };
  t.after(() => {
    Date.now = saved.now;
    if (saved.perf) Object.defineProperty(globalThis, 'performance', saved.perf);
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
  });
  return {
    get now() {
      return clock;
    },
    pending: () => queue.length,
    /** move the clocks without running animation frames (a hidden/throttled tab) */
    advance(ms) {
      clock += ms;
      perf += ms;
    },
    /** advance one frame of `ms` and run the queued callbacks */
    step(ms = 1000 / 60) {
      clock += ms;
      perf += ms;
      const q = queue;
      queue = [];
      for (const { cb } of q) cb(perf);
    },
  };
}

test('wheel: createWheel.spinTo lands exactly on all 12 indices and ticks once per boundary', async (t) => {
  const w = await load('wheel.js');
  const time = fakeTime(t);
  const svg = new FakeEl();
  const wheel = w.createWheel(svg, w.DEFAULT_SEGMENTS, { reducedMotion: false });
  t.after(() => wheel.destroy());
  assert.equal(svg.getAttribute('viewBox'), '-380 -380 760 760');
  for (const i of [7, 0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11]) {
    const from = wheel.rotation;
    const expectedTicks = w.tickCount(w.spinTarget(from, i, 12, 6)) - w.tickCount(from);
    let ticks = 0;
    let done = null;
    const p = wheel.spinTo(i, 5000, { onTick: () => ticks++, onDone: (x) => (done = x) });
    assert.equal(wheel.spinning, true);
    let frames = 0;
    while (time.pending() && frames < 2000) {
      time.step();
      frames++;
    }
    assert.equal(await p, true);
    assert.equal(done, i);
    assert.ok(frames >= 299 && frames <= 302, `about 5 s of frames (${frames})`);
    assert.equal(wheel.rotation, w.restRotation(i));
    assert.equal(wheel.index, i);
    assert.equal(w.offsetFromCentre(wheel.rotation), 0);
    assert.equal(ticks, expectedTicks, `ticks for ${i}`);
    assert.equal(svg.querySelector('.wheel__rotor').getAttribute('transform'), `rotate(${w.restRotation(i)})`);
    assert.equal(svg.querySelector('.wheel__hl').getAttribute('opacity'), '1', 'winner highlighted');
    assert.match(svg.getAttribute('aria-label'), /landed on/);
  }
});

test('wheel: a late-joining TV syncs to startedAt (and clockOffset) and lands on time', async (t) => {
  const w = await load('wheel.js');
  const time = fakeTime(t);
  const wheel = w.createWheel(new FakeEl(), w.DEFAULT_SEGMENTS, { reducedMotion: false });
  t.after(() => wheel.destroy());
  for (let i = 0; i < 12; i++) {
    // server clock is 10 s ahead of this TV; the spin started 2.5 s ago (server time)
    const offset = 10_000;
    const startedAt = time.now + offset - 2500;
    let frames = 0;
    const p = wheel.spinTo(i, 5000, { startedAt, clockOffset: offset });
    while (time.pending() && frames < 1000) {
      time.step();
      frames++;
    }
    assert.equal(await p, true);
    assert.ok(frames >= 149 && frames <= 152, `remaining 2.5 s only (${frames} frames)`);
    assert.equal(wheel.rotation, w.restRotation(i));
  }
  // spin already finished before the TV loaded: rest immediately, no ticks
  let ticks = 0;
  const done = await wheel.spinTo(4, 5000, { startedAt: time.now - 8000, onTick: () => ticks++ });
  assert.equal(done, true);
  assert.equal(ticks, 0);
  assert.equal(wheel.rotation, w.restRotation(4));
  assert.equal(time.pending(), 0);
});

test('wheel: restOn cancels a running spin (stale spin never lands); highlight/idle are safe', async (t) => {
  const w = await load('wheel.js');
  const time = fakeTime(t);
  const svg = new FakeEl();
  const wheel = w.createWheel(svg, w.DEFAULT_SEGMENTS, { reducedMotion: false });
  t.after(() => wheel.destroy());
  let landed = false;
  const p = wheel.spinTo(9, 5000, { onDone: () => (landed = true) });
  for (let k = 0; k < 60; k++) time.step();
  wheel.restOn(2);
  for (let k = 0; k < 400; k++) time.step();
  assert.equal(await p, false);
  assert.equal(landed, false);
  assert.equal(wheel.rotation, w.restRotation(2));
  assert.equal(svg.querySelector('.wheel__hl').getAttribute('opacity'), '0');
  wheel.highlight(5);
  assert.equal(svg.querySelector('.wheel__hl').getAttribute('transform'), 'rotate(150)');
  wheel.highlight(null);
  assert.equal(svg.querySelector('.wheel__hl').getAttribute('opacity'), '0');
  wheel.restOn(undefined); // ignored
  wheel.restOn(26); // wraps
  assert.equal(wheel.index, 2);
  wheel.idle(true);
  assert.equal(svg.dataset.bulbs, 'chase');
  wheel.idle(false);
  assert.equal(svg.dataset.bulbs, 'rest');
});

test('wheel: in a hidden tab (no frames) the safety timer still lands once, and a late frame cannot land twice', async (t) => {
  const w = await load('wheel.js');
  const time = fakeTime(t);
  const wheel = w.createWheel(new FakeEl(), w.DEFAULT_SEGMENTS, { reducedMotion: false });
  t.after(() => wheel.destroy());
  let done = 0;
  const p = wheel.spinTo(6, 40, { onDone: () => done++ });
  time.advance(60); // the tab was hidden: no rAF ran, but time passed
  assert.equal(await p, true); // resolved by the real setTimeout fallback
  assert.equal(done, 1);
  time.step(); // a stale queued frame runs when the tab comes back
  time.step();
  assert.equal(done, 1, 'onDone fires exactly once');
  assert.equal(wheel.rotation, w.restRotation(6));
});

test('wheel: bulbs chase with the spin, freeze lit for the 150 ms hit-stop, flash 3x, then stay lit', async (t) => {
  const w = await load('wheel.js');
  const time = fakeTime(t);
  const svg = new FakeEl();
  const wheel = w.createWheel(svg, w.DEFAULT_SEGMENTS, { reducedMotion: false });
  t.after(() => wheel.destroy());
  assert.equal(svg.dataset.bulbs, 'rest');
  wheel.idle(true);
  assert.equal(svg.dataset.bulbs, 'chase', 'idle = CSS chase');
  const phases = new Set();
  const p = wheel.spinTo(3, 2000);
  assert.equal(svg.dataset.bulbs, 'spin');
  let early = 0;
  let late = 0;
  let last = svg.dataset.phase;
  for (let k = 0; k < 130 && time.pending(); k++) {
    time.step();
    phases.add(svg.dataset.phase);
    if (svg.dataset.phase !== last) {
      if (k < 40) early++;
      else if (k > 80) late++;
    }
    last = svg.dataset.phase;
  }
  assert.deepEqual([...phases].sort(), ['0', '1', '2'], 'all three phases light up during the spin');
  assert.ok(early > late, `the chase is faster at the start than near the stop (${early} vs ${late})`);
  assert.equal(await p, true);
  assert.equal(svg.dataset.bulbs, 'lit', 'hit-stop: bulbs freeze lit');
  await new Promise((r) => setTimeout(r, w.HIT_STOP_MS + 40));
  assert.equal(svg.dataset.bulbs, 'blink', 'then flash');
  await new Promise((r) => setTimeout(r, w.FLASH_MS + 80));
  assert.equal(svg.dataset.bulbs, 'lit', 'then stay lit while landed');
  // a restOn during the hit-stop cancels the pending flash
  const q = wheel.spinTo(1, 50);
  for (let k = 0; k < 10 && time.pending(); k++) time.step();
  assert.equal(await q, true);
  wheel.restOn(5);
  await new Promise((r) => setTimeout(r, w.HIT_STOP_MS + 40));
  assert.equal(svg.dataset.bulbs, 'rest', 'restOn cancels the pending flash');
});

/* ============================================================== client.js ================== */

test('client: esc escapes every HTML-significant character', async () => {
  const { esc } = await load('client.js');
  assert.equal(esc(`<img src=x onerror="a('b')">&\``), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;&#96;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
});

test('client: h`` escapes interpolations, composes, and trusts only raw()/icon output', async () => {
  const { h, raw, isRaw } = await load('client.js');
  const { icon, teamDisc } = await load('icons.js');
  assert.equal(String(h`<p>${'<b>x</b>'}</p>`), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.equal(String(h`<a title="${'" onmouseover="x'}">`), '<a title="&quot; onmouseover=&quot;x">');
  assert.equal(String(h`<ul>${['a', '<b>'].map((x) => h`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(String(h`${raw('<i>ok</i>')}`), '<i>ok</i>');
  assert.equal(String(h`[${null}${undefined}${false}${0}]`), '[0]');
  assert.ok(isRaw(h`x`));
  assert.equal('' + h`a${1}b`, 'a1b');
  const star = icon('star', { size: 20 });
  assert.equal(String(h`${star}`), star, 'icon() output is trusted');
  const d = teamDisc({ color: '#FF5A4E', mascot: 'star', name: '<Evil>' }, { label: true });
  assert.equal(String(h`${d}`), d);
  assert.ok(d.includes('&lt;Evil&gt;'));
  const forged = '<svg class="icon" onload="alert(1)"></svg>';
  assert.equal(String(h`${forged}`), '&lt;svg class=&quot;icon&quot; onload=&quot;alert(1)&quot;&gt;&lt;/svg&gt;');
});

test('client: number and text formatting', async () => {
  const c = await load('client.js');
  assert.equal(c.formatPoints(1150), '1,150');
  assert.equal(c.formatPoints(0), '0');
  assert.equal(c.formatPoints(999.6), '1,000');
  assert.equal(c.formatPoints(1234567), '1,234,567');
  assert.equal(c.formatPoints(-50), '−50');
  assert.equal(c.formatPoints('abc'), '0');
  assert.equal(c.formatDelta(300), '+300');
  assert.equal(c.formatDelta(-100), '−100');
  assert.equal(c.formatDelta(1500), '+1,500');
  assert.equal(c.formatDelta(0), '0');
  assert.equal(c.plural(1, 'player'), '1 player');
  assert.equal(c.plural(3, 'player'), '3 players');
  assert.equal(c.plural(0, 'person', 'people'), '0 people');
  assert.equal(c.possessive('Team Rudolph'), 'Team Rudolph’s');
  assert.equal(c.possessive('The Grinches'), 'The Grinches’');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(c.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  assert.equal(c.listJoin(['Aunt Linda', 'Sam', 'Max']), 'Aunt Linda, Sam or Max');
  assert.equal(c.listJoin(['A', 'B'], 'and'), 'A and B');
});

test('client: timer math and ring markup', async () => {
  const c = await load('client.js');
  const now = 100_000;
  const run = (ms, total = 20_000) => ({ running: true, endsAt: now + ms, durationMs: total, remainingMs: total });
  assert.equal(c.timerRemaining(null, now), 0);
  assert.equal(c.timerRemaining(run(18_000), now), 18_000);
  assert.equal(c.timerRemaining(run(-500), now), 0);
  assert.equal(c.timerRemaining({ running: false, remainingMs: 9000, durationMs: 20_000 }, now), 9000);
  assert.equal(c.timerText(run(18_200), now), '19');
  assert.equal(c.timerText(run(65_000, 90_000), now), '1:05');
  assert.equal(c.timerText(run(0), now), '0');
  assert.equal(c.timerFraction(run(10_000), now), 0.5);
  assert.equal(c.timerWarn(run(5000), now), true);
  assert.equal(c.timerWarn(run(5001), now), false);
  assert.equal(c.timerWarn(run(0), now), false);
  const ring = String(c.timerRing(run(10_000), now));
  assert.ok(ring.includes('stroke-dasharray="339.3"'));
  assert.ok(ring.includes('stroke-dashoffset="169.6"'), 'half drained');
  assert.ok(ring.includes('>10<') && ring.includes('SECONDS'));
  assert.ok(!ring.includes('is-warn'));
  assert.ok(String(c.timerRing(run(3000), now)).includes('is-warn'), 'red under 5 s');
  assert.ok(String(c.timerRing({ running: false, remainingMs: 4000, durationMs: 20_000 }, now)).includes('PAUSED'));
  assert.ok(String(c.timerRing(run(3000), now, { size: 72 })).includes('timer-ring--compact'));
  assert.ok(ring.includes('class="timer-ring__head"') && ring.includes('rotate(180.0deg)'), 'a glowing bulb rides the end of the arc');
});

test('client: getClientId is persistent and never uses crypto.randomUUID', async (t) => {
  const c = await load('client.js');
  store.clear();
  if (globalThis.crypto?.randomUUID) t.mock.method(globalThis.crypto, 'randomUUID', () => assert.fail('randomUUID must not be used'));
  const a = c.getClientId();
  assert.match(a, /^c_[a-z0-9]{16}$/);
  assert.equal(c.getClientId(), a);
  assert.equal(store.get('cc.clientId'), a);
  store.set('cc.clientId', 'bad id with spaces');
  const b = c.getClientId();
  assert.notEqual(b, 'bad id with spaces');
  const ids = new Set(Array.from({ length: 500 }, () => c.randomId(16)));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[a-z0-9]{16}$/);
});

test('client: clock offset uses the least-delayed sample', async () => {
  const { createClock } = await load('client.js');
  const clk = createClock(3);
  clk.sample(1100, 1000); // +100
  clk.sample(1050, 1000); // +50 (delayed)
  assert.equal(clk.offset, 100);
  clk.sample(2120, 2000); // +120
  assert.equal(clk.offset, 120);
  clk.sample(3010, 3000);
  clk.sample(4010, 4000);
  clk.sample(5010, 5000); // window of 3 forgets the old ones
  assert.equal(clk.offset, 10);
  assert.equal(clk.sample('nope'), 10);
});

class FakeSocket {
  constructor() {
    this.handlers = {};
    this.connected = false;
    this.sent = [];
    this.responder = () => ({ ok: true });
  }
  on(ev, fn) {
    (this.handlers[ev] ||= []).push(fn);
  }
  fire(ev, ...args) {
    if (ev === 'connect') this.connected = true;
    if (ev === 'disconnect') this.connected = false;
    for (const fn of this.handlers[ev] || []) fn(...args);
  }
  timeout(ms) {
    return {
      emit: (ev, payload, cb) => {
        this.sent.push({ ev, payload });
        const res = this.responder(ev, payload);
        if (res === undefined) setTimeout(() => cb(new Error('timeout')), ms);
        else queueMicrotask(() => cb(null, res));
      },
    };
  }
  close() {
    this.closed = true;
  }
}

test('client: connect() sends hello on every (re)connect, tracks the clock, routes state/fx, acks', async () => {
  const c = await load('client.js');
  store.clear();
  const sock = new FakeSocket();
  let pin = '4821';
  sock.responder = (ev) => (ev === 'hello' ? { ok: true, isHost: true, me: null } : ev === 'slow' ? undefined : { ok: true, echoed: ev });
  const client = c.connect('host', { io: () => sock, hostKey: () => pin, ackTimeout: 30 });
  await client.ready;
  assert.equal(client.connected, false);

  sock.fire('connect');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sock.sent[0], { ev: 'hello', payload: { role: 'host', clientId: client.clientId, hostKey: '4821' } });
  assert.equal(client.isHost, true);
  assert.equal(client.connected, true);

  // reconnect: a NEW hello with the same clientId (and the latest PIN)
  sock.fire('disconnect');
  assert.equal(client.connected, false);
  assert.deepEqual(await client.emit('host:undo'), { ok: false, error: 'offline' }, 'no stale buffered actions while offline');
  pin = '1234';
  sock.fire('connect');
  await new Promise((r) => setImmediate(r));
  const hellos = sock.sent.filter((s) => s.ev === 'hello');
  assert.equal(hellos.length, 2);
  assert.equal(hellos[1].payload.clientId, client.clientId);
  assert.equal(hellos[1].payload.hostKey, '1234');

  // state + clock
  const seen = [];
  client.onState((s) => seen.push(s.phase));
  sock.fire('state', { now: Date.now() + 5000, phase: 'lobby' });
  assert.deepEqual(seen, ['lobby']);
  assert.ok(Math.abs(client.clockOffset - 5000) < 50);
  assert.ok(Math.abs(client.serverNow() - (Date.now() + 5000)) < 50);
  const late = [];
  client.onState((s) => late.push(s.phase)); // gets the latest state immediately
  assert.deepEqual(late, ['lobby']);
  sock.fire('state', null); // ignored

  // fx in both shapes
  const fx = [];
  client.onFx((type, payload) => fx.push([type, payload]));
  sock.fire('fx', { type: 'spinStart', segmentIndex: 3, startedAt: 1, durationMs: 5000 });
  sock.fire('fx', 'buzz', { teamId: 't2', name: 'Priya' });
  sock.fire('fx', { nope: true });
  assert.deepEqual(fx, [
    ['spinStart', { segmentIndex: 3, startedAt: 1, durationMs: 5000 }],
    ['buzz', { teamId: 't2', name: 'Priya' }],
  ]);

  // acks
  assert.deepEqual(await client.emit('spin'), { ok: true, echoed: 'spin' });
  assert.deepEqual(await client.emit('slow'), { ok: false, error: 'timeout' });
  client.close();
  assert.equal(sock.closed, true);
});

test('client: player connect without hostKey omits it from hello', async () => {
  const c = await load('client.js');
  const sock = new FakeSocket();
  const client = c.connect('player', { io: () => sock });
  await client.ready;
  sock.fire('connect');
  assert.deepEqual(Object.keys(sock.sent[0].payload).sort(), ['clientId', 'role']);
  client.close();
});

test('client: DOM helpers are safe without a DOM', async () => {
  const c = await load('client.js');
  assert.equal(c.vibrate(50), false);
  assert.equal(c.reducedMotion(), false);
  const wl = c.wakeLock();
  assert.equal(wl.active, false);
  wl.release();
  assert.equal(typeof c.toast('hi'), 'function');
  c.showBanner('x', 'y');
  c.hideBanner('x');
  assert.equal(c.qs('div'), null);
  const dare = String(c.slotChip({ label: 'Dare', color: '#F6C453', ink: '#1A1206', icon: 'drama' }));
  assert.ok(dare.includes('--chip-bg:#F6C453') && dare.startsWith('<span class="chip"'));
  assert.ok(String(c.slotChip({ label: 'Pop Culture', color: '#2450D0', ink: '#FFF7EA', icon: 'clapperboard' })).includes('chip--rimmed'), 'royal gets a tinsel rim');
  assert.ok(!String(c.slotChip({ label: 'Christmas Trivia', color: '#C8102E', ink: '#FFF7EA', icon: 'tree-pine' })).includes('chip--rimmed'), 'cranberry pops on navy');
  assert.ok(String(c.slotChip({ label: 'Christmas Movies', color: '#7E0B22', ink: '#FFF7EA', icon: 'popcorn', trim: '#F6C453' }, { size: 'sm' })).includes('chip chip--sm chip--rimmed chip--velvet'));
  assert.ok(String(c.slotChip({ label: 'Double Down', color: '#FFF7EA', ink: '#0B1430', icon: 'sparkles', pattern: 'candy' })).includes('chip--candy'));
  assert.deepEqual(['#7E0B22', '#2450D0', '#7B4CE0', '#0E7C74', '#C8102E', '#F6C453', '#FF8FB1', '#9BD13B'].map(c.isDarkSlot), [true, true, true, true, false, false, false, false]);
  assert.ok(String(c.turnDots(2, 6)).includes('aria-label="Turn 3 of 6"'));
  const secret = String(c.secretCard({ label: 'Your movie', value: '<b>Home Alone</b>' }));
  assert.ok(secret.includes('&lt;b&gt;Home Alone&lt;/b&gt;'));
  assert.ok(secret.includes('data-secret-card'));
});

/* ============================================================== icons.js =================== */

const REQUIRED_ICONS = `tree-pine drama clapperboard flame music hand-coins swords list-checks zap sparkles snowflake star bell gift
candy-cane cookie moon crown trophy timer users qr-code mic check x undo-2 play pause skip-forward eye eye-off lock wifi wifi-off
volume-2 volume-x dices rotate-cw plus minus settings hand thumbs-up hand-metal party-popper chevron-right arrow-right trash-2 pencil
maximize monitor smartphone crosshair shuffle alarm-clock-plus arrow-down arrow-up arrow-right-left award bell-ring brain circle-check
coins external-link film flag gavel heart hourglass keyboard laptop lightbulb mic-off mountain-snow music-2 pointer refresh-cw
rotate-ccw smile sparkle tv popcorn projector ticket tickets train-front lamp armchair`.split(/\s+/);

test('icons: every icon used in SPEC and the artboards exists as Lucide inner SVG', async () => {
  const { ICONS, hasIcon } = await load('icons.js');
  for (const n of REQUIRED_ICONS) assert.ok(hasIcon(n), `missing icon ${n}`);
  for (const [n, inner] of Object.entries(ICONS)) {
    assert.match(inner, /^<(path|circle|line|rect|polyline|polygon|ellipse)\b/, n);
    assert.ok(!/script|on\w+=/i.test(inner), n);
  }
  // spot-check exact Lucide geometry (matches the artboards)
  assert.equal(ICONS['tree-pine'], '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3"/>');
});

test('icons: icon() options, accessibility and sanitising', async () => {
  const { icon } = await load('icons.js');
  const a = icon('crown', { size: 32, stroke: 2.4, color: '#FFC93C' });
  assert.ok(a.startsWith('<svg class="icon icon-crown"'));
  assert.ok(a.includes('width="32" height="32"') && a.includes('style="width:2rem;height:2rem"'));
  assert.ok(a.includes('stroke="#FFC93C"') && a.includes('stroke-width="2.4"'));
  assert.ok(a.includes('aria-hidden="true"') && !a.includes('role="img"'));
  const b = icon('crown', { label: 'Leader "<1>"' });
  assert.ok(b.includes('role="img" aria-label="Leader &quot;&lt;1&gt;&quot;"') && !b.includes('aria-hidden'));
  const c = icon('star', { color: 'red" onload="x', stroke: 99, size: 'calc(1px)' });
  assert.ok(c.includes('stroke="currentColor"') && c.includes('stroke-width="4"') && !c.includes('onload'));
  assert.ok(icon('no-such-icon').includes('icon-circle-help'));
  assert.ok(icon('star', { size: '1.5em' }).includes('style="width:1.5em;height:1.5em"'));
});

test('icons: MASCOTS are the 8 brief-A7 colour/mascot pairs (same as the server); teamDisc renders an ornament', async () => {
  const { MASCOTS, mascotFor, teamDisc } = await load('icons.js');
  const server = require('../src/game.js').MASCOTS;
  assert.deepEqual(
    MASCOTS.map((m) => [m.color, m.icon]),
    [['#FF5F6D', 'candy-cane'], ['#F6C453', 'star'], ['#6CB8FF', 'snowflake'], ['#5FE0C1', 'tree-pine'], ['#FF8AD0', 'gift'], ['#DCE3F2', 'moon'], ['#FF9A3C', 'cookie'], ['#B794FF', 'bell']]
  );
  assert.deepEqual(MASCOTS.map((m) => [m.id, m.color, m.colorName.toLowerCase()]), server.map((m) => [m.mascot, m.color, m.colorName]), 'client and server agree');
  assert.equal(mascotFor('bell').color, '#B794FF');
  assert.equal(mascotFor('Sky').icon, 'snowflake');
  assert.equal(mascotFor(4).id, 'gift');
  assert.equal(mascotFor('???').id, 'candy-cane');
  const d = teamDisc({ color: '#5FE0C1', mascot: 'tree-pine', name: 'The Grinches' }, { size: 'md', label: true });
  assert.ok(d.includes('--team-color:#5FE0C1;--disc-size:4rem'));
  assert.ok(d.startsWith('<span class="disc" '), 'plain disc by default');
  assert.ok(d.includes('icon-tree-pine') && d.includes('stroke="var(--night)"'));
  assert.ok(d.includes('aria-label="The Grinches mascot: a Christmas tree"'));
  assert.ok(teamDisc({ color: 'javascript:x', mascot: 'moon' }).includes('--team-color:#DCE3F2'), 'bad colour -> mascot colour');
  assert.ok(teamDisc({ mascot: 'star' }).includes('aria-hidden="true"'));
  assert.ok(teamDisc({ mascot: 'star' }, { ornament: true }).startsWith('<span class="disc disc--ornament"'));
  assert.ok(teamDisc({ mascot: 'star' }, { leader: true, beacon: true, halo: true }).startsWith('<span class="disc disc--halo disc--ornament disc--leader disc--beacon"'));
});

/* ============================================================== sound.js =================== */

test('sound: every effect is a safe no-op before unlock; volume/mute clamp and persist', async () => {
  store.clear();
  const s = await load('sound.js');
  assert.equal(s.isUnlocked(), false);
  for (const fn of ['tick', 'land', 'buzz', 'correct', 'wrong', 'beep', 'fanfare', 'applause', 'whoosh', 'leaderBeep', 'plugIn', 'dingLock', 'doubleDown', 'podium', 'sleighBells', 'steam']) {
    assert.doesNotThrow(() => s[fn](), fn);
  }
  assert.equal(typeof s.drumroll(1000), 'function');
  assert.equal(typeof s.ambience(), 'function', 'ambience() returns stop()');
  for (const name of ['leaderBeep', 'plugIn', 'dingLock', 'doubleDown', 'podium', 'sleighBells', 'steam']) assert.equal(typeof s.EFFECTS[name], 'function', name);
  assert.doesNotThrow(() => s.play('correct'));
  assert.equal(s.play('nope'), undefined);
  assert.equal(await s.unlock(), false, 'no Web Audio in node');
  assert.equal(s.setVolume(2), 1);
  assert.equal(s.setVolume(-1), 0);
  assert.equal(s.setVolume('x'), 0.8);
  assert.equal(s.setVolume(0.5), 0.5);
  assert.equal(store.get('cc.volume'), '0.5');
  const events = [];
  const off = s.onChange((e) => events.push(e));
  assert.equal(s.setMuted(true), true);
  assert.equal(store.get('cc.muted'), 'true');
  assert.equal(s.toggleMute(), false);
  off();
  s.toggleMute();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { volume: 0.5, muted: true, unlocked: false });
});

/* ============================================================== sky.js ===================== */

test('sky: snow lanes skip the reading column; markup helpers count, phase and escape', async () => {
  const sky = await load('sky.js');
  assert.deepEqual(sky.freeLanes([[0, 100]], [[40, 70]]), [[0, 40], [70, 100]]);
  assert.deepEqual(sky.freeLanes([[0, 100]], [[-5, 10], [95, 120]]), [[10, 95]]);
  assert.deepEqual(sky.freeLanes([[0, 30], [60, 100]], [[20, 70]]), [[0, 20], [70, 100]]);
  assert.deepEqual(sky.freeLanes([[0, 100]], [[0, 100]]), []);
  const bs = sky.bulbString({ count: 16 });
  assert.equal((bs.match(/class="bulb-string__bulb p[012]"/g) || []).length, 16);
  assert.equal((bs.match(/bulb-string__bulb p0/g) || []).length, 6);
  assert.ok(bs.includes('aria-hidden="true"') && bs.includes('vector-effect="non-scaling-stroke"'));
  assert.ok(sky.bulbString({ className: 'x" onload="y' }).includes('x&quot; onload=&quot;y'));
  const mq = sky.marqueeBulbs();
  assert.equal((mq.match(/<i class="p[012]"/g) || []).length, 28, '28 chasing bulbs (10 + 4 + 10 + 4)');
  assert.ok(mq.includes('--x:0%;--y:0%') && mq.includes('--x:100%;--y:100%'));
  const lb = sky.letterboard('Team <Rudolph>');
  assert.ok(lb.includes('<span class="sr-only">Team &lt;Rudolph&gt;</span>'));
  assert.equal((lb.match(/class="letterboard__char"/g) || []).length, 13);
  assert.ok(lb.includes('style="--i:12"') && !lb.includes('<Rudolph>'));
  const stars = sky.starfieldMarkup({ count: 12, twinkle: 2 });
  assert.equal((stars.match(/<svg /g) || []).length, 12);
  assert.equal((stars.match(/class="is-twinkle"/g) || []).length, 2);
  assert.equal(sky.snowfall(null).el, null, 'no container: safe no-op');
  assert.equal(sky.snowfall({}).el, null, 'no DOM: safe no-op');
  assert.equal(sky.starfield({}), null);
  const a = sky.rng(7);
  const b = sky.rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()], 'deterministic layouts');
});
