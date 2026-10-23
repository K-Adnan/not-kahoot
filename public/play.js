(function () {
  const app = document.querySelector('#app');
  const socket = io();
  let model = null;
  let paintedKey = '';
  let notice = '';
  let sending = false;

  NotKahoot.startClock(() => model);

  socket.on('connect', async () => {
    document.body.classList.remove('offline');
    const saved = NotKahoot.storageGet('not-kahoot-player');
    if (!saved?.code || !saved.playerId || !saved.token) return;
    const response = await NotKahoot.emit(socket, 'player:resume', saved);
    if (!response.ok) {
      NotKahoot.storageClear('not-kahoot-player');
      model = null;
      paintedKey = '';
      notice = 'That game has ended. Join with a new code.';
      paintJoin();
    }
  });

  socket.on('disconnect', () => document.body.classList.add('offline'));

  socket.on('state', (state) => {
    if (state.phase === 'ended') {
      NotKahoot.storageClear('not-kahoot-player');
      model = null;
      paintedKey = '';
      notice = 'The host ended this game.';
      paintJoin();
      return;
    }
    if (state.role !== 'player') return;
    model = NotKahoot.stamp(model, state);
    NotKahoot.storageSet('not-kahoot-player', { code: state.code, playerId: state.playerId, token: state.token });
    const key = NotKahoot.viewKey(state);
    if (key !== paintedKey) {
      paintedKey = key;
      paint();
    }
  });

  app.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-join]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    notice = '';
    const response = await NotKahoot.emit(socket, 'player:join', {
      code: String(data.get('code') || ''),
      name: String(data.get('name') || ''),
    });
    if (!response.ok) {
      notice = response.error;
      paintJoin();
    }
  });

  app.addEventListener('click', async (event) => {
    const choice = event.target.closest('[data-choice]');
    if (choice) return answer(Number(choice.dataset.choice));
    if (event.target.closest('[data-leave]')) {
      const saved = NotKahoot.storageGet('not-kahoot-player');
      if (saved) await NotKahoot.emit(socket, 'player:leave', saved);
      NotKahoot.storageClear('not-kahoot-player');
      model = null;
      paintedKey = '';
      notice = '';
      paintJoin();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!model || model.phase !== 'question' || model.locked) return;
    const choices = model.choices?.length || NotKahoot.COLORS.length;
    const index = ['1', '2', '3', '4'].indexOf(event.key);
    if (index >= 0 && index < choices) answer(index);
  });

  async function answer(choice) {
    if (sending || !model || model.phase !== 'question' || model.locked) return;
    sending = true;
    document.querySelector('.pad')?.classList.add('is-locked');
    document.querySelector(`[data-choice="${choice}"]`)?.classList.add('selected');
    const response = await NotKahoot.emit(socket, 'player:answer', { choice });
    sending = false;
    if (!response.ok && !response.ignored && model?.phase === 'question' && !model.locked) {
      notice = response.error;
      paintedKey = '';
      paint();
    }
  }

  function paint() {
    if (model.phase === 'lobby') app.innerHTML = waitView();
    else if (model.phase === 'countdown') app.innerHTML = countdownView();
    else if (model.phase === 'gap') app.innerHTML = '';
    else if (model.phase === 'question') app.innerHTML = questionView();
    else if (model.phase === 'reveal' || model.phase === 'chart') app.innerHTML = revealView();
    else if (model.phase === 'leaderboard') app.innerHTML = betweenView();
    else if (model.phase === 'podium') app.innerHTML = podiumView();
  }

  function codeFromLocation() {
    const raw = new URLSearchParams(window.location.search).get('code') || '';
    return raw.replace(/\D/g, '').slice(0, 6);
  }

  function paintJoin() {
    const code = codeFromLocation();
    app.innerHTML = `
      <main class="phone join">
        ${NotKahoot.logoMark()}
        <h1>Join a game</h1>
        <form data-join>
          <label>Game code
            <input name="code" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000 000" value="${NotKahoot.esc(NotKahoot.formatCode(code))}" required>
          </label>
          <label>Your name
            <input name="name" maxlength="16" autocomplete="nickname" placeholder="Alex" required>
          </label>
          ${notice ? `<p class="banner-error" role="alert">${NotKahoot.esc(notice)}</p>` : ''}
          <button class="primary xl" type="submit">Join</button>
        </form>
      </main>`;
    const focusName = code.length === 6;
    app.querySelector(focusName ? 'input[name="name"]' : 'input[name="code"]')?.focus();
  }

  function waitView() {
    return `
      <main class="phone waiting">
        ${NotKahoot.logoMark(true)}
        <p class="brand">You're in</p>
        <h1>${NotKahoot.esc(model.name)}</h1>
        <p class="lede">Watch the main screen. The quiz starts when the host is ready.</p>
        <p class="muted">${model.playerCount} player${model.playerCount === 1 ? '' : 's'} in the lobby</p>
        <div class="wait-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <button class="ghost" data-leave type="button">Leave</button>
      </main>`;
  }

  function countdownView() {
    return `
      <main class="phone countdown-screen">
        ${NotKahoot.logoMark(true)}
        <p class="brand">Get ready</p>
        <h1 class="countdown-num" data-count>${NotKahoot.secondsLeft(model)}</h1>
      </main>`;
  }

  function questionView() {
    const choices = model.choices?.length ? model.choices : NotKahoot.COLORS;
    const two = choices.length === 2;
    return `
      <main class="phone play-question">
        <header class="play-head">
          <p>Question ${model.number}<span> / ${model.total}</span></p>
          <strong data-count class="${NotKahoot.secondsLeft(model) <= 5 ? 'urgent' : ''}">${NotKahoot.secondsLeft(model)}</strong>
          <p class="score-pill">${NotKahoot.formatScore(model.score)}</p>
        </header>
        <div class="pad${two ? ' two' : ''}${model.locked ? ' is-locked' : ''}">
          ${choices.map((choice, index) => `
            <button type="button" class="choice ${choice.color || choice.id}${model.selected === index ? ' selected' : ''}" data-choice="${index}" aria-label="${NotKahoot.esc(choice.text || choice.label)}" ${model.locked ? 'disabled' : ''}>
              ${NotKahoot.shape(choice.shape)}
              ${choice.text ? `<span class="choice-word">${NotKahoot.esc(choice.text)}</span>` : ''}
            </button>`).join('')}
        </div>
        <p class="lock-note">${model.locked ? 'Locked in' : (two ? 'True or false' : 'Tap a colour')}</p>
      </main>`;
  }

  function revealView() {
    const heading = !model.answered ? "Time's up" : model.correct ? 'Correct' : 'Not this time';
    const tone = !model.answered ? 'missed' : model.correct ? 'good' : 'bad';
    return `
      <main class="phone feedback ${tone}">
        <p class="brand">${heading}</p>
        <h1>${model.correct ? `+${NotKahoot.formatScore(model.pointsAwarded)}` : '+0'}</h1>
        ${rankMark()}
        ${progressLines()}
        <p class="lede">Total ${NotKahoot.formatScore(model.score)}</p>
        <p class="muted">Eyes on the main screen.</p>
      </main>`;
  }

  function betweenView() {
    return `
      <main class="phone feedback neutral">
        <p class="brand">Leaderboard</p>
        <h1>${NotKahoot.formatScore(model.score)}</h1>
        ${rankMark()}
        ${progressLines()}
      </main>`;
  }

  function podiumView() {
    const heading = model.onPodium ? `Number ${model.rank}` : 'Quiz over';
    return `
      <main class="phone feedback ${model.onPodium ? 'good' : 'neutral'}">
        ${NotKahoot.logoMark(true)}
        <p class="brand">${heading}</p>
        <h1>${NotKahoot.esc(model.name)}</h1>
        <p class="lede">${NotKahoot.formatScore(model.score)} points · ${ordinal(model.rank)}</p>
        <p class="muted">${model.onPodium ? 'You are on the podium.' : 'The top 3 are on the main screen.'}</p>
      </main>`;
  }

  function rankMark() {
    const label = ordinal(model.rank);
    if (!label) return '<p class="lede">You are </p>';
    return `<p class="lede">You are</p><p class="rank-mark"><span class="rank-circle">${label}</span></p>`;
  }

  function progressLines() {
    const streak = Number(model.streak) || 0;
    return `<p class="streak-line">Streak ${streak}</p>${gapLine()}`;
  }

  function gapLine() {
    if (!model.rank) return '';
    if (model.leading && model.gap == null) return '<p class="gap-line">You\'re in the lead</p>';
    const points = NotKahoot.formatScore(model.gap ?? 0);
    const name = model.rivalName ? NotKahoot.esc(model.rivalName) : '';
    const phrase = model.leading
      ? `${points} points ahead${name ? ` of ${name}` : ''}`
      : `${points} points behind${name ? ` ${name}` : ''}`;
    const badge = model.rivalRank
      ? `<span class="rank-circle mini">${ordinal(model.rivalRank)}</span>`
      : '';
    return `<p class="gap-line"><span>${phrase}</span>${badge}</p>`;
  }

  function ordinal(rank) {
    const value = Number(rank);
    if (!value) return '';
    const end = value % 100;
    if (end >= 11 && end <= 13) return `${value}th`;
    return `${value}${['th', 'st', 'nd', 'rd'][value % 10] || 'th'}`;
  }

  paintJoin();
})();
