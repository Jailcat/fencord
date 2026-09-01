// ==UserScript==
// @name         Fencord
// @namespace    fencord
// @version      101
// @description  Theme manager for Fenrid
// @match        https://fenrid.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/fencord/fencord/main/fencord.user.js
// @downloadURL  https://raw.githubusercontent.com/fencord/fencord/main/fencord.user.js
// ==/UserScript==

(function () {
  'use strict';

  (function installRuntimeShield() {
    const BLOCKED_HOST_PATTERNS = [
      /grabify\.link$/i, /iplogger\.(org|ru|com|co)$/i, /2no\.co$/i,
      /yip\.su$/i, /blasze\.(tk|com)$/i, /ps3cfw\.com$/i, /leancy\.com$/i,
      /whatismyip\.link$/i, /stopforumspam\./i, /grabber\.link$/i,
      /ip-tracker\.org$/i, /trackip\./i, /canarytokens\.(com|org)$/i,
      /webhook\.site$/i
    ];
    let blockedCount = 0;

    function isBlockedUrl(rawUrl) {
      try {
        const url = new URL(String(rawUrl), location.href);
        if (url.hostname === location.hostname) return false;
        return BLOCKED_HOST_PATTERNS.some(re => re.test(url.hostname));
      } catch (e) {
        return false;
      }
    }

    function reportBlocked(url) {
      blockedCount++;
      try {
        console.warn('[Fencord Shield] Blocked a request to a known data-logging endpoint:', url);
        if (document.body && typeof window.__fencordShieldToast === 'function') {
          window.__fencordShieldToast(url);
        }
      } catch (e) {}
    }

    function mimicNative(fn, name) {
      try {
        const nativeStr = 'function ' + name + '() { [native code] }';
        Object.defineProperty(fn, 'toString', { value: () => nativeStr, configurable: true });
      } catch (e) {}
      return fn;
    }

    const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    if (nativeFetch) {
      const wrappedFetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        if (url && isBlockedUrl(url)) {
          reportBlocked(url);
          return Promise.reject(new Error('Blocked by Fencord Runtime Shield'));
        }
        return nativeFetch(input, init);
      };
      window.fetch = mimicNative(wrappedFetch, 'fetch');
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    const wrappedOpen = function (method, url) {
      if (url && isBlockedUrl(url)) {
        reportBlocked(url);
        this.__fencordBlocked = true;
        // Point the request at nothing rather than letting it fire.
        return nativeOpen.call(this, method, 'about:blank');
      }
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = mimicNative(wrappedOpen, 'open');

    if (navigator.sendBeacon) {
      const nativeBeacon = navigator.sendBeacon.bind(navigator);
      const wrappedBeacon = function (url, data) {
        if (url && isBlockedUrl(url)) {
          reportBlocked(url);
          return false;
        }
        return nativeBeacon(url, data);
      };
      navigator.sendBeacon = mimicNative(wrappedBeacon, 'sendBeacon');
    }

    // Expose the toast hook / counter without letting them show up in a
    // for-in / Object.keys(window) scan of the page.
    Object.defineProperty(window, '__fencordShieldBlockedCount', {
      value: () => blockedCount, enumerable: false, configurable: true
    });
  })();

  const MEDIA_CONTROLLER_KEY = 'fencord-media-controller';

  const MC_STATE = {
    panel: null, isDragging: false, dragStart: { x: 0, y: 0, left: 0, top: 0 },
    panelCreated: false, mediaEntries: new Map(), uidCounter: 0,
    hookInstalled: false, originalPlay: null
  };

  function mcUid() {
    return 'mc_' + (++MC_STATE.uidCounter) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function mcFmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function mcCloneMedia(original) {
    const tag = original.tagName.toLowerCase();
    const clone = document.createElement(tag);
    for (let i = 0; i < original.attributes.length; i++) {
      const attr = original.attributes[i];
      if (attr.name !== 'id') clone.setAttribute(attr.name, attr.value);
    }
    const src = original.currentSrc || original.src || '';
    if (src) clone.src = src;
    original.querySelectorAll('source').forEach(s => {
      const ns = document.createElement('source');
      for (let j = 0; j < s.attributes.length; j++) ns.setAttribute(s.attributes[j].name, s.attributes[j].value);
      clone.appendChild(ns);
    });
    original.querySelectorAll('track').forEach(t => {
      const nt = document.createElement('track');
      for (let j = 0; j < t.attributes.length; j++) nt.setAttribute(t.attributes[j].name, t.attributes[j].value);
      clone.appendChild(nt);
    });
    try { clone.currentTime = original.currentTime || 0; } catch (e) {}
    try { clone.volume = original.volume !== undefined ? original.volume : 1; } catch (e) {}
    try { clone.playbackRate = original.playbackRate !== undefined ? original.playbackRate : 1; } catch (e) {}
    try { clone.loop = !!original.loop; } catch (e) {}
    try { clone.muted = false; } catch (e) {}
    try { clone.autoplay = true; } catch (e) {}
    try { clone.crossOrigin = original.crossOrigin || 'anonymous'; } catch (e) {}
    try { clone.preload = original.preload || 'auto'; } catch (e) {}
    try { clone.playsInline = !!original.playsInline; } catch (e) {}
    clone.dataset.isClone = 'true';
    clone.dataset.mcClone = 'true';
    return clone;
  }

  function mcBuildPanel() {
    const existing = document.getElementById('mc-panel');
    if (existing) existing.remove();
    const panel = document.createElement('div');
    panel.id = 'mc-panel';
    panel.dataset.isClone = 'true';
    panel.dataset.mcPanel = 'true';
    Object.assign(panel.style, {
      position: 'fixed', top: '20px', right: '20px', width: '380px', maxHeight: '85vh',
      backgroundColor: '#0a0a12', border: '1px solid #3a3a4a', borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)',
      zIndex: '2147483647', overflow: 'hidden',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#e0e0e0', display: 'none', flexDirection: 'column',
      transition: 'opacity 0.2s ease', userSelect: 'none', WebkitUserSelect: 'none'
    });

    const header = document.createElement('div');
    header.id = 'mc-header';
    Object.assign(header.style, {
      padding: '12px 16px', backgroundColor: '#12121a', borderBottom: '1px solid #2a2a3a',
      cursor: 'move', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      borderRadius: '12px 12px 0 0', flexShrink: '0'
    });
    const grip = document.createElement('div');
    Object.assign(grip.style, { display: 'flex', gap: '3px', marginRight: '10px' });
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      Object.assign(dot.style, { width: '3px', height: '3px', borderRadius: '50%', background: '#555' });
      grip.appendChild(dot);
    }
    const titleWrap = document.createElement('div');
    Object.assign(titleWrap.style, { display: 'flex', alignItems: 'center', flex: '1' });
    titleWrap.appendChild(grip);
    const title = document.createElement('span');
    title.textContent = 'Media Controller';
    Object.assign(title.style, { fontSize: '14px', fontWeight: '500', color: '#c0c0d0', letterSpacing: '0.3px' });
    titleWrap.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close all media';
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', color: '#888', fontSize: '22px', cursor: 'pointer',
      padding: '0 2px', lineHeight: '1', transition: 'color 0.15s', width: '28px', height: '28px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px'
    });
    closeBtn.onmouseenter = () => { closeBtn.style.color = '#ff6b6b'; closeBtn.style.background = 'rgba(255,107,107,0.1)'; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = '#888'; closeBtn.style.background = 'transparent'; };
    closeBtn.onclick = (e) => { e.stopPropagation(); mcCloseAll(); };

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const content = document.createElement('div');
    content.id = 'mc-content';
    Object.assign(content.style, {
      padding: '12px', overflowY: 'auto', overflowX: 'hidden',
      maxHeight: 'calc(85vh - 50px)', display: 'flex', flexDirection: 'column', gap: '10px',
      scrollbarWidth: 'thin', scrollbarColor: '#3a3a4a transparent'
    });
    const empty = document.createElement('div');
    empty.id = 'mc-empty';
    empty.textContent = 'No active media';
    Object.assign(empty.style, { textAlign: 'center', padding: '32px 16px', color: '#555', fontSize: '13px', fontStyle: 'italic' });
    content.appendChild(empty);
    panel.appendChild(content);
    document.documentElement.appendChild(panel);
    MC_STATE.panel = panel;
    MC_STATE.panelCreated = true;

    function onDown(e) {
      if (e.target.closest('button')) return;
      const ev = e.touches ? e.touches[0] : e;
      MC_STATE.isDragging = true;
      const rect = panel.getBoundingClientRect();
      MC_STATE.dragStart = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };
      panel.style.transition = 'none';
      header.style.cursor = 'grabbing';
      e.preventDefault();
    }
    function onMove(e) {
      if (!MC_STATE.isDragging) return;
      const ev = e.touches ? e.touches[0] : e;
      const dx = ev.clientX - MC_STATE.dragStart.x;
      const dy = ev.clientY - MC_STATE.dragStart.y;
      let nx = MC_STATE.dragStart.left + dx;
      let ny = MC_STATE.dragStart.top + dy;
      nx = Math.max(0, Math.min(nx, window.innerWidth - panel.offsetWidth));
      ny = Math.max(0, Math.min(ny, window.innerHeight - panel.offsetHeight));
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      if (e.preventDefault) e.preventDefault();
    }
    function onUp() {
      if (!MC_STATE.isDragging) return;
      MC_STATE.isDragging = false;
      panel.style.transition = 'opacity 0.2s ease';
      header.style.cursor = 'move';
    }
    header.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    header.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);

    return panel;
  }

  function mcShowPanel() {
    const p = MC_STATE.panelCreated && document.getElementById('mc-panel') ? document.getElementById('mc-panel') : mcBuildPanel();
    p.style.display = 'flex';
    requestAnimationFrame(() => { p.style.opacity = '1'; });
  }

  function mcHidePanel() {
    const p = document.getElementById('mc-panel');
    if (!p) return;
    p.style.opacity = '0';
    setTimeout(() => { if (p) p.style.display = 'none'; }, 200);
  }

  function mcUpdateEmpty() {
    const content = document.getElementById('mc-content');
    const empty = document.getElementById('mc-empty');
    if (!content || !empty) return;
    empty.style.display = content.querySelectorAll('[data-mc-item]').length > 0 ? 'none' : 'block';
  }

  function mcCloseAll() {
    MC_STATE.mediaEntries.forEach((entry) => {
      if (entry.intervalId) clearInterval(entry.intervalId);
      if (entry.cloneEl) {
        try { entry.cloneEl.pause(); entry.cloneEl.src = ''; entry.cloneEl.load(); } catch (e) {}
      }
    });
    MC_STATE.mediaEntries.clear();
    const content = document.getElementById('mc-content');
    if (content) content.querySelectorAll('[data-mc-item]').forEach(el => el.remove());
    mcUpdateEmpty();
    mcHidePanel();
  }

  function mcBuildProgress(mediaEl, card) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' });
    const cur = document.createElement('span');
    cur.textContent = '0:00';
    Object.assign(cur.style, { fontSize: '10px', color: '#888', minWidth: '30px', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', textAlign: 'right' });
    const track = document.createElement('div');
    Object.assign(track.style, { flex: '1', height: '5px', backgroundColor: '#252535', borderRadius: '3px', position: 'relative', cursor: 'pointer' });
    const fill = document.createElement('div');
    Object.assign(fill.style, { position: 'absolute', top: '0', left: '0', height: '100%', width: '0%', backgroundColor: '#888', borderRadius: '3px', pointerEvents: 'none', transition: 'width 0.05s linear' });
    const knob = document.createElement('div');
    Object.assign(knob.style, {
      position: 'absolute', top: '50%', left: '0%', width: '11px', height: '11px',
      backgroundColor: '#aaa', borderRadius: '50%', transform: 'translate(-50%, -50%) scale(0)',
      cursor: 'grab', transition: 'transform 0.15s ease, left 0.05s linear',
      boxShadow: '0 0 6px rgba(170,170,170,0.4)', zIndex: '2'
    });
    track.appendChild(fill);
    track.appendChild(knob);
    const dur = document.createElement('span');
    dur.textContent = '0:00';
    Object.assign(dur.style, { fontSize: '10px', color: '#888', minWidth: '30px', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' });
    wrap.appendChild(cur);
    wrap.appendChild(track);
    wrap.appendChild(dur);

    let dragging = false, wasPlaying = false;
    function update() {
      if (dragging || !mediaEl) return;
      const d = mediaEl.duration || 0, c = mediaEl.currentTime || 0;
      const pct = d > 0 ? (c / d) * 100 : 0;
      fill.style.width = pct + '%';
      knob.style.left = pct + '%';
      cur.textContent = mcFmtTime(c);
      dur.textContent = mcFmtTime(d);
    }
    const iv = setInterval(update, 200);
    card._mcInterval = iv;

    function seekTo(clientX) {
      const rect = track.getBoundingClientRect();
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      fill.style.width = (pct * 100) + '%';
      knob.style.left = (pct * 100) + '%';
      if (mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) {
        mediaEl.currentTime = pct * mediaEl.duration;
        cur.textContent = mcFmtTime(mediaEl.currentTime);
      }
    }
    track.addEventListener('click', (e) => { if (!dragging) seekTo(e.clientX); });
    function startDrag(e) {
      dragging = true;
      wasPlaying = mediaEl && !mediaEl.paused;
      if (wasPlaying) mediaEl.pause();
      knob.style.transform = 'translate(-50%, -50%) scale(1)';
      knob.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    }
    knob.addEventListener('mousedown', startDrag);
    knob.addEventListener('touchstart', startDrag, { passive: false });
    function moveDrag(e) {
      if (!dragging) return;
      const ev = e.touches ? e.touches[0] : e;
      seekTo(ev.clientX);
      e.preventDefault();
    }
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      knob.style.transform = 'translate(-50%, -50%) scale(0)';
      knob.style.cursor = 'grab';
      if (wasPlaying && mediaEl) mediaEl.play().catch(() => {});
    }
    document.addEventListener('mousemove', moveDrag);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchmove', moveDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
    track.onmouseenter = () => { if (!dragging) knob.style.transform = 'translate(-50%, -50%) scale(1)'; };
    track.onmouseleave = () => { if (!dragging) knob.style.transform = 'translate(-50%, -50%) scale(0)'; };
    return wrap;
  }

  function mcMakeBtn(text) {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      backgroundColor: 'transparent', border: '1px solid #555', color: '#888', fontSize: '11px',
      padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', transition: 'all 0.15s',
      fontWeight: '500', flex: '1'
    });
    b.onmouseenter = () => { b.style.backgroundColor = '#888'; b.style.color = '#0a0a12'; b.style.borderColor = '#888'; };
    b.onmouseleave = () => { b.style.backgroundColor = 'transparent'; b.style.color = '#888'; b.style.borderColor = '#555'; };
    return b;
  }

  function mcBuildCard(src, type) {
    const card = document.createElement('div');
    card.dataset.mcItem = 'true';
    card.dataset.mcSrc = src.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    card.dataset.isClone = 'true';
    Object.assign(card.style, {
      backgroundColor: '#14141f', border: '1px solid #252535', borderRadius: '10px',
      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px',
      transition: 'border-color 0.15s ease'
    });
    card.onmouseenter = () => card.style.borderColor = '#3a3a5a';
    card.onmouseleave = () => card.style.borderColor = '#252535';

    const hdr = document.createElement('div');
    Object.assign(hdr.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between' });
    const badge = document.createElement('span');
    badge.textContent = type === 'video' ? 'Video' : 'Audio';
    Object.assign(badge.style, { fontSize: '10px', color: '#8888aa', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: '600' });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    Object.assign(del.style, {
      background: 'none', border: '1px solid #3a3a4a', color: '#888', fontSize: '10px',
      padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', transition: 'all 0.15s', fontWeight: '500'
    });
    del.onmouseenter = () => { del.style.borderColor = '#ff6b6b'; del.style.color = '#ff6b6b'; };
    del.onmouseleave = () => { del.style.borderColor = '#3a3a4a'; del.style.color = '#888'; };
    hdr.appendChild(badge);
    hdr.appendChild(del);

    const srcRow = document.createElement('div');
    srcRow.textContent = src.length > 55 ? src.slice(0, 26) + '...' + src.slice(-24) : src;
    Object.assign(srcRow.style, { fontSize: '10px', color: '#555', wordBreak: 'break-all', fontFamily: 'monospace', lineHeight: '1.4' });

    const ctrlRow = document.createElement('div');
    Object.assign(ctrlRow.style, { display: 'flex', gap: '6px', alignItems: 'center' });
    const btnPlay = mcMakeBtn('Play');
    const btnPause = mcMakeBtn('Pause');
    const btnRestart = mcMakeBtn('Restart');
    ctrlRow.appendChild(btnPlay);
    ctrlRow.appendChild(btnPause);
    ctrlRow.appendChild(btnRestart);

    const volRow = document.createElement('div');
    Object.assign(volRow.style, { display: 'flex', alignItems: 'center', gap: '8px' });
    const volLbl = document.createElement('span');
    volLbl.textContent = 'Vol';
    Object.assign(volLbl.style, { fontSize: '10px', color: '#666', minWidth: '22px', fontWeight: '500' });
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.01';
    volSlider.value = '1';
    Object.assign(volSlider.style, { flex: '1', accentColor: '#888', height: '3px', cursor: 'pointer' });
    volRow.appendChild(volLbl);
    volRow.appendChild(volSlider);

    card.appendChild(hdr);
    card.appendChild(srcRow);
    card.appendChild(ctrlRow);
    card.appendChild(volRow);
    return { card, btnPlay, btnPause, btnRestart, volSlider, del };
  }

  function mcHandleMedia(element, src) {
    if (element.dataset.mcProcessed === 'true') return null;
    if (element.closest('[data-mc-panel]')) return null;
    if (element.dataset.isClone === 'true') return null;

    element.dataset.mcProcessed = 'true';
    element.muted = true;
    element.volume = 0;

    const clone = mcCloneMedia(element);
    const playPromise = clone.play();
    if (playPromise) playPromise.catch(() => {});

    mcShowPanel();
    const content = document.getElementById('mc-content');
    if (!content) return clone;

    const isVideo = element.tagName.toLowerCase() === 'video';
    const { card, btnPlay, btnPause, btnRestart, volSlider, del } = mcBuildCard(src, isVideo ? 'video' : 'audio');

    if (isVideo) {
      const vWrap = document.createElement('div');
      Object.assign(vWrap.style, { position: 'relative', width: '100%', paddingBottom: '56.25%', backgroundColor: '#0a0a12', borderRadius: '6px', overflow: 'hidden', cursor: 'pointer' });
      Object.assign(clone.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', objectFit: 'contain', borderRadius: '6px' });
      vWrap.appendChild(clone);
      card.insertBefore(vWrap, card.children[2]);

      // Click to expand video into fullscreen overlay (YouTube style)
      // We MOVE the same clone element to preserve quality (no new video element)
      vWrap.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.getElementById('mc-video-overlay')) return;

        // Pause the panel video first
        const wasPlaying = !clone.paused;
        clone.pause();

        // Remember the wrapper so we can put the video back
        const originalWrap = vWrap;

        // Create fullscreen overlay
        const overlay = document.createElement('div');
        overlay.id = 'mc-video-overlay';
        Object.assign(overlay.style, {
          position: 'fixed', inset: '0', zIndex: '2147483647',
          background: '#000', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          opacity: '0', transition: 'opacity 0.2s ease'
        });

        // Move the SAME clone to overlay (preserves quality, no re-buffering)
        // GPU acceleration + best image rendering for crisp quality
        Object.assign(clone.style, {
          position: 'relative', top: 'auto', left: 'auto',
          width: '100vw', height: '100vh', objectFit: 'contain',
          borderRadius: '0', transform: 'none', transition: 'none',
          imageRendering: 'auto', willChange: 'auto'
        });
        clone.controls = true;
        clone.playsInline = false;
        if (wasPlaying) clone.play().catch(() => {});

        // Close button (×) top-right
        const closeBtn = document.createElement('div');
        closeBtn.textContent = '✕';
        Object.assign(closeBtn.style, {
          position: 'fixed', top: '16px', right: '24px',
          fontSize: '28px', color: '#fff', cursor: 'pointer',
          zIndex: '2147483648', opacity: '0',
          transition: 'opacity 0.2s 0.1s', userSelect: 'none',
          textShadow: '0 2px 8px rgba(0,0,0,0.8)'
        });
        closeBtn.onmouseenter = () => closeBtn.style.opacity = '1';
        closeBtn.onmouseleave = () => closeBtn.style.opacity = '0.7';

        function closeOverlay() {
          overlay.style.opacity = '0';
          setTimeout(() => {
            clone.pause();
            clone.controls = false;
            clone.playsInline = true;

            // Restore original panel styles
            Object.assign(clone.style, {
              position: 'absolute', top: '0', left: '0',
              width: '100%', height: '100%', objectFit: 'contain',
              borderRadius: '6px'
            });

            // Move clone back to the panel wrapper
            originalWrap.appendChild(clone);

            // Resume playing in panel if it was playing
            if (wasPlaying) clone.play().catch(() => {});

            overlay.remove();
            document.removeEventListener('keydown', onKey);
          }, 200);
        }

        closeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeOverlay();
        });

        function onKey(ev) {
          if (ev.key === 'Escape') closeOverlay();
        }
        document.addEventListener('keydown', onKey);

        overlay.appendChild(clone);
        overlay.appendChild(closeBtn);
        document.body.appendChild(overlay);

        // Animate overlay in only — no transform on video to avoid blur
        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
          closeBtn.style.opacity = '0.7';
        });
      });
    }

    const progress = mcBuildProgress(clone, card);
    card.appendChild(progress);

    btnPlay.onclick = () => clone.play().catch(() => {});
    btnPause.onclick = () => clone.pause();
    btnRestart.onclick = () => { clone.pause(); clone.currentTime = 0; clone.play().catch(() => {}); };
    volSlider.oninput = () => { clone.volume = parseFloat(volSlider.value); clone.muted = false; };

    const entryId = mcUid();
    del.onclick = () => {
      if (card._mcInterval) clearInterval(card._mcInterval);
      try { clone.pause(); clone.src = ''; clone.load(); } catch (e) {}
      card.remove();
      MC_STATE.mediaEntries.delete(entryId);
      mcUpdateEmpty();
    };

    clone.onended = () => { if (!clone.loop) card.style.opacity = '0.45'; };
    clone.onplay = () => { card.style.opacity = '1'; };

    content.appendChild(card);
    mcUpdateEmpty();

    MC_STATE.mediaEntries.set(entryId, {
      type: isVideo ? 'video' : 'audio', cloneEl: clone, card: card,
      intervalId: card._mcInterval, src: src
    });
    return clone;
  }

  function mcInstallHook() {
    if (MC_STATE.hookInstalled) return;
    MC_STATE.hookInstalled = true;
    MC_STATE.originalPlay = HTMLMediaElement.prototype.play;

    HTMLMediaElement.prototype.play = function() {
      const el = this;
      if (localStorage.getItem(MEDIA_CONTROLLER_KEY) !== 'true') {
        return MC_STATE.originalPlay.call(el);
      }
      if (el.dataset.isClone === 'true') return MC_STATE.originalPlay.call(el);
      if (el.dataset.mcProcessed === 'true' && el.closest('[data-mc-panel]')) return MC_STATE.originalPlay.call(el);

      let src = el.currentSrc || el.src || '';
      if (!src) {
        const source = el.querySelector('source');
        if (source) src = source.src || '';
      }
      if (!src) return MC_STATE.originalPlay.call(el);

      const clone = mcHandleMedia(el, src);
      if (clone) return clone.play();
      return MC_STATE.originalPlay.call(el);
    };
  }

  function mcUninstallHook() {
    if (!MC_STATE.hookInstalled) return;
    MC_STATE.hookInstalled = false;
    if (MC_STATE.originalPlay) {
      HTMLMediaElement.prototype.play = MC_STATE.originalPlay;
      MC_STATE.originalPlay = null;
    }
    mcCloseAll();
  }

  function isMediaControllerEnabled() {
    return localStorage.getItem(MEDIA_CONTROLLER_KEY) === 'true';
  }

  function setMediaControllerEnabled(enabled) {
    localStorage.setItem(MEDIA_CONTROLLER_KEY, enabled ? 'true' : 'false');
    if (enabled) mcInstallHook();
    else mcUninstallHook();
  }

  mcInstallHook();



  const STORAGE_KEY = 'fencord-active-theme';
  const CUSTOM_THEMES_KEY = 'fencord-custom-themes';
  const CREDITS_TEXT = 'made by @kitty and @702 on fenrid';

  function makeCreditNote({ compact = false, maxWidth = '420px' } = {}) {
    const note = document.createElement('div');
    note.className = 'fencord-credits';
    note.textContent = CREDITS_TEXT;
    Object.assign(note.style, {
      fontSize: compact ? '12px' : '13px',
      color: 'var(--text-muted)',
      opacity: '0.9',
      marginTop: compact ? '10px' : '16px',
      maxWidth,
      lineHeight: '1.35',
      userSelect: 'none',
      fontWeight: '600'
    });
    return note;
  }

  const TEMPLATE_THEME = {
    name: "My Theme",
    vars: {
      "--background": "#1e1e2e",
      "--foreground": "#cdd6f4",
      "--server-sidebar": "#181825",
      "--channel-sidebar": "#1e1e2e",
      "--main-chat-area": "#1e1e2e",
      "--member-list": "#181825",
      "--popups-and-modals": "#1e1e2e",
      "--borders-and-separators": "#313244",
      "--primary-action": "#89b4fa",
      "--primary-hover": "#74a8f9",
      "--secondary-button": "#313244",
      "--secondary-button-hover": "#45475a",
      "--accent-vibrant": "#89b4fa",
      "--success-green": "#a6e3a1",
      "--error-red": "#f38ba8",
      "--warning-yellow": "#f9e2af",
      "--text-primary": "#cdd6f4",
      "--text-secondary": "#a6adc8",
      "--text-muted": "#6c7086",
      "--interactive-hover": "#89b4fa",
      "--hover-overlay": "#ffffff0d",
      "--active-overlay": "#ffffff14",
      "--primary-foreground": "#1e1e2e",
      "--matrix-rain": "#00ff00"
    }
  };

  const THEMES_CACHE_KEY = 'fencord-remote-themes';
  let remoteThemes = null;
  let refreshSettingsPanel = null;
  let openFavoritesTab = null;

  const FALLBACK_THEMES = {
    none: { name: 'None (Default)', vars: {} },
    catppuccin: {
      name: 'Catppuccin Mocha',
      vars: {
        '--background': '#1e1e2e', '--foreground': '#cdd6f4',
        '--server-sidebar': '#181825', '--channel-sidebar': '#1e1e2e',
        '--main-chat-area': '#1e1e2e', '--member-list': '#181825',
        '--popups-and-modals': '#1e1e2e', '--borders-and-separators': '#313244',
        '--primary-action': '#89b4fa', '--primary-hover': '#74a8f9',
        '--secondary-button': '#313244', '--secondary-button-hover': '#45475a',
        '--accent-vibrant': '#89b4fa', '--success-green': '#a6e3a1',
        '--error-red': '#f38ba8', '--warning-yellow': '#f9e2af',
        '--text-primary': '#cdd6f4', '--text-secondary': '#a6adc8',
        '--text-muted': '#6c7086', '--interactive-hover': '#89b4fa',
        '--hover-overlay': '#ffffff0d', '--active-overlay': '#ffffff14',
        '--primary-foreground': '#1e1e2e',
        '--matrix-rain': '#a6e3a1',
      }
    }
  };

  function getCachedThemes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(THEMES_CACHE_KEY) || 'null');
      if (parsed && typeof parsed === 'object' && parsed.none) return parsed;
    } catch (e) {}
    return null;
  }

  function saveCachedThemes(themes) {
    localStorage.setItem(THEMES_CACHE_KEY, JSON.stringify(themes));
  }

  function getBuiltInThemes() {
    return remoteThemes || getCachedThemes() || FALLBACK_THEMES;
  }


  function getCustomThemes() {
    try {
      return JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveCustomThemes(obj) {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(obj));
  }

  // Theme values are injected into a <style> block. Only allow plain colors so
  // imports can't smuggle url()/(@)import/JS or break out of the declaration.
  const SAFE_THEME_VAR_NAME = /^--[a-z0-9-]+$/i;
  const SAFE_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const SAFE_RGB_COLOR = /^rgba?\(\s*(?:(?:\d{1,3}|100%|\d{1,2}%)\s*,\s*){2}(?:\d{1,3}|100%|\d{1,2}%)(?:\s*,\s*(?:0|1|0?\.\d+|100%|\d{1,2}%))?\s*\)$/i;
  const SAFE_THEME_COLOR_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset']);

  function isSafeThemeVarName(name) {
    return typeof name === 'string' && SAFE_THEME_VAR_NAME.test(name) && name.length <= 64;
  }

  function isSafeThemeColorValue(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!v || v.length > 64) return false;
    // Hard reject anything that can fetch, import, execute, or break out of CSS.
    if (/url\s*\(|@import|expression\s*\(|javascript:|data:|behavior\s*:|-moz-binding|<|>|[{};\\]|\/\*|\*\//i.test(v)) {
      return false;
    }
    if (SAFE_THEME_COLOR_KEYWORDS.has(v.toLowerCase())) return true;
    if (SAFE_HEX_COLOR.test(v)) return true;
    if (SAFE_RGB_COLOR.test(v)) return true;
    return false;
  }

  function sanitizeThemeVars(vars) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
      return { ok: false, vars: {}, errors: ['vars must be an object'] };
    }
    const clean = {};
    const errors = [];
    for (const [key, value] of Object.entries(vars)) {
      if (!isSafeThemeVarName(key)) {
        errors.push(`blocked var name: ${key}`);
        continue;
      }
      if (typeof value !== 'string' || !isSafeThemeColorValue(value)) {
        errors.push(`blocked value for ${key}: ${String(value)}`);
        continue;
      }
      clean[key] = value.trim();
    }
    return { ok: errors.length === 0, vars: clean, errors };
  }

  function sanitizeThemeObject(theme) {
    if (!theme || typeof theme !== 'object') {
      return { ok: false, theme: null, errors: ['theme must be an object'] };
    }
    if (typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80) {
      return { ok: false, theme: null, errors: ['theme name must be a short string'] };
    }
    if (/[<>]/.test(theme.name)) {
      return { ok: false, theme: null, errors: ['theme name contains blocked characters'] };
    }
    const cleaned = sanitizeThemeVars(theme.vars);
    if (!cleaned.ok) {
      return { ok: false, theme: null, errors: cleaned.errors };
    }
    return {
      ok: true,
      theme: { name: theme.name.trim(), vars: cleaned.vars },
      errors: []
    };
  }

  function getAllThemes() {
    return { ...getBuiltInThemes(), ...getCustomThemes() };
  }

  function hexToRgba(hex, alpha) {
    const raw = String(hex || '').replace('#', '').trim();
    if (raw.length !== 3 && raw.length !== 6) return `rgba(0, 0, 0, ${alpha})`;
    const full = raw.length === 3
      ? raw.split('').map((c) => c + c).join('')
      : raw;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return `rgba(0, 0, 0, ${alpha})`;
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getActiveThemeVars() {
    const theme = getAllThemes()[getSavedTheme()];
    return (theme && theme.vars) || {};
  }

  function getMatrixRainColor() {
    const vars = getActiveThemeVars();
    return (
      vars['--matrix-rain'] ||
      vars['--accent-vibrant'] ||
      vars['--primary-action'] ||
      '#00ff00'
    );
  }

  function fillEffectBackdropStyle(style) {
    if (!style) return;

    const vars = getActiveThemeVars();
    const bg = vars['--background'] || '#000000';
    const server = vars['--server-sidebar'] || bg;
    const channel = vars['--channel-sidebar'] || bg;
    const chat = vars['--main-chat-area'] || bg;
    const members = vars['--member-list'] || server;
    const popups = vars['--popups-and-modals'] || channel;

    style.textContent = `
      html, body {
        background: #000 !important;
      }
      :root {
        --background: ${hexToRgba(bg, 0.72)} !important;
        --server-sidebar: ${hexToRgba(server, 0.78)} !important;
        --channel-sidebar: ${hexToRgba(channel, 0.72)} !important;
        --main-chat-area: ${hexToRgba(chat, 0.65)} !important;
        --member-list: ${hexToRgba(members, 0.78)} !important;
        --popups-and-modals: ${hexToRgba(popups, 0.92)} !important;
      }
    `;
  }

  function updateMatrixBackdropStyle() {
    fillEffectBackdropStyle(document.getElementById(MATRIX_STYLE_ID));
  }

  function updateRainBackdropStyle() {
    fillEffectBackdropStyle(document.getElementById(RAIN_STYLE_ID));
  }

  function refreshEffectBackdrops() {
    for (const id of [MATRIX_STYLE_ID, RAIN_STYLE_ID, FIRE_STYLE_ID]) {
      const style = document.getElementById(id);
      if (!style) continue;
      fillEffectBackdropStyle(style);
      document.head.appendChild(style);
    }
  }

  function applyTheme(key) {
    let styleEl = document.getElementById('fencord-theme');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'fencord-theme';
      document.head.appendChild(styleEl);
    }

    const theme = getAllThemes()[key];
    if (!theme || key === 'none') {
      styleEl.textContent = '';
    } else {
      const cleaned = sanitizeThemeVars(theme.vars || {});
      const vars = { ...cleaned.vars };
      // Older cached themes may lack --matrix-rain; derive from accent.
      if (!vars['--matrix-rain']) {
        const fallback =
          vars['--accent-vibrant'] || vars['--primary-action'] || '#00ff00';
        if (isSafeThemeColorValue(fallback)) vars['--matrix-rain'] = fallback;
      }
      const rules = Object.entries(vars)
        .map(([k, v]) => `${k}: ${v} !important;`)
        .join('\n');
      styleEl.textContent = `:root {\n${rules}\n}`;
    }

    refreshEffectBackdrops();
  }

  function getSavedTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'none';
  }

  function saveTheme(key) {
    localStorage.setItem(STORAGE_KEY, key);
  }

  function importThemeFlow(rerenderPanel) {
    const input = prompt(
      'Paste your theme JSON below:\n\n(Use the "Copy Template" button to get a starting point)'
    );
    if (!input) return;

    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
      return;
    }

    if (!parsed.name || !parsed.vars || typeof parsed.vars !== 'object') {
      alert('Theme JSON must have a "name" string and a "vars" object.');
      return;
    }

    const sanitized = sanitizeThemeObject(parsed);
    if (!sanitized.ok) {
      alert(
        'Theme blocked — only safe color values are allowed (hex / rgb / rgba).\n\n' +
        'Rejected:\n' + sanitized.errors.slice(0, 8).join('\n')
      );
      return;
    }

    const key = 'custom_' + sanitized.theme.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const custom = getCustomThemes();
    custom[key] = sanitized.theme;
    saveCustomThemes(custom);

    alert(`Imported "${sanitized.theme.name}"! Select it from the theme list.`);
    rerenderPanel();
  }

  function showToast(message, { color = 'var(--success-green)', duration = 3000 } = {}) {
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%) translateY(12px)',
      zIndex: '1000010',
      background: 'var(--popups-and-modals)',
      color: color,
      border: '1px solid ' + color,
      borderRadius: '8px',
      padding: '10px 18px',
      fontSize: '13px',
      fontWeight: '600',
      boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.2s ease, transform 0.2s ease',
      whiteSpace: 'nowrap'
    });
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(12px)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  Object.defineProperty(window, '__fencordShieldToast', {
    value: function (url) {
      let host = url;
      try { host = new URL(url, location.href).hostname; } catch (e) {}
      showToast('🛡️ Blocked a suspicious request to ' + host, { color: 'var(--danger-red)', duration: 4000 });
    },
    enumerable: false, configurable: true
  });

  function exportThemeFlow(theme) {
    const text = JSON.stringify({ name: theme.name, vars: theme.vars }, null, 2);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    showToast('Exported "' + theme.name + '" — copied to clipboard!');
  }


  function copyTemplate() {
    const text = JSON.stringify(TEMPLATE_THEME, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      alert(`Template copied to clipboard! Edit the hex values, then use Import.`);
    }).catch(() => {
      prompt('Copy this template manually:', text);
    });
  }

  function shade(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    let r = (num >> 16) + Math.round(2.55 * percent);
    let g = ((num >> 8) & 0x00FF) + Math.round(2.55 * percent);
    let b = (num & 0x0000FF) + Math.round(2.55 * percent);
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }

  function isLight(hex) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = (num >> 16) & 0xFF, g = (num >> 8) & 0xFF, b = num & 0xFF;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6;
  }

  function deriveThemeFromTwoColors(bgHex, accentHex) {
    const light = isLight(bgHex);
    const textPrimary = light ? '#181825' : '#ffffff';
    const textSecondary = light ? shade(textPrimary, 40) : shade(textPrimary, -20);
    const textMuted = light ? shade(textPrimary, 60) : shade(textPrimary, -40);

    return {
      '--background': bgHex,
      '--foreground': textPrimary,
      '--server-sidebar': shade(bgHex, light ? -8 : -10),
      '--channel-sidebar': shade(bgHex, light ? -4 : 4),
      '--main-chat-area': bgHex,
      '--member-list': shade(bgHex, light ? -8 : -10),
      '--popups-and-modals': shade(bgHex, light ? -4 : 4),
      '--borders-and-separators': shade(bgHex, light ? -15 : 15),
      '--primary-action': accentHex,
      '--primary-hover': shade(accentHex, -15),
      '--secondary-button': shade(bgHex, light ? -15 : 15),
      '--secondary-button-hover': shade(bgHex, light ? -25 : 25),
      '--accent-vibrant': accentHex,
      '--success-green': '#a6e3a1',
      '--error-red': '#f38ba8',
      '--warning-yellow': '#f9e2af',
      '--text-primary': textPrimary,
      '--text-secondary': textSecondary,
      '--text-muted': textMuted,
      '--interactive-hover': accentHex,
      '--hover-overlay': light ? '#0000000d' : '#ffffff0d',
      '--active-overlay': light ? '#00000014' : '#ffffff14',
      '--primary-foreground': light ? '#ffffff' : bgHex,
      '--matrix-rain': accentHex
    };
  }

  function openQuickThemeUI(rerenderPanel) {
    const modalOverlay = document.createElement('div');
    Object.assign(modalOverlay.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)',
      zIndex: 1000001, display: 'flex', alignItems: 'center', justifyContent: 'center'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: 'var(--popups-and-modals)', color: 'var(--text-primary)', padding: '24px', borderRadius: '10px',
      fontFamily: 'inherit', width: '300px', display: 'flex', flexDirection: 'column', gap: '14px',
      border: '1px solid var(--borders-and-separators)'
    });

    box.innerHTML = `
      <div style="font-weight:bold;font-size:16px;">Quick 2-Color Theme</div>
      <label style="display:flex;flex-direction:column;gap:4px;">
        Background color
        <input type="color" id="fencord-bg-color" value="#1e1e2e" style="width:100%;height:36px;border:none;cursor:pointer;">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;">
        Accent color
        <input type="color" id="fencord-accent-color" value="#89b4fa" style="width:100%;height:36px;border:none;cursor:pointer;">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;">
        Theme name
        <input type="text" id="fencord-theme-name" placeholder="My Cool Theme" style="padding:8px;border-radius:6px;border:1px solid var(--borders-and-separators);background:var(--secondary-button);color:var(--text-primary);">
      </label>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="fencord-quick-save" style="flex:1;padding:10px;border-radius:6px;border:none;background:var(--primary-action);color:var(--primary-foreground);cursor:pointer;font-weight:bold;">Save</button>
        <button id="fencord-quick-cancel" style="flex:1;padding:10px;border-radius:6px;border:none;background:var(--secondary-button);color:var(--text-primary);cursor:pointer;">Cancel</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);user-select:none;">made by @kitty and @702 on fenrid</div>
    `;

    modalOverlay.appendChild(box);
    document.body.appendChild(modalOverlay);

    box.querySelector('#fencord-quick-cancel').addEventListener('click', () => modalOverlay.remove());
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) modalOverlay.remove();
    });

    box.querySelector('#fencord-quick-save').addEventListener('click', () => {
      const bg = box.querySelector('#fencord-bg-color').value;
      const accent = box.querySelector('#fencord-accent-color').value;
      const name = box.querySelector('#fencord-theme-name').value.trim() || 'Quick Theme';

      const vars = deriveThemeFromTwoColors(bg, accent);
      const sanitized = sanitizeThemeObject({ name, vars });
      if (!sanitized.ok) {
        alert('Could not save theme — colors failed safety checks.');
        return;
      }
      const key = 'custom_' + sanitized.theme.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now();

      const custom = getCustomThemes();
      custom[key] = sanitized.theme;
      saveCustomThemes(custom);

      applyTheme(key);
      saveTheme(key);

      modalOverlay.remove();
      rerenderPanel();
    });
  }

  const RGB_USERNAMES_KEY = 'fencord-rgb-usernames';
  let rgbObserver = null;
  let rgbInterval = null;
  const rgbColors = ['#ff0000', '#ff9900', '#ffee00', '#00ff66', '#00ccff', '#cc00ff'];

  function tickRgbColors() {
    const now = Date.now();
    // Only target actual clickable username spans (they carry cursor-pointer),
    // not the "font-semibold" date-divider spans that share the same base class.
    document.querySelectorAll('span.font-semibold.cursor-pointer').forEach((el, i) => {
      // offset each username slightly so they don't all flash in sync
      const step = Math.floor((now / 600) + i) % rgbColors.length;
      el.style.setProperty('color', rgbColors[step], 'important');
      el.dataset.fencordRgb = '1';
    });
  }

  function removeRgbFromUsernames() {
    document.querySelectorAll('[data-fencord-rgb]').forEach(el => {
      el.style.removeProperty('color');
      delete el.dataset.fencordRgb;
    });
  }

  function isRgbEnabled() {
    return localStorage.getItem(RGB_USERNAMES_KEY) === 'true';
  }

  function setRgbEnabled(enabled) {
    localStorage.setItem(RGB_USERNAMES_KEY, enabled ? 'true' : 'false');
    if (enabled) {
      if (!rgbInterval) {
        rgbInterval = setInterval(tickRgbColors, 150);
      }
      if (!rgbObserver) {
        rgbObserver = new MutationObserver(() => tickRgbColors());
        rgbObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      removeRgbFromUsernames();
      if (rgbInterval) {
        clearInterval(rgbInterval);
        rgbInterval = null;
      }
      if (rgbObserver) {
        rgbObserver.disconnect();
        rgbObserver = null;
      }
    }
  }

  // ---------------------------------------------------------------
  // FONT PLUGIN
  // Injects a Google Fonts <link> and applies the chosen font-family
  // to the whole app via a !important style rule. Supports a preset
  // list plus a custom Google Font name typed by the user.
  // ---------------------------------------------------------------

  const FONT_KEY = 'fencord-active-font';
  const FONT_LINK_ID = 'fencord-font-link';
  const FONT_STYLE_ID = 'fencord-font-style';
  const FONTS_CACHE_KEY = 'fencord-remote-fonts';
  let remoteFonts = null;
  let fencordBtnObserver = null;

  const FALLBACK_FONTS = [
    { id: 'default', label: 'Default', family: null, googleName: null },
    { id: 'inter', label: 'Inter', family: "'Inter', sans-serif", googleName: 'Inter:wght@400;600;700' },
    { id: 'couriernew', label: 'Courier New', family: "'Courier New', Courier, monospace", googleName: null }
  ];

  // Plugin string safety: fonts/names are injected into CSS or URLs.
  function isSafeFontFamily(family) {
    if (family == null) return true;
    if (typeof family !== 'string') return false;
    const v = family.trim();
    if (!v || v.length > 120) return false;
    if (/url\s*\(|@import|expression\s*\(|javascript:|data:|<|>|[{};\\]|\/\*|\*\//i.test(v)) return false;
    return /^[a-zA-Z0-9\s,'"_-]+$/.test(v);
  }

  function isSafeGoogleFontName(name) {
    if (name == null) return true;
    if (typeof name !== 'string') return false;
    const v = name.trim();
    if (!v || v.length > 80) return false;
    if (/url\s*\(|https?:|\/\/|<|>|[{}\\'"]/i.test(v)) return false;
    // e.g. Inter:wght@400;600;700 or Press+Start+2P
    return /^[A-Za-z0-9]+(?:[+ ][A-Za-z0-9]+)*(?::wght@[0-9;]+)?$/.test(v);
  }

  function sanitizePlainLabel(text, maxLen = 32) {
    if (typeof text !== 'string') return '';
    let t = text.replace(/[\u0000-\u001F\u007F<>&`"\\]/g, '').trim();
    if (t.length > maxLen) t = t.slice(0, maxLen);
    return t;
  }

  function sanitizeFontPreset(f) {
    if (!f || typeof f !== 'object') return null;
    if (typeof f.id !== 'string' || !/^[a-z0-9_-]+$/i.test(f.id) || f.id.length > 40) return null;
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > 60 || /[<>]/.test(f.label)) return null;
    if (!('family' in f) || !('googleName' in f)) return null;
    if (f.family != null && !isSafeFontFamily(f.family)) return null;
    if (f.googleName != null && !isSafeGoogleFontName(f.googleName)) return null;
    return {
      id: f.id,
      label: f.label.trim(),
      family: f.family == null ? null : String(f.family).trim(),
      googleName: f.googleName == null ? null : String(f.googleName).trim()
    };
  }

  function sanitizeSavedFontData(fontData) {
    if (!fontData || typeof fontData !== 'object') return null;
    if (!fontData.family) return null;
    if (!isSafeFontFamily(fontData.family)) return null;
    if (fontData.googleName != null && !isSafeGoogleFontName(fontData.googleName)) return null;
    const label = sanitizePlainLabel(typeof fontData.label === 'string' ? fontData.label : 'Custom', 60);
    return {
      family: fontData.family.trim(),
      googleName: fontData.googleName == null ? null : String(fontData.googleName).trim(),
      label: label || 'Custom'
    };
  }

  function getCachedFonts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FONTS_CACHE_KEY) || 'null');
      if (!Array.isArray(parsed) || !parsed.length) return null;
      const cleaned = parsed.map(sanitizeFontPreset).filter(Boolean);
      if (!cleaned.length || cleaned[0].id !== 'default') return null;
      return cleaned;
    } catch (e) {}
    return null;
  }

  function saveCachedFonts(fonts) {
    localStorage.setItem(FONTS_CACHE_KEY, JSON.stringify(fonts));
  }

  function getPresetFonts() {
    return remoteFonts || getCachedFonts() || FALLBACK_FONTS;
  }

  function getSavedFont() {
    try {
      return sanitizeSavedFontData(JSON.parse(localStorage.getItem(FONT_KEY) || 'null'));
    } catch (e) {
      return null;
    }
  }

  function saveFont(fontData) {
    if (!fontData) {
      localStorage.removeItem(FONT_KEY);
      return;
    }
    const clean = sanitizeSavedFontData(fontData);
    if (!clean) {
      localStorage.removeItem(FONT_KEY);
      return;
    }
    localStorage.setItem(FONT_KEY, JSON.stringify(clean));
  }

  function loadGoogleFont(googleName) {
    if (!isSafeGoogleFontName(googleName)) return;
    let link = document.getElementById(FONT_LINK_ID);
    if (!link) {
      link = document.createElement('link');
      link.id = FONT_LINK_ID;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    // Keep Google's expected family=Name:wght@... shape; value is allowlisted above.
    link.href = `https://fonts.googleapis.com/css2?family=${googleName}&display=swap`;
  }

  function applyFont(fontData) {
    let styleEl = document.getElementById(FONT_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = FONT_STYLE_ID;
      document.head.appendChild(styleEl);
    }

    const clean = sanitizeSavedFontData(fontData);
    if (!clean || !clean.family) {
      styleEl.textContent = '';
      const link = document.getElementById(FONT_LINK_ID);
      if (link) link.remove();
      return;
    }

    if (clean.googleName) {
      loadGoogleFont(clean.googleName);
    } else {
      const link = document.getElementById(FONT_LINK_ID);
      if (link) link.remove();
    }

    styleEl.textContent = `* { font-family: ${clean.family} !important; }`;
  }

  function setPresetFont(presetId) {
    if (typeof presetId !== 'string' || !/^[a-z0-9_-]+$/i.test(presetId)) return;
    const preset = getPresetFonts().find(f => f.id === presetId);
    if (!preset) return;
    const fontData = preset.family
      ? sanitizeSavedFontData({ family: preset.family, googleName: preset.googleName, label: preset.label })
      : null;
    saveFont(fontData);
    applyFont(fontData);
  }

  function setCustomFont(name) {
    const trimmed = sanitizePlainLabel(typeof name === 'string' ? name.trim() : '', 60);
    if (!trimmed) return;
    const googleName = trimmed.replace(/\s+/g, '+');
    if (!isSafeGoogleFontName(googleName)) {
      alert('Font blocked — use a plain Google Fonts name (letters/numbers/spaces only).');
      return;
    }
    const fontData = sanitizeSavedFontData({
      family: `'${trimmed}', sans-serif`,
      googleName,
      label: trimmed
    });
    if (!fontData) {
      alert('Font blocked — unsafe font-family value.');
      return;
    }
    saveFont(fontData);
    applyFont(fontData);
  }

  function initFont() {
    const saved = getSavedFont();
    if (saved) applyFont(saved);
  }


  function createSettingsUI() {
    // Guard: if button already exists and is in DOM, just ensure overlay exists
    const existingBtn = document.getElementById('fencord-btn');
    const existingOverlay = document.getElementById('fencord-overlay');

    if (existingBtn && existingBtn.isConnected && existingOverlay && existingOverlay.isConnected) {
      // Already initialized, just refresh the panel if needed
      if (typeof refreshSettingsPanel === 'function') refreshSettingsPanel();
      return;
    }

    const settingsBtn = document.querySelector('button[title="Settings"]');
    if (!settingsBtn) {
      // Settings button not found yet, retry once after delay
      setTimeout(createSettingsUI, 1000);
      return;
    }

    // Remove old elements if they exist but are detached (cleanup)
    if (existingBtn && !existingBtn.isConnected) existingBtn.remove();
    if (existingOverlay && !existingOverlay.isConnected) existingOverlay.remove();

    const btn = settingsBtn.cloneNode(true);
    btn.id = 'fencord-btn';
    btn.title = `Fencord Settings — ${CREDITS_TEXT}`;
    const svg = btn.querySelector('svg');
    if (svg) svg.outerHTML = '🛠️';

    settingsBtn.parentElement.insertBefore(btn, settingsBtn);

    // --- full-screen overlay ---
    let overlay = document.getElementById('fencord-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fencord-overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        background: 'var(--background)',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        zIndex: 999999,
        display: 'none'
      });
      document.body.appendChild(overlay);
    } else {
      // Clear existing content to rebuild
      overlay.innerHTML = '';
    }

    const layout = document.createElement('div');
    Object.assign(layout.style, {
      display: 'flex',
      width: '100%',
      height: '100%',
      maxWidth: '1100px',
      margin: '0 auto'
    });

    const sidebar = document.createElement('div');
    Object.assign(sidebar.style, {
      width: '240px',
      flexShrink: '0',
      background: 'var(--channel-sidebar)',
      padding: '32px 12px',
      boxSizing: 'border-box'
    });

    const content = document.createElement('div');
    Object.assign(content.style, {
      flex: '1',
      padding: '48px 56px',
      overflowY: 'auto',
      boxSizing: 'border-box'
    });

    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'fixed',
      top: '28px',
      right: '36px',
      fontSize: '22px',
      cursor: 'pointer',
      color: 'var(--text-muted)',
      zIndex: 1000000
    });
    closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = 'var(--text-primary)');
    closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = 'var(--text-muted)');
    closeBtn.addEventListener('click', () => overlay.style.display = 'none');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });

    layout.appendChild(sidebar);
    layout.appendChild(content);
    overlay.appendChild(layout);
    overlay.appendChild(closeBtn);

    let activeTab = 'themes';

    function renderThemesTab(body) {
      if (updateCheckResult && updateCheckResult.available) {
        const banner = buildUpdateBanner({ dismissible: true, compact: true });
        Object.assign(banner.style, { marginBottom: '20px' });
        body.appendChild(banner);
      }

      const themes = getAllThemes();
      const entries = Object.entries(themes).sort(([keyA, themeA], [keyB, themeB]) => {
        const customA = keyA.startsWith('custom_');
        const customB = keyB.startsWith('custom_');
        if (keyA === 'none') return -1;
        if (keyB === 'none') return 1;
        if (customA !== customB) return customA ? 1 : -1;
        return themeA.name.localeCompare(themeB.name);
      });

      for (const [key, theme] of entries) {
        const selected = getSavedTheme() === key;
        const row = document.createElement('div');
        Object.assign(row.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          marginBottom: '4px',
          maxWidth: '420px',
          width: '100%'
        });

        const option = document.createElement('div');
        option.textContent = theme.name;
        Object.assign(option.style, {
          flex: '1',
          minWidth: '0',
          padding: '10px 14px',
          borderRadius: '6px',
          cursor: 'pointer',
          background: selected ? 'var(--hover-overlay)' : 'transparent',
          color: 'var(--text-primary)'
        });
        option.addEventListener('mouseenter', () => { option.style.background = 'var(--hover-overlay)'; });
        option.addEventListener('mouseleave', () => {
          option.style.background = getSavedTheme() === key ? 'var(--hover-overlay)' : 'transparent';
        });
        option.addEventListener('click', () => {
          applyTheme(key);
          saveTheme(key);
          renderPanel();
        });
        row.appendChild(option);

        const trailing = document.createElement('div');
        Object.assign(trailing.style, {
          flexShrink: '0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px'
        });

        if (key.startsWith('custom_')) {
          const expBtn = document.createElement('div');
          expBtn.textContent = '↑';
          Object.assign(expBtn.style, {
            width: '32px',
            textAlign: 'center',
            padding: '10px 0',
            borderRadius: '6px',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '14px',
            fontWeight: '700'
          });
          expBtn.title = 'Export theme (copy JSON)';
          expBtn.addEventListener('mouseenter', () => {
            expBtn.style.background = 'var(--secondary-button-hover)';
            expBtn.style.color = 'var(--text-primary)';
          });
          expBtn.addEventListener('mouseleave', () => {
            expBtn.style.background = '';
            expBtn.style.color = 'var(--text-muted)';
          });
          expBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportThemeFlow(theme);
          });
          trailing.appendChild(expBtn);

          const delBtn = document.createElement('div');
          delBtn.textContent = '✕';
          Object.assign(delBtn.style, {
            width: '32px',
            textAlign: 'center',
            padding: '10px 0',
            borderRadius: '6px',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '13px',
            fontWeight: '700'
          });
          delBtn.title = 'Delete theme';
          delBtn.addEventListener('mouseenter', () => {
            delBtn.style.background = 'var(--danger-secondary-button)';
            delBtn.style.color = 'var(--text-primary)';
          });
          delBtn.addEventListener('mouseleave', () => {
            delBtn.style.background = '';
            delBtn.style.color = 'var(--text-muted)';
          });
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm(`Delete theme "${theme.name}"?`)) return;

            const custom = getCustomThemes();
            delete custom[key];
            saveCustomThemes(custom);

            if (getSavedTheme() === key) {
              applyTheme('none');
              saveTheme('none');
            }

            renderPanel();
          });
          trailing.appendChild(delBtn);
        }

        row.appendChild(trailing);
        body.appendChild(row);
      }

      const divider = document.createElement('div');
      Object.assign(divider.style, { borderTop: '1px solid var(--borders-and-separators)', margin: '20px 0', maxWidth: '420px' });
      body.appendChild(divider);

      const actionsRow = document.createElement('div');
      Object.assign(actionsRow.style, {
        display: 'flex',
        gap: '8px',
        maxWidth: '420px',
        width: '100%'
      });

      function makeActionBtn(label, onClick) {
        const btn = document.createElement('div');
        btn.textContent = label;
        Object.assign(btn.style, {
          flex: '1',
          textAlign: 'center',
          padding: '10px 12px',
          borderRadius: '6px',
          cursor: 'pointer',
          background: 'var(--secondary-button)',
          color: 'var(--text-primary)',
          fontSize: '13px',
          whiteSpace: 'nowrap'
        });
        btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--secondary-button-hover)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--secondary-button)'; });
        btn.addEventListener('click', onClick);
        return btn;
      }

      actionsRow.appendChild(makeActionBtn('Import Theme', () => importThemeFlow(renderPanel)));
      actionsRow.appendChild(makeActionBtn('Copy Template', copyTemplate));
      actionsRow.appendChild(makeActionBtn('Quick 2-Color', () => openQuickThemeUI(renderPanel)));
      body.appendChild(actionsRow);

      // --- Background Effect (Matrix / Rain / Fire) ---
      const fxDivider = document.createElement('div');
      Object.assign(fxDivider.style, { borderTop: '1px solid var(--borders-and-separators)', margin: '20px 0', maxWidth: '420px' });
      body.appendChild(fxDivider);

      const fxSection = document.createElement('div');
      Object.assign(fxSection.style, {
        padding: '14px 16px', borderRadius: '8px', background: 'var(--secondary-button)',
        maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '10px'
      });

      const fxLabel = document.createElement('div');
      const fxTitle = document.createElement('div');
      fxTitle.style.fontWeight = '600';
      fxTitle.textContent = 'Background Effect';
      const fxSub = document.createElement('div');
      Object.assign(fxSub.style, { fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' });
      fxSub.textContent = 'Animated backdrop behind the app (one at a time)';
      fxLabel.appendChild(fxTitle);
      fxLabel.appendChild(fxSub);
      fxSection.appendChild(fxLabel);

      const fxSelect = document.createElement('select');
      Object.assign(fxSelect.style, {
        padding: '8px', borderRadius: '6px',
        border: '1px solid var(--borders-and-separators)',
        background: 'var(--popups-and-modals)', color: 'var(--text-primary)', cursor: 'pointer'
      });
      getBackgroundEffects().forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.id === 'none'
          ? o.label
          : `${o.label} — needs a theme or it may not be visible`;
        fxSelect.appendChild(opt);
      });
      fxSelect.value = getBackgroundEffect();
      fxSelect.addEventListener('change', () => {
        setBackgroundEffect(fxSelect.value);
      });
      fxSection.appendChild(fxSelect);

      const fxHint = document.createElement('div');
      fxHint.textContent = 'Turn on a theme first — without one, effects may not be visible.';
      Object.assign(fxHint.style, {
        fontSize: '11px',
        color: 'var(--text-muted)',
        lineHeight: '1.35'
      });
      fxSection.appendChild(fxHint);
      body.appendChild(fxSection);

      body.appendChild(makeCreditNote());
    }

    function renderFavoritesTab(body) {
      const list = getFavoritePlugins();

      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No favorites yet — open the Plugins tab and tap the ☆ in a card\'s corner.';
        Object.assign(empty.style, {
          textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)',
          fontSize: '13px', fontStyle: 'italic'
        });
        body.appendChild(empty);
        return;
      }

      const wrap = document.createElement('div');
      Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '420px' });

      list.forEach(title => {
        const card = document.createElement('div');
        Object.assign(card.style, {
          padding: '12px 14px', borderRadius: '10px', background: 'var(--secondary-button)',
          border: '1px solid var(--borders-and-separators)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px'
        });

        const name = document.createElement('div');
        name.textContent = '★ ' + title;
        Object.assign(name.style, { fontSize: '13px', fontWeight: '650', color: 'var(--text-primary)' });
        card.appendChild(name);

        const actions = document.createElement('div');
        Object.assign(actions.style, { display: 'flex', gap: '10px', flexShrink: '0' });

        const goBtn = document.createElement('div');
        goBtn.textContent = '↳ Open';
        Object.assign(goBtn.style, { fontSize: '11px', fontWeight: '700', cursor: 'pointer', color: 'var(--primary-action)' });
        goBtn.addEventListener('click', () => {
          activeTab = 'plugins';
          renderPanel();
          setTimeout(() => {
            const target = Array.from(content.querySelectorAll('[data-plugin-title]'))
              .find(el => el.dataset.pluginTitle === title);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const prevBg = target.style.background;
              target.style.transition = 'background 0.3s ease';
              target.style.background = 'var(--hover-overlay)';
              setTimeout(() => { target.style.background = prevBg; }, 900);
            }
          }, 30);
        });
        actions.appendChild(goBtn);

        const removeBtn = document.createElement('div');
        removeBtn.textContent = '🗑';
        removeBtn.title = 'Remove from Favorites';
        Object.assign(removeBtn.style, { fontSize: '13px', cursor: 'pointer', color: 'var(--danger-red)' });
        removeBtn.addEventListener('click', () => {
          togglePluginFavorite(title);
          renderPanel();
        });
        actions.appendChild(removeBtn);

        card.appendChild(actions);
        wrap.appendChild(card);
      });

      body.appendChild(wrap);
    }

    function renderPluginsTab(body) {
      if (updateCheckResult && updateCheckResult.available) {
        const banner = buildUpdateBanner({ dismissible: true, compact: true });
        Object.assign(banner.style, { marginBottom: '14px', maxWidth: '100%' });
        body.appendChild(banner);
      }

      const noticeRow = document.createElement('div');
      Object.assign(noticeRow.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '0 2px 12px',
        width: '100%',
        boxSizing: 'border-box'
      });

      const pluginsCompact = isPluginsCompact();

      const notice = document.createElement('div');
      notice.textContent = pluginsCompact
        ? 'Compact mode — expand for Soft Tap options, Font, and more.'
        : 'If a toggle doesn\'t fully undo (e.g. RGB Usernames), refresh the page.';
      Object.assign(notice.style, {
        fontSize: '12px',
        color: 'var(--text-muted)',
        minWidth: '0',
        flex: '1',
        lineHeight: '1.35'
      });
      noticeRow.appendChild(notice);

      const compactBtn = document.createElement('div');
      compactBtn.textContent = pluginsCompact ? 'Expanded' : 'Compact';
      Object.assign(compactBtn.style, {
        padding: '6px 10px',
        borderRadius: '6px',
        cursor: 'pointer',
        background: pluginsCompact ? 'var(--primary-action)' : 'var(--secondary-button)',
        color: pluginsCompact ? 'var(--primary-foreground)' : 'var(--text-primary)',
        fontSize: '12px',
        fontWeight: '650',
        flexShrink: '0',
        border: '1px solid var(--borders-and-separators)',
        userSelect: 'none'
      });
      compactBtn.title = 'Toggle compact plugin cards (icons + toggles)';
      compactBtn.addEventListener('click', () => {
        setPluginsCompact(!isPluginsCompact());
        renderPanel();
      });
      noticeRow.appendChild(compactBtn);
      body.appendChild(noticeRow);

      const disclaimerRow = document.createElement('div');
      disclaimerRow.textContent = "Fencord is an unofficial, community-made tool. It is not built by the Fenrid team, but the owner is aware of it and has said it's fine to use. Fenrid is developed and paid for out of pocket by its owner — if you enjoy the platform, please consider supporting the official paid plan when it launches. It directly keeps this running for everyone.";
      Object.assign(disclaimerRow.style, {
        fontSize: '11px',
        color: 'var(--warning-yellow)',
        background: 'var(--secondary-button)',
        padding: '8px',
        borderRadius: '6px',
        marginBottom: '12px',
        lineHeight: '1.4',
        border: '1px solid var(--borders-and-separators)'
      });
      body.appendChild(disclaimerRow);

      const pluginGrid = document.createElement('div');
      Object.assign(pluginGrid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gridAutoRows: pluginsCompact ? 'auto' : '1fr',
        gap: pluginsCompact ? '8px' : '10px',
        width: '100%',
        alignItems: 'stretch'
      });

      function styleField(el) {
        Object.assign(el.style, {
          width: '100%',
          minWidth: '0',
          padding: '8px 10px',
          borderRadius: '6px',
          border: '1px solid var(--borders-and-separators)',
          background: 'var(--popups-and-modals)',
          color: 'var(--text-primary)',
          boxSizing: 'border-box',
          fontSize: '13px'
        });
      }

      function makeToggle(enabled, onChange, { dimmed = false } = {}) {
        const toggle = document.createElement('div');
        Object.assign(toggle.style, {
          width: '42px',
          height: '24px',
          borderRadius: '12px',
          background: enabled ? 'var(--primary-action)' : 'var(--borders-and-separators)',
          position: 'relative',
          cursor: 'pointer',
          flexShrink: '0',
          transition: 'background 0.15s',
          opacity: dimmed ? '0.45' : '1'
        });
        const knob = document.createElement('div');
        Object.assign(knob.style, {
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: '#fff',
          position: 'absolute',
          top: '3px',
          left: enabled ? '21px' : '3px',
          transition: 'left 0.15s'
        });
        toggle.appendChild(knob);
        toggle.addEventListener('click', () => {
          const next = onChange();
          toggle.style.background = next ? 'var(--primary-action)' : 'var(--borders-and-separators)';
          knob.style.left = next ? '21px' : '3px';
        });
        return toggle;
      }

      function makePluginCard({ icon, title, desc, badge, enabled, onToggle, dimmed, wide, build, forceFull }) {
        const compact = pluginsCompact && !forceFull;
        const card = document.createElement('div');
        Object.assign(card.style, {
          display: 'flex',
          flexDirection: 'column',
          gap: compact ? '0' : (build ? '6px' : '10px'),
          padding: compact ? '10px 12px' : (build ? '10px 12px' : '14px'),
          borderRadius: '10px',
          background: 'var(--secondary-button)',
          border: '1px solid var(--borders-and-separators)',
          minWidth: '0',
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          minHeight: compact ? '52px' : (onToggle && !build ? '72px' : '0'),
          justifyContent: compact ? 'center' : 'flex-start',
          gridColumn: wide && !compact ? '1 / -1' : 'auto'
        });

        const head = document.createElement('div');
        Object.assign(head.style, {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px'
        });

        const textWrap = document.createElement('div');
        Object.assign(textWrap.style, {
          minWidth: '0',
          flex: '1',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        });

        if (icon) {
          const iconEl = document.createElement('div');
          iconEl.textContent = icon;
          Object.assign(iconEl.style, {
            fontSize: compact ? '16px' : '15px',
            lineHeight: '1',
            flexShrink: '0',
            width: '22px',
            textAlign: 'center'
          });
          textWrap.appendChild(iconEl);
        }

        const textCol = document.createElement('div');
        Object.assign(textCol.style, { minWidth: '0', flex: '1' });

        const titleEl = document.createElement('div');
        Object.assign(titleEl.style, {
          fontWeight: '650',
          fontSize: compact ? '13px' : '14px',
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap'
        });
        titleEl.appendChild(document.createTextNode(title));
        if (badge && !compact) {
          const badgeEl = document.createElement('span');
          badgeEl.textContent = badge;
          Object.assign(badgeEl.style, {
            fontSize: '10px',
            fontWeight: '700',
            color: 'var(--warning-yellow)',
            letterSpacing: '0.02em'
          });
          titleEl.appendChild(badgeEl);
        }
        textCol.appendChild(titleEl);

        if (desc && !compact) {
          const descEl = document.createElement('div');
          descEl.textContent = desc;
          Object.assign(descEl.style, {
            fontSize: '12px',
            color: 'var(--text-muted)',
            marginTop: '4px',
            lineHeight: '1.35'
          });
          textCol.appendChild(descEl);
        }

        textWrap.appendChild(textCol);
        head.appendChild(textWrap);
        if (title) head.appendChild(favBuildStar(title));
        if (typeof enabled === 'boolean' && typeof onToggle === 'function') {
          head.appendChild(makeToggle(enabled, onToggle, { dimmed }));
        }
        card.appendChild(head);

        if (!compact && typeof build === 'function') {
          const controls = document.createElement('div');
          Object.assign(controls.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            marginTop: '0px'
          });
          build(controls, styleField);
          card.appendChild(controls);
        }

        if (title) card.dataset.pluginTitle = title;

        pluginGrid.appendChild(card);
        return card;
      }

      // Toggles first — even 2×2 grid
      makePluginCard({
        icon: '🌈',
        title: 'RGB Usernames',
        desc: 'Cycle chat usernames through rainbow colors',
        enabled: isRgbEnabled(),
        onToggle: () => {
          const next = !isRgbEnabled();
          setRgbEnabled(next);
          return next;
        }
      });

      makePluginCard({
        icon: '🔊',
        title: 'Soft Tap Sounds',
        desc: 'Quiet taps when typing or clicking',
        enabled: isSoftTapsEnabled(),
        onToggle: () => {
          const next = !isSoftTapsEnabled();
          setSoftTapsEnabled(next);
          return next;
        },
        build: (controls, styleField) => {
          const styleSelect = document.createElement('select');
          styleField(styleSelect);
          styleSelect.style.cursor = 'pointer';
          getSoftTapStyles().forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.label;
            styleSelect.appendChild(opt);
          });
          styleSelect.value = getSoftTapStyle();
          styleSelect.addEventListener('change', () => {
            setSoftTapStyle(styleSelect.value);
            if (isSoftTapsEnabled()) playSoftTap({ kind: 'click' });
          });
          controls.appendChild(styleSelect);

          const triggerSelect = document.createElement('select');
          styleField(triggerSelect);
          triggerSelect.style.cursor = 'pointer';
          getSoftTapTriggers().forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.label;
            triggerSelect.appendChild(opt);
          });
          triggerSelect.value = getSoftTapTrigger();
          triggerSelect.addEventListener('change', () => {
            setSoftTapTrigger(triggerSelect.value);
          });
          controls.appendChild(triggerSelect);

          const volumeSelect = document.createElement('select');
          styleField(volumeSelect);
          volumeSelect.style.cursor = 'pointer';
          getSoftTapVolumes().forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.label;
            volumeSelect.appendChild(opt);
          });
          volumeSelect.value = getSoftTapVolume();
          volumeSelect.addEventListener('change', () => {
            setSoftTapVolume(volumeSelect.value);
            if (isSoftTapsEnabled()) playSoftTap({ kind: 'click' });
          });
          controls.appendChild(volumeSelect);
        }
      });

      makePluginCard({
        icon: '🌫️',
        title: 'Blur Images',
        desc: 'Hide images until clicked (spoiler-style)',
        enabled: isImageBlurEnabled(),
        onToggle: () => {
          const next = !isImageBlurEnabled();
          setImageBlurEnabled(next);
          return next;
        }
      });

      makePluginCard({
        icon: '⏱️',
        title: 'Call Timer',
        desc: 'Show how long you\'ve been in the current call',
        enabled: isCallTimerEnabled(),
        onToggle: () => {
          const next = !isCallTimerEnabled();
          setCallTimerEnabled(next);
          return next;
        }
      });

      makePluginCard({
        icon: '✨',
        title: 'UI Animations',
        desc: 'Add smooth transitions and pop-in animations to the app',
        enabled: isUiAnimationsEnabled(),
        onToggle: () => {
          const next = !isUiAnimationsEnabled();
          setUiAnimationsEnabled(next);
          return next;
        }
      });

      makePluginCard({
        icon: '🎵',
        title: 'Media Controller',
        desc: 'Intercept media playback into a draggable control panel',
        enabled: isMediaControllerEnabled(),
        onToggle: () => {
          const next = !isMediaControllerEnabled();
          setMediaControllerEnabled(next);
          return next;
        }
      });

      makePluginCard({
        icon: '🕵️',
        title: 'Username Hider',
        desc: 'Scramble usernames into random characters',
        enabled: getUsernameHiderMode() !== 'off',
        onToggle: () => {
          const next = getUsernameHiderMode() === 'off' ? 'both' : 'off';
          setUsernameHiderMode(next);
          return next !== 'off';
        },
        build: (controls, styleField) => {
          const modeSelect = document.createElement('select');
          styleField(modeSelect);
          modeSelect.style.cursor = 'pointer';
          modeSelect.style.fontSize = '12px';
          modeSelect.style.padding = '6px 8px';
          [
            { id: 'off', label: 'Off' },
            { id: 'mine', label: 'Hide mine only' },
            { id: 'others', label: 'Hide others only' },
            { id: 'both', label: 'Hide all' }
          ].forEach(o => {
            const opt = document.createElement('option');
            opt.value = o.id;
            opt.textContent = o.label;
            modeSelect.appendChild(opt);
          });
          modeSelect.value = getUsernameHiderMode();
          modeSelect.addEventListener('change', () => {
            setUsernameHiderMode(modeSelect.value);
            renderPanel();
          });
          controls.appendChild(modeSelect);
        }
      });
      makePluginCard({
        icon: '🔌',
        title: 'Custom Plugin',
        desc: 'PASTE UR PLUGIN lol',
        enabled: isCustomPluginEnabled(),
        onToggle: () => {
          const next = !isCustomPluginEnabled();
          setCustomPluginEnabled(next);
          return next;
        },
        build: (controls, styleField) => {
          const codeArea = document.createElement('textarea');
          codeArea.placeholder = '';
          codeArea.value = getCustomPluginCode();
          Object.assign(codeArea.style, {
            width: '100%', minHeight: '120px', padding: '10px',
            borderRadius: '6px', border: '1px solid var(--borders-and-separators)',
            background: 'var(--popups-and-modals)', color: 'var(--text-primary)',
            fontFamily: 'monospace', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box'
          });
          controls.appendChild(codeArea);

          const btnRow = document.createElement('div');
          Object.assign(btnRow.style, { display: 'flex', gap: '8px', marginTop: '8px' });

          const saveBtn = document.createElement('div');
          saveBtn.textContent = '💾 Save & Test';
          Object.assign(saveBtn.style, {
            flex: '1', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer',
            background: 'var(--primary-action)', color: 'var(--primary-foreground)',
            fontWeight: '700', fontSize: '12px', textAlign: 'center'
          });
          saveBtn.addEventListener('click', () => {
            saveCustomPluginCode(codeArea.value);
            if (isCustomPluginEnabled()) {
              runCustomPlugin();
              showToast('Custom plugin saved & running!', { color: 'var(--success-green)' });
            } else {
              showToast('Custom plugin saved! Enable toggle to run.', { color: 'var(--warning-yellow)' });
            }
          });

          const scanBtn = document.createElement('div');
          scanBtn.textContent = '🔒 Security Scan';
          Object.assign(scanBtn.style, {
            flex: '1', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer',
            background: 'var(--secondary-button)', color: 'var(--text-primary)',
            fontWeight: '700', fontSize: '12px', textAlign: 'center'
          });
          scanBtn.addEventListener('click', () => {
            const result = scanCustomPlugin(codeArea.value);
            if (result.all.length === 0) {
              alert('✅ Security scan passed! No suspicious patterns found.');
              return;
            }
            let msg = '';
            if (result.high.length) {
              msg += '⛔ Blocking issues:\n• ' + result.high.map(i => i.name).join('\n• ') + '\n\n';
            }
            if (result.medium.length) {
              msg += '⚠️ Worth reviewing:\n• ' + result.medium.map(i => i.name).join('\n• ') + '\n\n';
            }
            msg += result.blocked
              ? 'This plugin will be blocked from running until the blocking issues above are removed.'
              : 'Nothing here blocks the plugin, but double-check these are intentional.';
            alert(msg);
          });

          const loadBtn = document.createElement('div');
          loadBtn.textContent = '📁 Load from File';
          Object.assign(loadBtn.style, {
            flex: '1', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer',
            background: 'var(--secondary-button)', color: 'var(--text-primary)',
            fontWeight: '700', fontSize: '12px', textAlign: 'center'
          });
          const fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = '.js,.txt';
          fileInput.style.display = 'none';
          fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            if (file.size > 512 * 1024) {
              showToast('File too large (max 512KB).', { color: 'var(--danger-red)' });
              fileInput.value = '';
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              codeArea.value = String(reader.result || '');
              const scan = scanCustomPlugin(codeArea.value);
              if (scan.blocked) {
                showToast('File loaded — contains blocking issues, run Security Scan for details.', { color: 'var(--warning-yellow)' });
              } else {
                showToast('File loaded into the code editor.', { color: 'var(--success-green)' });
              }
            };
            reader.onerror = () => showToast('Could not read that file.', { color: 'var(--danger-red)' });
            reader.readAsText(file);
            fileInput.value = '';
          });
          loadBtn.addEventListener('click', () => fileInput.click());
          controls.appendChild(fileInput);

          btnRow.appendChild(loadBtn);
          btnRow.appendChild(saveBtn);
          btnRow.appendChild(scanBtn);
          controls.appendChild(btnRow);

          const hint = document.createElement('div');
          hint.textContent = 'Code runs in a sandbox and is always security-scanned before it runs. Dangerous APIs are blocked.';
          Object.assign(hint.style, { fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px', fontStyle: 'italic' });
          controls.appendChild(hint);
        }
      });

     makePluginCard({
  icon: '🛡️',
  title: 'FENCORD PROTECT',
  desc: 'Always-on shield. Blocks anything trying to fingerprint you, sniff the site, or pull data off your device. GET OUT BAD PEOPLE!!',
  badge: 'ALWAYS ON',
  wide: true,
  build: (controls) => {
    const stat = document.createElement('div');

    const updateCount = () => {
      stat.textContent = '🚫 Blocked so far this session: ' + fencordProtectBlockedCount();
    };

    updateCount();

    Object.assign(stat.style, {
      fontSize: '12px',
      fontWeight: '600',
      color: 'var(--success-green)',
      marginTop: '2px'
    });

window.dispatchEvent(new CustomEvent('fencord:blocked'));

    controls.appendChild(stat);
  }
});

      // Settings cards (hidden in compact — toggles-only view)
      if (!pluginsCompact) {
      makePluginCard({
        icon: '🔤',
        title: 'Font',
        desc: getSavedFont()
          ? `App-wide font — ${getSavedFont().label}`
          : 'Change the app-wide font',
        build: (controls, styleField) => {
          const fontSelect = document.createElement('select');
          styleField(fontSelect);
          fontSelect.style.cursor = 'pointer';
          getPresetFonts().forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.label;
            fontSelect.appendChild(opt);
          });
          const savedFont = getSavedFont();
          if (savedFont) {
            const match = getPresetFonts().find(f => f.label === savedFont.label);
            if (match) fontSelect.value = match.id;
          } else {
            fontSelect.value = 'default';
          }
          fontSelect.addEventListener('change', () => {
            setPresetFont(fontSelect.value);
            renderPanel();
          });
          controls.appendChild(fontSelect);

          const customRow = document.createElement('div');
          Object.assign(customRow.style, { display: 'flex', gap: '8px' });

          const customInput = document.createElement('input');
          customInput.type = 'text';
          customInput.placeholder = 'Custom Google Font…';
          styleField(customInput);
          customInput.style.flex = '1';
          customInput.style.width = 'auto';
          customRow.appendChild(customInput);

          const customBtn = document.createElement('div');
          customBtn.textContent = 'Apply';
          Object.assign(customBtn.style, {
            padding: '8px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: 'var(--primary-action)',
            color: 'var(--primary-foreground)',
            fontWeight: '700',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center'
          });
          customBtn.addEventListener('mouseenter', () => customBtn.style.background = 'var(--primary-hover)');
          customBtn.addEventListener('mouseleave', () => customBtn.style.background = 'var(--primary-action)');
          customBtn.addEventListener('click', () => {
            if (!customInput.value.trim()) return;
            setCustomFont(customInput.value);
            if (getSavedFont()) renderPanel();
          });
          customRow.appendChild(customBtn);
          controls.appendChild(customRow);
        }
      });

      makePluginCard({
        icon: '🕐',
        title: 'Timestamp Format',
        desc: 'How message times are shown',
        build: (controls, styleField) => {
          const tsSelect = document.createElement('select');
          styleField(tsSelect);
          tsSelect.style.cursor = 'pointer';
          [
            { id: 'default', label: 'Default' },
            { id: '12h', label: '12-hour' },
            { id: '24h', label: '24-hour' },
            { id: 'relative', label: 'Relative' }
          ].forEach(o => {
            const opt = document.createElement('option');
            opt.value = o.id;
            opt.textContent = o.label;
            tsSelect.appendChild(opt);
          });
          tsSelect.value = getTimestampFormat();
          tsSelect.addEventListener('change', () => setTimestampFormat(tsSelect.value));
          controls.appendChild(tsSelect);
        }
      });

      makePluginCard({
        icon: '✏️',
        title: 'Display Name',
        desc: 'Local only — others still see your real name',
        wide: true,
        build: (controls, styleField) => {
          const currentOverride = getDisplayNameOverride();

          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.placeholder = 'Real username (as in chat)';
          nameInput.value = getMyRealUsername() || '';
          styleField(nameInput);
          controls.appendChild(nameInput);

          const overrideRow = document.createElement('div');
          Object.assign(overrideRow.style, { display: 'flex', gap: '8px' });

          const overrideInput = document.createElement('input');
          overrideInput.type = 'text';
          overrideInput.placeholder = 'Show as…';
          overrideInput.value = currentOverride;
          styleField(overrideInput);
          overrideInput.style.flex = '1';
          overrideInput.style.width = 'auto';
          overrideRow.appendChild(overrideInput);

          const nameApplyBtn = document.createElement('div');
          nameApplyBtn.textContent = 'Apply';
          Object.assign(nameApplyBtn.style, {
            padding: '8px 14px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: 'var(--primary-action)',
            color: 'var(--primary-foreground)',
            fontWeight: '700',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center'
          });
          nameApplyBtn.addEventListener('mouseenter', () => nameApplyBtn.style.background = 'var(--primary-hover)');
          nameApplyBtn.addEventListener('mouseleave', () => nameApplyBtn.style.background = 'var(--primary-action)');
          nameApplyBtn.addEventListener('click', () => {
            const real = sanitizePlainLabel(nameInput.value, 32);
            const override = sanitizePlainLabel(overrideInput.value, 32);
            if (real) localStorage.setItem(ORIGINAL_NAME_KEY, real);
            saveDisplayNameOverride(override);
            setDisplayNameEnabled(!!override);
            renderPanel();
          });
          overrideRow.appendChild(nameApplyBtn);
          controls.appendChild(overrideRow);

          if (currentOverride) {
            const clearBtn = document.createElement('div');
            clearBtn.textContent = 'Clear override';
            Object.assign(clearBtn.style, {
              fontSize: '12px',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              width: 'fit-content'
            });
            clearBtn.addEventListener('click', () => {
              saveDisplayNameOverride('');
              setDisplayNameEnabled(false);
              renderPanel();
            });
            controls.appendChild(clearBtn);
          }
        }
      });

      }

      body.appendChild(pluginGrid);
      body.appendChild(makeCreditNote({ maxWidth: '100%' }));
    }

    function renderPanel() {
      sidebar.innerHTML = '';
      content.innerHTML = '';

      const logo = document.createElement('div');
      logo.textContent = 'FENCORD';
      Object.assign(logo.style, {
        fontWeight: '800',
        fontSize: '22px',
        letterSpacing: '1px',
        padding: '0 14px 8px 14px',
        color: 'var(--primary-action)',
        textShadow: '0 0 12px var(--hover-overlay)'
      });
      sidebar.appendChild(logo);

      const sidebarCredits = makeCreditNote({ compact: true, maxWidth: '180px' });
      Object.assign(sidebarCredits.style, {
        padding: '0 14px 20px 14px',
        marginTop: '0',
        fontSize: '11px',
        lineHeight: '1.3'
      });
      sidebar.appendChild(sidebarCredits);

      const tabs = [
        { id: 'themes', label: '🎨 Themes' },
        { id: 'plugins', label: '🧩 Plugins' },
        { id: 'favorites', label: '⭐ Favorites' }
      ];

      tabs.forEach(tab => {
        const tabBtn = document.createElement('div');
        tabBtn.textContent = tab.label;
        Object.assign(tabBtn.style, {
          padding: '10px 14px',
          borderRadius: '6px',
          cursor: 'pointer',
          marginBottom: '4px',
          fontSize: '14px',
          background: activeTab === tab.id ? 'var(--hover-overlay)' : 'transparent',
          color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)'
        });
        tabBtn.addEventListener('mouseenter', () => {
          if (activeTab !== tab.id) tabBtn.style.background = 'var(--hover-overlay)';
        });
        tabBtn.addEventListener('mouseleave', () => {
          if (activeTab !== tab.id) tabBtn.style.background = 'transparent';
        });
        tabBtn.addEventListener('click', () => {
          activeTab = tab.id;
          renderPanel();
        });
        sidebar.appendChild(tabBtn);
      });

      const heading = document.createElement('div');
      heading.textContent = activeTab === 'themes' ? 'Themes' : activeTab === 'plugins' ? 'Plugins' : 'Favorites';
      Object.assign(heading.style, {
        fontSize: '26px',
        fontWeight: 'bold',
        marginBottom: '28px'
      });
      content.appendChild(heading);

      const body = document.createElement('div');
      content.appendChild(body);

      if (activeTab === 'themes') {
        renderThemesTab(body);
      } else if (activeTab === 'plugins') {
        renderPluginsTab(body);
      } else if (activeTab === 'favorites') {
        renderFavoritesTab(body);
      }
    }

    renderPanel();
    refreshSettingsPanel = renderPanel;
    openFavoritesTab = function () {
      activeTab = 'favorites';
      overlay.style.display = 'block';
      renderPanel();
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = overlay.style.display !== 'none';
      overlay.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) renderPanel();
    });
  }


  function watchForSettingsButton() {
    if (fencordBtnObserver) return;

    fencordBtnObserver = new MutationObserver(() => {
      const fencordBtn = document.getElementById('fencord-btn');
      const settingsBtn = document.querySelector('button[title="Settings"]');

      // If Settings button exists but Fencord button is missing or detached from DOM
      if (settingsBtn && (!fencordBtn || !fencordBtn.isConnected)) {
        createSettingsUI();
      }
    });

    fencordBtnObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // DISPLAY NAME OVERRIDE (local only)
  // Replaces your own username text in the DOM with a custom name.
  // Purely cosmetic and client-side; does not touch what's sent or
  // what other users see.
  // ---------------------------------------------------------------

  const DISPLAY_NAME_KEY = 'fencord-display-name-override';
  const ORIGINAL_NAME_KEY = 'fencord-original-name-cache';
  let displayNameObserver = null;

  function getDisplayNameOverride() {
    return sanitizePlainLabel(localStorage.getItem(DISPLAY_NAME_KEY) || '', 32);
  }

  function saveDisplayNameOverride(name) {
    const clean = sanitizePlainLabel(name, 32);
    if (clean) {
      localStorage.setItem(DISPLAY_NAME_KEY, clean);
    } else {
      localStorage.removeItem(DISPLAY_NAME_KEY);
    }
  }

  function getMyRealUsername() {
    const raw = localStorage.getItem(ORIGINAL_NAME_KEY);
    return raw ? sanitizePlainLabel(raw, 32) || null : null;
  }

  function tickDisplayNameOverride() {
    const override = getDisplayNameOverride();
    if (!override) return;

    const myOriginal = getMyRealUsername();
    if (!myOriginal) return; // haven't learned the real name yet, skip safely

    document.querySelectorAll('span.font-semibold.cursor-pointer').forEach(el => {
      if (el.dataset.fencordNameOverridden === '1') return;
      if (el.textContent.trim() === myOriginal) {
        el.dataset.fencordOriginalName = myOriginal;
        el.dataset.fencordNameOverridden = '1';
        el.textContent = override;
      }
    });
  }

  function revertDisplayNameOverride() {
    document.querySelectorAll('[data-fencord-name-overridden="1"]').forEach(el => {
      el.textContent = el.dataset.fencordOriginalName || el.textContent;
      delete el.dataset.fencordNameOverridden;
      delete el.dataset.fencordOriginalName;
    });
  }

  function setDisplayNameEnabled(enabled) {
    if (enabled) {
      tickDisplayNameOverride();
      if (!displayNameObserver) {
        displayNameObserver = new MutationObserver(() => tickDisplayNameOverride());
        displayNameObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      revertDisplayNameOverride();
      if (displayNameObserver) {
        displayNameObserver.disconnect();
        displayNameObserver = null;
      }
    }
  }

  // Try to learn the user's real username automatically. Best-effort:
  // looks for the account panel near the settings/mute buttons (the
  // bottom-left user bar), which reliably shows your own display name.
  function tryDetectRealUsername(attemptsLeft = 10) {
    if (getMyRealUsername()) return;

    const settingsBtn = document.querySelector('button[title="Settings"]');
    if (!settingsBtn) {
      // Settings button may not be mounted yet on first paint; retry briefly,
      // mirroring createSettingsUI's own retry loop.
      if (attemptsLeft > 0) setTimeout(() => tryDetectRealUsername(attemptsLeft - 1), 1000);
      return;
    }

    // walk up to the user panel container and look for a name-like span
    let panel = settingsBtn.closest('div');
    for (let i = 0; i < 4 && panel; i++) {
      const nameSpan = panel.querySelector('span.font-semibold');
      if (nameSpan && nameSpan.textContent.trim()) {
        const detected = sanitizePlainLabel(nameSpan.textContent, 32);
        if (detected) localStorage.setItem(ORIGINAL_NAME_KEY, detected);
        if (getDisplayNameOverride()) tickDisplayNameOverride();
        return;
      }
      panel = panel.parentElement;
    }

    // Found the button but no name span nearby this time — worth one more
    // try in case the panel renders its contents a moment later.
    if (attemptsLeft > 0) setTimeout(() => tryDetectRealUsername(attemptsLeft - 1), 1000);
  }

  // ---------------------------------------------------------------
  // TIMESTAMP FORMAT PLUGIN
  // Reformats message timestamps to 12h, 24h, or relative ("5m ago").
  // ---------------------------------------------------------------

  const TIMESTAMP_FORMAT_KEY = 'fencord-timestamp-format';
  const ALLOWED_TIMESTAMP_FORMATS = new Set(['default', '12h', '24h', 'relative']);
  let timestampInterval = null;
  let timestampObserver = null;

  function getTimestampFormat() {
    const fmt = localStorage.getItem(TIMESTAMP_FORMAT_KEY) || 'default';
    return ALLOWED_TIMESTAMP_FORMATS.has(fmt) ? fmt : 'default';
  }

  function saveTimestampFormat(fmt) {
    localStorage.setItem(
      TIMESTAMP_FORMAT_KEY,
      ALLOWED_TIMESTAMP_FORMATS.has(fmt) ? fmt : 'default'
    );
  }

  function formatRelative(date) {
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  }

  function formatTimestamp(date, fmt) {
    if (fmt === '24h') {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    if (fmt === '12h') {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    }
    if (fmt === 'relative') {
      return formatRelative(date);
    }
    return null; // 'default' = leave untouched
  }

  function tickTimestamps() {
    const fmt = getTimestampFormat();
    if (fmt === 'default') return;

    document.querySelectorAll('time[datetime]').forEach(el => {
      const iso = el.getAttribute('datetime');
      if (!iso) return;
      const date = new Date(iso);
      if (isNaN(date.getTime())) return;

      if (!el.dataset.fencordOriginalText) {
        el.dataset.fencordOriginalText = el.textContent;
      }
      const formatted = formatTimestamp(date, fmt);
      if (formatted) el.textContent = formatted;
    });
  }

  function revertTimestamps() {
    document.querySelectorAll('[data-fencord-original-text]').forEach(el => {
      el.textContent = el.dataset.fencordOriginalText;
      delete el.dataset.fencordOriginalText;
    });
  }

  function setTimestampFormat(fmt) {
    const next = ALLOWED_TIMESTAMP_FORMATS.has(fmt) ? fmt : 'default';
    saveTimestampFormat(next);
    revertTimestamps();

    if (next === 'default') {
      if (timestampInterval) { clearInterval(timestampInterval); timestampInterval = null; }
      if (timestampObserver) { timestampObserver.disconnect(); timestampObserver = null; }
      return;
    }

    tickTimestamps();
    if (!timestampInterval) {
      // re-tick periodically so "relative" times keep counting up
      timestampInterval = setInterval(tickTimestamps, 30000);
    }
    if (!timestampObserver) {
      timestampObserver = new MutationObserver(() => tickTimestamps());
      timestampObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function initTimestampFormat() {
    const fmt = getTimestampFormat();
    if (fmt !== 'default') setTimestampFormat(fmt);
  }

  // ---------------------------------------------------------------
  // IMAGE SPOILER / BLUR PLUGIN
  // Blurs image attachments until clicked. Purely visual (CSS filter
  // + click-to-reveal), doesn't stop images from loading.
  // ---------------------------------------------------------------

  const IMAGE_BLUR_KEY = 'fencord-blur-images';
  let imageBlurObserver = null;

  function isImageBlurEnabled() {
    return localStorage.getItem(IMAGE_BLUR_KEY) === 'true';
  }

  function shouldSkipBlur(img) {
    // Use rendered size first (available immediately, even pre-load) as a
    // fast skip for obviously-small elements like avatars/emoji.
    const renderedWidth = img.width || img.clientWidth || 0;
    const renderedHeight = img.height || img.clientHeight || 0;
    if (renderedWidth && renderedWidth < 64) return true;
    if (renderedHeight && renderedHeight < 64) return true;

    // If the image has already finished loading, we can trust naturalWidth.
    if (img.complete && img.naturalWidth) {
      return img.naturalWidth < 64;
    }

    // Not loaded yet and no rendered size to go on — don't decide yet.
    return null;
  }

  function blurSingleImage(img) {
    img.dataset.fencordBlurred = '1';
    img.style.filter = 'blur(24px)';
    img.style.cursor = 'pointer';
    img.style.transition = 'filter 0.2s';
    img.title = 'Click to reveal';

    img.addEventListener('click', function revealHandler(e) {
      if (img.style.filter === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      img.style.filter = 'none';
    }, { capture: true });
  }

  function tickImageBlur() {
    document.querySelectorAll('img').forEach(img => {
      if (img.dataset.fencordBlurred === '1') return;
      if (img.dataset.fencordBlurSkipped === '1') return;

      const skip = shouldSkipBlur(img);

      if (skip === true) {
        img.dataset.fencordBlurSkipped = '1';
        return;
      }

      if (skip === false) {
        blurSingleImage(img);
        return;
      }

      // skip === null: size unknown yet, wait for the image to actually load
      // then decide for real, instead of guessing based on naturalWidth === 0.
      if (!img.dataset.fencordBlurPending) {
        img.dataset.fencordBlurPending = '1';
        img.addEventListener('load', () => {
          delete img.dataset.fencordBlurPending;
          if (img.naturalWidth && img.naturalWidth < 64) {
            img.dataset.fencordBlurSkipped = '1';
          } else if (!img.dataset.fencordBlurred) {
            blurSingleImage(img);
          }
        }, { once: true });
      }
    });
  }

  function revertImageBlur() {
    document.querySelectorAll('[data-fencord-blurred="1"]').forEach(img => {
      img.style.filter = '';
      img.style.cursor = '';
      img.title = '';
      delete img.dataset.fencordBlurred;
    });
    document.querySelectorAll('[data-fencord-blur-skipped]').forEach(img => {
      delete img.dataset.fencordBlurSkipped;
    });
    document.querySelectorAll('[data-fencord-blur-pending]').forEach(img => {
      delete img.dataset.fencordBlurPending;
    });
  }

  function setImageBlurEnabled(enabled) {
    localStorage.setItem(IMAGE_BLUR_KEY, enabled ? 'true' : 'false');
    if (enabled) {
      tickImageBlur();
      if (!imageBlurObserver) {
        imageBlurObserver = new MutationObserver(() => tickImageBlur());
        imageBlurObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      revertImageBlur();
      if (imageBlurObserver) {
        imageBlurObserver.disconnect();
        imageBlurObserver = null;
      }
    }
  }

  // ---------------------------------------------------------------
  // SOFT TAP SOUNDS PLUGIN
  // Quiet synthesized taps on keypress and click (Web Audio — no files).
  // ---------------------------------------------------------------

  const SOFT_TAPS_KEY = 'fencord-soft-taps';
  const SOFT_TAP_STYLE_KEY = 'fencord-soft-tap-style';
  const SOFT_TAP_TRIGGER_KEY = 'fencord-soft-tap-trigger';
  const SOFT_TAP_VOLUME_KEY = 'fencord-soft-tap-volume';
  const PLUGINS_COMPACT_KEY = 'fencord-plugins-compact';

  const SOFT_TAP_STYLES = [
    { id: 'soft', label: 'Soft — gentle triangle tick' },
    { id: 'clicky', label: 'Clicky — sharp plastic click' },
    { id: 'thock', label: 'Thock — deep low tap' },
    { id: 'glass', label: 'Glass — bright sparkle' },
    { id: 'popcorn', label: 'Popcorn — tiny high pops' },
    { id: 'typewriter', label: 'Typewriter — mid mechanical clack' }
  ];

  const SOFT_TAP_TRIGGERS = [
    { id: 'both', label: 'Play on typing + clicks' },
    { id: 'keys', label: 'Typing only' },
    { id: 'clicks', label: 'Clicks only' }
  ];

  const SOFT_TAP_VOLUMES = [
    { id: 'quiet', label: 'Volume — Quiet', mult: 0.45 },
    { id: 'normal', label: 'Volume — Normal', mult: 1 },
    { id: 'loud', label: 'Volume — Loud', mult: 1.7 }
  ];

  let softTapsCtx = null;
  let softTapsKeyHandler = null;
  let softTapsClickHandler = null;
  let softTapsLastAt = 0;

  function getSoftTapStyles() { return SOFT_TAP_STYLES; }
  function getSoftTapTriggers() { return SOFT_TAP_TRIGGERS; }
  function getSoftTapVolumes() { return SOFT_TAP_VOLUMES; }

  function isPluginsCompact() {
    return localStorage.getItem(PLUGINS_COMPACT_KEY) === 'true';
  }

  function setPluginsCompact(enabled) {
    localStorage.setItem(PLUGINS_COMPACT_KEY, enabled ? 'true' : 'false');
  }

  function isSoftTapsEnabled() {
    return localStorage.getItem(SOFT_TAPS_KEY) === 'true';
  }

  function getSoftTapStyle() {
    const id = localStorage.getItem(SOFT_TAP_STYLE_KEY) || 'soft';
    return SOFT_TAP_STYLES.some(s => s.id === id) ? id : 'soft';
  }

  function setSoftTapStyle(id) {
    const next = SOFT_TAP_STYLES.some(s => s.id === id) ? id : 'soft';
    localStorage.setItem(SOFT_TAP_STYLE_KEY, next);
  }

  function getSoftTapTrigger() {
    const id = localStorage.getItem(SOFT_TAP_TRIGGER_KEY) || 'both';
    return SOFT_TAP_TRIGGERS.some(t => t.id === id) ? id : 'both';
  }

  function setSoftTapTrigger(id) {
    const next = SOFT_TAP_TRIGGERS.some(t => t.id === id) ? id : 'both';
    localStorage.setItem(SOFT_TAP_TRIGGER_KEY, next);
  }

  function getSoftTapVolume() {
    const id = localStorage.getItem(SOFT_TAP_VOLUME_KEY) || 'normal';
    return SOFT_TAP_VOLUMES.some(v => v.id === id) ? id : 'normal';
  }

  function setSoftTapVolume(id) {
    const next = SOFT_TAP_VOLUMES.some(v => v.id === id) ? id : 'normal';
    localStorage.setItem(SOFT_TAP_VOLUME_KEY, next);
  }

  function softTapVolumeMult() {
    const found = SOFT_TAP_VOLUMES.find(v => v.id === getSoftTapVolume());
    return found ? found.mult : 1;
  }

  function ensureSoftTapsAudio() {
    if (!softTapsCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      softTapsCtx = new AC();
    }
    if (softTapsCtx.state === 'suspended') softTapsCtx.resume().catch(() => {});
    return softTapsCtx;
  }

  function softTapProfile(kind) {
    const style = getSoftTapStyle();
    const click = kind === 'click';

    if (style === 'clicky') {
      return {
        type: 'square',
        freqStart: click ? 1400 : 1900,
        freqEnd: click ? 520 : 700,
        filterHz: 4200,
        peak: click ? 0.03 : 0.022,
        dur: 0.035
      };
    }
    if (style === 'thock') {
      return {
        type: 'sine',
        freqStart: click ? 220 : 280,
        freqEnd: click ? 90 : 110,
        filterHz: 900,
        peak: click ? 0.07 : 0.055,
        dur: 0.09
      };
    }
    if (style === 'glass') {
      return {
        type: 'sine',
        freqStart: click ? 2400 : 3200,
        freqEnd: click ? 1200 : 1600,
        filterHz: 6000,
        peak: click ? 0.028 : 0.02,
        dur: 0.06
      };
    }
    if (style === 'popcorn') {
      return {
        type: 'triangle',
        freqStart: click ? 2100 : 2600,
        freqEnd: click ? 900 : 1100,
        filterHz: 5000,
        peak: click ? 0.025 : 0.018,
        dur: 0.025
      };
    }
    if (style === 'typewriter') {
      return {
        type: 'sawtooth',
        freqStart: click ? 700 : 900,
        freqEnd: click ? 240 : 320,
        filterHz: 1800,
        peak: click ? 0.04 : 0.03,
        dur: 0.05
      };
    }

    return {
      type: 'triangle',
      freqStart: click ? 620 : 880,
      freqEnd: click ? 280 : 420,
      filterHz: 2400,
      peak: click ? 0.045 : 0.032,
      dur: 0.055
    };
  }

  function playSoftTap({ kind = 'key' } = {}) {
    const ctx = ensureSoftTapsAudio();
    if (!ctx) return;


    const now = performance.now();
    const minGap = kind === 'key' ? 28 : 40;
    if (now - softTapsLastAt < minGap) return;
    softTapsLastAt = now;

    const profile = softTapProfile(kind);
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = profile.type;
    osc.frequency.setValueAtTime(profile.freqStart, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, profile.freqEnd), t0 + profile.dur * 0.85);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(profile.filterHz, t0);

    const peak = Math.max(0.0002, profile.peak * softTapVolumeMult());
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + profile.dur);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + profile.dur + 0.02);
  }

  function startSoftTaps() {
    stopSoftTaps();

    softTapsKeyHandler = (e) => {
      if (!isSoftTapsEnabled()) return;
      const trigger = getSoftTapTrigger();
      if (trigger === 'clicks') return;
      if (e.repeat) return;
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      playSoftTap({ kind: 'key' });
    };

    softTapsClickHandler = (e) => {
      if (!isSoftTapsEnabled()) return;
      const trigger = getSoftTapTrigger();
      if (trigger === 'keys') return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      playSoftTap({ kind: 'click' });
    };

    document.addEventListener('keydown', softTapsKeyHandler, true);
    document.addEventListener('pointerdown', softTapsClickHandler, true);
  }

  function stopSoftTaps() {
    if (softTapsKeyHandler) {
      document.removeEventListener('keydown', softTapsKeyHandler, true);
      softTapsKeyHandler = null;
    }
    if (softTapsClickHandler) {
      document.removeEventListener('pointerdown', softTapsClickHandler, true);
      softTapsClickHandler = null;
    }
  }

  function setSoftTapsEnabled(enabled) {
    localStorage.setItem(SOFT_TAPS_KEY, enabled ? 'true' : 'false');
    if (enabled) startSoftTaps();
    else stopSoftTaps();
  }



  const BG_EFFECT_KEY = 'fencord-bg-effect';
  const MATRIX_BG_KEY = 'fencord-matrix-bg'; // legacy
  const RAIN_BG_KEY = 'fencord-rain-bg'; // legacy
  const FIRE_BG_KEY = 'fencord-fire-bg'; // legacy
  const EFFECTS_CACHE_KEY = 'fencord-remote-effects';
  const CLIENT_EFFECT_ENGINES = new Set(['matrix', 'rain', 'fire']);

  let remoteEffects = null;
  let effectsLoadInFlight = null;

  const FALLBACK_EFFECTS = [
    { id: 'none', label: 'None' },
    { id: 'matrix', label: 'Matrix — digital rain (--matrix-rain)' },
    { id: 'rain', label: 'Rain — falling streaks (theme accent)' },
    { id: 'fire', label: 'Fire — rising embers (warm / accent)' }
  ];

  function isValidEffectsCatalog(data) {
    if (!Array.isArray(data) || !data.length) return false;
    return data.every((e) =>
      e && typeof e === 'object' &&
      typeof e.id === 'string' &&
      typeof e.label === 'string' &&
      (e.id === 'none' || CLIENT_EFFECT_ENGINES.has(e.id))
    ) && data.some((e) => e.id === 'none');
  }

  function getCachedEffects() {
    try {
      const parsed = JSON.parse(localStorage.getItem(EFFECTS_CACHE_KEY) || 'null');
      if (isValidEffectsCatalog(parsed)) return parsed;
    } catch (e) {}
    return null;
  }

  function saveCachedEffects(effects) {
    localStorage.setItem(EFFECTS_CACHE_KEY, JSON.stringify(effects));
  }

  function getBackgroundEffects() {
    return remoteEffects || getCachedEffects() || FALLBACK_EFFECTS;
  }

  function isKnownEffectId(id) {
    return getBackgroundEffects().some((e) => e.id === id);
  }

  function getBackgroundEffect() {
    const saved = localStorage.getItem(BG_EFFECT_KEY);
    if (saved && isKnownEffectId(saved)) return saved;
    // Migrate old per-effect toggles.
    if (localStorage.getItem(MATRIX_BG_KEY) === 'true') return 'matrix';
    if (localStorage.getItem(RAIN_BG_KEY) === 'true') return 'rain';
    if (localStorage.getItem(FIRE_BG_KEY) === 'true') return 'fire';
    return 'none';
  }

  function setBackgroundEffect(effect) {
    const next = (effect && CLIENT_EFFECT_ENGINES.has(effect) && isKnownEffectId(effect))
      ? effect
      : 'none';
    localStorage.setItem(BG_EFFECT_KEY, next);
    localStorage.removeItem(MATRIX_BG_KEY);
    localStorage.removeItem(RAIN_BG_KEY);
    localStorage.removeItem(FIRE_BG_KEY);

    stopMatrixBg();
    stopRainBg();
    stopFireBg();

    if (next === 'matrix') startMatrixBg();
    else if (next === 'rain') startRainBg();
    else if (next === 'fire') startFireBg();
    else applyTheme(getSavedTheme());
  }

  const MATRIX_CANVAS_ID = 'fencord-matrix-canvas';
  const MATRIX_STYLE_ID = 'fencord-matrix-style';
  const MATRIX_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  let matrixRaf = null;
  let matrixResizeHandler = null;
  let matrixDrops = null;

  function stopMatrixBg() {
    if (matrixRaf != null) {
      cancelAnimationFrame(matrixRaf);
      matrixRaf = null;
    }
    if (matrixResizeHandler) {
      window.removeEventListener('resize', matrixResizeHandler);
      matrixResizeHandler = null;
    }
    matrixDrops = null;
    const canvas = document.getElementById(MATRIX_CANVAS_ID);
    if (canvas) canvas.remove();
    const style = document.getElementById(MATRIX_STYLE_ID);
    if (style) style.remove();
  }

  function startMatrixBg() {
    stopMatrixBg();

    const style = document.createElement('style');
    style.id = MATRIX_STYLE_ID;
    document.head.appendChild(style);
    updateMatrixBackdropStyle();

    const canvas = document.createElement('canvas');
    canvas.id = MATRIX_CANVAS_ID;
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '0',
      pointerEvents: 'none'
    });
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    const fontSize = 14;
    let columns = 0;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      columns = Math.max(1, Math.floor(canvas.width / fontSize));
      matrixDrops = new Array(columns).fill(0).map(() => Math.random() * -50);
    }

    matrixResizeHandler = resize;
    window.addEventListener('resize', resize);
    resize();

    function draw() {
      if (!document.getElementById(MATRIX_CANVAS_ID)) return;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = getMatrixRainColor();
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < matrixDrops.length; i++) {
        const x = i * fontSize;
        const y = matrixDrops[i] * fontSize;
        ctx.fillText(MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)], x, y);
        if (y > canvas.height && Math.random() > 0.975) matrixDrops[i] = 0;
        matrixDrops[i]++;
      }

      matrixRaf = requestAnimationFrame(draw);
    }

    matrixRaf = requestAnimationFrame(draw);
  }



  const RAIN_CANVAS_ID = 'fencord-rain-canvas';
  const RAIN_STYLE_ID = 'fencord-rain-style';

  let rainRaf = null;
  let rainResizeHandler = null;
  let rainDrops = null;

  function getRainColor() {
    const vars = getActiveThemeVars();
    return (
      vars['--accent-vibrant'] ||
      vars['--primary-action'] ||
      vars['--matrix-rain'] ||
      '#7ec8ff'
    );
  }

  function stopRainBg() {
    if (rainRaf != null) {
      cancelAnimationFrame(rainRaf);
      rainRaf = null;
    }
    if (rainResizeHandler) {
      window.removeEventListener('resize', rainResizeHandler);
      rainResizeHandler = null;
    }
    rainDrops = null;
    const canvas = document.getElementById(RAIN_CANVAS_ID);
    if (canvas) canvas.remove();
    const style = document.getElementById(RAIN_STYLE_ID);
    if (style) style.remove();
  }

  function startRainBg() {
    stopRainBg();

    const style = document.createElement('style');
    style.id = RAIN_STYLE_ID;
    document.head.appendChild(style);
    updateRainBackdropStyle();

    const canvas = document.createElement('canvas');
    canvas.id = RAIN_CANVAS_ID;
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '0',
      pointerEvents: 'none'
    });
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');

    function spawnDrop(canvasH) {
      return {
        x: Math.random() * canvas.width,
        y: Math.random() * canvasH - canvasH,
        len: 12 + Math.random() * 18,
        speed: 6 + Math.random() * 10,
        thickness: 1 + Math.random() * 1.5,
        alpha: 0.35 + Math.random() * 0.5
      };
    }

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = Math.max(60, Math.floor(canvas.width / 6));
      rainDrops = Array.from({ length: count }, () => spawnDrop(canvas.height));
    }

    rainResizeHandler = resize;
    window.addEventListener('resize', resize);
    resize();

    function draw() {
      if (!document.getElementById(RAIN_CANVAS_ID)) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const color = getRainColor();
      for (let i = 0; i < rainDrops.length; i++) {
        const d = rainDrops[i];
        ctx.strokeStyle = color;
        ctx.globalAlpha = d.alpha;
        ctx.lineWidth = d.thickness;
        ctx.beginPath();
        // Slight diagonal like wind-blown rain
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * 0.15, d.y + d.len);
        ctx.stroke();

        d.y += d.speed;
        d.x -= d.speed * 0.15;
        if (d.y > canvas.height + 20) {
          rainDrops[i] = spawnDrop(0);
          rainDrops[i].y = -20;
        }
      }
      ctx.globalAlpha = 1;

      rainRaf = requestAnimationFrame(draw);
    }

    rainRaf = requestAnimationFrame(draw);
  }



  const FIRE_CANVAS_ID = 'fencord-fire-canvas';
  const FIRE_STYLE_ID = 'fencord-fire-style';

  let fireRaf = null;
  let fireResizeHandler = null;
  let fireParticles = null;

  function getFireColors() {
    const vars = getActiveThemeVars();
    const accent =
      vars['--accent-vibrant'] ||
      vars['--primary-action'] ||
      vars['--warning-yellow'] ||
      '#ff6a00';
    const tip = vars['--warning-yellow'] || vars['--error-red'] || '#ffe566';
    const core = vars['--error-red'] || accent || '#ff3b00';
    return { accent, tip, core };
  }

  function stopFireBg() {
    if (fireRaf != null) {
      cancelAnimationFrame(fireRaf);
      fireRaf = null;
    }
    if (fireResizeHandler) {
      window.removeEventListener('resize', fireResizeHandler);
      fireResizeHandler = null;
    }
    fireParticles = null;
    const canvas = document.getElementById(FIRE_CANVAS_ID);
    if (canvas) canvas.remove();
    const style = document.getElementById(FIRE_STYLE_ID);
    if (style) style.remove();
  }

  function startFireBg() {
    stopFireBg();

    const style = document.createElement('style');
    style.id = FIRE_STYLE_ID;
    document.head.appendChild(style);
    fillEffectBackdropStyle(style);

    const canvas = document.createElement('canvas');
    canvas.id = FIRE_CANVAS_ID;
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '0',
      pointerEvents: 'none'
    });
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');

    function spawnParticle(fromBottom) {
      return {
        x: Math.random() * canvas.width,
        y: fromBottom ? canvas.height + Math.random() * 40 : Math.random() * canvas.height,
        r: 2 + Math.random() * 5,
        vy: -(1.5 + Math.random() * 3.5),
        vx: (Math.random() - 0.5) * 1.2,
        life: 1,
        decay: 0.008 + Math.random() * 0.012,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.04 + Math.random() * 0.08
      };
    }

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = Math.max(80, Math.floor(canvas.width / 8));
      fireParticles = Array.from({ length: count }, () => spawnParticle(false));
    }

    fireResizeHandler = resize;
    window.addEventListener('resize', resize);
    resize();

    function draw() {
      if (!document.getElementById(FIRE_CANVAS_ID)) return;

      // Soft fade so trails look like heat haze
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const colors = getFireColors();
      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < fireParticles.length; i++) {
        const p = fireParticles[i];
        p.wobble += p.wobbleSpeed;
        p.x += p.vx + Math.sin(p.wobble) * 0.6;
        p.y += p.vy;
        p.life -= p.decay;
        p.r *= 0.995;

        if (p.life <= 0 || p.y < -20) {
          fireParticles[i] = spawnParticle(true);
          continue;
        }

        const t = Math.max(0, Math.min(1, p.life));
        // Blend core → accent → tip as the ember rises / dies
        const color = t > 0.66 ? colors.core : t > 0.33 ? colors.accent : colors.tip;
        ctx.globalAlpha = Math.min(1, t * 0.9);
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(p.x, p.y, Math.max(0.5, p.r), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      fireRaf = requestAnimationFrame(draw);
    }

    fireRaf = requestAnimationFrame(draw);
  }



  const CALL_TIMER_KEY = 'fencord-call-timer';
  const CALL_TIMER_EL_ID = 'fencord-call-timer';

  const CALL_LEAVE_CONFIRM_POLLS = 3;

  let callTimerPoll = null;
  let callJoinedAt = null;
  let callMissCount = 0;

  function isCallTimerEnabled() {
    return localStorage.getItem(CALL_TIMER_KEY) === 'true';
  }

  function elementOwnText(el) {

    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
  }

  function findVoiceConnectedLabel() {
    // Exact Fenrid class set from their VoiceConnectedFooter (when present).
    for (const el of document.querySelectorAll('span.text-xs.font-semibold.text-blue-500')) {
      if (elementOwnText(el) === 'Voice Connected' || el.textContent.trim() === 'Voice Connected') {
        return el;
      }
    }

    // Prefer leaf-ish spans whose own text is exactly the label.
    for (const el of document.querySelectorAll('span')) {
      if (elementOwnText(el) === 'Voice Connected') return el;
    }

    // Last resort: a span/div whose full textContent is exactly the label
    // (single-child wrappers). Skip large containers.
    for (const el of document.querySelectorAll('span, div')) {
      if (el.childElementCount > 2) continue;
      if (el.textContent.trim() === 'Voice Connected') return el;
    }
    return null;
  }

  function isInCall() {
    // Keep this strict — broad "Leave" / class*=disconnect matches cause
    // false positives and a broken/flickering clock.
    if (findVoiceConnectedLabel()) return true;
    if (document.querySelector('button[title="Disconnect"]')) return true;
    if (document.querySelector('button[aria-label="Disconnect" i]')) return true;
    return false;
  }

  function formatCallElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) return `${hours}:${mm}:${ss}`;
    return `${minutes}:${ss}`;
  }

  function styleInlineCallTimer(el) {
    Object.assign(el.style, {
      position: '',
      bottom: '',
      left: '',
      zIndex: '',
      padding: '',
      borderRadius: '',
      background: '',
      border: '',
      boxShadow: '',
      pointerEvents: 'none',
      fontSize: '12px',
      fontWeight: '600',
      color: 'var(--text-muted)',
      marginLeft: '6px',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.2px',
      userSelect: 'none',
      fontFamily: 'inherit'
    });
  }

  function styleFloatingCallTimer(el) {
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '72px',
      left: '88px',
      zIndex: '999997',
      padding: '6px 12px',
      borderRadius: '8px',
      background: 'var(--popups-and-modals)',
      color: 'var(--text-primary)',
      border: '1px solid var(--primary-action)',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'inherit',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.3px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      pointerEvents: 'none',
      userSelect: 'none',
      marginLeft: ''
    });
  }

  function ensureCallTimerEl() {
    let el = document.getElementById(CALL_TIMER_EL_ID);
    const label = findVoiceConnectedLabel();

    // Prefer sitting inline next to "Voice Connected".
    if (label && label.parentElement) {
      if (!el) {
        el = document.createElement('span');
        el.id = CALL_TIMER_EL_ID;
      } else if (el.tagName !== 'SPAN') {
        // Reuse the same node id without destroying/recreating every tick:
        // convert floating pill → inline span only when needed.
        const next = document.createElement('span');
        next.id = CALL_TIMER_EL_ID;
        next.textContent = el.textContent;
        el.replaceWith(next);
        el = next;
      }

      styleInlineCallTimer(el);

      if (el.parentElement !== label.parentElement) {
        label.parentElement.insertBefore(el, label.nextSibling);
      }
      return el;
    }

    // Fallback floating pill if the label isn't found but Disconnect is.
    if (!el) {
      el = document.createElement('div');
      el.id = CALL_TIMER_EL_ID;
      document.body.appendChild(el);
    } else if (el.tagName !== 'DIV') {
      const next = document.createElement('div');
      next.id = CALL_TIMER_EL_ID;
      next.textContent = el.textContent;
      el.replaceWith(next);
      el = next;
      document.body.appendChild(el);
    } else if (el.parentElement !== document.body) {
      document.body.appendChild(el);
    }

    styleFloatingCallTimer(el);
    return el;
  }

  function removeCallTimerEl() {
    const el = document.getElementById(CALL_TIMER_EL_ID);
    if (el) el.remove();
  }

  function updateCallTimerDisplay() {
    if (callJoinedAt == null) return;
    const el = ensureCallTimerEl();
    if (!el) return;
    const time = formatCallElapsed(Date.now() - callJoinedAt);
    // Inline next to the label is just the time; floating gets a prefix.
    el.textContent = el.tagName === 'SPAN' ? time : `Call · ${time}`;
  }

  function startCallClock() {
    if (callJoinedAt != null) return;
    callJoinedAt = Date.now();
    callMissCount = 0;
    updateCallTimerDisplay();
  }

  function stopCallClock() {
    callJoinedAt = null;
    callMissCount = 0;
    removeCallTimerEl();
  }

  function tickCallTimer() {
    if (!isCallTimerEnabled()) return;

    if (isInCall()) {
      callMissCount = 0;
      if (callJoinedAt == null) startCallClock();
      else updateCallTimerDisplay();
      return;
    }

    if (callJoinedAt == null) return;

    callMissCount += 1;
    if (callMissCount >= CALL_LEAVE_CONFIRM_POLLS) {
      stopCallClock();
    } else {
      updateCallTimerDisplay();
    }
  }

  function setCallTimerEnabled(enabled) {
    localStorage.setItem(CALL_TIMER_KEY, enabled ? 'true' : 'false');
    if (enabled) {
      tickCallTimer();
      if (!callTimerPoll) {
        callTimerPoll = setInterval(tickCallTimer, 1000);
      }
    } else {
      stopCallClock();
      if (callTimerPoll) {
        clearInterval(callTimerPoll);
        callTimerPoll = null;
      }
    }
  }



  const UI_ANIMATIONS_KEY = 'fencord-ui-animations';
  let uiAnimationsStyle = null;
  let uiAnimationsObserver = null;

  function isUiAnimationsEnabled() {
    return localStorage.getItem(UI_ANIMATIONS_KEY) === 'true';
  }

  function applyUiAnimations() {
    if (isUiAnimationsEnabled()) {
      if (!uiAnimationsStyle) {
        uiAnimationsStyle = document.createElement('style');
        uiAnimationsStyle.id = 'fencord-ui-animations-style';
        uiAnimationsStyle.textContent = `
          button, a, input, select {
            transition: background-color 0.15s ease, opacity 0.15s ease, border-color 0.15s ease !important;
          }
          @keyframes fencordPopIn {
            0% { opacity: 0; transform: scale(0.95); }
            50% { opacity: 1; transform: scale(1.02); }
            100% { opacity: 1; transform: scale(1); }
          }
          .fencord-anim-enter {
            animation: fencordPopIn 1s ease-in-out forwards !important;
          }
        `;
        document.head.appendChild(uiAnimationsStyle);
      }

      if (!uiAnimationsObserver) {
        uiAnimationsObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1) {
                if (node.tagName === 'DIV' || node.tagName === 'LI') {
                   node.classList.add('fencord-anim-enter');
                }
              }
            }
          }
        });
        uiAnimationsObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      if (uiAnimationsStyle) {
        uiAnimationsStyle.remove();
        uiAnimationsStyle = null;
      }
      if (uiAnimationsObserver) {
        uiAnimationsObserver.disconnect();
        uiAnimationsObserver = null;
      }
    }
  }

  function setUiAnimationsEnabled(enabled) {
    localStorage.setItem(UI_ANIMATIONS_KEY, enabled ? 'true' : 'false');
    applyUiAnimations();
  }

  // Init animations on startup
  applyUiAnimations();




  const CURRENT_VERSION = 70;
  // raw.githubusercontent.com refreshes ~every 5m; jsDelivr can lag much longer on @main.
  const SCRIPT_UPDATE_URL = 'https://github.com/fencord/fencord/raw/main/fencord.user.js';
  const REPO_PAGE_URL = 'https://github.com/fencord/fencord';
  const BUNDLED_THEMES = {"none":{"name":"None (Default)","vars":{}},"hotpink":{"name":"Hot Pink","vars":{"--background":"#2b0010","--foreground":"#ffffff","--server-sidebar":"#1a0009","--channel-sidebar":"#3d0016","--main-chat-area":"#2b0010","--member-list":"#1a0009","--popups-and-modals":"#3d0016","--borders-and-separators":"#ff0055","--primary-action":"#ff007f","--primary-hover":"#ff3399","--secondary-button":"#660033","--secondary-button-hover":"#99004d","--accent-vibrant":"#ff007f","--success-green":"#ff66aa","--error-red":"#ff0000","--warning-yellow":"#ff66aa","--text-primary":"#ffffff","--text-secondary":"#ffb3d1","--text-muted":"#ff80b3","--interactive-hover":"#ff007f","--hover-overlay":"#ff007f22","--active-overlay":"#ff007f33","--primary-foreground":"#ffffff","--matrix-rain":"#ff007f"}},"catppuccin":{"name":"Catppuccin Mocha","vars":{"--background":"#1e1e2e","--foreground":"#cdd6f4","--server-sidebar":"#181825","--channel-sidebar":"#1e1e2e","--main-chat-area":"#1e1e2e","--member-list":"#181825","--popups-and-modals":"#1e1e2e","--borders-and-separators":"#313244","--primary-action":"#89b4fa","--primary-hover":"#74a8f9","--secondary-button":"#313244","--secondary-button-hover":"#45475a","--accent-vibrant":"#89b4fa","--success-green":"#a6e3a1","--error-red":"#f38ba8","--warning-yellow":"#f9e2af","--text-primary":"#cdd6f4","--text-secondary":"#a6adc8","--text-muted":"#6c7086","--interactive-hover":"#89b4fa","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#1e1e2e","--matrix-rain":"#89b4fa"}},"dracula":{"name":"Dracula","vars":{"--background":"#282a36","--foreground":"#f8f8f2","--server-sidebar":"#21222c","--channel-sidebar":"#282a36","--main-chat-area":"#282a36","--member-list":"#21222c","--popups-and-modals":"#282a36","--borders-and-separators":"#44475a","--primary-action":"#bd93f9","--primary-hover":"#a679f2","--secondary-button":"#44475a","--secondary-button-hover":"#565a72","--accent-vibrant":"#ff79c6","--success-green":"#50fa7b","--error-red":"#ff5555","--warning-yellow":"#f1fa8c","--text-primary":"#f8f8f2","--text-secondary":"#bfbfd1","--text-muted":"#6272a4","--interactive-hover":"#bd93f9","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#282a36","--matrix-rain":"#ff79c6"}},"nord":{"name":"Nord","vars":{"--background":"#2e3440","--foreground":"#eceff4","--server-sidebar":"#242933","--channel-sidebar":"#2e3440","--main-chat-area":"#2e3440","--member-list":"#242933","--popups-and-modals":"#2e3440","--borders-and-separators":"#4c566a","--primary-action":"#88c0d0","--primary-hover":"#8fbcbb","--secondary-button":"#3b4252","--secondary-button-hover":"#434c5e","--accent-vibrant":"#81a1c1","--success-green":"#a3be8c","--error-red":"#bf616a","--warning-yellow":"#ebcb8b","--text-primary":"#eceff4","--text-secondary":"#d8dee9","--text-muted":"#7b88a1","--interactive-hover":"#88c0d0","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#2e3440","--matrix-rain":"#81a1c1"}},"gruvbox":{"name":"Gruvbox Dark","vars":{"--background":"#282828","--foreground":"#ebdbb2","--server-sidebar":"#1d2021","--channel-sidebar":"#282828","--main-chat-area":"#282828","--member-list":"#1d2021","--popups-and-modals":"#282828","--borders-and-separators":"#3c3836","--primary-action":"#fe8019","--primary-hover":"#fb923c","--secondary-button":"#3c3836","--secondary-button-hover":"#504945","--accent-vibrant":"#fabd2f","--success-green":"#b8bb26","--error-red":"#fb4934","--warning-yellow":"#fabd2f","--text-primary":"#ebdbb2","--text-secondary":"#d5c4a1","--text-muted":"#928374","--interactive-hover":"#fe8019","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#282828","--matrix-rain":"#fabd2f"}},"tokyonight":{"name":"Tokyo Night","vars":{"--background":"#1a1b26","--foreground":"#c0caf5","--server-sidebar":"#16161e","--channel-sidebar":"#1a1b26","--main-chat-area":"#1a1b26","--member-list":"#16161e","--popups-and-modals":"#1a1b26","--borders-and-separators":"#292e42","--primary-action":"#7aa2f7","--primary-hover":"#89b4fa","--secondary-button":"#292e42","--secondary-button-hover":"#3b4261","--accent-vibrant":"#bb9af7","--success-green":"#9ece6a","--error-red":"#f7768e","--warning-yellow":"#e0af68","--text-primary":"#c0caf5","--text-secondary":"#a9b1d6","--text-muted":"#565f89","--interactive-hover":"#7aa2f7","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#1a1b26","--matrix-rain":"#bb9af7"}},"vaporwave":{"name":"Vaporwave","vars":{"--background":"#241b2f","--foreground":"#f8f0fb","--server-sidebar":"#1a1424","--channel-sidebar":"#2b2038","--main-chat-area":"#241b2f","--member-list":"#1a1424","--popups-and-modals":"#2b2038","--borders-and-separators":"#553c7b","--primary-action":"#ff6ad5","--primary-hover":"#ff8ade","--secondary-button":"#3c2b52","--secondary-button-hover":"#513a6d","--accent-vibrant":"#8bd3ff","--success-green":"#94ffb3","--error-red":"#ff5c8a","--warning-yellow":"#ffd76a","--text-primary":"#f8f0fb","--text-secondary":"#d3b8e8","--text-muted":"#8d6fae","--interactive-hover":"#ff6ad5","--hover-overlay":"#ff6ad51a","--active-overlay":"#ff6ad526","--primary-foreground":"#241b2f","--matrix-rain":"#8bd3ff"}},"glitchcore":{"name":"Glitchcore","vars":{"--background":"#0a0a0f","--foreground":"#e0fbff","--server-sidebar":"#050507","--channel-sidebar":"#0f0f16","--main-chat-area":"#0a0a0f","--member-list":"#050507","--popups-and-modals":"#0f0f16","--borders-and-separators":"#ff00e5","--primary-action":"#00fff2","--primary-hover":"#5affee","--secondary-button":"#1a1a24","--secondary-button-hover":"#2a2a38","--accent-vibrant":"#ff00e5","--success-green":"#39ff14","--error-red":"#ff0037","--warning-yellow":"#faff00","--text-primary":"#e0fbff","--text-secondary":"#9be8ff","--text-muted":"#4d6b73","--interactive-hover":"#ff00e5","--hover-overlay":"#00fff21a","--active-overlay":"#ff00e526","--primary-foreground":"#0a0a0f","--matrix-rain":"#ff00e5"}},"digicore":{"name":"Digicore","vars":{"--background":"#12101c","--foreground":"#f1e8ff","--server-sidebar":"#0b0a13","--channel-sidebar":"#171425","--main-chat-area":"#12101c","--member-list":"#0b0a13","--popups-and-modals":"#171425","--borders-and-separators":"#3a2e5c","--primary-action":"#c77dff","--primary-hover":"#d896ff","--secondary-button":"#241f3a","--secondary-button-hover":"#332a52","--accent-vibrant":"#7dfff0","--success-green":"#7dffb0","--error-red":"#ff5c7a","--warning-yellow":"#ffe27d","--text-primary":"#f1e8ff","--text-secondary":"#c9b8ea","--text-muted":"#6b5a94","--interactive-hover":"#c77dff","--hover-overlay":"#c77dff1a","--active-overlay":"#c77dff26","--primary-foreground":"#12101c","--matrix-rain":"#7dfff0"}},"solarizedlight":{"name":"Solarized Light","vars":{"--background":"#fdf6e3","--foreground":"#073642","--server-sidebar":"#eee8d5","--channel-sidebar":"#fdf6e3","--main-chat-area":"#fdf6e3","--member-list":"#eee8d5","--popups-and-modals":"#fdf6e3","--borders-and-separators":"#d3cbb7","--primary-action":"#268bd2","--primary-hover":"#2aa1f0","--secondary-button":"#e4ddc8","--secondary-button-hover":"#d8d0b8","--accent-vibrant":"#2aa198","--success-green":"#859900","--error-red":"#dc322f","--warning-yellow":"#b58900","--text-primary":"#073642","--text-secondary":"#4c6b70","--text-muted":"#93a1a1","--interactive-hover":"#268bd2","--hover-overlay":"#00000012","--active-overlay":"#0000001e","--primary-foreground":"#fdf6e3","--matrix-rain":"#2aa198"}},"paperwhite":{"name":"Paper White","vars":{"--background":"#ffffff","--foreground":"#1a1a1a","--server-sidebar":"#f4f4f5","--channel-sidebar":"#ffffff","--main-chat-area":"#ffffff","--member-list":"#f4f4f5","--popups-and-modals":"#ffffff","--borders-and-separators":"#e2e2e5","--primary-action":"#3355ff","--primary-hover":"#5470ff","--secondary-button":"#eeeef0","--secondary-button-hover":"#e2e2e6","--accent-vibrant":"#3355ff","--success-green":"#1f9d55","--error-red":"#e0293e","--warning-yellow":"#c98a11","--text-primary":"#1a1a1a","--text-secondary":"#55555a","--text-muted":"#9a9aa0","--interactive-hover":"#3355ff","--hover-overlay":"#00000010","--active-overlay":"#0000001c","--primary-foreground":"#ffffff","--matrix-rain":"#3355ff"}},"midnightocean":{"name":"Midnight Ocean","vars":{"--background":"#031521","--foreground":"#dff4ff","--server-sidebar":"#020f18","--channel-sidebar":"#04202f","--main-chat-area":"#031521","--member-list":"#020f18","--popups-and-modals":"#04202f","--borders-and-separators":"#0d3d54","--primary-action":"#20b2c4","--primary-hover":"#37c8d9","--secondary-button":"#0a2c3d","--secondary-button-hover":"#0f3a4f","--accent-vibrant":"#3ee8e2","--success-green":"#4de1a4","--error-red":"#ff5c66","--warning-yellow":"#ffcf5c","--text-primary":"#dff4ff","--text-secondary":"#9fd4e6","--text-muted":"#4d7d90","--interactive-hover":"#20b2c4","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#031521","--matrix-rain":"#3ee8e2"}},"sunsetpeach":{"name":"Sunset Peach","vars":{"--background":"#2b1a1f","--foreground":"#ffe8dc","--server-sidebar":"#201316","--channel-sidebar":"#332026","--main-chat-area":"#2b1a1f","--member-list":"#201316","--popups-and-modals":"#332026","--borders-and-separators":"#5c3a3f","--primary-action":"#ff9770","--primary-hover":"#ffab8c","--secondary-button":"#452a30","--secondary-button-hover":"#593640","--accent-vibrant":"#ffc785","--success-green":"#a8d982","--error-red":"#ff6b6b","--warning-yellow":"#ffd166","--text-primary":"#ffe8dc","--text-secondary":"#e0b8ab","--text-muted":"#8c6a63","--interactive-hover":"#ff9770","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#2b1a1f","--matrix-rain":"#ffc785"}},"forestmoss":{"name":"Forest Moss","vars":{"--background":"#1a2419","--foreground":"#e6f1e3","--server-sidebar":"#131b12","--channel-sidebar":"#202d1f","--main-chat-area":"#1a2419","--member-list":"#131b12","--popups-and-modals":"#202d1f","--borders-and-separators":"#3b4f38","--primary-action":"#7fbf6b","--primary-hover":"#94d180","--secondary-button":"#2a3a28","--secondary-button-hover":"#374a34","--accent-vibrant":"#b4d97a","--success-green":"#7fbf6b","--error-red":"#e0655e","--warning-yellow":"#dcbb5c","--text-primary":"#e6f1e3","--text-secondary":"#b6ccb1","--text-muted":"#6b8266","--interactive-hover":"#7fbf6b","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#1a2419","--matrix-rain":"#b4d97a"}},"pastelcloud":{"name":"Pastel Cloud","vars":{"--background":"#f5f0fa","--foreground":"#4a3f5c","--server-sidebar":"#ece2f7","--channel-sidebar":"#f5f0fa","--main-chat-area":"#f5f0fa","--member-list":"#ece2f7","--popups-and-modals":"#f5f0fa","--borders-and-separators":"#dccdec","--primary-action":"#b09aef","--primary-hover":"#c1aef4","--secondary-button":"#e4d6f2","--secondary-button-hover":"#d8c6ec","--accent-vibrant":"#f6a6c1","--success-green":"#8fd6a8","--error-red":"#ef8a9c","--warning-yellow":"#f3d089","--text-primary":"#4a3f5c","--text-secondary":"#786b8c","--text-muted":"#ac9dc0","--interactive-hover":"#b09aef","--hover-overlay":"#00000010","--active-overlay":"#0000001c","--primary-foreground":"#ffffff","--matrix-rain":"#f6a6c1"}},"bloodmoon":{"name":"Blood Moon","vars":{"--background":"#160707","--foreground":"#ffe2e2","--server-sidebar":"#0d0404","--channel-sidebar":"#200a0a","--main-chat-area":"#160707","--member-list":"#0d0404","--popups-and-modals":"#200a0a","--borders-and-separators":"#5c1a1a","--primary-action":"#e0393f","--primary-hover":"#f04c52","--secondary-button":"#2e0f0f","--secondary-button-hover":"#421414","--accent-vibrant":"#ff6b6b","--success-green":"#7fbf6b","--error-red":"#ff2d2d","--warning-yellow":"#e0a13f","--text-primary":"#ffe2e2","--text-secondary":"#d19a9a","--text-muted":"#7a4a4a","--interactive-hover":"#e0393f","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#160707","--matrix-rain":"#ff6b6b"}},"monochrome":{"name":"Monochrome","vars":{"--background":"#141414","--foreground":"#eaeaea","--server-sidebar":"#0d0d0d","--channel-sidebar":"#1a1a1a","--main-chat-area":"#141414","--member-list":"#0d0d0d","--popups-and-modals":"#1a1a1a","--borders-and-separators":"#333333","--primary-action":"#d9d9d9","--primary-hover":"#ffffff","--secondary-button":"#242424","--secondary-button-hover":"#303030","--accent-vibrant":"#bfbfbf","--success-green":"#9ecb9e","--error-red":"#d97a7a","--warning-yellow":"#d9c47a","--text-primary":"#eaeaea","--text-secondary":"#a6a6a6","--text-muted":"#5c5c5c","--interactive-hover":"#d9d9d9","--hover-overlay":"#ffffff0d","--active-overlay":"#ffffff14","--primary-foreground":"#141414","--matrix-rain":"#bfbfbf"}}};
  const BUNDLED_FONTS = [{"id":"default","label":"Default","family":null,"googleName":null},{"id":"inter","label":"Inter","family":"'Inter', sans-serif","googleName":"Inter:wght@400;600;700"},{"id":"poppins","label":"Poppins","family":"'Poppins', sans-serif","googleName":"Poppins:wght@400;600;700"},{"id":"jetbrains","label":"JetBrains Mono","family":"'JetBrains Mono', monospace","googleName":"JetBrains+Mono:wght@400;600;700"},{"id":"comicneue","label":"Comic Neue","family":"'Comic Neue', cursive","googleName":"Comic+Neue:wght@400;700"},{"id":"pressstart","label":"Press Start 2P","family":"'Press Start 2P', system-ui","googleName":"Press+Start+2P"},{"id":"spacemono","label":"Space Mono","family":"'Space Mono', monospace","googleName":"Space+Mono:wght@400;700"},{"id":"couriernew","label":"Courier New","family":"'Courier New', Courier, monospace","googleName":null}];
  const BUNDLED_EFFECTS = [{"id":"none","label":"None"},{"id":"matrix","label":"Matrix — digital rain (--matrix-rain)"},{"id":"rain","label":"Rain — falling streaks (theme accent)"},{"id":"fire","label":"Fire — rising embers (warm / accent)"}];
  const BUNDLED_VERSION = 76;
  // Re-check while the tab stays open. ~5m matches GitHub raw CDN cache.
  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

  let updateCheckResult = null; // { available: bool, latestVersion: string } | null while unknown
  let updateCheckInFlight = null;
  let updateToastDismissed = false;
  let themesLoadInFlight = null;
  let fontsLoadInFlight = null;

  function isValidThemesCatalog(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (!data.none || typeof data.none !== 'object') return false;
    for (const theme of Object.values(data)) {
      if (!theme || typeof theme !== 'object') return false;
      if (typeof theme.name !== 'string') return false;
      if (!theme.vars || typeof theme.vars !== 'object') return false;
      // Built-in/remote themes must also pass the color-only safety check.
      const cleaned = sanitizeThemeVars(theme.vars);
      if (Object.keys(theme.vars).length && !Object.keys(cleaned.vars).length) return false;
      if (cleaned.errors.length) return false;
    }
    return true;
  }

  function isValidFontsCatalog(data) {
    if (!Array.isArray(data) || !data.length) return false;
    const cleaned = data.map(sanitizeFontPreset).filter(Boolean);
    return cleaned.length === data.length && cleaned[0].id === 'default';
  }

  async function loadThemes() {
    if (themesLoadInFlight) return themesLoadInFlight;

    themesLoadInFlight = (async () => {
      try {
        const data = BUNDLED_THEMES;
        remoteThemes = data;
        saveCachedThemes(data);
        const active = getSavedTheme();
        if (getAllThemes()[active]) applyTheme(active);
        if (typeof refreshSettingsPanel === 'function') refreshSettingsPanel();
        return data;
      } finally {
        themesLoadInFlight = null;
      }
    })();

    return themesLoadInFlight;
  }

  async function loadFonts() {
    if (fontsLoadInFlight) return fontsLoadInFlight;

    fontsLoadInFlight = (async () => {
      try {
        const cleaned = BUNDLED_FONTS.map(sanitizeFontPreset).filter(Boolean);
        remoteFonts = cleaned;
        saveCachedFonts(cleaned);
        if (typeof refreshSettingsPanel === 'function') refreshSettingsPanel();
        return cleaned;
      } finally {
        fontsLoadInFlight = null;
      }
    })();

    return fontsLoadInFlight;
  }

  async function loadEffects() {
    if (effectsLoadInFlight) return effectsLoadInFlight;

    effectsLoadInFlight = (async () => {
      try {
        const data = BUNDLED_EFFECTS;
        remoteEffects = data;
        saveCachedEffects(data);
        if (!isKnownEffectId(getBackgroundEffect())) setBackgroundEffect('none');
        if (typeof refreshSettingsPanel === 'function') refreshSettingsPanel();
        return data;
      } finally {
        effectsLoadInFlight = null;
      }
    })();

    return effectsLoadInFlight;
  }

  function compareVersions(a, b) {
    return a - b;
  }

  async function checkForUpdate({ force = false } = {}) {
    if (!force && updateCheckResult !== null) return updateCheckResult;
    if (updateCheckInFlight) return updateCheckInFlight;

    updateCheckInFlight = (async () => {
      try {
        const latest = BUNDLED_VERSION;
        const available = Number.isFinite(latest) && compareVersions(latest, CURRENT_VERSION) > 0;
        updateCheckResult = { available, latestVersion: latest };
      } finally {
        updateCheckInFlight = null;
      }
      return updateCheckResult;
    })();

    return updateCheckInFlight;
  }

  function startUpdateChecker() {
    const run = () => checkForUpdate({ force: true }).then(() => createUpdateCheckToast());
    run();
    setInterval(run, UPDATE_CHECK_INTERVAL_MS);
  }

  function buildUpdateBanner({ dismissible = true, compact = false } = {}) {
    const banner = document.createElement('div');
    banner.className = 'fencord-update-banner';
    Object.assign(banner.style, {
      background: 'var(--popups-and-modals)',
      color: 'var(--text-primary)',
      border: '1px solid var(--primary-action)',
      borderRadius: '10px',
      padding: compact ? '10px 14px' : '14px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      fontSize: '13px',
      fontFamily: 'inherit',
      boxShadow: compact ? 'none' : '0 6px 20px rgba(0,0,0,0.35)',
      maxWidth: compact ? '420px' : '360px'
    });

    const headerRow = document.createElement('div');
    Object.assign(headerRow.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' });

    const heading = document.createElement('div');
    heading.textContent = '⚠️ New Fencord update available!';
    Object.assign(heading.style, { fontWeight: '700', color: 'var(--primary-action)' });
    headerRow.appendChild(heading);

    if (dismissible) {
      const closeBtn = document.createElement('div');
      closeBtn.textContent = '✕';
      Object.assign(closeBtn.style, { cursor: 'pointer', color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1', flexShrink: '0' });
      closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = 'var(--text-primary)');
      closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = 'var(--text-muted)');
      closeBtn.addEventListener('click', () => {
        updateToastDismissed = true;
        banner.remove();
      });
      headerRow.appendChild(closeBtn);
    }

    banner.appendChild(headerRow);

    const bodyText = document.createElement('div');
    bodyText.textContent = updateCheckResult && updateCheckResult.latestVersion
      ? `Version ${updateCheckResult.latestVersion} is out (you're on ${CURRENT_VERSION}). Would you like to update?`
      : 'A new version is out. Would you like to update?';
    Object.assign(bodyText.style, { color: 'var(--text-secondary)' });
    banner.appendChild(bodyText);

    const reminderText = document.createElement('div');
    reminderText.textContent = 'Note: If it says an update is available but you are ALREADY on the new version (e.g. 2.0), you need to completely delete the script and recreate it, not just click update.';
    Object.assign(reminderText.style, { color: 'var(--warning-yellow)', fontSize: '11px', marginTop: '2px', fontWeight: 'bold' });
    banner.appendChild(reminderText);

    const urlText = document.createElement('div');
    urlText.textContent = SCRIPT_UPDATE_URL;
    Object.assign(urlText.style, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: 'var(--text-primary)',
      background: 'var(--secondary-button)',
      padding: '6px 8px',
      borderRadius: '5px',
      wordBreak: 'break-all'
    });
    banner.appendChild(urlText);

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '10px', marginTop: '4px' });

    const yesBtn = document.createElement('a');
    yesBtn.textContent = 'Yes, install update';
    yesBtn.href = SCRIPT_UPDATE_URL;
    yesBtn.target = '_blank';
    yesBtn.rel = 'noopener noreferrer';
    Object.assign(yesBtn.style, {
      padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
      background: 'var(--primary-action)', color: 'var(--primary-foreground)',
      fontWeight: 'bold', fontSize: '12px', textDecoration: 'none', display: 'inline-block'
    });
    yesBtn.addEventListener('mouseenter', () => yesBtn.style.background = 'var(--primary-hover)');
    yesBtn.addEventListener('mouseleave', () => yesBtn.style.background = 'var(--primary-action)');
    btnRow.appendChild(yesBtn);

    const noBtn = document.createElement('div');
    noBtn.textContent = 'Not now';
    Object.assign(noBtn.style, {
      padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
      background: 'var(--secondary-button)', color: 'var(--text-primary)', fontSize: '12px'
    });
    noBtn.addEventListener('mouseenter', () => noBtn.style.background = 'var(--secondary-button-hover)');
    noBtn.addEventListener('mouseleave', () => noBtn.style.background = 'var(--secondary-button)');
    noBtn.addEventListener('click', () => {
      updateToastDismissed = true;
      banner.remove();
    });
    btnRow.appendChild(noBtn);

    banner.appendChild(btnRow);

    return banner;
  }

  async function createUpdateCheckToast() {
    if (updateToastDismissed) return;
    if (document.getElementById('fencord-update-toast')) return;

    const result = await checkForUpdate();
    if (!result.available) return; // no nag if already up to date or check failed

    const banner = buildUpdateBanner({ dismissible: true });
    banner.id = 'fencord-update-toast';
    Object.assign(banner.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '1000002'
    });

    document.body.appendChild(banner);

    // auto-dismiss after 15s so it doesn't linger forever
    setTimeout(() => {
      if (banner.parentElement) {
        updateToastDismissed = true;
        banner.remove();
      }
    }, 15000);
  }

  function createFencordWatermark() {
    if (document.getElementById('fencord-watermark')) return;

    const watermark = document.createElement('a');
    watermark.id = 'fencord-watermark';
    watermark.textContent = 'FENCORD';
    watermark.href = 'https://fenrid.com/iAZw7Qfu';
    watermark.target = '_blank';
    watermark.rel = 'noopener noreferrer';
    watermark.title = `FENCORD — ${CREDITS_TEXT}`;
    Object.assign(watermark.style, {
      position: 'fixed',
      bottom: '10px',
      right: '12px',
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '1px',
      color: 'var(--text-muted)',
      opacity: '0.55',
      zIndex: '999998',
      userSelect: 'none',
      fontFamily: 'inherit',
      textDecoration: 'none',
      cursor: 'pointer',
      transition: 'opacity 0.2s, color 0.2s'
    });
    watermark.addEventListener('mouseenter', () => watermark.style.opacity = '1');
    watermark.addEventListener('mouseleave', () => watermark.style.opacity = '0.55');
    document.body.appendChild(watermark);
  }

  function showBootDisclaimerToast() {
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '1000003',
      background: 'var(--popups-and-modals)',
      color: 'var(--text-primary)',
      border: '1px solid var(--warning-yellow)',
      borderRadius: '10px',
      padding: '14px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      fontSize: '13px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      maxWidth: '450px',
      lineHeight: '1.4'
    });

    const headerRow = document.createElement('div');
    Object.assign(headerRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });

    const title = document.createElement('div');
    title.textContent = 'Unofficial Tool';
    Object.assign(title.style, { fontWeight: 'bold', color: 'var(--warning-yellow)' });

    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, { cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' });
    closeBtn.onclick = () => banner.remove();

    headerRow.appendChild(title);
    headerRow.appendChild(closeBtn);
    banner.appendChild(headerRow);

    const bodyText = document.createElement('div');
    bodyText.textContent = "Fencord is an unofficial, community-made tool. It is not built by the Fenrid team, but the owner is aware of it and has said it's fine to use. Fenrid is developed and paid for out of pocket by its owner — if you enjoy the platform, please consider supporting the official paid plan when it launches. It directly keeps this running for everyone.";
    banner.appendChild(bodyText);

    document.body.appendChild(banner);

    setTimeout(() => {
      if (banner.parentElement) banner.remove();
    }, 10000);
  }



  const PROFILER_KEY = 'fencord-show-user-profile';
  let profilerObserver = null;
  let profilerMsgCounter = new Map();
  let profilerTooltip = null;
  let profilerHideTimer = null;
  let profilerModalOpen = false;

  function isProfilerEnabled() {
    return localStorage.getItem(PROFILER_KEY) === 'true';
  }

  function setProfilerEnabled(enabled) {
    localStorage.setItem(PROFILER_KEY, enabled ? 'true' : 'false');
    if (enabled) startProfiler();
    else stopProfiler();
  }

  function profilerCountMessage(username) {
    if (!username) return;
    const cur = profilerMsgCounter.get(username) || 0;
    profilerMsgCounter.set(username, cur + 1);
  }

  function profilerWatchMessages() {
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const msgRow = node.closest?.('[class*="message"]') || node;
          const authorEl = msgRow.querySelector?.('span.font-semibold.cursor-pointer');
          if (authorEl) {
            const name = authorEl.textContent.trim();
            if (name) profilerCountMessage(name);
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return obs;
  }

  function profilerEscapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function profilerFindAvatar(usernameEl) {
    const msgRow = usernameEl.closest('[class*="message"]');
    if (msgRow) {
      const img = msgRow.querySelector('img[src*="avatar"], img[alt*="avatar" i]');
      if (img && img.src) return img.src;
    }
    let parent = usernameEl.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const img = parent.querySelector('img[src*="avatar"], img[alt*="avatar" i]');
      if (img && img.src) return img.src;
      parent = parent.parentElement;
    }
    return null;
  }

  function profilerFindAllRoles(username) {
    const roles = new Set();
    document.querySelectorAll('span.font-semibold.cursor-pointer').forEach(el => {
      if (el.textContent.trim() === username) {
        const container = el.closest('[class*="member"]') || el.closest('[class*="message"]') || el.parentElement && el.parentElement.parentElement;
        if (container) {
          container.querySelectorAll('[class*="role"], [class*="badge"], [class*="pill"]').forEach(p => {
            const text = p.textContent.trim();
            if (text && text.length < 30) roles.add(text);
          });
        }
      }
    });
    return Array.from(roles);
  }

  function profilerFindStatus(usernameEl) {
    const msgRow = usernameEl.closest('[class*="message"]');
    if (msgRow) {
      const statusDot = msgRow.querySelector('[class*="status"], [class*="presence"]');
      if (statusDot) {
        const style = window.getComputedStyle(statusDot);
        const bg = style.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') return bg;
      }
    }
    return '#a6e3a1';
  }

  function profilerEstimateFirstSeen(username) {
    let oldestTime = null;
    document.querySelectorAll('time[datetime]').forEach(el => {
      const msgRow = el.closest('[class*="message"]');
      if (!msgRow) return;
      const author = msgRow.querySelector('span.font-semibold.cursor-pointer');
      if (author && author.textContent.trim() === username) {
        const dt = new Date(el.getAttribute('datetime'));
        if (!isNaN(dt.getTime()) && (!oldestTime || dt < oldestTime)) {
          oldestTime = dt;
        }
      }
    });
    return oldestTime;
  }

  function profilerOpenProfileModal(username, avatarSrc, statusColor) {
    if (profilerModalOpen) return;
    profilerModalOpen = true;

    const roles = profilerFindAllRoles(username);
    const msgCount = profilerMsgCounter.get(username) || 0;
    const firstSeen = profilerEstimateFirstSeen(username);

    const overlay = document.createElement('div');
    overlay.id = 'fencord-profile-modal-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '1000005',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: '0', transition: 'opacity 0.25s ease',
      backdropFilter: 'blur(4px)'
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: 'var(--popups-and-modals)',
      border: '1px solid var(--borders-and-separators)',
      borderRadius: '16px',
      padding: '28px',
      minWidth: '340px',
      maxWidth: '420px',
      width: '90%',
      boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      fontFamily: 'inherit',
      color: 'var(--text-primary)',
      transform: 'scale(0.92)',
      transition: 'transform 0.25s ease',
      position: 'relative'
    });

    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute', top: '16px', right: '20px',
      fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)',
      width: '32px', height: '32px', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      borderRadius: '6px', transition: 'all 0.15s'
    });
    closeBtn.onmouseenter = function() { closeBtn.style.color = 'var(--text-primary)'; closeBtn.style.background = 'var(--hover-overlay)'; };
    closeBtn.onmouseleave = function() { closeBtn.style.color = 'var(--text-muted)'; closeBtn.style.background = 'transparent'; };

    function closeModal() {
      overlay.style.opacity = '0';
      modal.style.transform = 'scale(0.92)';
      setTimeout(function() {
        overlay.remove();
        profilerModalOpen = false;
      }, 250);
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); }
    });

    let html = '';

    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;margin-bottom:20px;">';
    if (avatarSrc) {
      html += '<div style="position:relative;">';
      html += '<img src="' + profilerEscapeHtml(avatarSrc) + '" style="width:90px;height:90px;border-radius:50%;object-fit:cover;border:3px solid var(--borders-and-separators);">';
      html += '<span style="position:absolute;bottom:4px;right:4px;width:18px;height:18px;border-radius:50%;background:' + statusColor + ';border:3px solid var(--popups-and-modals);"></span>';
      html += '</div>';
    } else {
      html += '<div style="width:90px;height:90px;border-radius:50%;background:var(--secondary-button);display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;border:3px solid var(--borders-and-separators);">' + profilerEscapeHtml(username.charAt(0).toUpperCase()) + '</div>';
    }
    html += '<div style="font-weight:800;font-size:20px;color:var(--text-primary);text-align:center;">' + profilerEscapeHtml(username) + '</div>';
    html += '<div style="font-size:12px;color:var(--text-muted);">User Profile</div>';
    html += '</div>';

    html += '<div style="background:var(--secondary-button);border-radius:12px;padding:16px;margin-bottom:16px;">';
    html += '<div style="font-weight:700;font-size:13px;color:var(--text-primary);margin-bottom:12px;">📊 Session Statistics</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';

    html += '<div style="text-align:center;">';
    html += '<div style="font-size:22px;font-weight:800;color:var(--accent-vibrant);font-variant-numeric:tabular-nums;">' + msgCount + '</div>';
    html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Messages</div>';
    html += '</div>';

    if (firstSeen) {
      const timeStr = firstSeen.toLocaleDateString() + '<br>' + firstSeen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += '<div style="text-align:center;">';
      html += '<div style="font-size:13px;font-weight:700;color:var(--text-secondary);">' + timeStr + '</div>';
      html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">First Seen</div>';
      html += '</div>';
    } else {
      html += '<div style="text-align:center;">';
      html += '<div style="font-size:13px;font-weight:700;color:var(--text-secondary);">—</div>';
      html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">First Seen</div>';
      html += '</div>';
    }

    html += '</div></div>';

    if (roles.length > 0) {
      html += '<div style="margin-bottom:16px;">';
      html += '<div style="font-weight:700;font-size:13px;color:var(--text-primary);margin-bottom:10px;">🎭 Roles (' + roles.length + ')</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
      roles.forEach(function(role) {
        html += '<span style="font-size:12px;padding:5px 12px;border-radius:20px;background:var(--hover-overlay);color:var(--text-secondary);border:1px solid var(--borders-and-separators);font-weight:600;">' + profilerEscapeHtml(role) + '</span>';
      });
      html += '</div></div>';
    } else {
      html += '<div style="margin-bottom:16px;">';
      html += '<div style="font-weight:700;font-size:13px;color:var(--text-primary);margin-bottom:10px;">🎭 Roles</div>';
      html += '<div style="font-size:12px;color:var(--text-muted);font-style:italic;">No roles detected in current view</div>';
      html += '</div>';
    }

    html += '<div style="font-size:10px;color:var(--text-muted);text-align:center;border-top:1px solid var(--borders-and-separators);padding-top:10px;font-style:italic;">All data gathered from visible DOM only. No API requests made.</div>';

    modal.innerHTML = html;
    modal.appendChild(closeBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(function() {
      overlay.style.opacity = '1';
      modal.style.transform = 'scale(1)';
    });
  }

  function profilerBuildTooltip(username, targetEl) {
    const tooltip = document.createElement('div');
    tooltip.id = 'fencord-profiler-tooltip';

    const avatarSrc = profilerFindAvatar(targetEl);
    const roles = profilerFindAllRoles(username);
    const msgCount = profilerMsgCounter.get(username) || 0;
    const firstSeen = profilerEstimateFirstSeen(username);
    const statusColor = profilerFindStatus(targetEl);

    let html = '';

    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">';
    if (avatarSrc) {
      html += '<img src="' + profilerEscapeHtml(avatarSrc) + '" id="fencord-profiler-avatar" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;cursor:pointer;transition:transform 0.15s;border:2px solid var(--borders-and-separators);" title="Click for full profile">';
    } else {
      html += '<div id="fencord-profiler-avatar" style="width:44px;height:44px;border-radius:50%;background:var(--secondary-button);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex-shrink:0;cursor:pointer;transition:transform 0.15s;border:2px solid var(--borders-and-separators);" title="Click for full profile">' + profilerEscapeHtml(username.charAt(0).toUpperCase()) + '</div>';
    }
    html += '<div style="min-width:0;flex:1;">';
    html += '<div style="font-weight:700;font-size:14px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">';
    html += profilerEscapeHtml(username);
    html += '<span style="width:8px;height:8px;border-radius:50%;background:' + statusColor + ';display:inline-block;"></span>';
    html += '</div>';
    html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Click avatar for full profile</div>';
    html += '</div></div>';

    html += '<div style="border-top:1px solid var(--borders-and-separators);padding-top:10px;display:flex;flex-direction:column;gap:6px;">';

    html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">';
    html += '<span style="color:var(--text-muted);">💬 Messages (session)</span>';
    html += '<span style="font-weight:700;color:var(--accent-vibrant);font-variant-numeric:tabular-nums;">' + msgCount + '</span>';
    html += '</div>';

    if (firstSeen) {
      const timeStr = firstSeen.toLocaleDateString() + ' ' + firstSeen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">';
      html += '<span style="color:var(--text-muted);">🕐 First seen today</span>';
      html += '<span style="font-weight:600;color:var(--text-secondary);font-variant-numeric:tabular-nums;">' + profilerEscapeHtml(timeStr) + '</span>';
      html += '</div>';
    }

    if (roles.length > 0) {
      html += '<div style="margin-top:4px;">';
      html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">🎭 Roles (' + roles.length + ')</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
      roles.slice(0, 3).forEach(function(role) {
        html += '<span style="font-size:10px;padding:2px 8px;border-radius:4px;background:var(--hover-overlay);color:var(--text-secondary);border:1px solid var(--borders-and-separators);white-space:nowrap;">' + profilerEscapeHtml(role) + '</span>';
      });
      if (roles.length > 3) {
        html += '<span style="font-size:10px;padding:2px 8px;color:var(--text-muted);">+' + (roles.length - 3) + ' more</span>';
      }
      html += '</div></div>';
    }

    html += '<div style="font-size:10px;color:var(--text-muted);margin-top:6px;font-style:italic;border-top:1px solid var(--borders-and-separators);padding-top:6px;">Session data only. No API calls.</div>';
    html += '</div>';

    tooltip.innerHTML = html;

    Object.assign(tooltip.style, {
      position: 'fixed', zIndex: '999999',
      background: 'var(--popups-and-modals)',
      border: '1px solid var(--borders-and-separators)',
      borderRadius: '12px', padding: '14px',
      minWidth: '260px', maxWidth: '320px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      fontFamily: 'inherit', color: 'var(--text-primary)',
      pointerEvents: 'auto',
      opacity: '0',
      transform: 'translateY(6px) scale(0.97)',
      transition: 'opacity 0.18s ease, transform 0.18s ease'
    });

    setTimeout(function() {
      const avatarEl = tooltip.querySelector('#fencord-profiler-avatar');
      if (avatarEl) {
        avatarEl.addEventListener('click', function(e) {
          e.stopPropagation();
          profilerOpenProfileModal(username, avatarSrc, statusColor);
        });
        avatarEl.addEventListener('mouseenter', function() { avatarEl.style.transform = 'scale(1.08)'; avatarEl.style.borderColor = 'var(--primary-action)'; });
        avatarEl.addEventListener('mouseleave', function() { avatarEl.style.transform = 'scale(1)'; avatarEl.style.borderColor = 'var(--borders-and-separators)'; });
      }
    }, 0);

    return tooltip;
  }

  function profilerOnMouseEnter(e) {
    const target = e.target;
    if (!target.matches('span.font-semibold.cursor-pointer')) return;
    if (profilerModalOpen) return;

    const username = target.textContent.trim();
    if (!username || username.length > 50) return;

    if (profilerHideTimer) { clearTimeout(profilerHideTimer); profilerHideTimer = null; }
    if (profilerTooltip) { profilerTooltip.remove(); profilerTooltip = null; }

    const tooltip = profilerBuildTooltip(username, target);
    document.body.appendChild(tooltip);
    profilerTooltip = tooltip;

    const rect = target.getBoundingClientRect();
    requestAnimationFrame(function() {
      const tooltipRect = tooltip.getBoundingClientRect();
      let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      let top = rect.bottom + 10;
      left = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));
      if (top + tooltipRect.height > window.innerHeight - 10) {
        top = rect.top - tooltipRect.height - 10;
      }
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.style.opacity = '1';
      tooltip.style.transform = 'translateY(0) scale(1)';
    });
  }

  function profilerOnMouseLeave(e) {
    if (!profilerTooltip) return;
    const related = e.relatedTarget;
    if (profilerTooltip.contains(related)) return;

    profilerHideTimer = setTimeout(function() {
      if (profilerTooltip) {
        profilerTooltip.style.opacity = '0';
        profilerTooltip.style.transform = 'translateY(6px) scale(0.97)';
        setTimeout(function() {
          if (profilerTooltip) { profilerTooltip.remove(); profilerTooltip = null; }
        }, 180);
      }
    }, 200);
  }

  function profilerOnScroll() {
    if (profilerTooltip) {
      profilerTooltip.style.opacity = '0';
      profilerTooltip.style.transform = 'translateY(6px) scale(0.97)';
      setTimeout(function() {
        if (profilerTooltip) { profilerTooltip.remove(); profilerTooltip = null; }
      }, 180);
    }
  }

  let profilerMsgObserver = null;

  function startProfiler() {
    if (profilerObserver) return;
    profilerMsgObserver = profilerWatchMessages();
    document.addEventListener('mouseenter', profilerOnMouseEnter, true);
    document.addEventListener('mouseleave', profilerOnMouseLeave, true);
    window.addEventListener('scroll', profilerOnScroll, true);

    profilerObserver = {
      disconnect: function() {
        document.removeEventListener('mouseenter', profilerOnMouseEnter, true);
        document.removeEventListener('mouseleave', profilerOnMouseLeave, true);
        window.removeEventListener('scroll', profilerOnScroll, true);
        if (profilerMsgObserver) { profilerMsgObserver.disconnect(); profilerMsgObserver = null; }
        if (profilerTooltip) { profilerTooltip.remove(); profilerTooltip = null; }
        if (profilerHideTimer) { clearTimeout(profilerHideTimer); profilerHideTimer = null; }
      }
    };
  }

  function stopProfiler() {
    if (!profilerObserver) return;
    profilerObserver.disconnect();
    profilerObserver = null;
  }

  function initProfiler() {
    if (isProfilerEnabled()) startProfiler();
  }



  const CUSTOM_PLUGIN_KEY = 'fencord-custom-plugin-code';
  const CUSTOM_PLUGIN_ENABLED_KEY = 'fencord-custom-plugin-enabled';
  let customPluginCleanup = null;


  const DANGEROUS_PATTERNS = [

    { pattern: /fetch\s*\(/gi, name: 'fetch() — network requests', severity: 'high' },
    { pattern: /XMLHttpRequest/gi, name: 'XMLHttpRequest', severity: 'high' },
    { pattern: /WebSocket/gi, name: 'WebSocket', severity: 'high' },
    { pattern: /navigator\s*\.\s*sendBeacon/gi, name: 'sendBeacon() — silent data upload', severity: 'high' },
    { pattern: /new\s+Image\s*\(\s*\)/gi, name: 'new Image() — often used to leak data via pixel requests', severity: 'medium' },
    { pattern: /\.src\s*=\s*[`'"][^`'"]*(https?:)?\/\//gi, name: 'assigning a remote URL to .src (possible beacon/exfil)', severity: 'medium' },
    { pattern: /navigator\.sendBeacon|navigator\.connection/gi, name: 'network/connection introspection', severity: 'medium' },
    { pattern: /import\s*\(/gi, name: 'dynamic import()', severity: 'high' },
    { pattern: /require\s*\(/gi, name: 'require()', severity: 'high' },


    { pattern: /eval\s*\(/gi, name: 'eval()', severity: 'high' },
    { pattern: /Function\s*\(/gi, name: 'Function() constructor', severity: 'high' },
    { pattern: /setTimeout\s*\(\s*["'`]/gi, name: 'setTimeout with a string (implicit eval)', severity: 'high' },
    { pattern: /setInterval\s*\(\s*["'`]/gi, name: 'setInterval with a string (implicit eval)', severity: 'high' },
    { pattern: /atob\s*\(|btoa\s*\(/gi, name: 'base64 encode/decode (often used to hide payloads)', severity: 'medium' },
    { pattern: /String\.fromCharCode/gi, name: 'String.fromCharCode (common obfuscation trick)', severity: 'medium' },
    { pattern: /\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){5,}/gi, name: 'hex-escaped string blob (obfuscated payload)', severity: 'medium' },
    { pattern: /\[\s*["']constructor["']\s*\]/gi, name: 'accessing .constructor via brackets (sandbox-escape trick)', severity: 'high' },


    { pattern: /document\.cookie/gi, name: 'document.cookie access', severity: 'high' },
    { pattern: /localStorage\s*\.\s*getItem/gi, name: 'reading localStorage (may target tokens/session data)', severity: 'medium' },
    { pattern: /localStorage\.clear\s*\(/gi, name: 'localStorage.clear()', severity: 'high' },
    { pattern: /sessionStorage/gi, name: 'sessionStorage access', severity: 'medium' },
    { pattern: /indexedDB/gi, name: 'indexedDB access', severity: 'medium' },
    { pattern: /navigator\.credentials/gi, name: 'Credential Management API', severity: 'high' },
    { pattern: /\btoken\b|\bpassword\b|\bwebhook\b/gi, name: "references to 'token' / 'password' / 'webhook'", severity: 'medium' },
    { pattern: /discord(app)?\.com\/api\/webhooks/gi, name: 'Discord webhook URL (classic exfil vector)', severity: 'high' },


    { pattern: /navigator\.clipboard/gi, name: 'clipboard read/write access', severity: 'high' },
    { pattern: /addEventListener\s*\(\s*["']key(down|up|press)["']/gi, name: 'keystroke listener (possible keylogger)', severity: 'medium' },
    { pattern: /addEventListener\s*\(\s*["']paste["']/gi, name: 'paste event listener', severity: 'medium' },


    { pattern: /document\.write/gi, name: 'document.write', severity: 'high' },
    { pattern: /location\s*(=|\.href\s*=|\.replace\s*\()/gi, name: 'page redirect (location change)', severity: 'high' },
    { pattern: /window\.open/gi, name: 'window.open', severity: 'medium' },
    { pattern: /<\s*script/gi, name: 'injecting a <script> tag', severity: 'high' },
    { pattern: /<\s*iframe/gi, name: 'injecting an <iframe>', severity: 'medium' },


    { pattern: /chrome\s*\./gi, name: 'Chrome extension API', severity: 'high' },
    { pattern: /\bbrowser\s*\.\s*(runtime|storage|tabs|extension)/gi, name: 'browser extension API', severity: 'high' },
    { pattern: /GM_[A-Za-z]+/gi, name: 'Greasemonkey/Tampermonkey privileged API', severity: 'high' },
    { pattern: /unsafeWindow/gi, name: 'unsafeWindow', severity: 'high' },
    { pattern: /prototype\s*\.\s*__/gi, name: 'prototype pollution attempt', severity: 'high' },
    { pattern: /top\s*\.\s*(location|postMessage)|parent\s*\.\s*(location|postMessage)/gi, name: 'reaching into top/parent frame', severity: 'medium' },
  ];

  function scanForSuspiciousBlobs(code) {
    const issues = [];
    const blob = code.match(/[A-Za-z0-9+/]{80,}={0,2}/g);
    if (blob && blob.length) {
      issues.push({ name: 'long base64-like blob embedded in code', severity: 'medium' });
    }
    return issues;
  }


  let contextMenuEl = null;

  function profilerShowRolesContextMenu(username, x, y) {
    // Remove any existing context menu
    if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }

    const roles = profilerFindAllRoles(username);
    const msgCount = profilerMsgCounter.get(username) || 0;

    const menu = document.createElement('div');
    menu.id = 'fencord-context-menu';

    let html = '';

    // Header
    html += '<div style="padding:10px 14px;border-bottom:1px solid var(--borders-and-separators);font-weight:700;font-size:13px;color:var(--text-primary);display:flex;align-items:center;gap:8px;">';
    html += '<span style="font-size:14px;">🎭</span>';
    html += profilerEscapeHtml(username);
    html += '</div>';

    // Roles section
    if (roles.length > 0) {
      html += '<div style="padding:10px 14px;">';
      html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600;">Roles (' + roles.length + ')</div>';
      html += '<div style="display:flex;flex-direction:column;gap:4px;">';
      roles.forEach(function(role) {
        html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;background:var(--hover-overlay);">';
        html += '<span style="width:6px;height:6px;border-radius:50%;background:var(--accent-vibrant);flex-shrink:0;"></span>';
        html += '<span style="font-size:12px;color:var(--text-secondary);font-weight:500;">' + profilerEscapeHtml(role) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    } else {
      html += '<div style="padding:10px 14px;font-size:12px;color:var(--text-muted);font-style:italic;">No roles detected</div>';
    }

    // Stats
    html += '<div style="padding:8px 14px;border-top:1px solid var(--borders-and-separators);display:flex;justify-content:space-between;align-items:center;">';
    html += '<span style="font-size:11px;color:var(--text-muted);">💬 Messages</span>';
    html += '<span style="font-size:12px;font-weight:700;color:var(--accent-vibrant);">' + msgCount + '</span>';
    html += '</div>';

    menu.innerHTML = html;

    Object.assign(menu.style, {
      position: 'fixed',
      zIndex: '1000006',
      background: 'var(--popups-and-modals)',
      border: '1px solid var(--borders-and-separators)',
      borderRadius: '10px',
      minWidth: '200px',
      maxWidth: '280px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      fontFamily: 'inherit',
      color: 'var(--text-primary)',
      overflow: 'hidden',
      opacity: '0',
      transform: 'scale(0.95)',
      transition: 'opacity 0.12s ease, transform 0.12s ease'
    });

    document.body.appendChild(menu);
    contextMenuEl = menu;

    // Position
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 10) left = window.innerWidth - rect.width - 10;
    if (top + rect.height > window.innerHeight - 10) top = y - rect.height;
    if (top < 10) top = 10;

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    requestAnimationFrame(function() {
      menu.style.opacity = '1';
      menu.style.transform = 'scale(1)';
    });
  }

  function profilerHideContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.style.opacity = '0';
      contextMenuEl.style.transform = 'scale(0.95)';
      setTimeout(function() {
        if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
      }, 120);
    }
  }

  function profilerOnContextMenu(e) {
    const target = e.target;
    // Check if right-clicked on a username
    const usernameEl = target.closest('span.font-semibold.cursor-pointer');
    if (!usernameEl) return;

    e.preventDefault();
    e.stopPropagation();

    const username = usernameEl.textContent.trim();
    if (!username) return;

    profilerShowRolesContextMenu(username, e.clientX, e.clientY);
  }

  function profilerOnDocumentClick(e) {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) {
      profilerHideContextMenu();
    }
  }

  // Hook into startProfiler to add context menu listener
  const _originalStartProfiler = startProfiler;
  startProfiler = function() {
    _originalStartProfiler();
    document.addEventListener('contextmenu', profilerOnContextMenu, true);
    document.addEventListener('click', profilerOnDocumentClick, true);
  };

  const _originalStopProfiler = stopProfiler;
  stopProfiler = function() {
    _originalStopProfiler();
    document.removeEventListener('contextmenu', profilerOnContextMenu, true);
    document.removeEventListener('click', profilerOnDocumentClick, true);
    profilerHideContextMenu();
  };


  function scanCustomPlugin(code) {
    const found = [];
    for (let i = 0; i < DANGEROUS_PATTERNS.length; i++) {
      const p = DANGEROUS_PATTERNS[i];
      p.pattern.lastIndex = 0;
      if (p.pattern.test(code)) {
        found.push({ name: p.name, severity: p.severity });
      }
    }
    found.push(...scanForSuspiciousBlobs(code));

    const high = found.filter(f => f.severity === 'high');
    const medium = found.filter(f => f.severity === 'medium');
    return { high, medium, all: found, blocked: high.length > 0 };
  }

  function getCustomPluginCode() {
    return localStorage.getItem(CUSTOM_PLUGIN_KEY) || '';
  }

  function saveCustomPluginCode(code) {
    localStorage.setItem(CUSTOM_PLUGIN_KEY, code);
  }

  function isCustomPluginEnabled() {
    return localStorage.getItem(CUSTOM_PLUGIN_ENABLED_KEY) === 'true';
  }

  function setCustomPluginEnabled(enabled) {
    localStorage.setItem(CUSTOM_PLUGIN_ENABLED_KEY, enabled ? 'true' : 'false');
    if (enabled) runCustomPlugin();
    else stopCustomPlugin();
  }

  function runCustomPlugin() {
    stopCustomPlugin();
    const code = getCustomPluginCode();
    if (!code.trim()) return;

    const scan = scanCustomPlugin(code);
    if (scan.blocked) {
      alert('Custom plugin blocked!\n\nDangerous patterns found:\n• ' + scan.high.map(i => i.name).join('\n• ') + '\n\nRemove these and try again.');
      localStorage.setItem(CUSTOM_PLUGIN_ENABLED_KEY, 'false');
      if (typeof refreshSettingsPanel === 'function') refreshSettingsPanel();
      return;
    }

    try {
      const wrapped = '(function() { "use strict"; const console = window.console; const document = window.document; const MutationObserver = window.MutationObserver; const setTimeout = window.setTimeout; const setInterval = window.setInterval; const clearTimeout = window.clearTimeout; const clearInterval = window.clearInterval; ' + code + ' })();';
      const fn = new Function(wrapped);
      const cleanup = fn();
      if (typeof cleanup === 'function') {
        customPluginCleanup = cleanup;
      }
    } catch (e) {
      alert('Custom plugin error: ' + e.message);
      localStorage.setItem(CUSTOM_PLUGIN_ENABLED_KEY, 'false');
      if (typeof refreshSettingsPanel === 'function') refreshSettingsPanel();
    }
  }

  function stopCustomPlugin() {
    if (customPluginCleanup) {
      try { customPluginCleanup(); } catch (e) {}
      customPluginCleanup = null;
    }
  }

  function initCustomPlugin() {
    if (isCustomPluginEnabled()) runCustomPlugin();
  }



  function fencordProtectBlockedCount() {
    return (typeof window.__fencordShieldBlockedCount === 'function')
      ? window.__fencordShieldBlockedCount()
      : 0;
  }



  const FAVORITE_PLUGINS_KEY = 'fencord-favorite-plugins';
  let favStyleInjected = false;

  function favInjectStyle() {
    if (favStyleInjected) return;
    favStyleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fencordFavPop {
        0%   { transform: scale(1);   filter: drop-shadow(0 0 0 rgba(255,214,10,0)); }
        35%  { transform: scale(1.6); filter: drop-shadow(0 0 6px rgba(255,214,10,0.9)); }
        65%  { transform: scale(0.85);}
        100% { transform: scale(1.15); filter: drop-shadow(0 0 3px rgba(255,214,10,0.6)); }
      }
      .fencord-fav-star.fencord-fav-pop { animation: fencordFavPop 0.45s ease; }
    `;
    document.head.appendChild(style);
  }

  function getFavoritePlugins() {
    try { return JSON.parse(localStorage.getItem(FAVORITE_PLUGINS_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function saveFavoritePlugins(list) {
    localStorage.setItem(FAVORITE_PLUGINS_KEY, JSON.stringify(list));
  }

  function isPluginFavorited(title) {
    return getFavoritePlugins().includes(title);
  }

  function togglePluginFavorite(title) {
    const list = getFavoritePlugins();
    const idx = list.indexOf(title);
    if (idx >= 0) { list.splice(idx, 1); saveFavoritePlugins(list); return false; }
    list.unshift(title);
    saveFavoritePlugins(list);
    return true;
  }

  function favBuildStar(title) {
    favInjectStyle();
    const star = document.createElement('span');
    star.className = 'fencord-fav-star';
    star.title = 'Favorite this plugin';
    const favored = isPluginFavorited(title);
    star.textContent = favored ? '★' : '☆';
    Object.assign(star.style, {
      fontSize: '15px', lineHeight: '1', cursor: 'pointer', flexShrink: '0',
      color: favored ? '#ffd60a' : 'var(--text-muted)', userSelect: 'none',
      padding: '2px'
    });
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFavored = togglePluginFavorite(title);
      star.textContent = nowFavored ? '★' : '☆';
      star.style.color = nowFavored ? '#ffd60a' : 'var(--text-muted)';
      star.classList.remove('fencord-fav-pop');
      void star.offsetWidth;
      star.classList.add('fencord-fav-pop');
      if (nowFavored) showToast('⭐ Added to Favorites', { color: 'var(--success-green)', duration: 1400 });
    });
    return star;
  }

  const USERNAME_HIDER_KEY = 'fencord-username-hider-mode';
  const ALLOWED_HIDER_MODES = new Set(['off', 'mine', 'others', 'both']);
  let usernameHiderInterval = null;

  const HIDER_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

  function randomScramble(length) {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += HIDER_CHARS[Math.floor(Math.random() * HIDER_CHARS.length)];
    }
    return out;
  }

  function getUsernameHiderMode() {
    const v = localStorage.getItem(USERNAME_HIDER_KEY) || 'off';
    return ALLOWED_HIDER_MODES.has(v) ? v : 'off';
  }

  function saveUsernameHiderMode(mode) {
    localStorage.setItem(USERNAME_HIDER_KEY, ALLOWED_HIDER_MODES.has(mode) ? mode : 'off');
  }

  function tickUsernameHider() {
    try {
      const mode = getUsernameHiderMode();
      if (mode === 'off') return;

      const myName = getMyRealUsername();

      document.querySelectorAll('span.font-semibold.cursor-pointer').forEach(el => {
        // Save original text once.
        if (!el.dataset.fencordHiderOriginal) {
          el.dataset.fencordHiderOriginal = el.textContent.trim();
        }
        const original = el.dataset.fencordHiderOriginal;
        const isMe = myName && original === myName;

        const shouldHide =
          mode === 'both' ||
          (mode === 'mine' && isMe) ||
          (mode === 'others' && !isMe);

        if (shouldHide) {
          el.dataset.fencordHiderActive = '1';
          el.textContent = randomScramble(original.length || 6);
        } else if (el.dataset.fencordHiderActive === '1') {
          // This element was previously scrambled but is no longer in scope
          // (e.g. mode changed to 'mine' and this is someone else).
          delete el.dataset.fencordHiderActive;
          el.textContent = original;
        }
      });
    } catch (e) {}
  }

  function revertUsernameHider() {
    document.querySelectorAll('[data-fencord-hider-original]').forEach(el => {
      el.textContent = el.dataset.fencordHiderOriginal;
      delete el.dataset.fencordHiderOriginal;
      delete el.dataset.fencordHiderActive;
    });
  }

  function setUsernameHiderMode(mode) {
    const clean = ALLOWED_HIDER_MODES.has(mode) ? mode : 'off';
    saveUsernameHiderMode(clean);

    // Always revert first so we start fresh.
    revertUsernameHider();

    if (clean === 'off') {
      if (usernameHiderInterval) { clearInterval(usernameHiderInterval); usernameHiderInterval = null; }
      return;
    }

    tickUsernameHider();

    if (!usernameHiderInterval) {
      usernameHiderInterval = setInterval(tickUsernameHider, 1500);
    }
  }

  function initUsernameHider() {
    const mode = getUsernameHiderMode();
    if (mode !== 'off') setUsernameHiderMode(mode);
  }

  function init() {
    // Prevent double initialization
    if (window.__fencordInitialized) return;
    Object.defineProperty(window, '__fencordInitialized', { value: true, enumerable: false, configurable: true });

    applyTheme(getSavedTheme());
    initFont();
    watchForSettingsButton();
    loadThemes();
    loadFonts();
    loadEffects();
    tryDetectRealUsername();
    if (isRgbEnabled()) setRgbEnabled(true);
    if (getDisplayNameOverride()) setDisplayNameEnabled(true);
    initTimestampFormat();
    if (isImageBlurEnabled()) setImageBlurEnabled(true);
    if (isSoftTapsEnabled()) setSoftTapsEnabled(true);
    setBackgroundEffect(getBackgroundEffect());
    if (isCallTimerEnabled()) setCallTimerEnabled(true);
    initUsernameHider();
    initCustomPlugin();
    createFencordWatermark();
    startUpdateChecker();
    showBootDisclaimerToast();
  }

  if (document.body) {
    init();
  } else {
    const fencordBootObserver = new MutationObserver((_, obs) => {
      if (document.body) {
        init();
        obs.disconnect();
      }
    });
    fencordBootObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
