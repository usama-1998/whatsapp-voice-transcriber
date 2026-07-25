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

  async function handleExportChat(format = 'txt') {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) {
      alert("Could not find scroll container.");
      return;
    }

    const initialRows = Array.from(document.querySelectorAll('#main div[role="row"]'));
    if (initialRows.length === 0) {
      alert("No messages found.");
      return;
    }
    
    let targetDateStr = null;
    for (let i = initialRows.length - 1; i >= 0; i--) {
      const copyable = initialRows[i].querySelector('[data-pre-plain-text]');
      if (copyable) {
        const match = copyable.getAttribute('data-pre-plain-text').match(/,\s(.*?)]/);
        if (match) {
          targetDateStr = match[1];
          break;
        }
      }
    }

    if (!targetDateStr) {
      alert("Could not determine today's date from visible messages.");
      return;
    }

    const extractedMessageIds = new Set();
    const allChunks = [];

    function extractVisible() {
      let reachedOlder = false;
      const rows = Array.from(document.querySelectorAll('#main div[role="row"]'));
      const chunk = [];
      
      for (const row of rows) {
        let meta = '';
        const copyable = row.querySelector('[data-pre-plain-text]');
        if (copyable) meta = copyable.getAttribute('data-pre-plain-text');
        
        let msgDateStr = null;
        if (meta) {
          const match = meta.match(/,\s(.*?)]/);
          if (match) msgDateStr = match[1];
        }

        if (msgDateStr && msgDateStr !== targetDateStr) {
          reachedOlder = true;
          continue; 
        }

        const msgIdNode = row.querySelector('[data-id]') || row;
        const dataId = msgIdNode.getAttribute('data-id');
        if (!dataId) continue;

        if (extractedMessageIds.has(dataId)) continue; // Already extracted

        let text = '';
        const wvtBtn = row.querySelector('.wvt-btn');
        if (wvtBtn) {
          const transcript = wvtBtn.dataset.wvtTranscript;
          text = transcript ? `[Voice Message Transcript]: ${transcript}` : `[Voice Message - Not Transcribed]`;
        } else {
          const spans = row.querySelectorAll('span.selectable-text.copyable-text');
          if (spans.length > 0) {
            text = spans[spans.length - 1].innerText;
          } else if (row.querySelector('img')) {
            text = `[Image/Media]`;
          }
        }

        if (meta || text) {
          extractedMessageIds.add(dataId);
          chunk.push({ meta: meta || '[Unknown Time] Unknown Sender: ', text: text || '' });
        }
      }
      
      if (chunk.length > 0) {
        allChunks.unshift(chunk); // Prepend older chunk
      }
      return reachedOlder;
    }

    let prevScrollTop = scrollContainer.scrollTop;
    let stuckCount = 0;
    
    // Extract what's on screen first
    extractVisible();

    // Scroll up loop
    while (true) {
      scrollContainer.scrollTop -= (scrollContainer.clientHeight * 0.5);
      await new Promise(r => setTimeout(r, 300)); // wait for DOM to update
      
      const reachedOlder = extractVisible();
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
      alert("No messages extracted.");
      return;
    }

    let output = '';
    let mimeType = 'text/plain';

    if (format === 'json') {
      output = JSON.stringify({
        exportDate: targetDateStr,
        messages: finalMessages.map(m => ({ meta: m.meta.trim(), text: m.text }))
      }, null, 2);
      mimeType = 'application/json';
    } else if (format === 'csv') {
      const escapeCsv = (str) => `"${str.replace(/"/g, '""')}"`;
      output = 'Metadata,Message\n';
      for (const msg of finalMessages) {
        output += `${escapeCsv(msg.meta.trim())},${escapeCsv(msg.text)}\n`;
      }
      mimeType = 'text/csv';
    } else {
      output = `WhatsApp Chat Export - ${targetDateStr}\n\n`;
      for (const msg of finalMessages) {
        output += `${msg.meta}${msg.text}\n`;
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
