// Service worker: routes messages between the WhatsApp Web content script
// and the offscreen document that runs the local Whisper model.

const OFFSCREEN_URL = 'offscreen.html';

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification:
          'Runs a local (on-device) Whisper speech-recognition model in WASM to transcribe voice messages. No data is sent to any server.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// The offscreen document registers its message listener only after its
// (fairly large) module script has loaded, which can be after createDocument()
// resolves. Retry until the listener exists.
async function sendToOffscreen(message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await chrome.runtime.sendMessage(message);
      return;
    } catch (err) {
      if (!/Receiving end does not exist/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('The transcription engine did not start in time.');
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object') return;

  // Content script -> offscreen: transcription request
  if (message.target === 'background' && message.type === 'transcribe') {
    const tabId = sender.tab && sender.tab.id;
    ensureOffscreenDocument()
      .then(() => sendToOffscreen({ ...message, target: 'offscreen', tabId }))
      .catch((err) => {
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, {
            target: 'content',
            type: 'error',
            requestId: message.requestId,
            error: 'Could not start the transcription engine: ' + err.message,
          });
        }
      });
    return;
  }

  // Offscreen -> content script: progress updates and results
  if (message.target === 'content' && message.tabId != null) {
    chrome.tabs.sendMessage(message.tabId, message).catch(() => {
      // Tab was closed or navigated away; nothing to do.
    });
  }
});
