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

test('wheel: radial labels (Bagel Fat One 25, rim inward, like the TV concept) fit their slot; long words shrink', async () => {
  const w = await load('wheel.js');
  const L = (seg) => w.labelLayout(w.labelLines(seg));
  const two = L({ lines: ['Christmas', 'Trivia'] });
  assert.deepEqual(two.map((l) => l.offset), [-13, 15], 'two lines either side of the slot centre line');
  assert.deepEqual(two.map((l) => l.size), [25, 25]);
  assert.ok(two.every((l) => l.start === w.LABEL_START && w.LABEL_START === 222), 'labels start just inside the art (r=222)');
  const one = L({ lines: ['Dare'] });
  assert.deepEqual([one[0].offset, one[0].size], [1, 25]);
  const wide = L({ lines: ['Supercalifragilistic'] });
  assert.ok(wide[0].size < 25 && wide[0].size >= 12, `long words shrink (got ${wide[0].size})`);
  for (const l of [...two, ...one, ...wide]) {
    assert.ok(w.labelWidthEm(l.text) * l.size <= w.labelRoom(l.offset, l.size) + 0.5, `${l.text} fits its slot`);
  }
  // every label on the real wheel fits at the full 25 px, and never runs into the hub
  for (const seg of w.DEFAULT_SEGMENTS) {
    for (const l of L(seg)) {
      assert.equal(l.size, 25, `${l.text} at full size`);
      assert.ok(l.start - w.labelWidthEm(l.text) * l.size >= 72, `${l.text} clears the hub`);
    }
  }
  assert.deepEqual(w.labelLines({ label: 'Sound It Out' }), ['Sound', 'It Out'], 'sentence case is kept');
  assert.deepEqual(w.labelLines({ label: 'Dare' }), ['Dare']);
  assert.deepEqual(w.labelLines({ label: 'Grinch Steal' }), ['Grinch', 'Steal']);
  // Bagel Fat One metrics (measured in Edge): "Christmas" is ~4.85 em; display + label faces are the same font
  assert.ok(Math.abs(w.displayWidthEm('Christmas') - 4.85) < 0.06, `Christmas = ${w.displayWidthEm('Christmas')} em`);
  assert.ok(w.displayWidthEm('DOUBLE DOWN') > w.displayWidthEm('Double Down'), 'capitals are wider');
  assert.equal(w.textWidthEm('AB', 'display'), w.labelWidthEm('AB'));
});

test('wheel: DEFAULT_SEGMENTS mirror the server wheel (the TV concept fills, inks, 3D art and candy pattern)', async () => {
  const { DEFAULT_SEGMENTS } = await load('wheel.js');
  const { hasIcon, hasArt } = await load('icons.js');
  const { SEGMENTS } = require('../src/game.js');
  assert.equal(DEFAULT_SEGMENTS.length, 12);
  const W = '#FFFFFF';
  const I = '#1C2333';
  const spec = [
    ['Christmas Trivia', '#D42A2A', W, 'tree'], ['Dare', '#EDB321', I, 'masks'], ['Pop Culture', '#2E6FD1', W, 'clapper'],
    ['Hot Seat', '#E9558A', W, 'fire'], ['Christmas Movies', '#9E1B32', W, 'popcorn'], ['Sound It Out', '#7B4BC9', W, 'music'],
    ['Grinch Steal', '#7CB518', I, 'money'], ['Showdown', '#8ECAE6', I, 'boxing'], ['Dare', '#EDB321', I, 'masks'],
    ['Rapid List', '#1F7A4A', W, 'list'], ['All Play', '#F28C28', I, 'zap'], ['Double Down', W, I, 'sparkles'],
  ];
  DEFAULT_SEGMENTS.forEach((s, i) => {
    assert.equal(s.index, i);
    assert.deepEqual([s.label, s.color, s.ink, s.art], spec[i]);
    const g = SEGMENTS[i];
    assert.deepEqual([s.label, s.color, s.ink, s.icon, s.art, s.pattern, s.stripe], [g.label, g.color, g.ink, g.icon, g.art, g.pattern, g.stripe], `slot ${i} matches the server`);
    assert.deepEqual(s.lines, g.lines);
    assert.ok(hasIcon(s.icon), `Lucide fallback ${s.icon}`);
    assert.ok(hasArt(s.art), `3D art ${s.art}`);
  });
  assert.equal(DEFAULT_SEGMENTS[4].trim, undefined);
  assert.equal(DEFAULT_SEGMENTS[11].pattern, 'candy');
  assert.equal(DEFAULT_SEGMENTS[11].stripe, '#D42A2A');
});

test('wheel: markup is the candy-cane wheel (rim, gutter, 3D art, radial labels, hub with Santa, star pointer) and escapes', async () => {
  const w = await load('wheel.js');
  const segs = w.DEFAULT_SEGMENTS.map((s) => ({ ...s }));
  segs[3] = { ...segs[3], lines: ['<script>x</script>'], color: 'red;background:url(x)' };
  segs[5] = { ...segs[5], art: '../../secret' };
  const m = w.wheelMarkup(segs);
  assert.equal((m.match(/class="wheel__slot"/g) || []).length, 12);
  assert.equal((m.match(/class="wheel__art"/g) || []).length, 11, 'one 3D art image per slot (unknown art falls back)');
  assert.equal((m.match(/class="wheel__icon"/g) || []).length, 1, '…to the Lucide glyph');
  assert.ok(!m.includes('secret'), 'art ids are whitelisted');
  assert.ok(m.includes('href="/assets/art/tree.png" x="-27" y="-288" width="54" height="54"'), 'art near the rim');
  assert.equal((m.match(/class="wheel__label" transform="rotate\(90\)" x="-222"/g) || []).length, 21, 'radial labels from the rim inward');
  assert.ok(/font-family="'Bagel Fat One'/.test(m), 'Bagel Fat One labels');
  assert.ok(!m.includes('<script>'));
  assert.ok(m.includes('&lt;script&gt;'));
  assert.ok(!m.includes('url(x)'), 'unsafe colours are rejected');
  // candy-cane rim, white gutter, white seams between slots
  assert.ok(/<circle class="wheel__rim" r="334" fill="url\(#ccw\d+-rim\)"\/>/.test(m), 'candy-cane rim');
  assert.ok(/<pattern id="ccw\d+-rim" width="34" height="34" patternUnits="userSpaceOnUse" patternTransform="rotate\(30\)"><rect width="34" height="34" fill="#FFFFFF"\/><rect width="14" height="34" fill="#D42A2A"\/>/.test(m), 'red on white stripes');
  assert.ok(m.includes('class="wheel__gutter" r="308" fill="#FFFFFF"'), 'white gutter');
  assert.equal((m.match(/class="wheel__face"[^>]*stroke="#FFFFFF" stroke-width="4"/g) || []).length, 12, 'white seams');
  // hub + pointer
  assert.ok(m.includes('class="wheel__hub"') && m.includes('class="wheel__santa" href="/assets/art/santa.png"'), 'peppermint hub with Santa');
  assert.ok(/class="wheel__hubicon" transform="rotate\(0\)"><circle r="54" fill="url\(#ccw\d+-mint\)"/.test(m), 'peppermint stripes turn with the wheel');
  assert.ok(m.includes('class="wheel__pointer"') && m.includes(`d="${w.POINTER_PATH}"`), 'gold star pointer');
  assert.ok(m.includes('class="wheel__star" href="/assets/art/star.png"'), '3D star art');
  assert.ok(!m.includes('wheel__bulb'), 'the garland is the light show now');
  // stopped state: others wash out (opacity .82 over white + desaturate), winner gets a white outline
  assert.ok(m.includes('class="wheel__dim"') && m.includes('fill="#FFFFFF" fill-opacity=".18"') && m.includes('mix-blend-mode:saturation'));
  assert.ok(m.includes('class="wheel__outline"') && /class="wheel__outline"[^>]*stroke="#FFFFFF" stroke-width="8"/.test(m));
  // the default wheel: candy stripes + one white label pill on Double Down only
  const d = w.wheelMarkup(w.DEFAULT_SEGMENTS, { id: 't1' });
  assert.ok(d.includes('<pattern id="t1-cane11"') && d.includes('fill="url(#t1-cane11)"'), 'candy pattern fill');
  assert.equal((d.match(/class="wheel__pill"/g) || []).length, 1, 'white label pill on the candy slot only');
  assert.ok(/class="wheel__pill"[^>]*fill="#FFFFFF"/.test(d));
  assert.ok(!/fill="#D42A2A" stroke="#FFFFFF" stroke-width="4"[^>]*\/><image class="wheel__art" href="\/assets\/art\/sparkles/.test(d), 'Double Down is striped, not flat red');
  // ids are unique per wheel so two wheels on one page never share patterns
  const idOf = (x) => x.match(/id="(ccw\d+)-rim"/)[1];
  assert.notEqual(idOf(w.wheelMarkup()), idOf(w.wheelMarkup()));
  const evil = w.wheelMarkup(segs.map((x, i) => (i === 2 ? { ...x, pattern: 'candy', stripe: 'javascript:x' } : x)));
  assert.ok(!evil.includes('javascript'), 'stripe is sanitised');
  const mini = w.miniWheelMarkup();
  assert.ok(mini.startsWith('<svg class="mini-wheel"') && mini.includes('fill="#EDB321"'), 'mini wheel with a gold star');
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

test('wheel: tease ending (pure) creeps into the slot before, hangs at the peg, then lands EXACTLY on every index', async () => {
  const w = await load('wheel.js');
  const starts = [0, 17.3, w.restRotation(5), 1234.5];
  for (const from of starts) {
    for (let i = 0; i < 12; i++) {
      const plain = w.planSpin({ from, index: i, durationMs: 5000, startedAt: 0, now: 0 });
      const plan = w.planSpin({ from, index: i, durationMs: 5000, startedAt: 0, now: 0, tease: true });
      assert.equal(plan.tease, true);
      assert.equal(plan.to, plain.to, 'same target as a normal spin');
      let prev = -Infinity;
      for (let t = 0; t < 5000; t += 5) {
        const { rotation, done } = w.rotationAt(plan, t);
        assert.equal(done, false);
        assert.ok(rotation >= prev - 1e-9, 'never runs backwards');
        prev = rotation;
      }
      // the stop and the hang both show the slot BEFORE the winner, right up to the peg
      const stop = w.rotationAt(plan, 5000 * w.TEASE.stopAt).rotation;
      const hang = w.rotationAt(plan, 5000 * w.TEASE.hangAt).rotation;
      assert.equal(w.indexAtRotation(stop), (i + 1) % 12, 'stops in the slot before');
      assert.equal(w.indexAtRotation(hang), (i + 1) % 12, 'hangs on the peg');
      assert.ok(Math.abs(w.offsetFromCentre(hang)) > 14, 'right against the boundary');
      const end = w.rotationAt(plan, 5000);
      assert.equal(end.done, true);
      assert.equal(end.rotation, w.restRotation(i), 'then settles exactly');
      assert.equal(w.offsetFromCentre(end.rotation), 0);
      assert.ok(Math.abs(w.angleDiff(w.rotationAt(plan, 4999).rotation, w.restRotation(i))) < 0.05);
    }
  }
  assert.equal(w.planSpin({ from: 0, index: 11, turns: 0, tease: true }).tease, false, 'no tease on a tiny nudge');
  const plan = w.planSpin({ from: 0, index: 3, durationMs: 5000, tease: true });
  assert.ok(w.speedAt(plan, 0.1) > w.speedAt(plan, 0.85), 'slow creep near the end');
});

test('wheel: spinTo({tease:true}) lands exactly with the same ticks; the lights follow every mode and phase', async (t) => {
  const w = await load('wheel.js');
  const time = fakeTime(t);
  const svg = new FakeEl();
  const calls = [];
  const lights = { mode: (m) => calls.push(['mode', m]), phase: (p) => calls.push(['phase', p]) };
  const wheel = w.createWheel(svg, w.DEFAULT_SEGMENTS, { reducedMotion: false, lights });
  t.after(() => wheel.destroy());
  assert.deepEqual(calls[0], ['mode', 'twinkle'], 'resting wheel = twinkling lights');
  for (const i of [3, 11, 0]) {
    const from = wheel.rotation;
    const expectedTicks = w.tickCount(w.spinTarget(from, i, 12, 6)) - w.tickCount(from);
    let ticks = 0;
    let teasing = false;
    const p = wheel.spinTo(i, 5000, { tease: true, onTick: () => ticks++ });
    let frames = 0;
    while (time.pending() && frames < 2000) {
      time.step();
      frames++;
      teasing ||= svg.classList.contains('is-teasing');
    }
    assert.equal(await p, true);
    assert.equal(wheel.rotation, w.restRotation(i), `tease lands exactly on ${i}`);
    assert.equal(ticks, expectedTicks, 'one tick per boundary, the tip-over included');
    assert.ok(teasing, '.is-teasing during the creep');
    assert.equal(svg.classList.contains('is-teasing'), false, 'cleared on landing');
  }
  const modes = calls.filter((c) => c[0] === 'mode').map((c) => c[1]);
  assert.ok(modes.includes('spin') && modes.includes('lit'), `lights: ${modes.join(',')}`);
  assert.ok(new Set(calls.filter((c) => c[0] === 'phase').map((c) => c[1])).size === 3, 'lights chase through 3 phases');
  await new Promise((r) => setTimeout(r, w.HIT_STOP_MS + 40));
  assert.equal(calls.filter((c) => c[0] === 'mode').pop()[1], 'flash', 'lights flash after the hit-stop');
  const extra = [];
  const detach = wheel.attachLights({ mode: (m) => extra.push(m) });
  assert.deepEqual(extra, ['flash'], 'a late garland picks up the current mode');
  detach();
  wheel.idle(true);
  assert.deepEqual(extra, ['flash'], 'detached');
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
  const { mascotImg, artImg } = await load('icons.js');
  const m = mascotImg({ mascot: 'deer', name: '<Evil>' }, 40);
  assert.equal(String(h`${m}`), m, 'mascotImg() output is trusted');
  assert.ok(m.includes('alt="&lt;Evil&gt;"'));
  const a = artImg('popcorn');
  assert.equal(String(h`${a}`), a, 'artImg() output is trusted');
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
  assert.ok(ring.includes('>10<') && ring.includes('>seconds<'), 'sentence-case unit');
  assert.ok(ring.includes('class="timer-ring__cap"') && ring.includes('class="timer-ring__loop"'), 'ornament: gold cap + loop');
  assert.ok(!ring.includes('is-warn'));
  assert.ok(String(c.timerRing(run(3000), now)).includes('is-warn'), 'fast pulse under 5 s');
  assert.ok(String(c.timerRing({ running: false, remainingMs: 4000, durationMs: 20_000 }, now)).includes('>Paused<'));
  assert.ok(String(c.timerRing(run(3000), now, { size: 72 })).includes('timer-ring--compact'));
  assert.ok(String(c.timerRing(run(3000), now, { tone: 'holly' })).includes('timer-ring--holly'));
  assert.ok(String(c.timerRing(run(10_000), now, { size: 150 })).includes('--ring-size:9.375rem'), 'TV concept size');
  assert.ok(ring.includes('class="timer-ring__head"') && ring.includes('rotate(180.0deg)'), 'a glint rides the end of the arc');
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
  // category chip = slot colour + slot ink + the 3D slot art (TV concept)
  const movies = String(c.slotChip({ label: 'Christmas Movies', color: '#9E1B32', ink: '#FFFFFF', icon: 'popcorn', art: 'popcorn' }));
  assert.ok(movies.startsWith('<span class="chip chip--cat" style="--chip-bg:#9E1B32;--chip-ink:#FFFFFF">'));
  assert.ok(movies.includes('src="/assets/art/popcorn.png" width="40" height="40"') && movies.endsWith('Christmas Movies</span>'));
  assert.ok(String(c.slotChip({ label: 'Dare', color: '#EDB321', ink: '#1C2333', type: 'dare' }, { size: 'sm' })).includes('chip chip--cat chip--sm" style="--chip-bg:#EDB321;--chip-ink:#1C2333"><img class="art" src="/assets/art/masks.png" width="26"'), 'art by type when the segment has none');
  assert.ok(String(c.slotChip({ label: 'Double Down', color: '#FFFFFF', ink: '#1C2333', art: 'sparkles', pattern: 'candy' })).includes('chip--candy'));
  assert.ok(String(c.slotChip({ label: 'X', color: 'url(x)', ink: '#fff', icon: 'zap', art: '../../x' })).includes('icon-zap') , 'unknown art falls back to the Lucide icon');
  assert.ok(!String(c.slotChip({ label: 'X', color: 'url(x)', ink: '#fff', icon: 'zap' })).includes('url(x)'));
  assert.equal(c.slotArtId({ category: 'movies', type: 'trivia' }), 'popcorn');
  assert.equal(c.slotArtId({ type: 'grinch' }), 'money');
  assert.ok(String(c.slotArt({ art: 'zap' }, { size: 54 })).includes('src="/assets/art/zap.png"'));
  // score tag: name on top, mascot + Bagel score; active = Up now; leader = glowing star
  const tag = String(c.scoreTag({ id: 't3', name: '<b>Team Rudolph</b>', mascot: 'deer', color: '#D42A2A', score: 1150 }, { active: true, leader: true, badge: '×2' }));
  assert.ok(tag.startsWith('<div class="score-tag is-active" style="--team:#D42A2A" data-team="t3">'));
  assert.ok(tag.includes('<span class="up-now score-tag__upnow">Up now</span>') && tag.includes('glowing-star.png') && tag.includes('alt="Leader"'));
  assert.ok(tag.includes('src="/assets/art/deer.png"') && tag.includes('&lt;b&gt;Team Rudolph&lt;/b&gt;') && tag.includes('>1,150</span>') && tag.includes('score-tag__badge'));
  assert.ok(!String(c.scoreTag({ name: 'A', mascot: 'tree', score: 5 })).includes('up-now'), 'only the active team is up');
  // phone buttons
  const mint = String(c.peppermint({ spinning: true, attrs: c.raw('data-spin') }));
  assert.ok(mint.startsWith('<button type="button" class="peppermint is-spinning" aria-label="Spin the wheel" aria-disabled="false" data-spin>'));
  assert.ok(mint.includes('<span class="peppermint__word">Spin</span>'));
  const armed = String(c.ornamentBuzz());
  assert.ok(armed.startsWith('<button type="button" class="ornament-btn is-armed" aria-label="Buzz in"') && armed.includes('>Buzz</span>') && armed.includes('ornament-btn__cap'));
  assert.ok(String(c.ornamentBuzz({ state: 'first' })).includes('is-first') && String(c.ornamentBuzz({ state: 'first' })).includes('You’re first!'));
  const other = String(c.ornamentBuzz({ state: 'other', name: '<Elf Help>' }));
  assert.ok(other.startsWith('<div class="ornament-btn is-other" role="img"') && other.includes('&lt;Elf Help&gt;'));
  assert.ok(String(c.ornamentBuzz({ state: 'locked' })).includes('icon-lock'));
  // presents, stockings, meters, Santa's list
  const gift = String(c.present({ size: 'lg', label: 'Hard', points: 300, inside: 'popcorn', button: true, state: 'unwrapping' }));
  assert.ok(gift.startsWith('<button type="button" class="present present--lg is-unwrapping"') && gift.includes('present__lid') && gift.includes('present__bow') && gift.includes('<b>300</b>'));
  assert.ok(String(c.present({ color: 'url(x)' })).includes('--present:#D42A2A'), 'colours are sanitised');
  assert.ok(String(c.stocking({ team: { mascot: 'snowman', color: '#F28C28' } })).includes('src="/assets/art/snowman.png"'), 'mascot peeks out of the stocking');
  assert.ok(String(c.stocking({ state: 'coal' })).includes('is-coal') && String(c.stocking({ state: 'full' })).includes('icon-check'));
  const meter = String(c.bellMeter({ label: 'Nailed it', count: 7, fill: 0.625 }));
  assert.ok(meter.includes('bell-meter--holly') && meter.includes('--fill:0.625') && meter.includes('aria-valuenow="63"') && meter.includes('bell.png'));
  const list = String(c.santaList({ items: ['Dasher', { text: 'Dancer', done: true }, { text: '', done: false }], total: 6 }));
  assert.ok(list.includes('2 of 6') && (list.match(/<li class="is-done">/g) || []).length === 2 && (list.match(/<li class="is-empty">/g) || []).length === 4);
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

test('icons: MASCOTS are the 8 North Pole 3D mascots (same as the server); teamDisc renders the 3D art; ART is whitelisted', async () => {
  const { MASCOTS, mascotFor, teamDisc, mascotImg, artImg, artSrc, hasArt, ART } = await load('icons.js');
  const server = require('../src/game.js').MASCOTS;
  assert.deepEqual(
    MASCOTS.map((m) => [m.id, m.color]),
    [['deer', '#D42A2A'], ['tree', '#1F7A4A'], ['bell', '#EDB321'], ['gift', '#2E6FD1'], ['santa', '#7B4BC9'], ['snowman', '#F28C28'], ['cookie', '#E9558A'], ['star', '#0F8C8C']]
  );
  assert.deepEqual(MASCOTS.map((m) => [m.id, m.color, m.colorName.toLowerCase()]), server.map((m) => [m.mascot, m.color, m.colorName]), 'client and server agree');
  for (const m of MASCOTS) {
    assert.ok(hasArt(m.art) && m.art === m.id, `${m.id} is a 3D art id`);
    assert.ok(/^#(FFFFFF|1C2333)$/.test(m.ink), 'ink on the accent');
  }
  assert.equal(mascotFor('bell').color, '#EDB321');
  assert.equal(mascotFor('Teal').id, 'star');
  assert.equal(mascotFor(4).id, 'santa');
  assert.equal(mascotFor('???').id, 'deer');
  assert.equal(mascotFor('candy-cane').id, 'deer', 'old saves map to the nearest new mascot');
  assert.equal(mascotFor('tree-pine').id, 'tree');
  const d = teamDisc({ color: '#1F7A4A', mascot: 'tree', name: 'The Grinches' }, { size: 'md', label: true });
  assert.ok(d.startsWith('<span class="disc disc--art" style="--team-color:#1F7A4A;--disc-size:4rem" data-mascot="tree"'), 'no colour ball: the 3D art');
  assert.ok(d.includes('<img src="/assets/art/tree.png" alt=""'));
  assert.ok(d.includes('aria-label="The Grinches mascot: a Christmas tree"'));
  assert.ok(teamDisc({ color: 'javascript:x', mascot: 'cookie' }).includes('--team-color:#E9558A'), 'bad colour -> mascot colour');
  assert.ok(teamDisc({ mascot: 'star' }).includes('aria-hidden="true"'));
  assert.ok(teamDisc({ mascot: 'star' }, { leader: true, beacon: true, halo: true }).startsWith('<span class="disc disc--art disc--halo disc--ornament disc--leader disc--beacon"'));
  const img = mascotImg({ mascot: 'santa', name: 'Naughty List' }, 64);
  assert.ok(img.startsWith('<img class="art mascot-img" src="/assets/art/santa.png" width="64" height="64" style="width:4rem;height:4rem" alt="Naughty List"'), 'alt = team name');
  assert.ok(mascotImg({ mascot: 'santa', name: 'N' }, { size: 'sm', alt: '' }).includes('alt="" aria-hidden="true"') , 'decorative when the name is printed beside it');
  assert.equal(artSrc('../../etc/passwd'), '/assets/art/sparkles.png', 'unknown art falls back');
  assert.equal(artSrc('elf'), '/assets/art/sparkles.png', 'the fantasy elves are not used');
  assert.ok(artImg('popcorn', { size: 40, alt: '"x"' }).includes('alt="&quot;x&quot;"'));
  assert.ok(ART.includes('glowing-star') && ART.includes('medal3') && !ART.includes('elf'));
  const fs = require('node:fs');
  for (const id of ART) assert.ok(fs.existsSync(path.join(ASSETS, 'art', id + '.png')), `art/${id}.png exists`);
});

/* ============================================================== sound.js =================== */

test('sound: every effect is a safe no-op before unlock; volume/mute clamp and persist', async () => {
  store.clear();
  const s = await load('sound.js');
  assert.equal(s.isUnlocked(), false);
  const comedy = ['slideWhistle', 'sadTrombone', 'sleighRun', 'hoHoHo', 'boing', 'splat', 'kaChing', 'cymbal', 'crowdOoh'];
  for (const fn of ['tick', 'land', 'buzz', 'correct', 'wrong', 'beep', 'fanfare', 'applause', 'whoosh', 'leaderBeep', 'plugIn', 'dingLock', 'doubleDown', 'podium', 'sleighBells', 'steam', ...comedy]) {
    assert.doesNotThrow(() => s[fn](), fn);
  }
  assert.equal(typeof s.drumroll(1000), 'function');
  assert.equal(typeof s.ambience(), 'function', 'ambience() returns stop()');
  for (const name of ['leaderBeep', 'plugIn', 'dingLock', 'doubleDown', 'podium', 'sleighBells', 'steam', ...comedy]) assert.equal(typeof s.EFFECTS[name], 'function', name);
  for (const [gag, snd] of Object.entries(s.GAG_SOUNDS)) assert.equal(typeof s.EFFECTS[snd], 'function', `${gag} -> ${snd}`);
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

test('sky: garland geometry matches the TV concept and fits any width; markup has modes, phases and C9 colours', async () => {
  const sky = await load('sky.js');
  const tv = sky.garlandGeometry({ width: 1960 });
  assert.equal(tv.points.length, 30, '30 bulbs across the TV');
  assert.ok(tv.path.startsWith('M0 18 Q 140 134 280 18'), '7 swags, rope at 18, dipping to 76');
  assert.equal((tv.path.match(/Q /g) || []).length, 7);
  assert.ok(tv.points.every(([x, y]) => x > 0 && x < 1960 && y >= 18 && y <= 76.01), 'bulbs sit on the rope');
  for (let i = 1; i < tv.points.length; i++) assert.ok(tv.points[i][0] > tv.points[i - 1][0], 'left to right');
  const phone = sky.garlandGeometry({ width: 430, size: 'phone' });
  assert.equal((phone.path.match(/Q /g) || []).length, 3, 'a short version tops the phone');
  assert.ok(phone.points.length >= 10 && phone.points.length <= 13);
  assert.ok(phone.height < 90 && tv.height <= 150);
  const wide = sky.garlandGeometry({ width: 3840 });
  assert.equal(wide.points.length, 59, 'more bulbs on a wider screen, same spacing');
  const m = sky.garlandMarkup({ width: 1960 });
  assert.ok(m.startsWith('<svg class="garland" viewBox="0 0 1960 136" data-mode="twinkle" data-phase="0" aria-hidden="true"'));
  assert.equal((m.match(/class="garland__bulb p[012]"/g) || []).length, 30);
  assert.equal((m.match(/class="garland__bulb p0"/g) || []).length, 10, 'three chase phases');
  for (const c of sky.BULB_COLORS) assert.ok(m.includes(`--c:${c};`), `bulb colour ${c}`);
  assert.ok(m.includes('stroke="#1B5E3B" stroke-width="30"') && m.includes('stroke="#2E8B57" stroke-width="26"') && m.includes('stroke="#43A36B" stroke-width="18"'), 'three-green pine rope');
  assert.ok(sky.garlandMarkup({ mode: 'chase', className: 'x" onload="y' }).includes('data-mode="chase"') && sky.garlandMarkup({ className: 'x" onload="y' }).includes('x&quot; onload'));
  assert.ok(sky.garlandMarkup({ colors: ['javascript:x'] }).includes('--c:#D42A2A'), 'colours are sanitised');
  assert.deepEqual(sky.GARLAND_MODES, ['twinkle', 'chase', 'spin', 'lit', 'flash', 'blink', 'off']);
  const g = sky.garland(null);
  assert.equal(g.el, null, 'no container: safe no-op');
  g.chase(0.5);
  g.phase(2);
  assert.equal(await g.flash(), undefined);
  const bank = sky.snowbank();
  assert.ok(bank.startsWith('<svg class="snowbank" viewBox="0 0 1920 250" preserveAspectRatio="none"') && bank.includes('fill="#E7EFF8"') && bank.includes('fill="#FFFFFF"'));
});

/* ============================================================== fx.js ====================== */

test('fx: the comedy kit is safe without a DOM, every effect resolves false, play() dispatches by name', async () => {
  const fx = await load('fx.js');
  assert.deepEqual([...fx.EFFECT_NAMES], ['bounce', 'droop', 'wobble', 'shake', 'splat', 'coalDrop', 'dash', 'sneak', 'melt', 'peek', 'confetti', 'heartGrow']);
  for (const n of fx.EFFECT_NAMES) {
    const p = fx.FX[n]();
    assert.ok(p instanceof Promise, `${n} returns a Promise`);
    assert.equal(await p, false, `${n} is a no-op without a DOM`);
  }
  assert.equal(await fx.play('dash', 'deer'), false);
  assert.equal(await fx.play('nope'), false);
  assert.equal(fx.MAX_MS, 2500, 'gags never run longer than 2.5 s');
  assert.equal(fx.reducedMotion(), false);
});
