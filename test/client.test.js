import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const uiSource = readFileSync(path.resolve('public/ui.js'), 'utf8');
const hostSource = readFileSync(path.resolve('public/host.js'), 'utf8');
const playSource = readFileSync(path.resolve('public/play.js'), 'utf8');

function createSocket() {
  const handlers = {};
  const sent = [];
  let reply = () => ({ ok: true });
  return {
    sent,
    on(event, callback) {
      (handlers[event] ||= []).push(callback);
    },
    emit(event, payload, ack) {
      sent.push({ event, payload });
      if (!ack) return;
      Promise.resolve(reply(event, payload)).then((value) => ack(value));
    },
    fire(event, payload) {
      for (const callback of handlers[event] || []) callback(payload);
    },
    setReply(next) {
      reply = next;
    },
  };
}

function boot(page, { search = '', reduced = false, storage, before } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `http://127.0.0.1:3000/${page === 'host' ? 'host' : ''}?${search}`,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  });
  const { window } = dom;
  const frames = [];
  window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  window.matchMedia = (query) => ({
    matches: reduced && query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const rows = [...window.document.querySelectorAll('.board li')];
    const index = rows.indexOf(this);
    const tops = window.__tops || rows.map((_, rowIndex) => rowIndex * 48);
    const top = index < 0 ? 0 : tops[index] ?? 0;
    return { x: 0, y: top, top, left: 0, bottom: top + 40, right: 200, width: 200, height: 40, toJSON() { return {}; } };
  };
  const timers = new Map();
  let timerSeq = 0;
  window.setTimeout = (fn, delay) => {
    const id = ++timerSeq;
    timers.set(id, { fn, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const socket = createSocket();
  window.io = () => socket;
  const api = {
    quizzes: [
      { id: 'example.json', title: 'Warm-up', questionCount: 12 },
      { id: 'one.json', title: 'A & B <One>', questionCount: 1 },
      { id: 'zz-broken.json', title: 'zz-broken.json', questionCount: 0, error: 'Bad <file>' },
    ],
    info: { local: 'http://localhost:3000', lan: ['http://192.168.0.10:3000'] },
    post: { status: 200, body: { id: 'extra.json', title: 'Extra', questionCount: 1 } },
  };
  const fetchLog = [];
  window.fetch = async (url, options = {}) => {
    fetchLog.push({ url, body: options.body });
    if (options.method === 'POST') {
      return { ok: api.post.status === 200, json: async () => api.post.body };
    }
    if (String(url).includes('/api/quizzes')) return { ok: true, json: async () => api.quizzes };
    if (String(url).includes('/api/info')) return { ok: true, json: async () => api.info };
    throw new Error(`unexpected ${url}`);
  };
  before?.(window, api);
  if (storage) {
    for (const [key, value] of Object.entries(storage)) window.sessionStorage.setItem(key, value);
  }
  const context = dom.getInternalVMContext();
  vm.runInContext(uiSource, context, { filename: path.resolve('public/ui.js') });
  vm.runInContext(page === 'host' ? hostSource : playSource, context, { filename: path.resolve(`public/${page}.js`) });
  return {
    window,
    socket,
    api,
    fetchLog,
    flush(times = 1) {
      for (let index = 0; index < times; index += 1) {
        const batch = frames.splice(0, frames.length);
        for (const callback of batch) callback(0);
      }
    },
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
    timerDelays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function lobbyState(extra = {}) {
  return {
    role: 'host',
    phase: 'lobby',
    step: 1,
    token: 'host-token',
    code: '123456',
    title: 'A & B <Quiz>',
    urls: { local: 'http://localhost:3000', lan: ['http://10.0.0.8:3000'] },
    questionCount: 4,
    players: [{ name: "O'Ada" }],
    joinUrl: 'http://10.0.0.8:3000/?code=123456',
    qrSvg: '<svg id="qr"></svg>',
    shuffleQuestions: true,
    shuffleAnswers: true,
    ...extra,
  };
}

function questionState(extra = {}) {
  return {
    role: 'host',
    phase: 'question',
    step: 2,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    number: 1,
    total: 4,
    text: 'Rings? <b>',
    options: [
      { text: 'Jupiter', color: 'green', shape: 'triangle' },
      { text: 'Saturn', color: 'yellow', shape: 'diamond' },
      { text: 'Mars', color: 'blue', shape: 'circle' },
      { text: 'Venus', color: 'red', shape: 'square' },
    ],
    startedAt: Date.now() - 16000,
    durationMs: 20000,
    serverNow: Date.now(),
    answered: 0,
    playerCount: 2,
    ...extra,
  };
}

test('shared interface helpers cover codes, clocks, storage, and keys', async () => {
  const page = boot('host');
  await page.settle();
  const { NotKahoot } = page.window;
  assert.equal(NotKahoot.esc(`A&<>"'`), 'A&amp;&lt;&gt;&quot;&#39;');
  assert.equal(NotKahoot.esc(null), '');
  assert.match(NotKahoot.shape('circle'), /<circle/);
  assert.equal(NotKahoot.shape('missing'), '');
  assert.equal(NotKahoot.formatCode('123456'), '123 456');
  assert.equal(NotKahoot.formatCode('12'), '12');
  assert.equal(NotKahoot.formatCode(null), '');
  assert.equal(NotKahoot.formatScore(2345), '2,345');
  assert.equal(NotKahoot.formatScore(0), '0');
  assert.equal(NotKahoot.formatScore('1000000'), '1,000,000');
  assert.equal(NotKahoot.formatScore('nope'), '0');
  assert.equal(NotKahoot.viewKey(null), '');
  assert.equal(NotKahoot.viewKey({ phase: 'ended' }), 'ended');
  assert.equal(NotKahoot.viewKey({ role: 'host', phase: 'lobby', players: [1], shuffleQuestions: true, shuffleAnswers: false }), 'lobby:1:true:false');
  assert.equal(NotKahoot.viewKey({ role: 'player', phase: 'lobby', playerCount: 2, name: 'Ada' }), 'lobby:2:Ada');
  assert.equal(NotKahoot.viewKey({ phase: 'question', number: 3, locked: true, selected: 1 }), 'q:3:1');
  assert.equal(NotKahoot.viewKey({ phase: 'question', number: 3, locked: false }), 'q:3:open');
  assert.equal(NotKahoot.viewKey({ phase: 'countdown' }), 'countdown');
  assert.equal(NotKahoot.viewKey({ phase: 'gap', step: 4 }), 'gap:4');
  assert.equal(NotKahoot.viewKey({ phase: 'podium' }), 'podium:end');
  assert.equal(NotKahoot.secondsLeft(null), 0);
  assert.equal(NotKahoot.secondsLeft({ phase: 'lobby' }), 0);

  const stamped = { phase: 'question', number: 1, startedAt: 50, durationMs: 1000, serverNow: 100 };
  NotKahoot.stamp(null, stamped);
  const again = { ...stamped };
  NotKahoot.stamp(stamped, again);
  assert.equal(again.clientReceivedAt, stamped.clientReceivedAt);
  stamped.clientReceivedAt = 1;
  const changed = { ...stamped, number: 2 };
  NotKahoot.stamp(stamped, changed);
  assert.notEqual(changed.clientReceivedAt, 1);
  const counted = {
    phase: 'countdown',
    startedAt: Date.now(),
    durationMs: 3000,
    serverNow: Date.now(),
    clientReceivedAt: Date.now(),
  };
  assert.equal(NotKahoot.secondsLeft(counted), 3);
  NotKahoot.stamp(null, counted);
  const countedAgain = { ...counted };
  NotKahoot.stamp(counted, countedAgain);
  assert.equal(countedAgain.clientReceivedAt, counted.clientReceivedAt);
  counted.clientReceivedAt = 1;
  const shifted = { ...counted, serverNow: counted.serverNow + 8000 };
  NotKahoot.stamp(counted, shifted);
  assert.notEqual(shifted.clientReceivedAt, 1);
  const idle = { phase: 'lobby' };
  assert.equal(NotKahoot.stamp(stamped, idle), idle);

  page.window.sessionStorage.setItem('not-kahoot-host', '{');
  assert.equal(NotKahoot.storageGet('not-kahoot-host'), null);
  NotKahoot.storageSet('not-kahoot-host', { code: '1' });
  assert.equal(NotKahoot.storageGet('not-kahoot-host').code, '1');
  NotKahoot.storageClear('not-kahoot-host');
  assert.equal(NotKahoot.storageGet('not-kahoot-host'), null);
  page.window.sessionStorage.getItem = () => { throw new Error('blocked'); };
  page.window.sessionStorage.setItem = () => { throw new Error('blocked'); };
  page.window.sessionStorage.removeItem = () => { throw new Error('blocked'); };
  assert.equal(NotKahoot.storageGet('not-kahoot-host'), null);
  NotKahoot.storageSet('not-kahoot-host', { code: '1' });
  NotKahoot.storageClear('not-kahoot-host');

  page.window.document.body.innerHTML = '<strong data-count></strong><span data-bar></span>';
  let model = {
    phase: 'question',
    startedAt: Date.now() - 25000,
    durationMs: 20000,
    serverNow: Date.now(),
    clientReceivedAt: Date.now(),
  };
  NotKahoot.startClock(() => model);
  page.flush(1);
  const label = page.window.document.querySelector('[data-count]');
  const bar = page.window.document.querySelector('[data-bar]');
  assert.equal(label.classList.contains('urgent'), true);
  assert.match(bar.style.transform, /scaleX\(0\)/);
  model = { phase: 'lobby' };
  page.flush(1);
  assert.match(bar.style.transform, /scaleX\(1\)/);
  model = {
    phase: 'countdown',
    startedAt: Date.now(),
    durationMs: 3000,
    serverNow: Date.now(),
    clientReceivedAt: Date.now(),
  };
  page.flush(1);
  assert.equal(label.classList.contains('urgent'), false);
  assert.match(label.textContent, /^[123]$/);
  model = {
    phase: 'question',
    startedAt: Date.now(),
    durationMs: 20000,
    serverNow: Date.now(),
    clientReceivedAt: Date.now(),
  };
  page.flush(1);
  assert.equal(label.classList.contains('urgent'), false);
  assert.match(bar.style.transform, /scaleX\((1|0\.9\d*)\)/);
  label.remove();
  bar.remove();
  page.flush(1);

  page.socket.setReply(() => undefined);
  const silent = await NotKahoot.emit(page.socket, 'player:join', {});
  assert.equal(silent.ok, false);
  assert.equal(silent.error, 'No response from the server.');
  page.socket.setReply(() => ({ ok: true }));
  const heard = await NotKahoot.emit(page.socket, 'player:join', { name: 'Ada' });
  assert.equal(heard.ok, true);
});

test('the host screen walks setup, lobby, questions, movement, and the podium', async () => {
  const page = boot('host');
  await page.settle();
  const { document } = page.window;
  assert.equal(document.querySelector('.logo').getAttribute('alt'), 'Not Kahoot');
  assert.match(document.querySelector('.logo').getAttribute('src'), /logo\.jpg/);
  assert.match(document.body.textContent, /Host a quiz/);
  assert.match(document.body.textContent, /Warm-up/);
  assert.match(document.body.textContent, /12 questions/);
  assert.match(document.body.textContent, /1 question/);
  assert.match(document.body.textContent, /Bad <file>/);
  assert.match(document.body.innerHTML, /Bad &lt;file&gt;/);

  const drop = document.querySelector('[data-drop]');
  const over = new page.window.Event('dragover', { bubbles: true, cancelable: true });
  drop.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  const ignored = new page.window.Event('dragover', { bubbles: true, cancelable: true });
  document.body.dispatchEvent(ignored);
  assert.equal(ignored.defaultPrevented, false);
  const emptyDrop = new page.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(emptyDrop, 'dataTransfer', { value: { files: [] } });
  drop.dispatchEvent(emptyDrop);
  document.body.dispatchEvent(new page.window.Event('drop', { bubbles: true, cancelable: true }));
  assert.equal(page.fetchLog.some((entry) => entry.body), false);

  const file = new page.window.File(['{"title":"Extra"}'], 'My Quiz.json', { type: 'application/json' });
  const dropped = new page.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropped, 'dataTransfer', { value: { files: [file] } });
  drop.dispatchEvent(dropped);
  await page.settle();
  assert.match(page.fetchLog.find((entry) => entry.body).body, /My Quiz\.json/);

  page.api.post = { status: 400, body: {} };
  const input = document.querySelector('[data-upload]');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await page.settle();
  assert.match(document.body.textContent, /Could not read that file/);

  page.api.post = { status: 400, body: { error: 'Too odd <x>' } };
  const retry = document.querySelector('[data-upload]');
  Object.defineProperty(retry, 'files', { configurable: true, value: [file] });
  retry.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await page.settle();
  assert.match(document.body.textContent, /Too odd <x>/);

  document.body.click();
  page.socket.setReply(() => ({ ok: false, error: 'Nope <i>' }));
  document.querySelector('[data-action="host"]').click();
  await page.settle();
  assert.match(document.body.textContent, /Nope <i>/);

  page.socket.setReply((event) => (event === 'host:create' ? { ok: true } : { ok: true }));
  document.querySelector('[data-action="host"]').click();
  await page.settle();
  page.socket.fire('state', { role: 'player', phase: 'lobby' });
  assert.match(document.body.textContent, /Host a quiz/);

  page.socket.fire('state', lobbyState({ players: [], qrSvg: '', urls: undefined, title: 'Local only' }));
  assert.match(document.body.textContent, /QR unavailable/);
  assert.match(document.body.textContent, /localhost:3000/);
  assert.match(document.body.textContent, /Names appear here/);
  const start = document.querySelector('[data-action="start"]');
  assert.equal(start.disabled, true);
  start.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  assert.equal(page.socket.sent.some((entry) => entry.event === 'host:start'), false);

  page.socket.fire('state', lobbyState());
  assert.match(document.body.textContent, /123 456/);
  assert.match(document.body.textContent, /10\.0\.0\.8:3000/);
  assert.match(document.body.textContent, /O'Ada/);
  assert.equal(document.body.innerHTML.includes('<Quiz>'), false);
  assert.match(document.querySelector('.chip').getAttribute('style'), /%/);
  assert.equal(document.querySelector('[data-option="shuffleQuestions"]').checked, true);

  const pending = [];
  page.socket.setReply(() => new Promise((resolve) => pending.push(resolve)));
  const box = document.querySelector('[data-option="shuffleQuestions"]');
  box.checked = false;
  box.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  box.checked = true;
  box.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await page.settle();
  assert.equal(pending.length, 2);
  pending[0]({ ok: false, error: 'old' });
  await page.settle();
  assert.equal(document.body.textContent.includes('old'), false);
  pending[1]({ ok: false, error: 'Save failed' });
  await page.settle();
  assert.match(document.body.textContent, /Save failed/);

  page.socket.setReply(() => ({ ok: false, error: 'Wait for players' }));
  document.querySelector('[data-action="start"]').click();
  await page.settle();
  assert.match(document.body.textContent, /Wait for players/);

  page.socket.fire('state', {
    role: 'host',
    phase: 'countdown',
    step: 2,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    startedAt: Date.now(),
    durationMs: 3000,
    serverNow: Date.now(),
  });
  assert.match(document.body.textContent, /Get ready/);
  assert.match(document.querySelector('[data-count]').textContent, /^[123]$/);
  page.socket.fire('state', {
    role: 'host',
    phase: 'gap',
    step: 3,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
  });
  assert.equal(document.querySelector('.prompt'), null);
  assert.ok(document.querySelector('.end-quiz'));

  page.socket.fire('state', questionState());
  assert.match(document.body.textContent, /Rings\? <b>/);
  assert.equal(document.body.innerHTML.includes('<b>'), false);
  assert.match(document.querySelector('[data-count]').className, /urgent/);
  assert.equal(document.querySelector('.answer-count').textContent, '0');
  assert.equal(document.body.textContent.includes('answered'), false);
  assert.ok(document.querySelector('.next-dock'));
  page.socket.fire('state', questionState({ answered: 2 }));
  assert.equal(document.querySelector('.answer-count').textContent, '2');
  document.querySelector('.next-dock button').click();
  await page.settle();
  const expiredSends = page.socket.sent.filter((entry) => entry.event === 'host:next').length;
  page.socket.fire('state', questionState({
    number: 9,
    startedAt: Date.now() - 25000,
    durationMs: 20000,
    serverNow: Date.now(),
  }));
  page.flush(2);
  assert.ok(page.socket.sent.filter((entry) => entry.event === 'host:next').length > expiredSends);
  const beforeNext = page.socket.sent.filter((entry) => entry.event === 'host:next').length;
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.equal(page.socket.sent.filter((entry) => entry.event === 'host:next').length, beforeNext);

  page.socket.fire('state', {
    ...questionState({ phase: 'reveal', step: 3, text: 'Sky?' }),
    options: [
      { text: 'True', color: 'green', shape: 'triangle', correct: true, count: 1 },
      { text: 'False', color: 'red', shape: 'square', correct: false, count: 1 },
    ],
    correctCount: 1,
    playerCount: 2,
    number: 2,
  });
  assert.match(document.querySelector('.options').className, /two/);
  assert.ok(document.querySelector('.is-correct'));
  assert.ok(document.querySelector('.is-faded'));
  assert.equal(document.querySelector('.tally'), null);
  assert.equal(document.body.textContent.includes('got it right'), false);
  document.querySelector('[data-action="end"]').click();
  assert.match(document.body.textContent, /Are you sure you want to end the quiz/);
  const blockedNext = page.socket.sent.filter((entry) => entry.event === 'host:next').length;
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.equal(page.socket.sent.filter((entry) => entry.event === 'host:next').length, blockedNext);
  document.querySelector('[data-action="dismiss-end"]').click();
  assert.equal(document.querySelector('.confirm-end'), null);
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await page.settle();
  assert.equal(page.socket.sent.at(-1).event, 'host:next');
  document.querySelector('[data-action="next"]').click();
  await page.settle();

  page.socket.fire('state', {
    role: 'host',
    phase: 'chart',
    step: 9,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    number: 2,
    total: 4,
    text: 'Sky? <b>',
    options: [
      { text: 'True', color: 'green', shape: 'triangle', correct: true, count: 1 },
      { text: 'False', color: 'red', shape: 'square', correct: false, count: 2345 },
    ],
  });
  assert.ok(document.querySelector('.bar-row.is-correct'));
  assert.ok(document.querySelector('.bar-row:not(.is-correct)'));
  assert.match(document.querySelector('.bar-row.is-correct').getAttribute('aria-label'), /True/);
  assert.match(document.querySelector('.bar-row.is-correct .bar-score .bar-tick').textContent, /✓/);
  assert.equal(document.querySelector('.bar-row:not(.is-correct) .bar-tick'), null);
  assert.match(document.querySelector('.bar-row:not(.is-correct)').getAttribute('style'), /--pct:\s*100/);
  assert.match(document.querySelector('.bar-row.is-correct').getAttribute('style'), /--pct:\s*0/);
  assert.ok(document.querySelector('.bar-row.is-correct .bar-foot svg'));
  assert.ok(document.querySelector('.bar-row:not(.is-correct) .bar-foot svg'));
  assert.equal(document.querySelector('.bar-row.is-correct .bar-label').textContent, 'True');
  assert.equal(document.querySelector('.bar-row:not(.is-correct) .bar-label').textContent, 'False');
  assert.match(document.querySelector('.bar-row.is-correct .bar-col').className, /\bgreen\b/);
  assert.match(document.querySelector('.bar-row:not(.is-correct) .bar-col').className, /\bred\b/);
  assert.match(document.body.textContent, /2,345/);
  assert.equal(document.body.innerHTML.includes('<b>'), false);
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await page.settle();
  assert.equal(page.socket.sent.at(-1).event, 'host:next');

  page.socket.fire('state', {
    role: 'host',
    phase: 'leaderboard',
    step: 4,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    number: 1,
    total: 4,
    standings: [
      { rank: 1, name: 'Bev <1>', score: 2345, previousRank: 2 },
      { rank: 2, name: 'Ada', score: 0, previousRank: 1 },
    ],
  });
  assert.match(document.body.textContent, /2,345/);
  assert.equal(document.querySelector('.track'), null);
  assert.equal(document.querySelector('.streak'), null);
  assert.equal(document.body.innerHTML.includes('<1>'), false);
  assert.equal(document.querySelector('.is-moving'), null);
  assert.deepEqual(page.timerDelays(), [1000]);
  assert.match(document.querySelector('[data-rank="1"]').style.transform, /translateY\(/);
  page.runTimers();
  page.flush(4);
  assert.ok(document.querySelector('[data-rank="1"]').classList.contains('is-rising'));
  assert.ok(document.querySelector('[data-rank="2"]').classList.contains('is-moving'));

  page.socket.fire('state', {
    role: 'host',
    phase: 'leaderboard',
    number: 2,
    total: 4,
    step: 5,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    standings: [{ rank: 1, name: 'Only', score: 0, previousRank: 1, streakLabel: '' }],
  });
  page.flush(2);
  assert.equal(document.querySelector('.is-moving'), null);

  page.window.__tops = [20, 20];
  page.socket.fire('state', {
    role: 'host',
    phase: 'leaderboard',
    number: 3,
    total: 4,
    step: 6,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    standings: [
      { rank: 1, name: 'Bev', score: 10, previousRank: 2, streakLabel: '' },
      { rank: 2, name: 'Ada', score: 0, previousRank: 0, streakLabel: '' },
    ],
  });
  page.flush(3);
  assert.equal(document.querySelector('.is-moving'), null);

  page.window.__tops = [0, 48];
  page.socket.fire('state', {
    role: 'host',
    phase: 'leaderboard',
    number: 4,
    total: 4,
    step: 7,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    standings: [
      { rank: 1, name: 'Bev', score: 10, previousRank: 0, streakLabel: '' },
      { rank: 2, name: 'Ada', score: 0, previousRank: 2, streakLabel: '' },
    ],
  });
  page.flush(3);
  assert.equal(document.querySelector('.is-rising'), null);

  const podium = (number, top) => page.socket.fire('state', {
    role: 'host', phase: 'podium', number, step: 8, token: 'host-token', code: '123456', title: 'Warm-up', top,
  });
  podium(1, [{ rank: 1, name: 'Ada', score: 10 }, { rank: 2, name: 'Bev', score: 9 }, { rank: 3, name: 'Cam', score: 8 }]);
  assert.deepEqual([...document.querySelectorAll('.place')].map((node) => node.className), ['place place-2', 'place place-1', 'place place-3']);
  podium(2, [{ rank: 1, name: 'Ada', score: 10 }, { rank: 2, name: 'Bev', score: 9 }]);
  assert.deepEqual([...document.querySelectorAll('.place')].map((node) => node.className), ['place place-2', 'place place-1']);
  podium(3, [{ rank: 1, name: 'Ada', score: 10 }]);
  assert.deepEqual([...document.querySelectorAll('.place')].map((node) => node.className), ['place place-1']);
  podium(4, [{ rank: 1, name: 'Ada', score: 10 }, { rank: 3, name: 'Cam', score: 8 }]);
  assert.match(document.body.textContent, /Ada/);

  const upload = document.createElement('input');
  upload.dataset.upload = '';
  Object.defineProperty(upload, 'files', { value: [file] });
  document.querySelector('#app').appendChild(upload);
  page.api.post = { status: 200, body: { id: 'extra.json' } };
  const fetches = page.fetchLog.length;
  upload.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await page.settle();
  assert.ok(page.fetchLog.length > fetches);
  assert.match(document.body.textContent, /Top 3/);

  page.socket.fire('connect');
  page.socket.fire('disconnect');
  assert.ok(document.body.classList.contains('offline'));
  page.socket.fire('connect');
  assert.equal(document.body.classList.contains('offline'), false);

  document.querySelector('[data-action="new"]').click();
  await page.settle();
  assert.match(document.body.textContent, /Host a quiz/);
  assert.equal(page.socket.sent.some((entry) => entry.event === 'host:end'), true);

  page.socket.fire('state', lobbyState());
  const endsBefore = page.socket.sent.filter((entry) => entry.event === 'host:end').length;
  document.querySelector('[data-action="end"]').click();
  document.querySelector('[data-action="confirm-end"]').click();
  await page.settle();
  assert.match(document.body.textContent, /Host a quiz/);
  assert.ok(page.socket.sent.filter((entry) => entry.event === 'host:end').length > endsBefore);

  page.socket.fire('state', lobbyState({ code: undefined, token: undefined }));
  document.querySelector('[data-action="cancel"]').click();
  await page.settle();
  assert.match(document.body.textContent, /Host a quiz/);
});

test('reduced motion skips the leaderboard slide', async () => {
  const page = boot('host', { reduced: true });
  await page.settle();
  page.socket.fire('state', {
    role: 'host',
    phase: 'leaderboard',
    number: 1,
    total: 2,
    step: 4,
    token: 'host-token',
    code: '123456',
    title: 'Warm-up',
    standings: [
      { rank: 1, name: 'Bev', score: 10, previousRank: 2, streakLabel: '' },
      { rank: 2, name: 'Ada', score: 0, previousRank: 1, streakLabel: '' },
    ],
  });
  page.flush(3);
  assert.equal(page.window.document.querySelector('[data-rank="1"]').style.transform, '');
});

test('an empty library and a saved host session still render', async () => {
  const empty = boot('host', { before: (_window, api) => { api.quizzes = []; } });
  await empty.settle();
  assert.match(empty.window.document.body.textContent, /No quiz files yet/);

  const saved = boot('host', { storage: { 'not-kahoot-host': JSON.stringify({ code: '123456', token: 'tok' }) } });
  await saved.settle();
  saved.socket.fire('connect');
  assert.equal(saved.socket.sent[0].event, 'host:resume');

  const broken = boot('host', { storage: { 'not-kahoot-host': '{' } });
  await broken.settle();
  broken.socket.fire('connect');
  assert.equal(broken.socket.sent.length, 0);

  const blocked = boot('host', {
    before(window) {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: {
          getItem() { throw new Error('blocked'); },
          setItem() { throw new Error('blocked'); },
          removeItem() { throw new Error('blocked'); },
        },
      });
    },
  });
  await blocked.settle();
  blocked.socket.fire('connect');
  blocked.socket.fire('state', lobbyState());
  assert.match(blocked.window.document.body.textContent, /123 456/);
  blocked.window.document.querySelector('[data-action="cancel"]').click();
  await blocked.settle();
  assert.match(blocked.window.document.body.textContent, /Host a quiz/);
});

test('the phone walks joining, answering, streaks, ranks, and the podium', async () => {
  const linked = boot('play', { search: 'code=12ab3456zz' });
  assert.equal(linked.window.document.querySelector('input[name="code"]').value, '123 456');
  assert.equal(linked.window.document.activeElement, linked.window.document.querySelector('input[name="name"]'));

  const page = boot('play');
  const { document } = page.window;
  assert.equal(document.querySelector('.logo').getAttribute('alt'), 'Not Kahoot');
  assert.equal(document.activeElement, document.querySelector('input[name="code"]'));
  const stray = document.createElement('form');
  document.querySelector('#app').appendChild(stray);
  stray.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  document.body.click();

  page.socket.setReply(() => ({ ok: false, error: 'Nope <b>' }));
  document.querySelector('input[name="code"]').value = '000000';
  document.querySelector('input[name="name"]').value = 'Ada';
  document.querySelector('[data-join]').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await page.settle();
  assert.match(document.body.textContent, /Nope <b>/);
  assert.equal(document.body.innerHTML.includes('<b>'), false);

  page.socket.setReply(() => ({ ok: true, playerId: 'p1', token: 'tok' }));
  document.querySelector('[data-join]').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await page.settle();
  assert.match(document.body.textContent, /Join a game/);
  page.socket.fire('state', { role: 'host', phase: 'lobby' });
  page.socket.fire('state', {
    role: 'player', phase: 'lobby', code: '123456', playerId: 'p1', token: 'tok', name: '<Ada>', score: 0, title: 'Warm-up', playerCount: 1,
  });
  assert.match(document.body.textContent, /You're in/);
  assert.match(document.body.textContent, /1 player/);
  assert.equal(document.body.innerHTML.includes('<Ada>'), false);
  document.querySelector('h1').textContent = 'MUTATED';
  page.socket.fire('state', {
    role: 'player', phase: 'lobby', code: '123456', playerId: 'p1', token: 'tok', name: '<Ada>', score: 0, title: 'Warm-up', playerCount: 1,
  });
  assert.equal(document.querySelector('h1').textContent, 'MUTATED');

  page.socket.fire('state', {
    role: 'player', phase: 'lobby', code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 0, title: 'Warm-up', playerCount: 2,
  });
  assert.match(document.body.textContent, /2 players/);
  document.querySelector('[data-leave]').click();
  await page.settle();
  assert.equal(page.socket.sent.some((entry) => entry.event === 'player:leave'), true);
  assert.match(document.body.textContent, /Join a game/);

  page.socket.fire('state', {
    role: 'player',
    phase: 'countdown',
    code: '123456',
    playerId: 'p1',
    token: 'tok',
    name: 'Ada',
    score: 0,
    title: 'Warm-up',
    startedAt: Date.now(),
    durationMs: 3000,
    serverNow: Date.now(),
  });
  assert.match(document.body.textContent, /Get ready/);
  page.socket.fire('state', {
    role: 'player',
    phase: 'gap',
    step: 8,
    code: '123456',
    playerId: 'p1',
    token: 'tok',
    name: 'Ada',
    score: 0,
    title: 'Warm-up',
  });
  assert.equal(document.querySelector('#app').innerHTML, '');

  const choices = [
    { color: 'green', shape: 'triangle', text: '' },
    { color: 'yellow', shape: 'diamond', text: '' },
    { color: 'blue', shape: 'circle', text: '' },
    { color: 'red', shape: 'square', text: '' },
  ];
  const open = {
    role: 'player', phase: 'question', code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 0,
    title: 'Warm-up', number: 1, total: 3, startedAt: Date.now(), durationMs: 20000, serverNow: Date.now(),
    locked: false, selected: null, choices,
  };
  page.socket.fire('state', open);
  assert.match(document.body.textContent, /Tap a colour/);
  const held = [];
  page.socket.setReply(() => new Promise((resolve) => held.push(resolve)));
  document.querySelector('[data-choice="0"]').click();
  document.querySelector('[data-choice="1"]').click();
  await page.settle();
  assert.equal(page.socket.sent.filter((entry) => entry.event === 'player:answer').length, 1);
  assert.ok(document.querySelector('.pad').classList.contains('is-locked'));
  document.querySelector('main').dataset.mark = 'keep';
  held[0]({ ok: true, ignored: true });
  await page.settle();
  assert.equal(document.querySelector('main').dataset.mark, 'keep');

  page.socket.fire('state', { ...open, number: 2, choices: [
    { color: 'green', shape: 'triangle', text: 'True & <yes>' },
    { color: 'red', shape: 'square', text: 'False' },
  ] });
  assert.match(document.querySelector('.pad').className, /two/);
  assert.match(document.body.textContent, /True or false/);
  assert.match(document.querySelector('.choice-word').innerHTML, /True &amp; &lt;yes&gt;/);
  const answersBefore = page.socket.sent.filter((entry) => entry.event === 'player:answer').length;
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: '4' }));
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: '9' }));
  assert.equal(page.socket.sent.filter((entry) => entry.event === 'player:answer').length, answersBefore);
  document.querySelector('main').dataset.mark = 'gone';
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: '1' }));
  await page.settle();
  held.at(-1)({ ok: false, error: 'Too late' });
  await page.settle();
  assert.equal(document.querySelector('main').dataset.mark, undefined);

  page.socket.fire('state', { ...open, number: 3, locked: true, selected: 1 });
  assert.match(document.body.textContent, /Locked in/);
  assert.ok(document.querySelector('[data-choice="1"]').classList.contains('selected'));
  const lockedCount = page.socket.sent.filter((entry) => entry.event === 'player:answer').length;
  document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: '1' }));
  document.querySelector('[data-choice="0"]').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await page.settle();
  assert.equal(page.socket.sent.filter((entry) => entry.event === 'player:answer').length, lockedCount);

  const reveal = (number, extra) => page.socket.fire('state', {
    role: 'player', phase: 'reveal', number, code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 1000, title: 'Warm-up', ...extra,
  });
  reveal(1, { answered: false, correct: false, pointsAwarded: 0, streak: 0, rank: 2, leading: false, gap: 80, rivalName: 'Bev', rivalRank: 1 });
  assert.match(document.body.textContent, /Time's up/);
  assert.match(document.body.textContent, /Streak 0/);
  assert.match(document.body.textContent, /80 points behind Bev/);
  assert.equal(document.querySelector('.rank-circle.mini').textContent, '1st');
  reveal(2, { answered: true, correct: false, pointsAwarded: 0, streak: 0, rank: 2, leading: false, gap: 80, rivalName: 'Bev', rivalRank: 1 });
  assert.match(document.body.textContent, /Not this time/);
  reveal(3, { answered: true, correct: true, pointsAwarded: 1100, streak: 2, rank: 1, leading: true, gap: 50, score: 2345, rivalName: 'Kamran', rivalRank: 2 });
  assert.match(document.body.textContent, /\+1,100/);
  assert.match(document.body.textContent, /Streak 2/);
  assert.match(document.body.textContent, /50 points ahead of Kamran/);
  assert.equal(document.querySelector('.rank-circle.mini').textContent, '2nd');
  assert.match(document.body.textContent, /2,345/);
  assert.equal(/x1/.test(document.body.textContent), false);
  page.socket.fire('state', {
    role: 'player', phase: 'chart', number: 4, code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 2345, title: 'Warm-up',
    answered: true, correct: true, pointsAwarded: 1100, streak: 2, rank: 1, leading: true, gap: null,
  });
  assert.match(document.body.textContent, /You're in the lead/);

  const between = (number, rank, extra = {}) => page.socket.fire('state', {
    role: 'player', phase: 'leaderboard', number, code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 2345, title: 'Warm-up',
    rank, streak: 3, leading: rank === 1, gap: rank == null ? null : (rank === 1 ? 120 : 15),
    rivalName: rank === 1 ? 'Bev' : 'Ada', rivalRank: rank == null ? null : (rank === 1 ? 2 : 1), ...extra,
  });
  const expected = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [null, 'You are ']];
  expected.forEach(([rank, label]) => {
    between(rank || 9, rank);
    assert.match(document.body.textContent, new RegExp(label.replace(' ', '\\s*')));
    assert.match(document.body.textContent, /Streak 3/);
    assert.match(document.body.textContent, /2,345/);
    assert.equal(document.body.textContent.includes('top 7'), false);
    assert.equal(/x1/.test(document.body.textContent), false);
    if (rank === 1) {
      assert.match(document.body.textContent, /120 points ahead of Bev/);
      assert.equal(document.querySelector('.rank-circle.mini').textContent, '2nd');
    } else if (rank) {
      assert.match(document.body.textContent, /15 points behind Ada/);
      assert.equal(document.querySelector('.rank-circle.mini').textContent, '1st');
    }
    if (rank) assert.equal(document.querySelector('.rank-circle').textContent, label.trim());
    else assert.equal(document.querySelector('.rank-circle'), null);
  });
  between(30, 1, { gap: null, leading: true, streak: 0, rivalName: null, rivalRank: null });
  assert.match(document.body.textContent, /in the lead/);
  assert.equal(document.querySelector('.rank-circle.mini'), null);
  assert.match(document.body.textContent, /Streak 0/);

  const podium = (number, extra) => page.socket.fire('state', {
    role: 'player', phase: 'podium', number, code: '123456', playerId: 'p1', token: 'tok', name: 'Ada & Co', score: 1100, title: 'Warm-up', ...extra,
  });
  podium(1, { rank: 1, onPodium: true });
  assert.match(document.body.textContent, /Number 1/);
  assert.match(document.body.textContent, /on the podium/);
  podium(2, { rank: 4, onPodium: false });
  assert.match(document.body.textContent, /Quiz over/);
  assert.match(document.body.textContent, /4th/);
  assert.equal(document.body.innerHTML.includes('Ada & Co'), false);

  page.socket.fire('disconnect');
  assert.ok(document.body.classList.contains('offline'));
  page.socket.fire('connect');
  assert.equal(document.body.classList.contains('offline'), false);
  page.socket.fire('state', { role: 'player', phase: 'ended' });
  assert.match(document.body.textContent, /The host ended this game/);
  assert.equal(page.window.NotKahoot.storageGet('not-kahoot-player'), null);

  document.querySelector('[data-leave]')?.click();
  document.body.click();
  const joinAgain = boot('play');
  joinAgain.window.NotKahoot.storageClear('not-kahoot-player');
  joinAgain.socket.fire('state', {
    role: 'player', phase: 'lobby', code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 0, title: 'Warm-up', playerCount: 1,
  });
  joinAgain.window.sessionStorage.clear();
  joinAgain.window.document.querySelector('[data-leave]').click();
  await joinAgain.settle();
  assert.equal(joinAgain.socket.sent.some((entry) => entry.event === 'player:leave'), false);
});

test('a saved phone session resumes or returns to the join form', async () => {
  const saved = JSON.stringify({ code: '123456', playerId: 'p1', token: 'tok' });
  const failed = boot('play', { storage: { 'not-kahoot-player': saved } });
  failed.socket.setReply(() => ({ ok: false, error: 'gone' }));
  failed.socket.fire('connect');
  await failed.settle();
  assert.match(failed.window.document.body.textContent, /That game has ended/);

  const ready = boot('play', { storage: { 'not-kahoot-player': saved } });
  ready.socket.fire('connect');
  await ready.settle();
  assert.equal(ready.socket.sent[0].event, 'player:resume');
  assert.match(ready.window.document.body.textContent, /Join a game/);

  const partial = boot('play', { storage: { 'not-kahoot-player': JSON.stringify({ code: '123456' }) } });
  partial.socket.fire('connect');
  await partial.settle();
  assert.equal(partial.socket.sent.length, 0);

  const blocked = boot('play', {
    before(window) {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: {
          getItem() { throw new Error('blocked'); },
          setItem() { throw new Error('blocked'); },
          removeItem() { throw new Error('blocked'); },
        },
      });
    },
  });
  blocked.socket.fire('connect');
  blocked.socket.fire('state', {
    role: 'player', phase: 'lobby', code: '123456', playerId: 'p1', token: 'tok', name: 'Ada', score: 0, title: 'Warm-up', playerCount: 1,
  });
  assert.match(blocked.window.document.body.textContent, /You're in/);
  blocked.socket.fire('state', { phase: 'ended' });
  assert.match(blocked.window.document.body.textContent, /The host ended this game/);
});
