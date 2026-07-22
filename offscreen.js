// Offscreen document: decodes the voice message audio and runs the Whisper
// speech-recognition model entirely on-device (ONNX runtime in WASM).
//
// The model files are downloaded once from the Hugging Face CDN on first use
// and then cached by the browser (Cache API). The audio itself is NEVER sent
// anywhere - decoding and inference both happen in this document.

import { pipeline, env } from './lib/transformers.min.js';

// Model options (trade speed for accuracy):
//   'Xenova/whisper-tiny'   ~40 MB  - fastest, okay quality
//   'Xenova/whisper-base'   ~80 MB  - good balance, multilingual
//   'Xenova/whisper-small' ~250 MB  - best quality, slower
// The multilingual models auto-detect the spoken language.
const MODEL_ID = 'Xenova/whisper-small';

const WHISPER_SAMPLE_RATE = 16000;

// All model/config files come from the Hugging Face CDN; never look for them
// on a local server. The WASM runtime is bundled with the extension.
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.logLevel = 'fatal';

let transcriberPromise = null;

function getTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
      quantized: true,
      progress_callback: onProgress,
    }).catch((err) => {
      // Allow a retry (e.g. the model download failed halfway).
      transcriberPromise = null;
      throw err;
    });
  }
  return transcriberPromise;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Decode any browser-supported container (WhatsApp voice notes are ogg/opus)
// and resample to the 16 kHz mono float stream Whisper expects.
async function decodeToMono16k(arrayBuffer) {
  const ctx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const { numberOfChannels, length } = audioBuffer;
    if (numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i] / numberOfChannels;
    }
    return mono;
  } finally {
    ctx.close().catch(() => {});
  }
}

function sendToContent(tabId, payload) {
  chrome.runtime.sendMessage({ target: 'content', tabId, ...payload });
}

async function handleTranscribe({ requestId, tabId, audioBase64 }) {
  const progress = (text) =>
    sendToContent(tabId, { type: 'progress', requestId, text });

  try {
    // Throttle model-download progress updates to one per file per percent.
    const lastPct = {};
    const transcriber = await getTranscriber((info) => {
      if (info.status === 'progress' && info.total) {
        const pct = Math.floor(info.progress);
        if (lastPct[info.file] !== pct) {
          lastPct[info.file] = pct;
          progress(`Downloading model (one time): ${info.file} ${pct}%`);
        }
      } else if (info.status === 'ready') {
        progress('Model loaded');
      }
    });

    progress('Decoding audio…');
    const audio = await decodeToMono16k(base64ToArrayBuffer(audioBase64));

    // Whisper processes long audio in chunks. Calculate total chunks to report accurate %.
    // chunk_length_s = 30s, stride_length_s = 5s. 
    // Step size = (30 - 2*5) * 16000 = 320000 samples.
    const stepSize = 320000;
    const totalChunks = Math.max(1, Math.ceil(audio.length / stepSize));
    let currentChunk = 0;

    const audioLengthInSeconds = audio.length / 16000;
    const chunkDuration = Math.min(30, audioLengthInSeconds);
    // Rough estimate: ~4 tokens generated per second of speech
    const estimatedTokens = Math.max(10, Math.floor(chunkDuration * 4));

    progress(`Transcribing locally… 0%`);
    const output = await transcriber(audio, {
      // Chunking lets Whisper handle voice notes longer than 30 s.
      chunk_length_s: 30,
      stride_length_s: 5,
      chunk_callback: (chunk) => {
        currentChunk++;
        const pct = Math.floor((currentChunk / totalChunks) * 100);
        // Cap at 99% until the final result is fully assembled
        progress(`Transcribing locally… ${Math.min(99, pct)}%`);
      },
      callback_function: (beams) => {
        try {
          let generatedTokens = 0;
          if (Array.isArray(beams) && beams.length > 0) {
            if (beams[0].output_token_ids) {
              generatedTokens = beams[0].output_token_ids.length;
            } else if (typeof beams[0] === 'number') {
              // Sometimes it's just an array of token ids
              generatedTokens = beams.length;
            }
          }
          if (generatedTokens > 0) {
             const basePct = Math.floor((currentChunk / totalChunks) * 100);
             const chunkProgress = Math.min(99, Math.floor((generatedTokens / estimatedTokens) * 100));
             const chunkWeight = 100 / totalChunks;
             let currentPct = basePct + Math.floor((chunkProgress * chunkWeight) / 100);
             progress(`Transcribing locally… ${Math.min(99, currentPct)}%`);
          }
        } catch (e) {
          // ignore callback errors to avoid breaking transcription
        }
      }
    });

    const text = (output && output.text ? output.text : '').trim();
    sendToContent(tabId, {
      type: 'result',
      requestId,
      text: text || '(no speech detected)',
    });
  } catch (err) {
    console.error('Transcription failed:', err);
    sendToContent(tabId, {
      type: 'error',
      requestId,
      error: err && err.message ? err.message : String(err),
    });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.target === 'offscreen' && message.type === 'transcribe') {
    handleTranscribe(message);
  }
});
