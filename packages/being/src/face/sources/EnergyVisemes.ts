import { CHANNEL, type FaceSource, VISEME_COUNT } from '../source.ts';
import { jawOpenOf } from '../tables/ms22.ts';

/** The slice of AnalyserNode this source reads; a plain object with these members works in tests. */
export interface AnalyserLike {
  readonly fftSize: number;
  readonly frequencyBinCount: number;
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
  readonly context?: { readonly sampleRate: number };
}

export interface EnergyOptions {
  /** RMS below this is silence; room noise through a laptop microphone sits around 0.01. */
  noiseFloor?: number;
  /** RMS at which the mouth is fully open. */
  fullOpenRms?: number;
  /** Spectral centroid (Hz) below which the sound reads as a rounded vowel. */
  roundedBelowHz?: number;
  /** Spectral centroid (Hz) above which the sound reads as a spread vowel. */
  spreadAboveHz?: number;
  /** Smoothing time constant for the mouth, in milliseconds. */
  smoothingMs?: number;
  /** Used when the analyser carries no context (tests). */
  sampleRate?: number;
}

export const ENERGY_VISEMES = { rounded: 7, open: 1, spread: 4, silence: 0 } as const;

/**
 * Lip-sync from audio alone, the wawa-lipsync way: loudness opens the mouth and the spectral centroid picks the
 * shape (rounded, open or spread). Good enough for live TTS where no viseme timeline exists. Priority 10.
 */
export class EnergyVisemesSource implements FaceSource {
  readonly name = 'energy-visemes';
  readonly priority = 10;
  private readonly analyser: AnalyserLike;
  private readonly noiseFloor: number;
  private readonly fullOpenRms: number;
  private readonly roundedBelowHz: number;
  private readonly spreadAboveHz: number;
  private readonly smoothingMs: number;
  private readonly sampleRate: number;
  private readonly spectrum: Uint8Array<ArrayBuffer>;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly weights = new Float32Array(VISEME_COUNT);
  private openness = 0;
  private lastSampleAt = -1;
  private stopped = false;

  constructor(analyser: AnalyserLike, options: EnergyOptions = {}) {
    this.analyser = analyser;
    this.noiseFloor = options.noiseFloor ?? 0.02;
    this.fullOpenRms = options.fullOpenRms ?? 0.25;
    this.roundedBelowHz = options.roundedBelowHz ?? 900;
    this.spreadAboveHz = options.spreadAboveHz ?? 2200;
    this.smoothingMs = options.smoothingMs ?? 55;
    this.sampleRate = analyser.context?.sampleRate ?? options.sampleRate ?? 48000;
    this.spectrum = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
  }

  active(_nowMs: number): boolean {
    return !this.stopped;
  }

  sample(nowMs: number, frame: Float32Array, written: Uint8Array): void {
    const dtMs = this.lastSampleAt < 0 ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - this.lastSampleAt);
    this.lastSampleAt = nowMs;
    const alpha = 1 - Math.exp(-dtMs / this.smoothingMs);

    const rms = this.rms();
    const targetOpen = rms <= this.noiseFloor ? 0 : Math.min(1, (rms - this.noiseFloor) / this.fullOpenRms);
    const shape = targetOpen === 0 ? ENERGY_VISEMES.silence : this.shapeFor(this.centroidHz());

    this.openness += (targetOpen - this.openness) * alpha;
    for (let viseme = 0; viseme < VISEME_COUNT; viseme += 1) {
      const target = viseme === shape && shape !== 0 ? 1 : 0;
      const current = this.weights[viseme] ?? 0;
      this.weights[viseme] = current + (target - current) * alpha;
    }

    let jaw = 0;
    for (let viseme = 0; viseme < VISEME_COUNT; viseme += 1) {
      const weight = (this.weights[viseme] ?? 0) * this.openness;
      frame[viseme] = weight;
      written[viseme] = 1;
      jaw += weight * jawOpenOf(viseme);
    }
    frame[CHANNEL.jawOpen] = Math.min(1, jaw);
    written[CHANNEL.jawOpen] = 1;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Current mouth openness 0..1, handy for the body dots while live audio plays. */
  level(): number {
    return this.openness;
  }

  private rms(): number {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let index = 0; index < this.samples.length; index += 1) {
      const value = this.samples[index] ?? 0;
      sum += value * value;
    }
    return this.samples.length === 0 ? 0 : Math.sqrt(sum / this.samples.length);
  }

  private centroidHz(): number {
    this.analyser.getByteFrequencyData(this.spectrum);
    const binHz = this.sampleRate / 2 / Math.max(1, this.spectrum.length);
    let weighted = 0;
    let total = 0;
    for (let bin = 0; bin < this.spectrum.length; bin += 1) {
      const magnitude = this.spectrum[bin] ?? 0;
      weighted += magnitude * bin * binHz;
      total += magnitude;
    }
    return total === 0 ? 0 : weighted / total;
  }

  private shapeFor(centroidHz: number): number {
    if (centroidHz < this.roundedBelowHz) return ENERGY_VISEMES.rounded;
    if (centroidHz > this.spreadAboveHz) return ENERGY_VISEMES.spread;
    return ENERGY_VISEMES.open;
  }
}
