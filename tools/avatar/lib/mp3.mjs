/** MP3 encoding with the pure-JS LAME port: no ffmpeg, no native binaries. */

import { Mp3Encoder } from '@breezystack/lamejs';

const BLOCK = 1152;

/**
 * @param {Float32Array} pcm mono samples in -1..1
 * @param {number} rate sample rate in Hz (24 kHz is MPEG-2, which LAME handles natively)
 * @param {number} kbps bitrate
 * @returns {Buffer}
 */
export const encodeMp3 = (pcm, rate, kbps) => {
  const encoder = new Mp3Encoder(1, rate, kbps);
  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    samples[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  const parts = [];
  for (let i = 0; i < samples.length; i += BLOCK) {
    const chunk = encoder.encodeBuffer(samples.subarray(i, i + BLOCK));
    if (chunk.length) parts.push(Buffer.from(chunk));
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
};
