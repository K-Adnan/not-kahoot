(function () {
  const app = document.querySelector('#app');
  const socket = io();
  let model = null;
  let paintedKey = '';
  let mode = 'setup';
  let optionsRevision = 0;
  let latestOptionsRevision = 0;
  let quizzes = [];
  let info = { local: '', lan: [] };
  let notice = '';
  let motionTimer = 0;
  let confirmingEnd = false;

  NotKahoot.startClock(() => model, () => {
    if (model?.phase === 'question') nextScreen(model.step);
  });

  socket.on('connect', () => {
    document.body.classList.remove('offline');
    const saved = NotKahoot.storageGet('not-kahoot-host');
    if (saved?.code && saved?.token) socket.emit('host:resume', saved);
  });

  socket.on('disconnect', () => document.body.classList.add('offline'));

  socket.on('state', (state) => {
    if (state.role !== 'host') return;
    model = NotKahoot.stamp(model, state);
    mode = 'live';
    NotKahoot.storageSet('not-kahoot-host', { code: state.code, token: state.token });
    const key = NotKahoot.viewKey(state);
    if (key !== paintedKey) {
      paintedKey = key;
      notice = '';
      paint();
    } else {
      const node = document.querySelector('[data-answered]');
      if (node) node.textContent = String(state.answered);
    }
  });

  app.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'host') return hostQuiz(button.dataset.quizId);
    if (action === 'start') return startQuiz();
    if (action === 'next') return nextScreen(Number(button.dataset.step));
    if (action === 'end') {
      confirmingEnd = true;
      if (!document.querySelector('.confirm-end')) app.insertAdjacentHTML('beforeend', confirmEndDialog());
      return;
    }
    if (action === 'dismiss-end') {
      confirmingEnd = false;
      document.querySelector('.confirm-end')?.remove();
      return;
    }
    if (action === 'confirm-end') return endGame();
    if (action === 'cancel' || action === 'new') return endGame();
  });

  app.addEventListener('change', (event) => {
    const input = event.target.closest('[data-upload]');
    if (input?.files?.[0]) uploadFile(input.files[0]);
    if (event.target.closest('[data-option]')) updateOptions();
  });

  app.addEventListener('dragover', (event) => {
    if (event.target.closest('[data-drop]')) event.preventDefault();
  });

  app.addEventListener('drop', (event) => {
    const zone = event.target.closest('[data-drop]');
    if (!zone) return;
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  });

  document.addEventListener('keydown', (event) => {
    if (confirmingEnd) return;
    if (event.key === 'Enter' && model && (model.phase === 'reveal' || model.phase === 'chart' || model.phase === 'leaderboard')) {
      nextScreen(model.step);
    }
  });

  async function hostQuiz(quizId) {
    notice = '';
    const response = await NotKahoot.emit(socket, 'host:create', { quizId });
    if (!response.ok) {
      notice = response.error;
      paintSetup();
    }
  }

  async function updateOptions() {
    if (!model || model.phase !== 'lobby') return;
    const shuffleQuestions = Boolean(document.querySelector('[data-option="shuffleQuestions"]')?.checked);
    const shuffleAnswers = Boolean(document.querySelector('[data-option="shuffleAnswers"]')?.checked);
    model.shuffleQuestions = shuffleQuestions;
    model.shuffleAnswers = shuffleAnswers;
    const revision = Date.now() * 1000 + (++optionsRevision);
    latestOptionsRevision = revision;
    const response = await NotKahoot.emit(socket, 'host:options', {
      code: model.code,
      token: model.token,
      shuffleQuestions,
      shuffleAnswers,
      revision,
    });
    if (revision !== latestOptionsRevision) return;
    if (!response.ok && model?.phase === 'lobby') {
      notice = response.error;
      paint();
    }
  }

  async function startQuiz() {
    const response = await NotKahoot.emit(socket, 'host:start', { code: model.code, token: model.token });
    if (!response.ok && model?.phase === 'lobby') {
      notice = response.error;
      paint();
    }
  }

  async function nextScreen(step) {
    await NotKahoot.emit(socket, 'host:next', { code: model.code, token: model.token, step });
  }

  async function endGame() {
    confirmingEnd = false;
    if (model?.code) await NotKahoot.emit(socket, 'host:end', { code: model.code, token: model.token });
    NotKahoot.storageClear('not-kahoot-host');
    model = null;
    paintedKey = '';
    mode = 'setup';
    notice = '';
    await loadSetup();
  }

  async function uploadFile(file) {
    notice = '';
    const text = await file.text();
    const response = await fetch('/api/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, text }),
    });
    const body = await response.json();
    if (!response.ok) {
      notice = body.error || 'Could not read that file.';
      paintSetup();
      return;
    }
    await loadSetup();
  }

  async function loadSetup() {
    const [quizResponse, infoResponse] = await Promise.all([fetch('/api/quizzes'), fetch('/api/info')]);
    quizzes = await quizResponse.json();
    info = await infoResponse.json();
    if (mode === 'setup') paintSetup();
  }

  function paint() {
    clearTimeout(motionTimer);
    if (model.phase === 'lobby') app.innerHTML = lobbyView();
    else if (model.phase === 'countdown') app.innerHTML = countdownView();
    else if (model.phase === 'gap') app.innerHTML = '';
    else if (model.phase === 'question') app.innerHTML = questionView();
    else if (model.phase === 'reveal') app.innerHTML = revealView();
    else if (model.phase === 'chart') app.innerHTML = chartView();
    else if (model.phase === 'leaderboard') {
      app.innerHTML = leaderboardView();
      primeBoardMotion();
    }
    else if (model.phase === 'podium') app.innerHTML = podiumView();
    app.insertAdjacentHTML('beforeend', endQuizButton());
    if (confirmingEnd) app.insertAdjacentHTML('beforeend', confirmEndDialog());
  }

  function endQuizButton() {
    return '<button class="end-quiz" type="button" data-action="end">End Quiz</button>';
  }

  function confirmEndDialog() {
    return `
      <div class="confirm-end" role="dialog" aria-modal="true" aria-labelledby="end-quiz-title">
        <div class="confirm-card">
          <h2 id="end-quiz-title">End the quiz?</h2>
          <p>Are you sure you want to end the quiz and go back to the home screen?</p>
          <div class="confirm-actions">
            <button class="ghost" type="button" data-action="dismiss-end">Keep playing</button>
            <button class="primary" type="button" data-action="confirm-end">Yes, end the quiz</button>
          </div>
        </div>
      </div>`;
  }

  function paintSetup() {
    app.innerHTML = `
      <main class="wrap setup">
        ${NotKahoot.logoMark()}
        <h1>Host a quiz</h1>
        <p class="lede">Put a JSON or CSV quiz on this screen, then let everyone join from their phones.</p>
        <label class="drop" data-drop>
          <input data-upload type="file" accept=".json,.csv,application/json,text/csv">
          <strong>Drop a quiz file</strong>
          <span>or click to browse. .json and .csv</span>
        </label>
        ${notice ? `<p class="banner-error" role="alert">${NotKahoot.esc(notice)}</p>` : ''}
        <section class="quiz-grid">
          ${quizzes.map(quizCard).join('') || '<p class="muted">No quiz files yet. Drop one above.</p>'}
        </section>
      </main>`;
  }

  function quizCard(quiz) {
    if (quiz.error) {
      return `<article class="quiz-card broken"><h2>${NotKahoot.esc(quiz.title)}</h2><p>${NotKahoot.esc(quiz.error)}</p></article>`;
    }
    return `
      <article class="quiz-card">
        <h2>${NotKahoot.esc(quiz.title)}</h2>
        <p>${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'}</p>
        <button class="primary" data-action="host" data-quiz-id="${NotKahoot.esc(quiz.id)}">Host this quiz</button>
      </article>`;
  }

  function lobbyView() {
    const urls = model.urls?.lan?.length ? model.urls.lan : [model.urls?.local || info.local];
    return `
      <main class="wrap lobby">
        ${NotKahoot.logoMark(true)}
        <header class="split">
          <div>
            <h1>${NotKahoot.esc(model.title)}</h1>
          </div>
          <button class="ghost" data-action="cancel">Change quiz</button>
        </header>
        <div class="join-layout">
          <div>
            <p class="eyebrow">Join at</p>
            <div class="url-list">
              ${urls.map((url) => `<p class="join-url">${NotKahoot.esc(url)}</p>`).join('')}
            </div>
            <p class="eyebrow">Game code</p>
            <p class="code">${NotKahoot.esc(NotKahoot.formatCode(model.code))}</p>
          </div>
          <figure class="qr-card">
            <div class="qr" role="img" aria-label="QR code for game ${NotKahoot.esc(NotKahoot.formatCode(model.code))}">
              ${model.qrSvg || '<p class="qr-missing">QR unavailable</p>'}
            </div>
            <figcaption>Scan to join</figcaption>
          </figure>
        </div>
        <fieldset class="toggles">
          <legend class="eyebrow">Before you start</legend>
          <label class="toggle">
            <input type="checkbox" data-option="shuffleQuestions" ${model.shuffleQuestions ? 'checked' : ''}>
            Randomise questions
          </label>
          <label class="toggle">
            <input type="checkbox" data-option="shuffleAnswers" ${model.shuffleAnswers ? 'checked' : ''}>
            Randomise answers
          </label>
        </fieldset>
        <section class="roster">
          <div class="split">
            <h2>${model.players.length} joined</h2>
            <p class="muted">${model.questionCount} questions · 20 seconds each</p>
          </div>
          <div class="chips">
            ${model.players.map((player) => `<span class="chip" style="--chip:${hue(player.name)}">${NotKahoot.esc(player.name)}</span>`).join('')
              || '<p class="muted">Names appear here as players join.</p>'}
          </div>
        </section>
        ${notice ? `<p class="banner-error" role="alert">${NotKahoot.esc(notice)}</p>` : ''}
        <button class="primary xl" data-action="start" ${model.players.length ? '' : 'disabled'}>Start quiz</button>
      </main>`;
  }

  function countdownView() {
    return `
      <main class="wrap stage countdown-screen">
        ${NotKahoot.logoMark(true)}
        <p class="brand">${NotKahoot.esc(model.title)}</p>
        <p class="eyebrow">Get ready</p>
        <h1 class="countdown-num" data-count>${NotKahoot.secondsLeft(model)}</h1>
      </main>`;
  }

  function nextButton() {
    return `<div class="next-dock"><button class="primary xl" data-action="next" data-step="${model.step}">Next</button></div>`;
  }

  function questionView() {
    return `
      <main class="wrap stage">
        <h1 class="prompt">${NotKahoot.esc(model.text)}</h1>
        ${stageHead()}
        <p class="answer-count" data-answered>${model.answered}</p>
        ${optionGrid(model.options)}
        ${nextButton()}
      </main>`;
  }

  function revealView() {
    return `
      <main class="wrap stage">
        <h1 class="prompt">${NotKahoot.esc(model.text)}</h1>
        ${stageHead()}
        ${optionGrid(model.options, true)}
        ${nextButton()}
      </main>`;
  }

  function chartView() {
    const peak = Math.max(1, ...model.options.map((option) => option.count || 0));
    return `
      <main class="wrap stage">
        <h1 class="prompt">${NotKahoot.esc(model.text)}</h1>
        <p class="brand">Answers</p>
        <p class="eyebrow">Question ${model.number} of ${model.total}</p>
        <ol class="bars">
          ${model.options.map((option) => {
            const pct = Math.round(((option.count || 0) / peak) * 100);
            const count = NotKahoot.formatScore(option.count);
            const name = `${option.text}, ${count}${option.correct ? ', correct answer' : ''}`;
            return `
            <li class="bar-row tone-${option.color}${option.correct ? ' is-correct' : ''}" style="--pct:${pct}" aria-label="${NotKahoot.esc(name)}">
              <p class="bar-score">
                ${option.correct ? '<span class="bar-tick" aria-label="Correct answer">✓</span>' : ''}
                <span class="bar-count">${count}</span>
              </p>
              <div class="bar-grow">
                <div class="bar-col ${option.color}">
                  <span class="bar-fill"></span>
                  <span class="bar-foot">${NotKahoot.shape(option.shape)}</span>
                </div>
              </div>
              <p class="bar-label">${NotKahoot.esc(option.text)}</p>
            </li>`;
          }).join('')}
        </ol>
        ${nextButton()}
      </main>`;
  }

  function leaderboardView() {
    return `
      <main class="wrap stage">
        <p class="brand">Leaderboard</p>
        <p class="eyebrow">Question ${model.number} of ${model.total}</p>
        <ol class="board">
          ${model.standings.map((row) => `
            <li data-rank="${row.rank}" data-from="${row.previousRank}">
              <span class="rank">${row.rank}</span>
              <span class="who">${NotKahoot.esc(row.name)}</span>
              <span class="pts">${NotKahoot.formatScore(row.score)}</span>
            </li>`).join('')}
        </ol>
        ${nextButton()}
      </main>`;
  }

  function podiumView() {
    const order = arrangePodium(model.top);
    return `
      <main class="wrap stage podium-wrap">
        ${NotKahoot.logoMark(true)}
        <p class="brand">That's the quiz</p>
        <h1>Top 3</h1>
        <div class="podium">
          ${order.map((row) => `
            <article class="place place-${row.rank}">
              <p class="medal">${row.rank}</p>
              <h2>${NotKahoot.esc(row.name)}</h2>
              <p>${NotKahoot.formatScore(row.score)} pts</p>
            </article>`).join('')}
        </div>
        <button class="primary xl" data-action="new">New quiz</button>
      </main>`;
  }

  function stageHead() {
    const urgent = NotKahoot.secondsLeft(model) <= 5 ? ' urgent' : '';
    return `
      <header class="stage-head">
        <p class="brand">${NotKahoot.esc(model.title)}</p>
        <div class="timer${model.phase === 'question' ? '' : ' hidden'}" aria-hidden="${model.phase === 'question' ? 'false' : 'true'}">
          <strong data-count class="${urgent.trim()}">${model.phase === 'question' ? NotKahoot.secondsLeft(model) : ''}</strong>
        </div>
        <p class="count">Question ${model.number} <span>of ${model.total}</span></p>
      </header>`;
  }

  function optionGrid(options, reveal) {
    return `
      <div class="options${options.length === 2 ? ' two' : ''}">
        ${options.map((option) => `
          <article class="answer-card ${option.color}${reveal && option.correct ? ' is-correct' : ''}${reveal && !option.correct ? ' is-faded' : ''}">
            <span class="shape">${NotKahoot.shape(option.shape)}</span>
            <span class="label">${NotKahoot.esc(option.text)}</span>
          </article>`).join('')}
      </div>`;
  }

  function primeBoardMotion() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rows = [...document.querySelectorAll('.board li')];
    if (rows.length < 2) return;
    const stride = rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top;
    if (!stride) return;
    const moves = [];
    for (const row of rows) {
      const from = Number(row.dataset.from);
      const to = Number(row.dataset.rank);
      if (!from || from === to) continue;
      const shift = Math.max(-rows.length, Math.min(rows.length, from - to));
      if (!shift) continue;
      moves.push({ row, shift });
    }
    if (!moves.length) return;
    for (const move of moves) move.row.style.transform = `translateY(${move.shift * stride}px)`;
    motionTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        for (const move of moves) {
          if (!move.row.isConnected) continue;
          move.row.classList.add('is-moving');
          if (move.shift > 0) move.row.classList.add('is-rising');
        }
        requestAnimationFrame(() => {
          for (const move of moves) {
            if (!move.row.isConnected) continue;
            move.row.style.transform = 'translateY(0)';
          }
        });
      });
    }, 1000);
  }

  function arrangePodium(top) {
    const byRank = Object.fromEntries(top.map((row) => [row.rank, row]));
    const order = top.length >= 3 ? [2, 1, 3] : top.length === 2 ? [2, 1] : [1];
    return order.map((rank) => byRank[rank]).filter(Boolean);
  }

  function hue(name) {
    let hash = 0;
    for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) % 360;
    return `${hash} 72% 58%`;
  }

  loadSetup();
})();
