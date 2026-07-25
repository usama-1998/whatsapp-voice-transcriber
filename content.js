// Content script for web.whatsapp.com.
// Adds a small transcript icon next to every voice message. Clicking it asks
// injected.js (running in the page's MAIN world) to capture the audio bytes,
// then hands them to the extension's offscreen document, where a local
// Whisper model produces the transcript. The transcript is shown directly
// underneath the voice player, inside the chat bubble.

(() => {
  'use strict';

  const VERSION = '1.4.0';

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
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M7 5H3"/></svg>';

  const pending = new Map(); // requestId -> { bubble, ui, lastActivity }
  let requestCounter = 0;
  let attachedCount = 0;
  let captureInFlight = false;
  let isInitialized = false; // Prevents auto-transcribing historical messages on load

  const ENABLED_CHATS_KEY = 'wvt_enabled_chats';
  let enabledChats = new Set();

  // Load enabled chats from storage on startup
  chrome.storage.local.get(ENABLED_CHATS_KEY).then(data => {
    if (data[ENABLED_CHATS_KEY]) {
      enabledChats = new Set(data[ENABLED_CHATS_KEY]);
      log('Loaded enabled chats:', [...enabledChats]);
    }
  }).catch(() => {});

  function saveEnabledChats() {
    chrome.storage.local.set({ [ENABLED_CHATS_KEY]: [...enabledChats] }).catch(() => {});
  }

  function getActiveChatId() {
    // WhatsApp stores the chat id in the header or conversation panel
    const header = document.querySelector('#main header');
    if (!header) return null;
    // Try to get the chat title text as a stable identifier
    const titleSpan = header.querySelector('span[dir="auto"][title]');
    if (titleSpan) return titleSpan.getAttribute('title');
    const titleText = header.querySelector('span[dir="auto"]');
    if (titleText) return titleText.textContent.trim();
    return null;
  }

  function isChatEnabled() {
    const chatId = getActiveChatId();
    return chatId && enabledChats.has(chatId);
  }

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
    const dirClass = outgoing ? 'wvt-out' : 'wvt-in';

    // AI sparkles button.
    const button = document.createElement('button');
    button.className = 'wvt-btn ' + dirClass;
    button.type = 'button';
    button.setAttribute('aria-label', 'Transcribe');
    button.title = 'Transcribe locally (audio never leaves your browser)';
    button.innerHTML = ICON_SVG;

    // Place the button inside the voice controls row (the flex container that
    // holds the play button and the waveform slider) so it sits right next to
    // the waveform.  Walk up from the play button until we find an ancestor
    // that also contains the waveform slider.
    let buttonHost = null;
    const playBtn = bubble.querySelector(
      'button[aria-label*="lay voice"], button[aria-label*="lay audio"]'
    );
    if (playBtn) {
      let el = playBtn.parentElement;
      for (let i = 0; i < 10 && el && el !== bubble; i++) {
        if (el.querySelector('[role="slider"]')) {
          buttonHost = el;
          break;
        }
        el = el.parentElement;
      }
    }
    if (!buttonHost) {
      buttonHost =
        bubble.querySelector('[data-testid="msg-container"]') || bubble;
    }
    buttonHost.prepend(button);

    // Small inline status/error text (inside the msg-container).
    const msgContainer =
      bubble.querySelector('[data-testid="msg-container"]') || bubble;
    const output = document.createElement('div');
    output.className = 'wvt-output';
    output.hidden = true;
    msgContainer.appendChild(output);

    return { wrap: null, button, output };
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

  // --------------------------------------------------------- modal

  function showResultModal(text) {
    // Remove any existing modal.
    const existing = document.querySelector('.wvt-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'wvt-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'wvt-modal';

    // Header.
    const header = document.createElement('div');
    header.className = 'wvt-modal-header';
    const title = document.createElement('div');
    title.className = 'wvt-modal-title';
    title.innerHTML = ICON_SVG + '<span>Voice Transcription</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'wvt-modal-close';
    closeBtn.type = 'button';
    closeBtn.innerHTML = '&#10005;';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body.
    const body = document.createElement('div');
    body.className = 'wvt-modal-body';
    body.textContent = text;

    // Footer.
    const footer = document.createElement('div');
    footer.className = 'wvt-modal-footer';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'wvt-modal-copy';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy to Clipboard';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied \u2713';
        copyBtn.classList.add('wvt-copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy to Clipboard';
          copyBtn.classList.remove('wvt-copied');
        }, 2000);
      }).catch(() => {
        // Fallback: select text so user can Ctrl-C.
        const range = document.createRange();
        range.selectNodeContents(body);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });
    footer.appendChild(copyBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    // Close on overlay click or Escape.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
  }

  // -------------------------------------------------------- result / error

  function showResult(ui, text, autoOpen) {
    if (autoOpen === undefined) autoOpen = true;
    ui.output.hidden = true;
    ui.output.classList.remove('wvt-status', 'wvt-error');
    setWorking(ui, false);

    // Mark button as "done" — transcript available, click to re-view.
    ui.button.classList.add('wvt-done');
    ui.button.title = 'View transcription';
    ui.button.disabled = false;
    ui.button.dataset.wvtTranscript = text;

    if (autoOpen) showResultModal(text);
  }

  function showError(ui, text) {
    ui.output.hidden = false;
    ui.output.classList.remove('wvt-status');
    ui.output.classList.add('wvt-error');
    ui.output.textContent = text;
    setWorking(ui, false);
    ui.button.title = 'Retry transcription';
  }

  async function onTranscribeClick(bubble, ui, autoOpenModal = true) {
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

      pending.set(requestId, { bubble, ui, lastActivity: Date.now(), autoOpen: autoOpenModal });
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
    
    // Ignore the user's own outgoing voice messages
    if (isOutgoingMessage(bubble, control)) {
      bubble.dataset.wvtAttached = '1';
      return;
    }

    // Only attach if transcription is enabled for this chat
    if (!isChatEnabled()) return;
    
    bubble.dataset.wvtAttached = '1';
    attachedCount++;

    const ui = createUi(bubble, control);

    // Universal click handler: if a transcript is stored on the button open
    // the modal; otherwise start a new transcription.
    ui.button.addEventListener('click', () => {
      if (ui.button.dataset.wvtTranscript) {
        showResultModal(ui.button.dataset.wvtTranscript);
      } else {
        onTranscribeClick(bubble, ui);
      }
    });

    // Restore a previously saved transcript for this message, if any.
    const key = messageKey(bubble);
    let alreadyTranscribed = false;
    if (key) {
      try {
        const stored = await chrome.storage.local.get(key);
        if (stored && stored[key]) {
          showResult(ui, stored[key], false); // don't auto-open modal
          alreadyTranscribed = true;
        }
      } catch (e) {
        /* storage unavailable - ignore */
      }
    }

    if (!alreadyTranscribed && isInitialized) {
      // Check if it's a genuinely new message by seeing if it's near the bottom of the DOM list
      const row = bubble.closest('div[role="row"]');
      if (row && row.parentElement) {
        const rows = Array.from(row.parentElement.children);
        const index = rows.indexOf(row);
        // If it's one of the last few rows, it's a new message (not scrolled history)
        if (index >= rows.length - 5) {
          // Wait a second for WhatsApp to finish rendering the audio element before capturing
          setTimeout(() => {
            if (!ui.button.disabled && !ui.button.classList.contains('wvt-done')) {
              onTranscribeClick(bubble, ui, false); // auto-transcribe without auto-opening modal
            }
          }, 1500);
        }
      }
    }
  }

  // --------------------------------------------------------------- exporting

  function getScrollContainer() {
    const firstRow = document.querySelector('#main div[role="row"]');
    if (!firstRow) return null;
    let el = firstRow.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'scroll' || style.overflowY === 'auto') {
        return el;
      }
      el = el.parentElement;
    }
    return firstRow.parentElement;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A span whose entire text is a clock time, e.g. "2:25 PM" or "14:25".
  const TIME_TEXT_RE = /^\d{1,2}:\d{2}(\s?[APap]\.?\s?[Mm]\.?)?$/;
  const TIME_IN_TEXT_RE = /\d{1,2}:\d{2}(\s?[APap]\.?\s?[Mm]\.?)?/;

  function rowDataId(row) {
    if (row.hasAttribute('data-id')) return row.getAttribute('data-id');
    const holder = row.querySelector('[data-id]');
    return holder ? holder.getAttribute('data-id') : null;
  }

  // Parse WhatsApp's metadata attribute: "[7:12 PM, 7/21/2026] Some Name: ".
  // Returns null for anything else (list items carry data-pre-plain-text
  // values like "- " or "1. ", which must not be mistaken for metadata).
  function parsePrePlainText(pre) {
    const m = /^\[([^,\]]+),\s*([^\]]+)\]\s*(.*?):\s*$/.exec(pre || '');
    if (!m) return null;
    return { time: m[1].trim(), date: m[2].trim(), sender: m[3].trim() };
  }

  function rowPrePlainMeta(row) {
    for (const el of row.querySelectorAll('[data-pre-plain-text]')) {
      const parsed = parsePrePlainText(el.getAttribute('data-pre-plain-text'));
      if (parsed) return parsed;
    }
    return null;
  }

  // Message time for rows that have no data-pre-plain-text (voice notes,
  // images, documents...). The bubble's meta area holds the timestamp.
  function rowTime(row) {
    const meta = row.querySelector('[data-testid="msg-meta"]');
    if (meta) {
      const m = (meta.textContent || '').match(TIME_IN_TEXT_RE);
      if (m) return m[0];
    }
    // Fallback: the last leaf span that contains only a time. (The timestamp
    // renders after the message content, so a voice note's duration like
    // "0:51" is overwritten by the real time.)
    let found = null;
    for (const sp of row.querySelectorAll('span')) {
      if (sp.children.length || isOurUi(sp)) continue;
      const t = (sp.textContent || '').trim();
      if (TIME_TEXT_RE.test(t)) found = t;
    }
    return found;
  }

  function isRowOutgoing(row) {
    if (row.querySelector('.message-out')) return true;
    if (row.querySelector('.message-in')) return false;
    if (row.querySelector('span[data-icon="tail-out"]')) return true;
    if (row.querySelector('span[data-icon="tail-in"]')) return false;
    // Delivery ticks (sent/delivered/read) render only on outgoing bubbles.
    if (row.querySelector('[data-testid="msg-meta"] span[aria-label] svg')) return true;
    // Geometry: outgoing bubbles sit in the right half of the chat panel.
    const bubble =
      row.querySelector('[data-testid="msg-container"]') ||
      row.querySelector('[data-id]') ||
      row;
    const rect = bubble.getBoundingClientRect();
    const panel = (row.closest('#main') || document.body).getBoundingClientRect();
    return (rect.left + rect.right) / 2 > panel.left + panel.width / 2;
  }

  // The clickable quoted-reply box inside a message bubble, if any.
  function findQuoteBox(row) {
    const mention = row.querySelector('.quoted-mention');
    if (mention) {
      let el = mention.parentElement;
      while (el && el !== row) {
        if (
          el.getAttribute('role') === 'button' ||
          /quoted/i.test(el.getAttribute('aria-label') || '')
        ) {
          return el;
        }
        el = el.parentElement;
      }
      return mention;
    }
    return row.querySelector('[aria-label*="Quoted" i], [data-testid="quoted-message"]');
  }

  function quotePreview(quoteBox) {
    const lines = (quoteBox.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    let sender = null;
    let text = lines.join(' ');
    if (lines.length > 1) {
      sender = lines[0];
      text = lines.slice(1).join(' ');
    }
    if (text.length > 150) text = text.slice(0, 147) + '…';
    return sender ? `${sender}: ${text}` : text;
  }

  function isReadMoreButton(el) {
    if (el.classList.contains('read-more-button')) return true;
    if (/read-more/i.test(el.getAttribute('data-testid') || '')) return true;
    const label = (el.textContent || '').trim().toLowerCase();
    return label === 'read more' || label === 'show more';
  }

  function findReadMoreButtons(scope) {
    const buttons = new Set();
    const selector = scope
      ? '.read-more-button, [role="button"]'
      : '#main div[role="row"] .read-more-button, #main div[role="row"] [role="button"]';
    for (const el of (scope || document).querySelectorAll(selector)) {
      if (isOurUi(el)) continue;
      if (isReadMoreButton(el)) buttons.add(el);
    }
    return [...buttons];
  }

  // Click every visible "Read more" until none is left (or clicks stop
  // having an effect), so long messages are exported in full.
  async function expandReadMores() {
    let lastCount = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
      const buttons = findReadMoreButtons();
      if (buttons.length === 0 || buttons.length >= lastCount) return;
      lastCount = buttons.length;
      for (const btn of buttons) btn.click();
      await sleep(300);
    }
  }

  // Plain text of a message body: keeps WhatsApp's literal newlines, list
  // markers (each list item span carries its "- " / "1. " prefix in
  // data-pre-plain-text) and emoji (rendered as <img alt="...">), and skips
  // clickable widgets ("Read more", quote boxes, link previews) and our UI.
  function extractRichText(root) {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue) parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName.toUpperCase();
      if (tag === 'BR') {
        parts.push('\n');
        return;
      }
      if (tag === 'IMG') {
        const alt = el.getAttribute('data-plain-text') || el.getAttribute('alt');
        if (alt) parts.push(alt);
        return;
      }
      if (tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE') return;
      if (el !== root) {
        if (isOurUi(el)) return;
        if (el.getAttribute('role') === 'button' || isReadMoreButton(el)) return;
      }
      const isBlock = /^(DIV|P|LI|UL|OL|BLOCKQUOTE)$/.test(tag);
      if (isBlock && parts.length && !parts[parts.length - 1].endsWith('\n')) {
        parts.push('\n');
      }
      const pre = el.getAttribute('data-pre-plain-text');
      if (pre && el !== root && !parsePrePlainText(pre)) parts.push(pre);
      for (const child of el.childNodes) walk(child);
      if (isBlock && parts.length && !parts[parts.length - 1].endsWith('\n')) {
        parts.push('\n');
      }
    };
    walk(root);
    return parts
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // The outermost selectable-text span holding the message body (its nested
  // spans/strongs/list items are fragments of the same text). Quoted-reply
  // previews, link previews and the meta area are excluded.
  function findMessageTextRoot(row, quoteBox) {
    const container = row.querySelector('div.copyable-text[data-pre-plain-text]') || row;
    let best = null;
    for (const span of container.querySelectorAll('span.selectable-text')) {
      if (isOurUi(span)) continue;
      if (quoteBox && quoteBox.contains(span)) continue;
      if (span.closest('[data-testid="msg-meta"]')) continue;
      if (span.parentElement && span.parentElement.closest('span.selectable-text')) continue;
      let clickable = false;
      for (let el = span.parentElement; el && el !== container; el = el.parentElement) {
        if (el.getAttribute('role') === 'button') {
          clickable = true;
          break;
        }
      }
      if (clickable) continue;
      best = span; // keep the last candidate: quote previews render first
    }
    return best;
  }

  // First match for selector inside row that is NOT part of the quoted-reply
  // preview (a quote of a voice/image message renders mic icons and
  // thumbnails that must not classify the quoting message itself).
  function queryOutsideQuote(row, selector, quoteBox) {
    for (const el of row.querySelectorAll(selector)) {
      if (quoteBox && quoteBox.contains(el)) continue;
      return el;
    }
    return null;
  }

  function isVoiceRow(row, quoteBox) {
    if (
      queryOutsideQuote(
        row,
        '[data-testid="audio-play"], [data-testid="audio-pause"], [data-testid="audio-download"]',
        quoteBox
      )
    ) {
      return true;
    }
    if (
      queryOutsideQuote(
        row,
        '[aria-label="Voice message"], [aria-label="Voice note progress slider"]',
        quoteBox
      )
    ) {
      return true;
    }
    return findVoiceControls(row).some((el) => !quoteBox || !quoteBox.contains(el));
  }

  async function findVoiceTranscript(row, dataId) {
    const btn = row.querySelector('.wvt-btn');
    if (btn && btn.dataset.wvtTranscript) return btn.dataset.wvtTranscript;
    const out = row.querySelector('.wvt-output');
    if (
      out &&
      !out.hidden &&
      !out.classList.contains('wvt-status') &&
      !out.classList.contains('wvt-error') &&
      out.textContent.trim()
    ) {
      return out.textContent.trim();
    }
    if (dataId) {
      try {
        const key = STORAGE_PREFIX + dataId;
        const stored = await chrome.storage.local.get(key);
        if (stored && stored[key]) return stored[key];
      } catch (e) {
        /* storage unavailable - ignore */
      }
    }
    return null;
  }

  function mediaLabel(row, quoteBox) {
    if (
      queryOutsideQuote(row, 'span[data-icon^="document-"], [data-testid="document-thumb"]', quoteBox)
    ) {
      return '[Document]';
    }
    if (queryOutsideQuote(row, '[data-testid="image-thumb"], [aria-label="Open picture"]', quoteBox)) {
      return '[Image]';
    }
    if (queryOutsideQuote(row, '[data-testid="video-thumb"], [aria-label="Play video"]', quoteBox)) {
      return '[Video]';
    }
    if (queryOutsideQuote(row, 'img[src^="blob:"]', quoteBox)) return '[Image/Media]';
    return null;
  }

  async function handleExportChat(format = 'txt') {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) {
      alert('Could not find scroll container.');
      return;
    }

    const initialRows = Array.from(document.querySelectorAll('#main div[role="row"]'));
    if (initialRows.length === 0) {
      alert('No messages found.');
      return;
    }

    let targetDateStr = null;
    for (let i = initialRows.length - 1; i >= 0; i--) {
      const meta = rowPrePlainMeta(initialRows[i]);
      if (meta) {
        targetDateStr = meta.date;
        break;
      }
    }

    if (!targetDateStr) {
      alert("Could not determine today's date from visible messages.");
      return;
    }

    const extractedMessageIds = new Set();
    const allChunks = [];
    // Sender names by direction, learned from rows that carry
    // data-pre-plain-text, then reused for rows that don't (voice notes,
    // media). incomingNames guards against misattribution in group chats.
    const senderNames = { in: null, out: null };
    const incomingNames = new Set();
    const chatTitle = getActiveChatId();

    async function extractVisible() {
      await expandReadMores();

      const rows = Array.from(document.querySelectorAll('#main div[role="row"]'));

      // Pass 1: metadata + date inference. Rows without their own metadata
      // (media, voice notes) inherit the date of the nearest dated row above
      // them (messages are chronological); leading rows fall back to the
      // nearest dated row below.
      const infos = [];
      for (const row of rows) {
        const pre = rowPrePlainMeta(row);
        infos.push({ row, dataId: rowDataId(row), pre, date: pre ? pre.date : null });
        if (pre) {
          const outgoing = isRowOutgoing(row);
          senderNames[outgoing ? 'out' : 'in'] = pre.sender;
          if (!outgoing) incomingNames.add(pre.sender);
        }
      }
      let lastDate = null;
      for (const info of infos) {
        if (info.date) lastDate = info.date;
        else info.date = lastDate;
      }
      let nextDate = null;
      for (let i = infos.length - 1; i >= 0; i--) {
        if (infos[i].date) nextDate = infos[i].date;
        else infos[i].date = nextDate;
      }

      // Pass 2: extraction.
      let reachedOlder = false;
      const chunk = [];
      for (const info of infos) {
        const { dataId, pre } = info;
        let row = info.row;
        if (!dataId) continue; // date dividers, system rows
        if (info.date && info.date !== targetDateStr) {
          reachedOlder = true;
          continue;
        }
        if (extractedMessageIds.has(dataId)) continue;

        // Last-chance expansion if this row is still truncated. Expanding
        // can re-render the row, so re-locate it by id if it got detached.
        const rowReadMores = findReadMoreButtons(row);
        if (rowReadMores.length > 0) {
          for (const btn of rowReadMores) btn.click();
          await sleep(350);
          if (!row.isConnected) {
            const holder = document.querySelector(
              `#main [data-id="${CSS.escape(dataId)}"]`
            );
            if (!holder) continue; // gone; a later pass may pick it up
            row = holder.closest('div[role="row"]') || holder;
          }
        }

        const outgoing = isRowOutgoing(row);
        const time = pre ? pre.time : rowTime(row);
        const date = pre ? pre.date : info.date || targetDateStr;
        let sender = pre ? pre.sender : null;
        if (!sender) {
          if (outgoing) {
            sender = senderNames.out || 'You';
          } else if (senderNames.in && incomingNames.size <= 1) {
            sender = senderNames.in;
          } else {
            sender = chatTitle || 'Unknown Sender';
          }
        }

        const parts = [];
        const quoteBox = findQuoteBox(row);
        if (quoteBox) {
          const preview = quotePreview(quoteBox);
          if (preview) parts.push(`[Replying to ${preview}]`);
        }

        if (isVoiceRow(row, quoteBox)) {
          // Voice notes carry no caption text of their own; any selectable
          // text inside the row belongs to the quoted preview.
          const transcript = await findVoiceTranscript(row, dataId);
          parts.push(
            transcript
              ? `[Voice Message Transcript]: ${transcript}`
              : '[Voice Message - Not Transcribed]'
          );
        } else {
          const media = mediaLabel(row, quoteBox);
          if (media) parts.push(media);
          const textRoot = findMessageTextRoot(row, quoteBox);
          if (textRoot) {
            const text = extractRichText(textRoot);
            if (text) parts.push(text);
          }
        }

        extractedMessageIds.add(dataId);
        if (parts.length > 0) {
          chunk.push({
            time: time || null,
            date,
            sender,
            outgoing,
            text: parts.join('\n'),
          });
        }
      }

      if (chunk.length > 0) {
        allChunks.unshift(chunk); // prepend: later passes hold older messages
      }
      return reachedOlder;
    }

    let prevScrollTop = scrollContainer.scrollTop;
    let stuckCount = 0;

    // Extract what's on screen first
    await extractVisible();

    // Scroll up loop
    while (true) {
      scrollContainer.scrollTop -= scrollContainer.clientHeight * 0.5;
      await sleep(300); // wait for DOM to update

      const reachedOlder = await extractVisible();
      if (reachedOlder) break;

      if (scrollContainer.scrollTop === prevScrollTop || scrollContainer.scrollTop === 0) {
        stuckCount++;
        if (stuckCount > 3) break;
      } else {
        stuckCount = 0;
      }
      prevScrollTop = scrollContainer.scrollTop;

      if (extractedMessageIds.size > 5000) break; // safety limit
    }

    // Scroll back to bottom for user convenience
    scrollContainer.scrollTop = scrollContainer.scrollHeight;

    const finalMessages = allChunks.flat();
    if (finalMessages.length === 0) {
      alert('No messages extracted.');
      return;
    }

    const metaOf = (m) =>
      m.time ? `[${m.time}, ${m.date}] ${m.sender}: ` : `[${m.date}] ${m.sender}: `;

    let output = '';
    let mimeType = 'text/plain';

    if (format === 'json') {
      output = JSON.stringify(
        {
          exportDate: targetDateStr,
          chat: chatTitle || null,
          messages: finalMessages.map((m) => ({
            meta: metaOf(m).trim(),
            sender: m.sender,
            time: m.time,
            date: m.date,
            fromMe: m.outgoing,
            text: m.text,
          })),
        },
        null,
        2
      );
      mimeType = 'application/json';
    } else if (format === 'csv') {
      const escapeCsv = (str) => `"${String(str).replace(/"/g, '""')}"`;
      output = 'Metadata,Message\n';
      for (const msg of finalMessages) {
        output += `${escapeCsv(metaOf(msg).trim())},${escapeCsv(msg.text)}\n`;
      }
      mimeType = 'text/csv';
    } else {
      output = `WhatsApp Chat Export - ${targetDateStr}\n\n`;
      for (const msg of finalMessages) {
        output += `${metaOf(msg)}${msg.text}\n`;
      }
    }

    const blob = new Blob([output], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `WhatsApp_Export_${targetDateStr.replace(/\//g, '-')}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --------------------------------------------------------- chat toggle

  const TOGGLE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M7 5H3"/></svg>';

  function updateToggleLabel(btn, enabled) {
    btn.innerHTML = TOGGLE_SVG + '<span>' + (enabled ? 'Transcribe ON' : 'Transcribe OFF') + '</span>';
    btn.title = enabled ? 'Click to disable voice transcription for this chat' : 'Click to enable voice transcription for this chat';
    btn.classList.toggle('wvt-toggle-on', enabled);
    btn.classList.toggle('wvt-toggle-off', !enabled);
  }

  function injectChatToggle() {
    const header = document.querySelector('#main header');
    if (!header) return;

    // Remove stale toggle if the chat changed
    const existing = header.querySelector('.wvt-chat-toggle');
    const chatId = getActiveChatId();
    if (existing && existing.dataset.wvtChatId !== chatId) {
      existing.remove();
    }
    if (header.querySelector('.wvt-chat-toggle')) return; // already injected for this chat
    if (!chatId) return;

    const enabled = enabledChats.has(chatId);

    const btn = document.createElement('button');
    btn.className = 'wvt-chat-toggle';
    btn.dataset.wvtChatId = chatId;
    btn.type = 'button';
    updateToggleLabel(btn, enabled);

    btn.addEventListener('click', () => {
      const id = btn.dataset.wvtChatId;
      if (enabledChats.has(id)) {
        enabledChats.delete(id);
        updateToggleLabel(btn, false);
        log('Transcription disabled for:', id);
      } else {
        enabledChats.add(id);
        updateToggleLabel(btn, true);
        log('Transcription enabled for:', id);
        // Reset attached flags so voice messages get picked up on next scan
        for (const bubble of document.querySelectorAll('[data-wvt-attached]')) {
          if (!bubble.querySelector('.wvt-btn')) {
            delete bubble.dataset.wvtAttached;
          }
        }
      }
      saveEnabledChats();
    });

    // Insert right after the contact name / title area
    const titleContainer = header.querySelector('div[role="button"]') || header.firstElementChild;
    if (titleContainer && titleContainer.parentElement === header) {
      titleContainer.after(btn);
    } else {
      header.appendChild(btn);
    }
  }

  // --------------------------------------------------------------- scanning

  function scan() {
    // WhatsApp re-renders parts of message rows (e.g. when playback state
    // changes), which can destroy our injected UI while the bubble keeps its
    // attached flag. Detect that and allow re-attachment.
    for (const bubble of document.querySelectorAll('[data-wvt-attached]')) {
      if (!bubble.querySelector('.wvt-btn') && !bubble.querySelector('.wvt-output')) {
        delete bubble.dataset.wvtAttached;
      }
    }

    injectChatToggle();

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
    
    if (message.type === 'export_chat_today') {
      handleExportChat(message.format || 'txt');
      return;
    }

    const entry = pending.get(message.requestId);
    if (!entry) return;

    if (message.type === 'progress') {
      entry.lastActivity = Date.now();
      showStatus(entry.ui, message.text);
    } else if (message.type === 'result') {
      pending.delete(message.requestId);
      showResult(entry.ui, message.text, entry.autoOpen);
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

    // After 5 seconds, assume all historical messages are loaded. Any new
    // messages found after this at the bottom of the chat will be auto-transcribed.
    setTimeout(() => {
      isInitialized = true;
    }, 5000);

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
