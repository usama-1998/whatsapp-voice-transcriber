// Content script for web.whatsapp.com.
// Adds a small transcript icon next to every voice message. Clicking it asks
// injected.js (running in the page's MAIN world) to capture the audio bytes,
// then hands them to the extension's offscreen document, where a local
// Whisper model produces the transcript. The transcript is shown directly
// underneath the voice player, inside the chat bubble.

(() => {
  'use strict';

  const VERSION = '1.3.1';

  const log = (...args) =>
    console.log('%c[Voice Transcriber]', 'color:#00a884;font-weight:bold', ...args);

  // WhatsApp marks its icons with data-icon attributes whose names have
  // changed across releases (audio-play, ptt-play, mic-...). Match broadly on
  // anything audio/ptt related, and fall back to aria-labels on buttons.
  const ICON_NAME_RE = /audio|ptt/i;
  const ARIA_VOICE_RE = /voice message|audio message|sprachnachricht|mensaje de voz|message vocal/i;

  const STORAGE_PREFIX = 'transcript:';
  const SCAN_INTERVAL_MS = 1500;
  const CAPTURE_TIMEOUT_MS = 15000;

  const ICON_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path fill="currentColor" d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>';

  const pending = new Map(); // requestId -> { bubble, ui, lastActivity }
  let requestCounter = 0;
  let attachedCount = 0;
  let captureInFlight = false;

  // ---------------------------------------------------------------- helpers

  function findMessageBubble(el) {
    return (
      el.closest('[data-id]') ||
      el.closest('.message-in, .message-out') ||
      el.closest('div[role="row"]')
    );
  }

  function messageKey(bubble) {
    const holder = bubble.hasAttribute('data-id')
      ? bubble
      : bubble.querySelector('[data-id]');
    const id = holder && holder.getAttribute('data-id');
    return id ? STORAGE_PREFIX + id : null;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ------------------------------------------------------- message finding

  function isOurUi(el) {
    return !!el.closest('.wvt-wrap, .wvt-btn');
  }

  function findVoiceControls(scope) {
    const controls = [];
    for (const el of scope.querySelectorAll('span[data-icon]')) {
      if (isOurUi(el)) continue;
      if (ICON_NAME_RE.test(el.getAttribute('data-icon') || '')) controls.push(el);
    }
    for (const btn of scope.querySelectorAll('button[aria-label]')) {
      if (isOurUi(btn)) continue;
      if (ARIA_VOICE_RE.test(btn.getAttribute('aria-label') || '')) controls.push(btn);
    }
    return controls;
  }

  function findButtonByIcon(bubble, iconNameRe, ariaRe) {
    for (const el of bubble.querySelectorAll('span[data-icon]')) {
      if (isOurUi(el)) continue;
      if (iconNameRe.test(el.getAttribute('data-icon') || '')) {
        return el.closest('button') || el.parentElement;
      }
    }
    for (const btn of bubble.querySelectorAll('button[aria-label]')) {
      if (isOurUi(btn)) continue;
      if (ariaRe.test(btn.getAttribute('aria-label') || '')) return btn;
    }
    return null;
  }

  const findPlayButton = (bubble) =>
    findButtonByIcon(bubble, /play/i, /^play\b|play voice|play audio/i);
  const findPauseButton = (bubble) =>
    findButtonByIcon(bubble, /pause/i, /^pause\b|pause voice|pause audio/i);

  // ------------------------------------------------------ audio acquisition

  // Ask the MAIN-world script (injected.js) to capture this voice note's
  // audio bytes. Returns an ArrayBuffer.
  function captureAudio(bubble) {
    return new Promise((resolve, reject) => {
      if (captureInFlight) {
        reject(new Error('Another capture is in progress; try again in a moment.'));
        return;
      }
      captureInFlight = true;

      const id = 'wvt-cap-' + Date.now() + '-' + requestCounter++;

      const cleanup = () => {
        captureInFlight = false;
        window.removeEventListener('message', onMessage);
        clearTimeout(timeout);
      };

      const onMessage = (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.__wvt !== true || msg.id !== id) return;
        if (msg.type === 'WVT_AUDIO' && msg.buffer) {
          cleanup();
          resolve(msg.buffer);
        } else if (msg.type === 'WVT_ERROR') {
          cleanup();
          reject(new Error(msg.error || 'Audio capture failed.'));
        }
      };
      window.addEventListener('message', onMessage);

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the audio.'));
      }, CAPTURE_TIMEOUT_MS);

      const playing = !!findPauseButton(bubble);
      window.postMessage(
        { __wvt: true, type: 'WVT_ARM', id, expectPlaying: playing },
        window.location.origin
      );

      if (!playing) {
        const playButton = findPlayButton(bubble);
        if (!playButton) {
          cleanup();
          reject(new Error('Could not find the play button for this message.'));
          return;
        }
        // Give the MAIN world a beat to arm before triggering playback.
        setTimeout(() => playButton.click(), 50);
      }
    });
  }

  // Fallback for the (older) DOM layout where the <audio> element lives
  // inside the message bubble.
  async function domAudioFallback(bubble) {
    const audio = bubble.querySelector('audio');
    if (!audio || !audio.src) return null;
    try {
      const response = await fetch(audio.src);
      if (!response.ok) return null;
      return await (await response.blob()).arrayBuffer();
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------- UI

  // Is this one of the user's own (outgoing) messages? Try WhatsApp's
  // long-standing classes first, then fall back to geometry (outgoing
  // bubbles sit in the right half of the chat panel).
  function isOutgoingMessage(bubble, refEl) {
    if (
      bubble.matches('.message-out') ||
      bubble.closest('.message-out') ||
      bubble.querySelector('.message-out')
    ) {
      return true;
    }
    if (
      bubble.matches('.message-in') ||
      bubble.closest('.message-in') ||
      bubble.querySelector('.message-in')
    ) {
      return false;
    }
    const target = refEl || bubble;
    const rect = target.getBoundingClientRect();
    const panel = (bubble.closest('#main') || document.body).getBoundingClientRect();
    return (rect.left + rect.right) / 2 > panel.left + panel.width / 2;
  }

  function createUi(bubble, control) {
    const outgoing = isOutgoingMessage(bubble, control);

    const wrap = document.createElement('div');
    wrap.className = 'wvt-wrap ' + (outgoing ? 'wvt-out' : 'wvt-in');

    const button = document.createElement('button');
    button.className = 'wvt-btn';
    button.type = 'button';
    button.setAttribute('aria-label', 'Transcribe');
    button.title = 'Transcribe locally (audio never leaves your browser)';
    button.innerHTML = ICON_SVG;

    const output = document.createElement('div');
    output.className = 'wvt-output';
    output.hidden = true;

    wrap.appendChild(button);
    wrap.appendChild(output);

    // Attach to the element that hugs the bubble (correct chat side), not to
    // the full-width row container; fall back to the row with CSS alignment
    // (wvt-out / wvt-in) doing the side placement either way.
    const host = bubble.matches('.message-in, .message-out')
      ? bubble
      : bubble.querySelector('.message-in, .message-out') || bubble;
    host.appendChild(wrap);

    return { wrap, button, output };
  }

  function setWorking(ui, working) {
    ui.button.disabled = working;
    ui.button.classList.toggle('wvt-working', working);
  }

  function showStatus(ui, text) {
    ui.output.hidden = false;
    ui.output.classList.add('wvt-status');
    ui.output.classList.remove('wvt-error');
    ui.output.textContent = text;
  }

  function showResult(ui, text) {
    ui.output.hidden = false;
    ui.output.classList.remove('wvt-status', 'wvt-error');
    ui.output.textContent = text;
    setWorking(ui, false);
    ui.button.hidden = true;
  }

  function showError(ui, text) {
    ui.output.hidden = false;
    ui.output.classList.remove('wvt-status');
    ui.output.classList.add('wvt-error');
    ui.output.textContent = text;
    setWorking(ui, false);
    ui.button.title = 'Retry transcription';
  }

  async function onTranscribeClick(bubble, ui) {
    setWorking(ui, true);
    showStatus(ui, 'Capturing audio…');

    const requestId = 'wvt-' + Date.now() + '-' + requestCounter++;
    try {
      let buffer;
      try {
        buffer = await captureAudio(bubble);
      } catch (captureErr) {
        buffer = await domAudioFallback(bubble);
        if (!buffer) throw captureErr;
      }

      pending.set(requestId, { bubble, ui, lastActivity: Date.now() });
      await chrome.runtime.sendMessage({
        target: 'background',
        type: 'transcribe',
        requestId,
        audioBase64: arrayBufferToBase64(buffer),
      });
      showStatus(ui, 'Starting local transcription…');
    } catch (err) {
      pending.delete(requestId);
      showError(ui, err && err.message ? err.message : String(err));
    }
  }

  // --------------------------------------------------------------- scanning

  async function attachToVoiceMessage(control) {
    const bubble = findMessageBubble(control);
    if (!bubble || bubble.dataset.wvtAttached) return;
    bubble.dataset.wvtAttached = '1';
    attachedCount++;

    const ui = createUi(bubble, control);

    // Restore a previously saved transcript for this message, if any.
    const key = messageKey(bubble);
    if (key) {
      try {
        const stored = await chrome.storage.local.get(key);
        if (stored && stored[key]) {
          showResult(ui, stored[key]);
          return;
        }
      } catch (e) {
        /* storage unavailable - ignore */
      }
    }

    ui.button.addEventListener('click', () => onTranscribeClick(bubble, ui));
  }

  function scan() {
    // WhatsApp re-renders parts of message rows (e.g. when playback state
    // changes), which can destroy our injected UI while the bubble keeps its
    // attached flag. Detect that and allow re-attachment.
    for (const bubble of document.querySelectorAll('[data-wvt-attached]')) {
      if (!bubble.querySelector('.wvt-btn') && !bubble.querySelector('.wvt-output')) {
        delete bubble.dataset.wvtAttached;
      }
    }

    const before = attachedCount;
    for (const control of findVoiceControls(document)) {
      attachToVoiceMessage(control);
    }
    if (attachedCount !== before) {
      log(`attached to ${attachedCount - before} new voice message(s)`);
    }
  }

  // ------------------------------------------------------- message handling

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'content') return;
    const entry = pending.get(message.requestId);
    if (!entry) return;

    if (message.type === 'progress') {
      entry.lastActivity = Date.now();
      showStatus(entry.ui, message.text);
    } else if (message.type === 'result') {
      pending.delete(message.requestId);
      showResult(entry.ui, message.text);
      const key = messageKey(entry.bubble);
      if (key) {
        chrome.storage.local.set({ [key]: message.text }).catch(() => {});
      }
    } else if (message.type === 'error') {
      pending.delete(message.requestId);
      showError(entry.ui, 'Transcription failed: ' + message.error);
    }
  });

  // Watchdog: if a request stops making progress (extension reloaded,
  // offscreen document crashed, ...) surface an error instead of spinning
  // forever. Progress messages (including model-download updates) reset it.
  const WATCHDOG_TIMEOUT_MS = 180000;
  setInterval(() => {
    const now = Date.now();
    for (const [requestId, entry] of pending) {
      if (now - entry.lastActivity > WATCHDOG_TIMEOUT_MS) {
        pending.delete(requestId);
        showError(
          entry.ui,
          'Transcription timed out. Please try again (check your internet connection if the model was still downloading).'
        );
      }
    }
  }, 10000);

  // ------------------------------------------------------------------ init

  function start() {
    log(`content script active (v${VERSION})`);

    // WhatsApp renders its UI long after page load and uses a virtualized
    // message list, so re-scan periodically rather than relying on load-time
    // DOM state.
    scan();
    setInterval(scan, SCAN_INTERVAL_MS);

    // Diagnostics: if nothing was found after a while, print what icons the
    // page actually uses so selector updates are easy.
    setTimeout(() => {
      if (attachedCount === 0) {
        const icons = [
          ...new Set(
            [...document.querySelectorAll('[data-icon]')].map((el) =>
              el.getAttribute('data-icon')
            )
          ),
        ].sort();
        log(
          'no voice messages detected yet. If a chat with voice messages is open, ' +
            'please report these data-icon values found on the page:',
          JSON.stringify(icons)
        );
      }
    }, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
