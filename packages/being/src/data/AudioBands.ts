/**
 * Thirty-two frequency bands and one loudness level from an AnalyserNode (fftSize 128 gives 64 bins, two per
 * band). Without an analyser, an external level (the microphone meter while listening) is turned into a plausible
 * spectrum so the ring still moves.
 */
export const BAND_COUNT = 32;
export const FFT_SIZE = 128;

export class AudioBands {
  readonly bands = new Float32Array(BAND_COUNT);
  private analyser: AnalyserNode | null = null;
  private readonly freq = new Uint8Array(FFT_SIZE / 2);
  private readonly wave = new Uint8Array(FFT_SIZE);
  private external = 0;
  private smoothed = 0;
  private phase = 0;

  /** Point the meter at an analyser (or detach with null). The analyser is configured for this meter's layout. */
  attach(analyser: AnalyserNode | null): void {
    this.analyser = analyser;
    if (analyser) {
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
    }
  }

  /** A loudness 0..1 measured elsewhere, used when no analyser is attached or the analyser is silent. */
  setExternalLevel(level: number): void {
    this.external = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  update(dtSeconds: number): void {
    this.phase += dtSeconds;
    let level = 0;
    let analysed = false;
    const analyser = this.analyser;
    if (analyser) {
      analyser.getByteFrequencyData(this.freq);
      analyser.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (let i = 0; i < FFT_SIZE; i += 1) {
        const v = ((this.wave[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      level = Math.min(1, Math.sqrt(sum / FFT_SIZE) * 3.5);
      analysed = level > 0.004;
      for (let i = 0; i < BAND_COUNT; i += 1) {
        const a = this.freq[i * 2] ?? 0;
        const b = this.freq[i * 2 + 1] ?? 0;
        // Higher bins carry less energy in speech; a gentle tilt keeps the back of the ring alive.
        this.bands[i] = Math.min(1, ((a + b) / 510) * (1 + i * 0.03));
      }
    }
    if (!analysed) {
      level = Math.max(level, this.external);
      for (let i = 0; i < BAND_COUNT; i += 1) {
        const wobble = 0.55 + 0.45 * Math.sin(this.phase * (1.7 + i * 0.37) + i * 1.3);
        this.bands[i] = this.external * wobble * (1 - i / (BAND_COUNT * 1.6));
      }
    }
    // Quick to rise, slower to fall, like a VU meter.
    const k = level > this.smoothed ? 1 - Math.exp(-dtSeconds / 0.03) : 1 - Math.exp(-dtSeconds / 0.12);
    this.smoothed += (level - this.smoothed) * k;
  }

  /** Smoothed loudness 0..1. */
  level(): number {
    return this.smoothed;
  }
}
