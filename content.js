// Content script for web.whatsapp.com.
// Adds a "Transcribe" button to every voice message. Clicking it grabs the
// audio blob from the page and hands it to the extension's offscreen document,
// where a local Whisper model produces the transcript. The transcript is then
// shown directly underneath the voice player, inside the chat bubble.

(() => {
  'use strict';

  // Icon names WhatsApp uses for the play button of voice notes / audio
  // messages (they have changed over time, so match several).
  const PLAY_ICON_SELECTOR = [
    'span[data-icon="audio-play"]',
    'span[data-icon="ptt-play"]',
    'span[data-icon="audio-play-outline"]',
  ].join(', ');
  const PAUSE_ICON_SELECTOR =
    'span[data-icon="audio-pause"], span[data-icon="ptt-pause"]';

  const MESSAGE_SELECTOR = '.message-in, .message-out, [data-id]';
  const STORAGE_PREFIX = 'transcript:';
  const MAX_AUDIO_WAIT_MS = 8000;

  const pending = new Map(); // requestId -> UI elements
  let requestCounter = 0;

  // ---------------------------------------------------------------- helpers

  function findMessageBubble(el) {
    let node = el.closest(MESSAGE_SELECTOR);
    // Prefer an ancestor that carries the stable message id.
    const withId = el.closest('[data-id]');
    return withId || node;
  }

  function messageKey(bubble) {
    const id = bubble && bubble.getAttribute('data-id');
    return id ? STORAGE_PREFIX + id : null;
  }

  function waitFor(check, timeoutMs, intervalMs = 50) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const value = check();
        if (value) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result = "data:<mime>;base64,<data>"
        const result = String(reader.result);
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // ------------------------------------------------------ audio acquisition

  // Returns the <audio> element that belongs to this voice message, loading
  // it if necessary by briefly (and muted) starting playback.
  async function getAudioElement(bubble) {
    const existing = bubble.querySelector('audio');
    if (existing && existing.src) return existing;

    const playIcon = bubble.querySelector(PLAY_ICON_SELECTOR);
    const playButton = playIcon && (playIcon.closest('button') || playIcon.parentElement);
    if (!playButton) return null;

    // WhatsApp only creates/loads the <audio> element when playback starts.
    // Start it muted, capture the element, then immediately pause again.
    const before = new Set(document.querySelectorAll('audio'));
    const muted = new Set();
    const muteNewAudio = () => {
      for (const a of document.querySelectorAll('audio')) {
        if (!before.has(a) && !a.muted) {
          a.muted = true;
          muted.add(a);
        }
      }
    };
    const muteTimer = setInterval(muteNewAudio, 20);

    try {
      playButton.click();
      const audio = await waitFor(() => {
        muteNewAudio();
        const inBubble = bubble.querySelector('audio');
        if (inBubble && inBubble.src) return inBubble;
        for (const a of document.querySelectorAll('audio')) {
          if (!before.has(a) && a.src) return a;
        }
        return null;
      }, MAX_AUDIO_WAIT_MS);

      // Stop playback again: prefer WhatsApp's own pause button so its UI
      // state stays consistent, fall back to pausing the element directly.
      const pauseIcon = bubble.querySelector(PAUSE_ICON_SELECTOR);
      const pauseButton =
        pauseIcon && (pauseIcon.closest('button') || pauseIcon.parentElement);
      if (pauseButton) pauseButton.click();
      if (audio) {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
      }
      return audio;
    } finally {
      clearInterval(muteTimer);
      // Restore sound for normal playback later.
      setTimeout(() => {
        for (const a of muted) a.muted = false;
      }, 300);
    }
  }

  async function fetchAudioBase64(bubble) {
    const audio = await getAudioElement(bubble);
    if (!audio || !audio.src) {
      throw new Error(
        'Could not access the audio for this message. Try playing it once, then transcribe again.'
      );
    }
    const response = await fetch(audio.src);
    if (!response.ok) throw new Error('Failed to read audio data.');
    const blob = await response.blob();
    return blobToBase64(blob);
  }

  // ------------------------------------------------------------------- UI

  function createUi(bubble) {
    const wrap = document.createElement('div');
    wrap.className = 'wvt-wrap';

    const button = document.createElement('button');
    button.className = 'wvt-button';
    button.type = 'button';
    button.textContent = 'Transcribe';
    button.title = 'Transcribe this voice message locally (audio never leaves your browser)';

    const output = document.createElement('div');
    output.className = 'wvt-output';
    output.hidden = true;

    wrap.appendChild(button);
    wrap.appendChild(output);
    bubble.appendChild(wrap);

    return { wrap, button, output };
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
    ui.button.hidden = true;
  }

  function showError(ui, text) {
    ui.output.hidden = false;
    ui.output.classList.remove('wvt-status');
    ui.output.classList.add('wvt-error');
    ui.output.textContent = text;
    ui.button.disabled = false;
    ui.button.textContent = 'Retry transcription';
  }

  async function onTranscribeClick(bubble, ui) {
    ui.button.disabled = true;
    ui.button.textContent = 'Transcribing…';
    showStatus(ui, 'Reading audio…');

    const requestId = 'wvt-' + Date.now() + '-' + requestCounter++;
    try {
      const audioBase64 = await fetchAudioBase64(bubble);
      pending.set(requestId, { bubble, ui, lastActivity: Date.now() });
      await chrome.runtime.sendMessage({
        target: 'background',
        type: 'transcribe',
        requestId,
        audioBase64,
      });
      showStatus(ui, 'Starting local transcription…');
    } catch (err) {
      pending.delete(requestId);
      showError(ui, err && err.message ? err.message : String(err));
    }
  }

  // --------------------------------------------------------------- scanning

  async function attachToVoiceMessage(icon) {
    const bubble = findMessageBubble(icon);
    if (!bubble || bubble.dataset.wvtAttached) return;
    bubble.dataset.wvtAttached = '1';

    const ui = createUi(bubble);

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

  function scan(root) {
    if (!(root instanceof Element) && root !== document) return;
    const scope = root instanceof Element ? root : document;
    if (scope instanceof Element && scope.matches(PLAY_ICON_SELECTOR)) {
      attachToVoiceMessage(scope);
    }
    for (const icon of scope.querySelectorAll(PLAY_ICON_SELECTOR)) {
      attachToVoiceMessage(icon);
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

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) scan(node);
      }
    }
  });

  function start() {
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
