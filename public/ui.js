(function () {
  const SHAPES = {
    triangle: '<svg viewBox="0 0 80 80" aria-hidden="true"><polygon points="40,10 70,66 10,66"></polygon></svg>',
    diamond: '<svg viewBox="0 0 80 80" aria-hidden="true"><polygon points="40,8 72,40 40,72 8,40"></polygon></svg>',
    circle: '<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="26"></circle></svg>',
    square: '<svg viewBox="0 0 80 80" aria-hidden="true"><rect x="16" y="16" width="48" height="48" rx="8"></rect></svg>',
  };

  const COLORS = [
    { id: 'green', label: 'Green', shape: 'triangle' },
    { id: 'yellow', label: 'Yellow', shape: 'diamond' },
    { id: 'blue', label: 'Blue', shape: 'circle' },
    { id: 'red', label: 'Red', shape: 'square' },
  ];

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function shape(name) {
    return SHAPES[name] || '';
  }

  function formatCode(code) {
    const digits = String(code ?? '');
    return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  }

  function formatScore(value) {
    const amount = Math.round(Number(value));
    if (!Number.isFinite(amount)) return '0';
    const sign = amount < 0 ? '-' : '';
    return sign + String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function remainingMs(model) {
    const offset = model.serverNow - model.clientReceivedAt;
    return model.startedAt + model.durationMs - (Date.now() + offset);
  }

  function secondsLeft(model) {
    if (!model || (model.phase !== 'question' && model.phase !== 'countdown')) return 0;
    return Math.max(0, Math.ceil(remainingMs(model) / 1000));
  }

  function viewKey(state) {
    if (!state) return '';
    if (state.phase === 'ended') return 'ended';
    if (state.role === 'host' && state.phase === 'lobby') {
      return `lobby:${state.players.length}:${state.shuffleQuestions}:${state.shuffleAnswers}`;
    }
    if (state.role === 'player' && state.phase === 'lobby') return `lobby:${state.playerCount}:${state.name}`;
    if (state.phase === 'countdown') return 'countdown';
    if (state.phase === 'gap') return `gap:${state.step}`;
    if (state.phase === 'question') return `q:${state.number}:${state.locked ? state.selected : 'open'}`;
    return `${state.phase}:${state.number || 'end'}`;
  }

  function stamp(previous, state) {
    if (state.phase === 'question' || state.phase === 'countdown') {
    const same = previous
      && previous.phase === state.phase
      && previous.number === state.number
      && previous.startedAt === state.startedAt
      && previous.serverNow === state.serverNow;
    state.clientReceivedAt = same ? previous.clientReceivedAt : Date.now();
    }
    return state;
  }

  function storageGet(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode can refuse storage; the live socket still works */
    }
  }

  function storageClear(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  function logoMark(compact) {
    return `<img class="logo${compact ? ' compact' : ''}" src="/logo.jpg" alt="Not Kahoot">`;
  }

  function startClock(getModel, onExpire) {
    let expiredKey = '';
    const loop = () => {
      requestAnimationFrame(loop);
      const model = getModel();
      const bar = document.querySelector('[data-bar]');
      const timing = model && (model.phase === 'question' || model.phase === 'countdown');
      if (!timing) {
        if (bar) bar.style.transform = 'scaleX(1)';
        return;
      }
      const label = document.querySelector('[data-count]');
      const seconds = secondsLeft(model);
      if (label) {
        label.textContent = String(seconds);
        label.classList.toggle('urgent', model.phase === 'question' && seconds <= 5);
      }
      if (bar && model.durationMs) {
        const ratio = Math.max(0, Math.min(1, remainingMs(model) / model.durationMs));
        bar.style.transform = `scaleX(${ratio})`;
      }
      if (onExpire && model.phase === 'question' && remainingMs(model) <= 0) {
        const key = `${model.number}:${model.startedAt}`;
        if (key !== expiredKey) {
          expiredKey = key;
          onExpire();
        }
      }
    };
    requestAnimationFrame(loop);
  }

  function emit(socket, event, payload) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (response) => resolve(response || { ok: false, error: 'No response from the server.' }));
    });
  }

  window.NotKahoot = {
    COLORS,
    esc,
    shape,
    logoMark,
    formatCode,
    formatScore,
    remainingMs,
    secondsLeft,
    viewKey,
    stamp,
    storageGet,
    storageSet,
    storageClear,
    startClock,
    emit,
  };
})();
