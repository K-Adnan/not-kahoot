import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { getGlobalDispatcher } from 'undici';
import { io as ioClient } from 'socket.io-client';
import { start } from '../server.js';

const quizDir = path.resolve('quizzes');
const sample = {
  title: 'Sample',
  questions: [
    { question: 'Rings?', answers: ['Jupiter', 'Saturn', 'Mars', 'Venus'], correct: 2 },
    { question: 'Hexagon sides are six.', trueFalse: true, correct: true },
    { question: 'Ocean?', answers: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correct: 'Pacific' },
    { question: 'Boils at 90?', answers: ['True', 'False'], correct: false },
  ],
};

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response) => resolve(response));
  });
}

function connect(port) {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 4000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function waitFor(socket, predicate, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('state timeout')), ms);
    const onState = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('state', onState);
      resolve(state);
    };
    socket.on('state', onState);
  });
}

async function hostGame(port, quiz = sample) {
  const host = await connect(port);
  const pending = waitFor(host, (state) => state.role === 'host' && state.phase === 'lobby');
  const created = await emit(host, 'host:create', { quiz });
  assert.equal(created.ok, true, created.error);
  const lobby = await pending;
  return { host, lobby };
}

async function join(port, code, name) {
  const socket = await connect(port);
  const pending = waitFor(socket, (state) => state.role === 'player' && state.name === name);
  const response = await emit(socket, 'player:join', { code, name });
  assert.equal(response.ok, true, response.error);
  const state = await pending;
  return { socket, state, token: response.token, playerId: response.playerId };
}

describe('live quiz server', { concurrency: false }, () => {
  let server;
  const createdFiles = [];

  before(async () => {
    process.env.QUESTION_MS = '60000';
    process.env.COUNTDOWN_MS = '0';
    process.env.GAP_MS = '0';
    process.env.REVEAL_MS = '600000';
    server = await start(0);
  });

  after(async () => {
    delete process.env.QUESTION_MS;
    delete process.env.COUNTDOWN_MS;
    delete process.env.GAP_MS;
    delete process.env.REVEAL_MS;
    for (const file of createdFiles) rmSync(file, { recursive: true, force: true });
    await server.stop();
    await getGlobalDispatcher().close();
  });

  test('health, info, static pages, and quiz listing', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { ok: true });
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.match(info.local, /localhost/);
    assert.ok(Array.isArray(info.lan));

    const broken = path.join(quizDir, 'zz-broken.json');
    const asDir = path.join(quizDir, 'zz-dir.json');
    rmSync(asDir, { recursive: true, force: true });
    writeFileSync(broken, '{');
    mkdirSync(asDir);
    createdFiles.push(broken, asDir);
    const quizzes = await (await fetch(`${base}/api/quizzes`)).json();
    assert.ok(quizzes.some((quiz) => quiz.id === 'example.json' && quiz.questionCount === 12));
    assert.ok(quizzes.some((quiz) => quiz.id === 'all-about-dad.json' && quiz.questionCount === 19 && quiz.title === 'All about Dad'));
    assert.ok(quizzes.some((quiz) => quiz.id === 'zz-broken.json' && quiz.error));
    assert.ok(quizzes.some((quiz) => quiz.id === 'zz-dir.json' && quiz.error));

    for (const route of ['/', '/host', '/host.html', '/favicon.svg']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
    }
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  });

  test('quiz upload accepts json and csv and rejects bad names', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const text = JSON.stringify({
      title: 'Uploaded',
      questions: [{ question: 'Q', answers: ['A', 'B', 'C', 'D'], correct: 1 }],
    });
    const saved = await fetch(`${base}/api/quizzes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Quiz.JSON', text }),
    });
    const body = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(body.id, 'my-quiz.json');
    createdFiles.push(path.join(quizDir, 'my-quiz.json'));
    assert.equal(readFileSync(path.join(quizDir, 'my-quiz.json'), 'utf8'), text);

    const csv = await fetch(`${base}/api/quizzes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'extra.CSV',
        text: 'question,answer1,answer2,answer3,answer4,correct\nQ,True,False,,,1\n',
      }),
    });
    assert.equal((await csv.json()).questionCount, 1);
    createdFiles.push(path.join(quizDir, 'extra.csv'));

    for (const [name, textValue, pattern] of [
      ['notes.txt', '{}', /json or \.csv/],
      ['---.json', '{}', /name/],
      ['bad.json', '{', /parsed/],
      ['bad.json', undefined, /parsed|empty|at least one/],
    ]) {
      const response = await fetch(`${base}/api/quizzes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, text: textValue }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, pattern);
    }
  });

  test('a saved quiz can be hosted, resumed, and configured before anyone joins', async () => {
    process.env.QUESTION_MS = '60000';
    const host = await connect(server.port);
    const opened = waitFor(host, (state) => state.phase === 'lobby' && state.title === 'Warm-up');
    const created = await emit(host, 'host:create', { quizId: 'example.json' });
    assert.equal(created.ok, true, created.error);
    const lobby = await opened;
    assert.match(lobby.qrSvg, /<svg/i);
    assert.equal(lobby.shuffleQuestions, true);
    assert.equal(lobby.shuffleAnswers, true);
    assert.equal(lobby.questionCount, 12);

    const again = waitFor(host, (state) => state.qrSvg === lobby.qrSvg && state.phase === 'lobby');
    assert.equal((await emit(host, 'host:resume', { code: lobby.code, token: lobby.token })).ok, true);
    await again;
    assert.match((await emit(host, 'host:resume', { code: lobby.code, token: '' })).error, /no longer/);
    assert.match((await emit(host, 'host:resume', { code: lobby.code, token: 12 })).error, /no longer/);

    const questionsOff = waitFor(host, (state) => state.phase === 'lobby' && state.shuffleQuestions === false);
    assert.equal((await emit(host, 'host:options', {
      code: lobby.code,
      token: lobby.token,
      shuffleQuestions: false,
      revision: 1.5,
    })).ok, true);
    assert.equal((await questionsOff).shuffleAnswers, true);

    const answersOff = waitFor(host, (state) => state.shuffleAnswers === false);
    await emit(host, 'host:options', {
      code: lobby.code,
      token: lobby.token,
      shuffleAnswers: false,
      revision: 10,
    });
    await answersOff;
    const stale = await emit(host, 'host:options', {
      code: lobby.code,
      token: lobby.token,
      shuffleQuestions: true,
      shuffleAnswers: true,
      revision: 1,
    });
    assert.equal(stale.ignored, true);
    assert.match((await emit(host, 'host:start', { code: lobby.code, token: lobby.token })).error, /at least one/);
    assert.match((await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: lobby.step })).error, /Not ready/);
    host.close();
  });

  test('players join, score streaks, and reach the podium in a fixed order', async () => {
    process.env.QUESTION_MS = '60000';
    const { host, lobby } = await hostGame(server.port);
    const fixed = waitFor(host, (state) => state.shuffleQuestions === false && state.shuffleAnswers === false);
    await emit(host, 'host:options', {
      code: lobby.code,
      token: lobby.token,
      shuffleQuestions: false,
      shuffleAnswers: false,
      revision: Date.now(),
    });
    await fixed;

    const ada = await join(server.port, ` ${lobby.code.slice(0, 3)} ${lobby.code.slice(3)} `, "O'Ada");
    const bev = await join(server.port, lobby.code, 'Bev');
    assert.match((await emit(bev.socket, 'player:join', { code: lobby.code, name: "o'ada" })).error, /already/);
    assert.match((await emit(await connect(server.port), 'player:join', { code: '000000', name: 'No' })).error, /No game/);
    assert.match((await emit(await connect(server.port), 'player:join', { code: lobby.code, name: '   ' })).error, /1–16/);
    assert.match((await emit(await connect(server.port), 'player:join', { code: lobby.code, name: 'Name Is Way Too Long' })).error, /1–16/);
    assert.match((await emit(await connect(server.port), 'player:join', { code: lobby.code, name: 'Bad<script>' })).error, /letters/);
    const unicode = await join(server.port, lobby.code, 'Zoë 2');
    const left = waitFor(host, (state) => state.phase === 'lobby' && state.players.every((player) => player.name !== 'Zoë 2'));
    await emit(unicode.socket, 'player:leave', { code: lobby.code, playerId: unicode.playerId, token: unicode.token });
    await left;
    assert.equal((await emit(unicode.socket, 'player:leave', { code: '000000', playerId: 'x', token: 'y' })).ok, true);
    assert.equal((await emit(ada.socket, 'player:resume', {
      code: lobby.code,
      playerId: ada.playerId,
      token: ada.token,
    })).ok, true);
    assert.match((await emit(ada.socket, 'player:resume', {
      code: lobby.code,
      playerId: ada.playerId,
      token: 'nope',
    })).error, /no longer/);

    const stranger = await connect(server.port);
    assert.match((await emit(stranger, 'host:start', { code: lobby.code, token: 'nope' })).error, /not hosting/);
    process.env.COUNTDOWN_MS = '180';
    const hostCountdown = waitFor(host, (state) => state.phase === 'countdown');
    const adaCountdown = waitFor(ada.socket, (state) => state.phase === 'countdown');
    const hostQuestion = waitFor(host, (state) => state.phase === 'question' && state.number === 1);
    const adaQuestion = waitFor(ada.socket, (state) => state.phase === 'question');
    assert.equal((await emit(stranger, 'host:start', { code: lobby.code, token: lobby.token })).ok, true);
    const opening = await hostCountdown;
    assert.equal(opening.durationMs, 180);
    assert.equal(opening.text, undefined);
    assert.equal((await adaCountdown).phase, 'countdown');
    assert.match((await emit(ada.socket, 'player:answer', { choice: 0 })).error, /no question/);
    assert.match((await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: opening.step })).error, /Not ready/);
    process.env.COUNTDOWN_MS = '0';
    const question = await hostQuestion;
    const adaView = await adaQuestion;
    assert.equal(question.text, 'Rings?');
    assert.deepEqual(question.options.map((option) => option.text), ['Jupiter', 'Saturn', 'Mars', 'Venus']);
    assert.equal(adaView.choices.every((choice) => choice.text === ''), true);
    assert.match((await emit(host, 'host:options', { shuffleQuestions: false })).error, /already started/);
    assert.match((await emit(host, 'host:start', { code: lobby.code, token: lobby.token })).error, /already started/);
    assert.match((await emit(ada.socket, 'player:join', { code: lobby.code, name: 'Late' })).error, /already started/);
    assert.match((await emit(stranger, 'player:answer', { choice: 0 })).error, /Join a game/);
    assert.match((await emit(ada.socket, 'player:answer', { choice: 4 })).error, /four answers/);
    assert.match((await emit(ada.socket, 'player:answer', { choice: 1.5 })).error, /four answers/);
    assert.equal((await emit(ada.socket, 'player:leave', {
      code: lobby.code,
      playerId: ada.playerId,
      token: ada.token,
    })).ok, true);

    const adaReveal = waitFor(ada.socket, (state) => state.phase === 'reveal');
    const bevReveal = waitFor(bev.socket, (state) => state.phase === 'reveal');
    const hostReveal = waitFor(host, (state) => state.phase === 'reveal');
    assert.equal((await emit(ada.socket, 'player:answer', { choice: 0 })).ok, true);
    assert.equal((await emit(ada.socket, 'player:answer', { choice: 1 })).ignored, true);
    assert.equal((await emit(bev.socket, 'player:answer', { choice: 1 })).ok, true);
    const adaMarked = await adaReveal;
    const bevMarked = await bevReveal;
    const reveal = await hostReveal;
    assert.equal(adaMarked.correct, false);
    assert.equal(adaMarked.pointsAwarded, 0);
    assert.equal(adaMarked.streak, 0);
    assert.equal(adaMarked.leading, false);
    assert.equal(bevMarked.streak, 1);
    assert.equal(bevMarked.leading, true);
    assert.equal(bevMarked.gap, bevMarked.score);
    assert.equal(bevMarked.rivalName, "O'Ada");
    assert.equal(bevMarked.rivalRank, 2);
    assert.equal(adaMarked.gap, bevMarked.score);
    assert.equal(adaMarked.rivalName, 'Bev');
    assert.equal(adaMarked.rivalRank, 1);
    assert.ok(bevMarked.pointsAwarded >= 900);
    assert.equal(reveal.correctText, 'Saturn');
    assert.equal(reveal.correctCount, 1);
    assert.match((await emit(ada.socket, 'player:answer', { choice: 0 })).error, /no question/);
    assert.equal((await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: reveal.step - 1 })).ignored, true);

    const chartWait = waitFor(host, (state) => state.phase === 'chart' && state.number === 1);
    const adaChart = waitFor(ada.socket, (state) => state.phase === 'chart');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: reveal.step });
    const chart = await chartWait;
    assert.equal(chart.options.find((option) => option.text === 'Saturn').count, 1);
    assert.equal(chart.options.find((option) => option.text === 'Jupiter').count, 1);
    assert.equal((await adaChart).streak, 0);
    assert.equal((await adaChart).gap, bevMarked.score);

    const hostBoard = waitFor(host, (state) => state.phase === 'leaderboard' && state.number === 1);
    const adaBoard = waitFor(ada.socket, (state) => state.phase === 'leaderboard');
    const bevBoard = waitFor(bev.socket, (state) => state.phase === 'leaderboard');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: chart.step });
    const board = await hostBoard;
    assert.equal(board.standings[0].name, 'Bev');
    assert.equal(board.standings[0].previousRank, 2);
    assert.equal(board.standings[1].name, "O'Ada");
    assert.equal((await adaBoard).streak, 0);
    assert.equal((await adaBoard).leading, false);
    assert.equal((await bevBoard).rank, 1);
    assert.equal((await bevBoard).leading, true);

    process.env.GAP_MS = '120';
    const gapWait = waitFor(host, (state) => state.phase === 'gap');
    const trueFalse = waitFor(host, (state) => state.phase === 'question' && state.number === 2);
    const adaSecond = waitFor(ada.socket, (state) => state.phase === 'question' && state.number === 2);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: board.step });
    const gap = await gapWait;
    assert.equal(gap.text, undefined);
    assert.match((await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: gap.step })).error, /Not ready/);
    process.env.GAP_MS = '0';
    const second = await trueFalse;
    assert.deepEqual(second.options.map((option) => option.text), ['True', 'False']);
    assert.deepEqual((await adaSecond).choices.map((choice) => choice.text), ['True', 'False']);
    assert.match((await emit(ada.socket, 'player:answer', { choice: 2 })).error, /true or false/);

    const adaSecondReveal = waitFor(ada.socket, (state) => state.phase === 'reveal' && state.number === 2);
    const bevSecondReveal = waitFor(bev.socket, (state) => state.phase === 'reveal' && state.number === 2);
    const hostSecondReveal = waitFor(host, (state) => state.phase === 'reveal' && state.number === 2);
    await emit(ada.socket, 'player:answer', { choice: 0 });
    await emit(bev.socket, 'player:answer', { choice: 0 });
    const adaSecondMarked = await adaSecondReveal;
    const bevSecondMarked = await bevSecondReveal;
    assert.equal(adaSecondMarked.streak, 1);
    assert.equal(bevSecondMarked.streak, 2);
    assert.equal(bevSecondMarked.leading, true);
    assert.equal(adaSecondMarked.gap, bevSecondMarked.score - adaSecondMarked.score);
    const secondReveal = await hostSecondReveal;

    const secondChartWait = waitFor(host, (state) => state.phase === 'chart' && state.number === 2);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: secondReveal.step });
    const secondChart = await secondChartWait;
    assert.equal(secondChart.options[0].count, 2);
    const midBoardWait = waitFor(host, (state) => state.phase === 'leaderboard' && state.number === 2);
    const bevMidWait = waitFor(bev.socket, (state) => state.phase === 'leaderboard' && state.number === 2);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: secondChart.step });
    const midBoard = await midBoardWait;
    assert.equal(midBoard.standings[0].name, 'Bev');
    assert.equal((await bevMidWait).streak, 2);
    assert.equal((await bevMidWait).leading, true);

    const third = waitFor(host, (state) => state.phase === 'question' && state.number === 3);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: midBoard.step });
    await third;
    bev.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const closed = waitFor(host, (state) => state.phase === 'reveal' && state.number === 3);
    await emit(ada.socket, 'player:answer', { choice: 3 });
    const thirdReveal = await closed;
    assert.equal(thirdReveal.correctText, 'Pacific');

    const thirdChart = waitFor(host, (state) => state.phase === 'chart' && state.number === 3);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: thirdReveal.step });
    const afterThird = waitFor(host, (state) => state.phase === 'leaderboard' && state.number === 3);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: (await thirdChart).step });
    const thirdBoard = await afterThird;
    const fourth = waitFor(host, (state) => state.phase === 'question' && state.number === 4);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: thirdBoard.step });
    const lastQuestion = await fourth;
    assert.deepEqual(lastQuestion.options.map((option) => option.text), ['True', 'False']);
    await emit(host, 'host:end', { code: lobby.code, token: 'wrong' });
    const ended = waitFor(ada.socket, (state) => state.phase === 'ended');
    await emit(host, 'host:end', { code: lobby.code, token: lobby.token });
    assert.equal((await ended).phase, 'ended');
    assert.match((await emit(host, 'host:resume', { code: lobby.code, token: lobby.token })).error, /no longer/);
    ada.socket.close();
    host.close();
    stranger.close();
    unicode.socket.close();
  });

  test('a disconnect can close the question, and a short quiz ends on the podium', async () => {
    process.env.QUESTION_MS = '60000';
    const { host, lobby } = await hostGame(server.port, {
      title: 'Short <&>',
      questions: [
        { question: 'One', answers: ['A', 'B', 'C', 'D'], correct: 1 },
        { question: 'Two', answers: ['A', 'B', 'C', 'D'], correct: 1 },
      ],
    });
    const fixed = waitFor(host, (state) => state.shuffleQuestions === false && state.shuffleAnswers === false);
    await emit(host, 'host:options', {
      code: lobby.code,
      token: lobby.token,
      shuffleQuestions: false,
      shuffleAnswers: false,
      revision: 3,
    });
    await fixed;
    const ada = await join(server.port, lobby.code, 'Ada');
    const bev = await join(server.port, lobby.code, 'Bev');
    await emit(bev.socket, 'player:leave', { code: lobby.code, playerId: 'nope', token: 'nope' });
    const started = waitFor(host, (state) => state.phase === 'question');
    assert.equal((await emit(host, 'host:start', { code: 'missing', token: 'nope' })).ok, true);
    await started;

    const reveal = waitFor(ada.socket, (state) => state.phase === 'reveal');
    const hostReveal = waitFor(host, (state) => state.phase === 'reveal');
    bev.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await emit(ada.socket, 'player:answer', { choice: 0 })).ok, true);
    const first = await reveal;
    const hostFirst = await hostReveal;
    assert.equal(first.correct, true);

    const firstChart = waitFor(host, (state) => state.phase === 'chart');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: hostFirst.step });
    const boardWait = waitFor(host, (state) => state.phase === 'leaderboard');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: (await firstChart).step });
    const board = await boardWait;
    process.env.QUESTION_MS = '70';
    const secondWait = waitFor(host, (state) => state.phase === 'question' && state.number === 2);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: board.step });
    await secondWait;
    const missedWait = waitFor(ada.socket, (state) => state.phase === 'reveal' && state.number === 2, 2000);
    const hostMissedWait = waitFor(host, (state) => state.phase === 'reveal' && state.number === 2, 2000);
    const missed = await missedWait;
    const hostMissed = await hostMissedWait;
    assert.equal(missed.answered, false);

    const missedChart = waitFor(host, (state) => state.phase === 'chart' && state.number === 2);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: hostMissed.step });
    const lastBoardWait = waitFor(host, (state) => state.phase === 'leaderboard' && state.number === 2);
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: (await missedChart).step });
    const lastBoard = await lastBoardWait;
    const podiumWait = waitFor(host, (state) => state.phase === 'podium');
    const adaPodiumWait = waitFor(ada.socket, (state) => state.phase === 'podium');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: lastBoard.step });
    const podium = await podiumWait;
    assert.equal(podium.top[0].name, 'Ada');
    assert.equal(podium.top.length, 2);
    assert.equal((await adaPodiumWait).onPodium, true);

    host.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rejoin = await connect(server.port);
    const backWait = waitFor(rejoin, (state) => state.phase === 'podium');
    assert.equal((await emit(rejoin, 'host:resume', { code: lobby.code, token: lobby.token })).ok, true);
    await backWait;
    ada.socket.close();
    rejoin.close();
  });

  test('eight players fill the visible leaderboard and the lower ranks miss the podium', async () => {
    process.env.QUESTION_MS = '80';
    const { host, lobby } = await hostGame(server.port, {
      title: 'Crowd',
      questions: [{ question: 'Q', answers: ['A', 'B', 'C', 'D'], correct: 1 }],
    });
    const names = ['Ann', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'];
    const players = [];
    for (const name of names) players.push(await join(server.port, lobby.code, name));
    const question = waitFor(host, (state) => state.phase === 'question');
    await emit(host, 'host:start', { code: lobby.code, token: lobby.token });
    await question;
    const reveal = await waitFor(host, (state) => state.phase === 'reveal', 2000);
    const chartWait = waitFor(host, (state) => state.phase === 'chart');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: reveal.step });
    const boardWait = waitFor(host, (state) => state.phase === 'leaderboard');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: (await chartWait).step });
    const board = await boardWait;
    assert.equal(board.standings.length, 7);
    assert.equal(board.standings[0].name, 'Ann');
    assert.equal(board.standings[0].previousRank, 1);
    const podiumWait = waitFor(host, (state) => state.phase === 'podium');
    const firstWait = waitFor(players[0].socket, (state) => state.phase === 'podium');
    const fourthWait = waitFor(players[3].socket, (state) => state.phase === 'podium');
    await emit(host, 'host:next', { code: lobby.code, token: lobby.token, step: board.step });
    assert.equal((await podiumWait).top.length, 3);
    assert.equal((await firstWait).onPodium, true);
    assert.equal((await fourthWait).onPodium, false);
    for (const player of players) player.socket.close();
    host.close();
  });

  test('the room stops at 100 players and unknown quizzes are rejected', async () => {
    process.env.QUESTION_MS = '60000';
    const { host, lobby } = await hostGame(server.port, {
      title: 'Cap',
      questions: [{ question: 'Q', answers: ['A', 'B', 'C', 'D'], correct: 1 }],
    });
    const players = [];
    for (let index = 0; index < 100; index += 1) players.push(await join(server.port, lobby.code, `P${index}`));
    const overflow = await connect(server.port);
    assert.match((await emit(overflow, 'player:join', { code: lobby.code, name: 'Overflow' })).error, /full/);
    for (const player of players) player.socket.close();
    overflow.close();
    host.close();

    const stranger = await connect(server.port);
    assert.match((await emit(stranger, 'host:create', { quizId: '../package.json' })).error, /Unknown/);
    assert.match((await emit(stranger, 'host:create', { quizId: 'missing-quiz.json' })).error, /Unknown/);
    assert.match((await emit(stranger, 'host:create', { quizId: 'zz-dir.json' })).error, /.+/);
    assert.match((await emit(stranger, 'host:create', { quiz: { questions: [] } })).error, /at least one/);
    assert.match((await emit(stranger, 'host:options', {})).error, /not hosting/);
    assert.match((await emit(stranger, 'host:resume', { code: 'nope', token: 'nope' })).error, /no longer/);
    assert.equal((await emit(stranger, 'host:end', { code: 'nope', token: 'nope' })).ok, true);
    stranger.close();
  });

  test('the host reveals the answer as soon as the question time is up', async () => {
    process.env.QUESTION_MS = '60000';
    const { host, lobby } = await hostGame(server.port, {
      title: 'Snap',
      questions: [{ question: 'Q', answers: ['A', 'B', 'C', 'D'], correct: 1 }],
    });
    const ada = await join(server.port, lobby.code, 'Ada');
    const questionWait = waitFor(host, (state) => state.phase === 'question');
    await emit(host, 'host:start', { code: lobby.code, token: lobby.token });
    const question = await questionWait;
    process.env.REVEAL_MS = '80';
    try {
      const revealWait = waitFor(host, (state) => state.phase === 'reveal');
      const chartWait = waitFor(host, (state) => state.phase === 'chart');
      const adaReveal = waitFor(ada.socket, (state) => state.phase === 'reveal');
      assert.equal((await emit(host, 'host:next', {
        code: lobby.code,
        token: lobby.token,
        step: question.step,
      })).ok, true);
      assert.equal((await revealWait).text, 'Q');
      assert.equal((await adaReveal).answered, false);
      assert.equal((await chartWait).phase, 'chart');
    } finally {
      process.env.REVEAL_MS = '600000';
    }
    ada.socket.close();
    host.close();
  });

  test('question length falls back when QUESTION_MS is invalid, and the main server boots', async () => {
    process.env.QUESTION_MS = 'not-a-number';
    const slow = await hostGame(server.port, {
      questions: [{ question: 'Q', answers: ['A', 'B', 'C', 'D'], correct: 1 }],
    });
    const player = await join(server.port, slow.lobby.code, 'Tim');
    const questionWait = waitFor(slow.host, (state) => state.phase === 'question');
    await emit(slow.host, 'host:start', { code: slow.lobby.code, token: slow.lobby.token });
    assert.equal((await questionWait).durationMs, 20000);
    assert.equal((await emit(player.socket, 'player:answer', { choice: 0 })).ok, true);
    slow.host.close();
    player.socket.close();

    const child = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: '0', QUESTION_MS: '60000' },
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errorText = '';
    child.stderr.on('data', (chunk) => {
      errorText += chunk;
    });
    const output = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`server did not boot\n${errorText}\n${text}`)), 4000);
      child.stdout.on('data', (chunk) => {
        text += chunk;
        if (text.includes('Not Kahoot host screen')) {
          clearTimeout(timer);
          resolve(text);
        }
      });
    });
    assert.match(output, /Not Kahoot host screen: http:\/\/localhost:0\/host/);
    child.kill('SIGINT');
    await new Promise((resolve) => child.once('exit', resolve));
  });
});
