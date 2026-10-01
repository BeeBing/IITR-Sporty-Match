'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Confirmation prompts, delegated so they survive live-region refreshes.
  document.addEventListener('submit', (e) => {
    const msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Filter forms submit themselves on change.
  $$('form[data-autosubmit]').forEach((form) => {
    form.addEventListener('change', () => form.requestSubmit());
  });

  // "Other…" department reveals a text box.
  $$('select[data-other-toggle]').forEach((select) => {
    const wrap = document.getElementById(select.dataset.otherToggle);
    const sync = () => {
      wrap.hidden = select.value !== '__other';
      if (!wrap.hidden) $('input', wrap).focus();
    };
    select.addEventListener('change', sync);
  });

  // Copy-link buttons.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = old; }, 1500);
    } catch {
      window.prompt('Copy this link:', text);
    }
  });

  // Unread notification badge.
  const badge = $('[data-unread]');
  if (badge) {
    setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/notifications/count', { headers: { 'x-requested-with': 'fetch' } });
        if (!res.ok) return;
        const { unread } = await res.json();
        badge.textContent = unread;
        badge.hidden = unread === 0;
      } catch { /* offline; try again next tick */ }
    }, 45000);
  }

  // Match page: keep roster and chat fresh without reloading.
  const live = $('#live[data-live-url]');
  const scrollChat = () => {
    const log = $('[data-chat-log]');
    if (log) log.scrollTop = log.scrollHeight;
  };
  async function refreshLive() {
    if (!live) return;
    const url = `${live.dataset.liveUrl}?v=${encodeURIComponent(live.dataset.version)}`;
    try {
      const res = await fetch(url, { headers: { 'x-requested-with': 'fetch' } });
      if (res.status !== 200) return;
      const log = $('[data-chat-log]');
      const atBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      live.innerHTML = await res.text();
      live.dataset.version = decodeURIComponent(res.headers.get('x-live-version') || '');
      if (atBottom) scrollChat();
    } catch { /* offline; try again next tick */ }
  }
  if (live) {
    scrollChat();
    setInterval(() => { if (!document.hidden) refreshLive(); }, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(); });
  }

  const chatForm = $('#chat-form');
  if (chatForm) {
    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('input[name=body]', chatForm);
      if (!input.value.trim()) return;
      const button = $('button', chatForm);
      button.disabled = true;
      try {
        const res = await fetch(chatForm.action, {
          method: 'POST',
          headers: { 'x-requested-with': 'fetch' },
          body: new URLSearchParams(new FormData(chatForm)),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not send. Refresh and try again.');
        input.value = '';
        await refreshLive();
        scrollChat();
      } catch (err) {
        window.alert(err.message);
      } finally {
        button.disabled = false;
        input.focus();
      }
    });
  }

  // Host form: formats, player counts and venue hints follow the chosen sport.
  const form = $('#match-form');
  const dataEl = $('#sports-data');
  if (form && dataEl) {
    const sports = JSON.parse(dataEl.textContent);
    const formatsEl = $('#formats');
    const capField = $('#capacity-field');
    const cap = $('#capacity');
    const guests = $('#guests');
    const summary = $('#need-summary');
    const venues = $('#venue-list');

    const currentSport = () => sports.find((s) => s.key === (form.elements.sport.value || ''));
    const currentFormat = () => {
      const sport = currentSport();
      const key = form.elements.format ? form.elements.format.value : '';
      return sport && sport.formats.find((f) => f.key === key);
    };
    const describe = (f) => (f.type === 'sides'
      ? `${f.max} players · ${f.perTeam} per side`
      : f.min === f.max ? `${f.max} players` : `${f.min}–${f.max} players`);

    function renderFormats() {
      const sport = currentSport();
      formatsEl.replaceChildren();
      if (!sport) return;
      for (const f of sport.formats) {
        const label = document.createElement('label');
        label.className = 'format-card';
        const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'format', value: f.key, required: true });
        if (sport.formats.length === 1) input.checked = true;
        const span = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = f.label;
        const small = document.createElement('small');
        small.textContent = describe(f);
        span.append(b, small);
        label.append(input, span);
        formatsEl.append(label);
      }
      venues.replaceChildren(...sport.venues.map((v) => Object.assign(document.createElement('option'), { value: v })));
    }

    function update() {
      const f = currentFormat();
      if (!f) {
        capField.hidden = true;
        summary.textContent = '';
        return;
      }
      const flexible = f.type === 'group' && f.min !== f.max;
      capField.hidden = !flexible;
      cap.min = f.min;
      cap.max = f.max;
      let total = f.max;
      if (flexible) {
        const n = parseInt(cap.value, 10);
        total = Number.isInteger(n) ? Math.min(Math.max(n, f.min), f.max) : f.min;
      }
      guests.max = Math.max(0, total - 2);
      const g = Math.min(parseInt(guests.value, 10) || 0, total - 2);
      const need = total - 1 - Math.max(g, 0);
      const team = f.type === 'sides' ? ` (${f.perTeam} per side)` : '';
      summary.textContent = `${total} players${team}: you${g > 0 ? ` + ${g} friend${g === 1 ? '' : 's'}` : ''} → looking for ${need} more.`;
    }

    form.addEventListener('change', (e) => {
      if (e.target.name === 'sport') {
        renderFormats();
        cap.value = '';
      }
      if (e.target.name === 'format') {
        const f = currentFormat();
        if (f && f.type === 'group') cap.value = f.min;
      }
      update();
    });
    form.addEventListener('input', (e) => {
      if (e.target === cap || e.target === guests) update();
    });
    update();
  }
})();
