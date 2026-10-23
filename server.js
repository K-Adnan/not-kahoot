import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import QRCode from 'qrcode';
import { dealQuestion, parseQuizText, questionOrder } from './lib/quiz.js';
import { pointsFor } from './lib/score.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const quizDir = path.join(root, 'quizzes');
const PLAYER_CAP = 100;
const DEFAULT_DURATION_MS = 20000;

const games = new Map();
let io = null;
let listenPort = 3000;

function questionDuration() {
  const configured = Number(process.env.QUESTION_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_DURATION_MS;
  return configured;
}

function pacedDelay(envName, fallback) {
  const configured = Number(process.env[envName]);
  if (!Number.isFinite(configured) || configured < 0) return fallback;
  return configured;
}

function lanUrls(port) {
  const lan = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) lan.push(`http://${entry.address}:${port}`);
    }
  }
  return { local: `http://localhost:${port}`, lan };
}

function tokensMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cleanName(input) {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 16) throw new Error('Name must be 1–16 characters.');
  if (!/^[\p{L}\p{N} .'-]+$/u.test(name)) throw new Error('Use letters and numbers in the name.');
  return name;
}

function makeCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!games.has(code)) return code;
  }
  throw new Error('Could not open a new game. Try again.');
}

function standings(game) {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score || a.scoreTouchedAt - b.scoreTouchedAt || a.name.localeCompare(b.name))
    .map((player, index) => ({
      rank: index + 1,
      name: player.name,
      score: player.score,
      id: player.id,
    }));
}

function connectedPlayers(game) {
  return [...game.players.values()].filter((player) => player.connected);
}

function hostView(game) {
  const urls = lanUrls(listenPort);
  const base = {
    role: 'host',
    phase: game.phase,
    step: game.step,
    token: game.hostToken,
    code: game.code,
    title: game.title,
    urls,
    questionCount: game.order.length,
  };
  if (game.phase === 'lobby') {
    return {
      ...base,
      players: [...game.players.values()].map((player) => ({ name: player.name })),
      joinUrl: playerJoinUrl(game.code),
      qrSvg: game.qrSvg || '',
      shuffleQuestions: game.shuffleQuestions !== false,
      shuffleAnswers: game.shuffleAnswers !== false,
    };
  }
  if (game.phase === 'countdown') {
    return {
      ...base,
      startedAt: game.countdown.startedAt,
      durationMs: game.countdown.durationMs,
      serverNow: Date.now(),
    };
  }
  if (game.phase === 'gap') return base;
  const number = game.questionPos + 1;
  const total = game.order.length;
  if (game.phase === 'question') {
    return {
      ...base,
      number,
      total,
      text: game.current.text,
      options: game.current.options.map(({ text, color, shape }) => ({ text, color, shape })),
      startedAt: game.current.startedAt,
      durationMs: game.current.durationMs,
      serverNow: Date.now(),
      answered: game.current.answers.size,
      playerCount: game.players.size,
    };
  }
  if (game.phase === 'reveal' || game.phase === 'chart') {
    const counts = game.current.options.map(() => 0);
    let correctCount = 0;
    for (const answer of game.current.answers.values()) {
      counts[answer.choice] += 1;
      if (answer.correct) correctCount += 1;
    }
    return {
      ...base,
      number,
      total,
      text: game.current.text,
      correctText: game.current.options[game.current.correctIndex].text,
      correctCount,
      playerCount: game.players.size,
      options: game.current.options.map((option, index) => ({
        text: option.text,
        color: option.color,
        shape: option.shape,
        correct: option.correct,
        count: counts[index],
      })),
    };
  }
  if (game.phase === 'leaderboard') {
    return {
      ...base,
      number,
      total,
      standings: leaderboardRows(game),
    };
  }
  return {
    ...base,
    top: standings(game).slice(0, 3).map(({ rank, name, score }) => ({ rank, name, score })),
  };
}

function standingGap(ranked, playerId) {
  const index = ranked.findIndex((row) => row.id === playerId);
  if (index < 0) return { rank: null, leading: false, gap: null, rivalName: null, rivalRank: null };
  if (index === 0) {
    const next = ranked[1];
    return {
      rank: ranked[0].rank,
      leading: true,
      gap: next ? ranked[0].score - next.score : null,
      rivalName: next ? next.name : null,
      rivalRank: next ? next.rank : null,
    };
  }
  const above = ranked[index - 1];
  return {
    rank: ranked[index].rank,
    leading: false,
    gap: above.score - ranked[index].score,
    rivalName: above.name,
    rivalRank: above.rank,
  };
}

function playerView(game, player) {
  const ranked = standings(game);
  const gap = standingGap(ranked, player.id);
  const base = {
    role: 'player',
    phase: game.phase,
    code: game.code,
    playerId: player.id,
    token: player.token,
    name: player.name,
    score: player.score,
    title: game.title,
  };
  if (game.phase === 'lobby') return { ...base, playerCount: game.players.size };
  if (game.phase === 'countdown') {
    return {
      ...base,
      startedAt: game.countdown.startedAt,
      durationMs: game.countdown.durationMs,
      serverNow: Date.now(),
    };
  }
  if (game.phase === 'gap') return base;
  const number = game.questionPos + 1;
  const total = game.order.length;
  if (game.phase === 'question') {
    const mine = game.current.answers.get(player.id);
    return {
      ...base,
      number,
      total,
      startedAt: game.current.startedAt,
      durationMs: game.current.durationMs,
      serverNow: Date.now(),
      locked: Boolean(mine),
      selected: mine ? mine.choice : null,
      choices: game.current.options.map((option) => ({
        color: option.color,
        shape: option.shape,
        text: game.current.options.length === 2 ? option.text : '',
      })),
    };
  }
  if (game.phase === 'reveal' || game.phase === 'chart') {
    const mine = game.current.answers.get(player.id);
    return {
      ...base,
      number,
      total,
      answered: Boolean(mine),
      correct: Boolean(mine?.correct),
      pointsAwarded: mine?.points ?? 0,
      streak: player.streak || 0,
      rank: gap.rank,
      leading: gap.leading,
      gap: gap.gap,
      rivalName: gap.rivalName,
      rivalRank: gap.rivalRank,
    };
  }
  if (game.phase === 'leaderboard') {
    return {
      ...base,
      number,
      total,
      streak: player.streak || 0,
      rank: gap.rank,
      leading: gap.leading,
      gap: gap.gap,
      rivalName: gap.rivalName,
      rivalRank: gap.rivalRank,
    };
  }
  return { ...base, rank: gap.rank, onPodium: gap.rank != null && gap.rank <= 3 };
}

function publish(game) {
  if (game.hostSocketId) io.to(game.hostSocketId).emit('state', hostView(game));
  for (const player of game.players.values()) {
    if (player.connected && player.socketId) io.to(player.socketId).emit('state', playerView(game, player));
  }
}

function leaderboardRows(game) {
  return standings(game).slice(0, 7).map((row) => ({
    rank: row.rank,
    name: row.name,
    score: row.score,
    previousRank: game.previousRanks?.get(row.id) ?? row.rank,
  }));
}

function beginCountdown(game) {
  clearTimeout(game.timer);
  const durationMs = pacedDelay('COUNTDOWN_MS', 3000);
  game.countdown = { startedAt: Date.now(), durationMs };
  game.phase = 'countdown';
  game.step += 1;
  game.timer = setTimeout(() => beginQuestion(game), durationMs);
  publish(game);
}

function beginGap(game) {
  clearTimeout(game.timer);
  game.phase = 'gap';
  game.step += 1;
  const durationMs = pacedDelay('GAP_MS', 1000);
  game.timer = setTimeout(() => beginQuestion(game), durationMs);
  publish(game);
}

function beginQuestion(game) {
  game.previousRanks = new Map(standings(game).map((row) => [row.id, row.rank]));
  const question = game.questions[game.order[game.questionPos]];
  const dealt = dealQuestion(question, undefined, game.shuffleAnswers !== false);
  const durationMs = questionDuration();
  game.current = {
    text: dealt.text,
    options: dealt.options,
    correctIndex: dealt.correctIndex,
    startedAt: Date.now(),
    durationMs,
    answers: new Map(),
  };
  game.phase = 'question';
  game.step += 1;
  clearTimeout(game.timer);
  game.timer = setTimeout(() => closeQuestion(game), durationMs);
  publish(game);
}

function closeQuestion(game) {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  game.timer = null;
  for (const player of game.players.values()) {
    if (!game.current.answers.has(player.id)) player.streak = 0;
  }
  game.phase = 'reveal';
  game.step += 1;
  publish(game);
  const delay = pacedDelay('REVEAL_MS', 2000);
  game.timer = setTimeout(() => {
    if (game.phase !== 'reveal') return;
    advance(game);
  }, delay);
}

function maybeClose(game) {
  if (game.phase !== 'question') return;
  const waiting = connectedPlayers(game).filter((player) => !game.current.answers.has(player.id));
  if (waiting.length === 0) closeQuestion(game);
}

function advance(game) {
  if (game.phase === 'reveal' || game.phase === 'chart') {
    game.phase = game.phase === 'reveal' ? 'chart' : 'leaderboard';
    game.step += 1;
    publish(game);
    return;
  }
  if (game.phase !== 'leaderboard') return;
  if (game.questionPos >= game.order.length - 1) {
    game.phase = 'podium';
    game.step += 1;
    publish(game);
    return;
  }
  game.questionPos += 1;
  beginGap(game);
}

async function listQuizzes() {
  const files = (await readdir(quizDir)).filter((name) => /\.(json|csv)$/i.test(name)).sort();
  const quizzes = [];
  for (const file of files) {
    try {
      const quiz = parseQuizText(file, await readFile(path.join(quizDir, file), 'utf8'));
      quizzes.push({ id: file, title: quiz.title, questionCount: quiz.questions.length });
    } catch (error) {
      quizzes.push({ id: file, title: file, questionCount: 0, error: error.message });
    }
  }
  return quizzes;
}

async function loadQuiz(id) {
  const base = path.basename(String(id ?? ''));
  if (base !== id || !/\.(json|csv)$/i.test(base)) throw new Error('Unknown quiz.');
  const full = path.join(quizDir, base);
  try {
    return parseQuizText(base, await readFile(full, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Unknown quiz.');
    throw error;
  }
}

function playerJoinUrl(code) {
  const urls = lanUrls(listenPort);
  const base = urls.lan[0] || urls.local;
  return `${base}/?code=${code}`;
}

async function attachQr(game) {
  const url = playerJoinUrl(game.code);
  if (game.qrFor === url && game.qrSvg) return;
  game.qrFor = url;
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#101426', light: '#ffffff' },
    });
    game.qrSvg = String(svg).replace(/<\?xml[^>]*>\s*/i, '').trim();
  } catch {
    game.qrSvg = '';
  }
}

function createGame(quiz) {
  const code = makeCode();
  const game = {
    code,
    hostToken: crypto.randomBytes(24).toString('hex'),
    hostSocketId: null,
    title: quiz.title,
    questions: quiz.questions,
    order: questionOrder(quiz.questions.length, false),
    shuffleQuestions: true,
    shuffleAnswers: true,
    qrFor: '',
    qrSvg: '',
    optionsRevision: 0,
    phase: 'lobby',
    questionPos: 0,
    step: 1,
    current: null,
    timer: null,
    players: new Map(),
  };
  games.set(code, game);
  return game;
}

function findPlayer(game, playerId, token) {
  const player = game.players.get(playerId);
  if (!player || !tokensMatch(player.token, token)) return null;
  return player;
}

function onConnection(socket) {
  socket.on('host:create', async (payload, ack) => {
    try {
      const quiz = payload?.quiz ? parseQuizText('upload.json', JSON.stringify(payload.quiz)) : await loadQuiz(payload?.quizId);
      const game = createGame(quiz);
      game.hostSocketId = socket.id;
      await attachQr(game);
      ack?.({ ok: true, code: game.code, token: game.hostToken });
      publish(game);
    } catch (error) {
      ack?.({ ok: false, error: error.message || 'Could not start that quiz.' });
    }
  });

  socket.on('host:resume', async (payload, ack) => {
    const game = games.get(String(payload?.code ?? ''));
    if (!game || !tokensMatch(game.hostToken, payload?.token)) {
      ack?.({ ok: false, error: 'This game is no longer available.' });
      return;
    }
    game.hostSocketId = socket.id;
    await attachQr(game);
    ack?.({ ok: true });
    publish(game);
  });

  socket.on('host:options', (payload, ack) => {
    const game = gameForHost(socket, payload);
    if (!game) return ack?.({ ok: false, error: 'You are not hosting this game.' });
    if (game.phase !== 'lobby') return ack?.({ ok: false, error: 'The quiz has already started.' });
    const revision = Number(payload?.revision);
    if (Number.isInteger(revision) && revision < (game.optionsRevision || 0)) {
      ack?.({ ok: true, ignored: true });
      return;
    }
    if (Number.isInteger(revision)) game.optionsRevision = revision;
    if (typeof payload?.shuffleQuestions === 'boolean') game.shuffleQuestions = payload.shuffleQuestions;
    if (typeof payload?.shuffleAnswers === 'boolean') game.shuffleAnswers = payload.shuffleAnswers;
    publish(game);
    ack?.({ ok: true });
  });

  socket.on('host:start', (payload, ack) => {
    const game = gameForHost(socket, payload);
    if (!game) return ack?.({ ok: false, error: 'You are not hosting this game.' });
    if (game.phase !== 'lobby') return ack?.({ ok: false, error: 'The quiz has already started.' });
    if (game.players.size < 1) return ack?.({ ok: false, error: 'Wait for at least one player.' });
    game.order = questionOrder(game.questions.length, game.shuffleQuestions !== false);
    game.questionPos = 0;
    beginCountdown(game);
    ack?.({ ok: true });
  });

  socket.on('host:next', (payload, ack) => {
    const game = gameForHost(socket, payload);
    if (!game) return ack?.({ ok: false, error: 'You are not hosting this game.' });
    if (payload?.step !== game.step) return ack?.({ ok: true, ignored: true });
    if (game.phase === 'question') {
      closeQuestion(game);
      ack?.({ ok: true });
      return;
    }
    if (game.phase === 'reveal') clearTimeout(game.timer);
    if (game.phase !== 'reveal' && game.phase !== 'chart' && game.phase !== 'leaderboard') {
      return ack?.({ ok: false, error: 'Not ready for the next screen.' });
    }
    advance(game);
    ack?.({ ok: true });
  });

  socket.on('host:end', (payload, ack) => {
    const game = games.get(String(payload?.code ?? ''));
    if (game && tokensMatch(game.hostToken, payload?.token)) endGame(game);
    ack?.({ ok: true });
  });

  socket.on('player:join', (payload, ack) => {
    try {
      const code = String(payload?.code ?? '').replace(/\D/g, '');
      const game = games.get(code);
      if (!game) throw new Error('No game found for that code.');
      if (game.phase !== 'lobby') throw new Error('This quiz has already started.');
      if (game.players.size >= PLAYER_CAP) throw new Error('This game is full.');
      const name = cleanName(payload?.name);
      const taken = [...game.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase());
      if (taken) throw new Error('That name is already in this game.');
      const player = {
        id: crypto.randomBytes(12).toString('hex'),
        token: crypto.randomBytes(24).toString('hex'),
        name,
        score: 0,
        streak: 0,
        scoreTouchedAt: Date.now(),
        socketId: socket.id,
        connected: true,
      };
      game.players.set(player.id, player);
      ack?.({ ok: true, code: game.code, playerId: player.id, token: player.token });
      publish(game);
    } catch (error) {
      ack?.({ ok: false, error: error.message || 'Could not join.' });
    }
  });

  socket.on('player:resume', (payload, ack) => {
    const game = games.get(String(payload?.code ?? '').replace(/\D/g, ''));
    const player = game && findPlayer(game, payload?.playerId, payload?.token);
    if (!player) {
      ack?.({ ok: false, error: 'This game is no longer available.' });
      return;
    }
    player.socketId = socket.id;
    player.connected = true;
    ack?.({ ok: true });
    publish(game);
  });

  socket.on('player:leave', (payload, ack) => {
    const game = games.get(String(payload?.code ?? '').replace(/\D/g, ''));
    const player = game && findPlayer(game, payload?.playerId, payload?.token);
    if (player && game.phase === 'lobby') {
      game.players.delete(player.id);
      publish(game);
    }
    ack?.({ ok: true });
  });

  socket.on('player:answer', (payload, ack) => {
    const game = findGameBySocket(socket);
    const player = game && [...game.players.values()].find((entry) => entry.socketId === socket.id);
    if (!game || !player) return ack?.({ ok: false, error: 'Join a game first.' });
    if (game.phase !== 'question') return ack?.({ ok: false, error: 'There is no question open.' });
    if (game.current.answers.has(player.id)) return ack?.({ ok: true, ignored: true });
    const choice = Number(payload?.choice);
    const choiceCount = game.current.options.length;
    if (!Number.isInteger(choice) || choice < 0 || choice >= choiceCount) {
      const error = choiceCount === 2 ? 'Pick true or false.' : 'Pick one of the four answers.';
      return ack?.({ ok: false, error });
    }
    const elapsed = Date.now() - game.current.startedAt;
    if (elapsed > game.current.durationMs) return ack?.({ ok: false, error: 'Too late.' });
    const correct = choice === game.current.correctIndex;
    player.streak = correct ? (player.streak || 0) + 1 : 0;
    const points = pointsFor(elapsed, correct, game.current.durationMs, player.streak || 1);
    game.current.answers.set(player.id, { choice, correct, points, elapsed, streak: player.streak });
    if (points > 0) {
      player.score += points;
      player.scoreTouchedAt = Date.now();
    }
    ack?.({ ok: true });
    publish(game);
    maybeClose(game);
  });

  socket.on('disconnect', () => {
    for (const game of games.values()) {
      if (game.hostSocketId === socket.id) game.hostSocketId = null;
      for (const player of game.players.values()) {
        if (player.socketId !== socket.id) continue;
        player.connected = false;
        player.socketId = null;
        if (game.phase === 'lobby') game.players.delete(player.id);
        publish(game);
        maybeClose(game);
      }
    }
  });
}

function endGame(game) {
  clearTimeout(game.timer);
  for (const player of game.players.values()) {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit('state', { role: 'player', phase: 'ended' });
    }
  }
  games.delete(game.code);
}

function gameForHost(socket, payload) {
  const game = games.get(String(payload?.code ?? ''));
  if (!game) {
    return [...games.values()].find((entry) => entry.hostSocketId === socket.id) ?? null;
  }
  if (game.hostSocketId !== socket.id && !tokensMatch(game.hostToken, payload?.token)) return null;
  return game;
}

function findGameBySocket(socket) {
  return [...games.values()].find((game) => [...game.players.values()].some((player) => player.socketId === socket.id));
}

function buildApp() {
  const app = express();
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/info', (_req, res) => res.json(lanUrls(listenPort)));
  app.get('/api/quizzes', async (_req, res, next) => {
    try {
      res.json(await listQuizzes());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/quizzes', async (req, res) => {
    try {
      const name = safeQuizName(req.body?.name);
      const quiz = parseQuizText(name, req.body?.text ?? '');
      await writeFile(path.join(quizDir, name), String(req.body.text), 'utf8');
      res.json({ id: name, title: quiz.title, questionCount: quiz.questions.length });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Could not read that file.' });
    }
  });
  app.use(express.static(publicDir, { extensions: ['html'] }));
  return app;
}

function safeQuizName(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  if (ext !== '.json' && ext !== '.csv') throw new Error('Use a .json or .csv file.');
  const stem = path.basename(String(name), path.extname(String(name)))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!stem) throw new Error('Give the file a name.');
  return `${stem}${ext}`;
}

export async function start(port = 0) {
  const app = buildApp();
  const httpServer = createServer(app);
  io = new Server(httpServer);
  io.on('connection', onConnection);
  await new Promise((resolve) => httpServer.listen(port, resolve));
  listenPort = httpServer.address().port;
  return {
    port: listenPort,
    async stop() {
      for (const game of games.values()) clearTimeout(game.timer);
      games.clear();
      io.close();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  start(port).then(() => {
    const urls = lanUrls(port);
    console.log(`Not Kahoot host screen: ${urls.local}/host`);
    for (const url of urls.lan) console.log(`Players on the same Wi-Fi: ${url}`);
  });
}
