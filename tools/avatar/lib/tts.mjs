/**
 * Kokoro-82M through kokoro-js on the CPU. The model (about 92 MB for the q8 weights plus the tokenizer) is
 * fetched from Hugging Face on first use and cached under tools/avatar/cache/hf, which is gitignored; the
 * voice embeddings ship inside the kokoro-js package, so nothing else is downloaded. The timestamped export is the
 * same voice with one more output, how long it spoke each phoneme, which times the mouth exactly.
 */

import dns from 'node:dns';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { segmentsFromDurations } from './phonemes.mjs';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

// huggingface.co publishes AAAA records and on some machines the IPv6 route resets the connection; Node's
// fetch then fails instantly instead of falling back to IPv4, so prefer IPv4 answers for this process.
dns.setDefaultResultOrder('ipv4first');

/**
 * @param {{ cacheDir: string, voice: string, fallbackVoice: string, log?: (line: string) => void }} options
 */
export const loadVoice = async ({ cacheDir, voice, fallbackVoice, log = console.log }) => {
  env.cacheDir = join(cacheDir, 'hf');
  env.localModelPath = join(cacheDir, 'hf-models');
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  const local = join(env.localModelPath, MODEL_ID);
  const haveLocal = MODEL_FILES.every((file) => existsSync(join(local, file)));
  log(
    haveLocal
      ? `tts: using the local model copy in ${local}`
      : `tts: loading ${MODEL_ID} (first run downloads about 92 MB into ${env.cacheDir})`,
  );
  let tts;
  try {
    tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
  } catch (error) {
    const lines = MODEL_FILES.map(
      (file) =>
        `  curl -4 -L --create-dirs -o "${join(local, file)}" "https://huggingface.co/${MODEL_ID}/resolve/main/${file}"`,
    );
    throw new Error(
      `could not load ${MODEL_ID}: ${error instanceof Error ? error.message : error}\n` +
        `If the download keeps failing, fetch the files by hand and run again:\n${lines.join('\n')}`,
    );
  }
  // Catch the model's inputs and outputs: the token ids and, from the timestamped export, their durations.
  let spoken = null;
  const model = tts.model;
  tts.model = async (inputs) => {
    const out = await model(inputs);
    spoken = {
      ids: Array.from(inputs.input_ids.data, Number),
      durations: out.durations ? Array.from(out.durations.data, Number) : null,
    };
    return out;
  };
  const vocab = tts.tokenizer.model.vocab;
  // transformers.js keeps the vocabulary as a sparse array by id, or as symbol -> id.
  const symbols = new Map();
  if (Array.isArray(vocab)) {
    vocab.forEach((symbol, id) => {
      symbols.set(id, symbol);
    });
  } else {
    for (const [symbol, id] of vocab instanceof Map ? vocab : Object.entries(vocab)) symbols.set(Number(id), symbol);
  }
  const available = Object.keys(tts.voices);
  const chosen = available.includes(voice) ? voice : fallbackVoice;
  if (chosen !== voice) log(`tts: voice ${voice} is not available, using ${fallbackVoice}`);
  return {
    voice: chosen,
    /**
     * @returns {Promise<{ pcm: Float32Array, rate: number, phonemes: import('./phonemes.mjs').Segment[] | null }>}
     *   phonemes: null when the model reports no durations
     */
    synthesise: async (text) => {
      spoken = null;
      const audio = await tts.generate(text, { voice: chosen, speed: 1 });
      const pcm = Float32Array.from(audio.audio);
      const phonemes = spoken?.durations
        ? segmentsFromDurations(spoken.ids, spoken.durations, (id) => symbols.get(id), pcm.length)
        : null;
      return { pcm, rate: audio.sampling_rate, phonemes };
    },
  };
};
