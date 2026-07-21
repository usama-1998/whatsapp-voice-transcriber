// Runs in the page's MAIN world at document_start, before WhatsApp's own
// code loads. WhatsApp plays voice notes through a detached media element
// that never appears in the DOM, so the only reliable way to reach the audio
// is to hook the web APIs it must go through:
//
//   1. HTMLMediaElement.play()  - catches the (detached) <audio> element the
//      moment playback starts, so we can grab its blob src and immediately
//      mute + pause it again.
//   2. URL.createObjectURL()    - keeps a reference to every Blob turned into
//      a blob: URL (the decrypted voice note), surviving URL revocation.
//   3. decodeAudioData()        - fallback capture of the raw compressed
//      bytes in case playback ever moves to the Web Audio API.
//
// Communication with the extension's content script happens via
// window.postMessage. Everything stays inside this tab.

(() => {
  'use strict';

  if (window.__wvtInjected) return;
  window.__wvtInjected = true;

  const MAX_REGISTRY = 120;
  const blobRegistry = new Map(); // blob URL -> Blob

  // --- hook 2: createObjectURL -------------------------------------------
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL(obj);
    try {
      if (obj instanceof Blob) {
        blobRegistry.set(url, obj);
        if (blobRegistry.size > MAX_REGISTRY) {
          blobRegistry.delete(blobRegistry.keys().next().value);
        }
      }
    } catch (e) {
      /* never break the page */
    }
    return url;
  };

  // --- hook 3: decodeAudioData -------------------------------------------
  let lastDecoded = null; // { buffer: ArrayBuffer, time: number }
  try {
    const proto = (window.BaseAudioContext || window.AudioContext).prototype;
    const origDecode = proto.decodeAudioData;
    proto.decodeAudioData = function (buffer, ...rest) {
      try {
        if (buffer && buffer.byteLength > 512) {
          lastDecoded = { buffer: buffer.slice(0), time: Date.now() };
        }
      } catch (e) {
        /* ignore */
      }
      return origDecode.call(this, buffer, ...rest);
    };
  } catch (e) {
    /* ignore */
  }

  // --- hook 1: HTMLMediaElement.play -------------------------------------
  let lastMedia = null;
  let armed = null; // { id, timer }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    lastMedia = this;
    if (armed) {
      const wasMuted = this.muted;
      // Mute before playback becomes audible; restored after we pause.
      try {
        this.muted = true;
      } catch (e) {
        /* ignore */
      }
      const result = origPlay.apply(this, args);
      settleCapture(this, wasMuted);
      return result;
    }
    return origPlay.apply(this, args);
  };

  // ----------------------------------------------------------- messaging

  function send(msg) {
    window.postMessage({ __wvt: true, ...msg }, window.location.origin);
  }

  async function blobFromSrc(src) {
    if (!src) return null;
    if (blobRegistry.has(src)) return blobRegistry.get(src);
    try {
      const response = await fetch(src);
      if (response.ok) return await response.blob();
    } catch (e) {
      /* revoked blob URL etc. */
    }
    return null;
  }

  async function deliver(id, blob) {
    try {
      const buffer = await blob.arrayBuffer();
      send({ type: 'WVT_AUDIO', id, buffer });
    } catch (e) {
      send({ type: 'WVT_ERROR', id, error: 'Failed to read audio data: ' + e.message });
    }
  }

  async function settleCapture(media, restoreMuted) {
    const req = armed;
    if (!req) return;
    armed = null;
    clearTimeout(req.timer);

    // Stop playback again almost immediately (a short delay lets WhatsApp
    // finish wiring the element so pause() sticks and events stay in sync).
    setTimeout(() => {
      try {
        media.pause();
        media.currentTime = 0;
      } catch (e) {
        /* ignore */
      }
      setTimeout(() => {
        try {
          media.muted = restoreMuted;
        } catch (e) {
          /* ignore */
        }
      }, 250);
    }, 60);

    const src = media.currentSrc || media.src;
    const blob = await blobFromSrc(src);
    if (blob) {
      deliver(req.id, blob);
    } else {
      fallbackFinish(req.id);
    }
  }

  function fallbackFinish(id) {
    // Recently decoded compressed audio (Web Audio path)?
    if (lastDecoded && Date.now() - lastDecoded.time < 20000) {
      send({ type: 'WVT_AUDIO', id, buffer: lastDecoded.buffer.slice(0) });
      return;
    }
    // Most recent audio-typed blob WhatsApp created?
    const candidates = [...blobRegistry.values()].reverse();
    const audioBlob = candidates.find((b) =>
      /audio|ogg|opus|mpeg|mp4|webm/i.test(b.type || '')
    );
    if (audioBlob) {
      deliver(id, audioBlob);
      return;
    }
    send({
      type: 'WVT_ERROR',
      id,
      error: 'Could not capture the audio (no media playback detected).',
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__wvt !== true || msg.type !== 'WVT_ARM') return;

    if (armed) {
      clearTimeout(armed.timer);
      send({ type: 'WVT_ERROR', id: armed.id, error: 'Superseded by a new request.' });
    }
    armed = {
      id: msg.id,
      timer: setTimeout(() => {
        const req = armed;
        armed = null;
        if (req) fallbackFinish(req.id);
      }, 7000),
    };

    // If this voice note is already playing, there is no upcoming play()
    // call to intercept - capture the currently playing element directly.
    if (msg.expectPlaying && lastMedia && !lastMedia.paused) {
      settleCapture(lastMedia, lastMedia.muted);
    }
  });
})();
