/**
 * Offline audio analysis for the baked tour: trim, normalise, and per-frame openness plus spectral features.
 * Pure JS on Float32 PCM; no native dependencies, so it runs wherever Node runs.
 */

const FRAME_MS = 50;
const FFT_SIZE = 1024;

/**
 * Remove leading and trailing silence, keep a little room on each side and fade the edges to avoid clicks.
 * @param {Float32Array} pcm
 * @param {number} rate
 */
export const trimSilence = (pcm, rate, { threshold = 0.012, leadMs = 60, tailMs = 160 } = {}) => {
  const window = Math.round(rate * 0.01);
  let first = -1;
  let last = -1;
  for (let start = 0; start + window <= pcm.length; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i++) sum += pcm[i] * pcm[i];
    if (Math.sqrt(sum / window) > threshold) {
      if (first < 0) first = start;
      last = start + window;
    }
  }
  if (first < 0) return pcm;
  const from = Math.max(0, first - Math.round((rate * leadMs) / 1000));
  const to = Math.min(pcm.length, last + Math.round((rate * tailMs) / 1000));
  const out = pcm.slice(from, to);
  const fade = Math.min(Math.round(rate * 0.005), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    const gain = i / fade;
    out[i] *= gain;
    out[out.length - 1 - i] *= gain;
  }
  return out;
};

/** Peak-normalise so every stop plays at the same level. */
export const normalise = (pcm, peak = 0.89) => {
  let max = 0;
  for (const sample of pcm) max = Math.max(max, Math.abs(sample));
  if (max <= 0) return pcm;
  const gain = peak / max;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain;
  return out;
};

/** In-place radix-2 FFT (real input in `re`, zeros in `im`). */
const fft = (re, im) => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
};

/**
 * @typedef {{ atMs: number, rms: number, openness: number, centroid: number, low: number, mid: number, high: number, flatness: number }} Frame
 */

/**
 * One analysis frame every 50 ms: RMS openness (normalised to the clip), spectral centroid and band energies.
 * The same quantities the runtime's EnergyVisemes source derives live from an AnalyserNode.
 * @param {Float32Array} pcm
 * @param {number} rate
 * @returns {Frame[]}
 */
export const analyse = (pcm, rate) => {
  const hop = Math.round((rate * FRAME_MS) / 1000);
  const frames = [];
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const binHz = rate / FFT_SIZE;
  for (let start = 0; start < pcm.length; start += hop) {
    let energy = 0;
    const centre = start + hop / 2;
    const from = Math.round(centre - FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE; i++) {
      const index = from + i;
      const sample = index >= 0 && index < pcm.length ? pcm[index] : 0;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      re[i] = sample * hann;
      im[i] = 0;
    }
    for (let i = start; i < Math.min(start + hop, pcm.length); i++) energy += pcm[i] * pcm[i];
    const rms = Math.sqrt(energy / hop);
    fft(re, im);
    let weighted = 0;
    let total = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    let logSum = 0;
    let bins = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const magnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const hz = k * binHz;
      weighted += magnitude * hz;
      total += magnitude;
      if (hz < 600) low += magnitude;
      else if (hz < 2500) mid += magnitude;
      else if (hz < 9000) high += magnitude;
      if (hz < 9000) {
        logSum += Math.log(magnitude + 1e-9);
        bins++;
      }
    }
    const centroid = total > 0 ? weighted / total : 0;
    const geometric = Math.exp(logSum / Math.max(1, bins));
    const arithmetic = (low + mid + high) / Math.max(1, bins);
    frames.push({
      atMs: Math.round((start / rate) * 1000),
      rms,
      openness: 0,
      centroid,
      low: total > 0 ? low / total : 0,
      mid: total > 0 ? mid / total : 0,
      high: total > 0 ? high / total : 0,
      flatness: arithmetic > 0 ? geometric / arithmetic : 0,
    });
  }
  // Openness is the RMS envelope on a decibel scale between the clip's noise floor and its loudest frame.
  const peak = Math.max(...frames.map((frame) => frame.rms), 1e-6);
  const floorDb = 20 * Math.log10(peak) - 32;
  const peakDb = 20 * Math.log10(peak);
  for (const frame of frames) {
    const db = 20 * Math.log10(frame.rms + 1e-9);
    frame.openness = Math.min(1, Math.max(0, (db - floorDb) / (peakDb - floorDb)));
  }
  return frames;
};
