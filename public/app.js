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

  // Profile photo: pick from the gallery or camera, crop to a circle in the browser,
  // then upload a small JPEG. The server re-encodes it and strips metadata.
  const photoInput = $('#photo-input');
  const photoDialog = $('#photo-dialog');
  if (photoInput && photoDialog) {
    const canvas = $('#crop-canvas', photoDialog);
    const ctx = canvas.getContext('2d');
    const zoom = $('#crop-zoom', photoDialog);
    const errorEl = $('#photo-error', photoDialog);
    const saveBtn = $('[data-photo-save]', photoDialog);
    const S = canvas.width;
    const OUT = 512;
    let img = null;
    let objectUrl = null;
    let base = 1; // scale at which the image just covers the square
    let scale = 1;
    let x = 0; // image top-left, in canvas pixels
    let y = 0;

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    };
    const clamp = () => {
      x = Math.min(0, Math.max(S - img.naturalWidth * scale, x));
      y = Math.min(0, Math.max(S - img.naturalHeight * scale, y));
    };
    const draw = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, S, S);
      ctx.drawImage(img, x, y, img.naturalWidth * scale, img.naturalHeight * scale);
    };
    const setScale = (next, cx = S / 2, cy = S / 2) => {
      next = Math.min(base * 4, Math.max(base, next));
      x = cx - ((cx - x) * next) / scale;
      y = cy - ((cy - y) * next) / scale;
      scale = next;
      zoom.value = String(scale / base);
      clamp();
      draw();
    };
    const close = () => {
      photoDialog.close();
      photoInput.value = '';
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };

    photoInput.addEventListener('change', () => {
      const file = photoInput.files[0];
      if (!file) return;
      showError('');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        img = image;
        base = Math.max(S / img.naturalWidth, S / img.naturalHeight);
        scale = base;
        x = (S - img.naturalWidth * scale) / 2;
        y = (S - img.naturalHeight * scale) / 2;
        zoom.value = '1';
        draw();
        if (!photoDialog.open) photoDialog.showModal();
      };
      image.onerror = () => {
        window.alert('Couldn’t open that image. Try a JPG or PNG photo.');
        photoInput.value = '';
      };
      image.src = objectUrl;
    });

    zoom.addEventListener('input', () => { if (img) setScale(base * Number(zoom.value)); });

    // Drag with one finger or the mouse; pinch with two fingers.
    const pointers = new Map();
    let last = null;
    const toCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return { px: ((e.clientX - r.left) * S) / r.width, py: ((e.clientY - r.top) * S) / r.height };
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, toCanvas(e));
      last = null;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!img || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, toCanvas(e));
      const pts = [...pointers.values()];
      if (pts.length === 1) {
        const p = pts[0];
        if (last && last.n === 1) {
          x += p.px - last.px;
          y += p.py - last.py;
          clamp();
          draw();
        }
        last = { n: 1, px: p.px, py: p.py };
      } else {
        const [a, b] = pts;
        const dist = Math.hypot(a.px - b.px, a.py - b.py);
        const mid = { px: (a.px + b.px) / 2, py: (a.py + b.py) / 2 };
        if (last && last.n === 2) setScale((scale * dist) / last.dist, mid.px, mid.py);
        last = { n: 2, dist };
      }
    });
    const lift = (e) => {
      pointers.delete(e.pointerId);
      last = null;
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('wheel', (e) => {
      if (!img) return;
      e.preventDefault();
      const p = toCanvas(e);
      setScale(scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p.px, p.py);
    }, { passive: false });

    $('[data-photo-cancel]', photoDialog).addEventListener('click', close);
    photoDialog.addEventListener('cancel', () => { photoInput.value = ''; });

    saveBtn.addEventListener('click', async () => {
      if (!img) return;
      showError('');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const out = document.createElement('canvas');
        out.width = OUT;
        out.height = OUT;
        const k = OUT / S;
        const octx = out.getContext('2d');
        octx.fillStyle = '#fff';
        octx.fillRect(0, 0, OUT, OUT);
        octx.drawImage(img, x * k, y * k, img.naturalWidth * scale * k, img.naturalHeight * scale * k);
        const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.9));
        if (!blob) throw new Error('Couldn’t prepare that photo. Try another one.');
        const res = await fetch('/profile/photo', {
          method: 'POST',
          headers: { 'content-type': 'image/jpeg', 'x-csrf-token': photoInput.dataset.csrf, 'x-requested-with': 'fetch' },
          body: blob,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Upload failed. Check your connection and try again.');
        window.location.assign(window.location.pathname);
      } catch (err) {
        showError(err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save photo';
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
    const venueInput = $('#venue');

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

    // A sport's usual spot (Running → LBS ground) fills the venue unless the host typed their own.
    let autoVenue = (currentSport() && currentSport().defaultVenue) || '';
    form.addEventListener('change', (e) => {
      if (e.target.name === 'sport') {
        renderFormats();
        cap.value = '';
        const next = (currentSport() && currentSport().defaultVenue) || '';
        if (!venueInput.value.trim() || venueInput.value === autoVenue) venueInput.value = next;
        autoVenue = next;
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
