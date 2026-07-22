# WhatsApp Voice Transcriber (Local)

A Chrome extension that transcribes voice messages on **WhatsApp Web** and displays
the text **in a clean modal overlay**, with a magical AI button right next to the voice player.

Speech recognition runs **100% locally in your browser** using OpenAI's Whisper
model via [transformers.js](https://github.com/xenova/transformers.js) (ONNX
runtime compiled to WebAssembly).

- No paid APIs, no API keys.
- Your audio is **never** uploaded anywhere — decoding and transcription happen
  entirely on your machine.
- Works with voice notes in any language Whisper supports (the language is
  auto-detected).
- Transcripts are cached locally, so a message you already transcribed shows its
  text again instantly after a page reload.

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this repository's folder.
5. Open (or reload) [web.whatsapp.com](https://web.whatsapp.com).

## Usage

1. Open a chat that contains a voice message.
2. A magical **AI sparkles** icon appears right next to the voice message player controls.
3. Click it. The first time ever, the extension downloads the Whisper model
   (~250 MB, one time only — it is cached by the browser afterwards).
4. The transcript opens in a premium modal overlay, making it easy to read.
5. You can also easily copy the transcript using the **Copy to Clipboard** button in the modal.

Notes:

- If the voice message hasn't been loaded by WhatsApp yet, the extension
  briefly starts playback **muted** to obtain the audio, then stops it again.
- Transcription speed depends on your CPU. A typical 30-second voice note takes
  a few seconds with the default model.

## Privacy

| Data | Where it goes |
| --- | --- |
| Voice message audio | Stays in your browser. Decoded and transcribed locally in WASM. |
| Transcripts | Stored only in the extension's local storage on your machine. |
| Model files | Downloaded **once** from the Hugging Face CDN (this is a download of the neural network weights, not an upload of any of your data), then cached locally. |

The extension requests no host permissions beyond running its content script on
`web.whatsapp.com`.

## Choosing a different model

The default is `Xenova/whisper-small` (best accuracy, ~250 MB). To change it,
edit `MODEL_ID` in `offscreen.js`:

| Model | Size | Notes |
| --- | --- | --- |
| `Xenova/whisper-tiny` | ~40 MB | Fastest, lower accuracy |
| `Xenova/whisper-base` | ~80 MB | Good balance of speed and accuracy |
| `Xenova/whisper-small` | ~250 MB | Default, best accuracy, slower |
| `Xenova/whisper-base.en` | ~80 MB | English-only, slightly better for English |

After editing, click **Reload** on the extension in `chrome://extensions`.

## How it works

```
WhatsApp Web tab                      Extension
┌─────────────────────┐   audio    ┌──────────────────┐   audio    ┌────────────────────────┐
│ content.js          │──────────▶│ background.js    │──────────▶│ offscreen.js           │
│ • adds Transcribe   │  (base64)  │ (service worker, │            │ • decodes ogg/opus     │
│   button per voice  │            │  message router) │            │ • resamples to 16 kHz  │
│   message           │◀───────────│                  │◀───────────│ • runs Whisper in WASM │
│ • renders transcript│  progress/ └──────────────────┘   text     └────────────────────────┘
└─────────────────────┘  transcript
```

- `injected.js` runs in the page's MAIN world at document_start and hooks
  `HTMLMediaElement.play()`, `URL.createObjectURL()` and `decodeAudioData()`.
  WhatsApp plays voice notes through a detached audio element that never
  appears in the DOM, so hooking these APIs is the only reliable way to reach
  the audio bytes (and to immediately mute/pause the capture playback).
- `content.js` finds voice messages in the chat, requests the audio bytes from
  `injected.js` via `window.postMessage`, and renders the AI icon and transcript modal.
- `background.js` routes messages and manages the offscreen document.
- `offscreen.js` decodes the audio with the Web Audio API and runs Whisper via
  transformers.js (with ONNX warnings silenced for a clean console). The ONNX WASM runtime is bundled in `lib/` so no code is
  loaded from remote servers at runtime.

## Limitations

- WhatsApp Web's DOM changes from time to time; if the Transcribe button stops
  appearing after a WhatsApp update, the selectors in `content.js`
  (`PLAY_ICON_SELECTOR`) may need updating.
- The first transcription after a browser restart takes a few extra seconds
  while the model is loaded from cache into memory.
- "View once" voice messages are not supported.
