/**
 * Adaptive Voice Activity Detection (VAD) & noise-gated waveform analyzer.
 *
 * Designed for real-world desktop environments (laptop fans, AC hum, breathing):
 * - Focuses on the human vocal frequency band (300 Hz – 3,400 Hz) instead of raw broadband RMS,
 *   ignoring low-frequency fan rumble and high-frequency hiss.
 * - Continuously tracks a rolling ambient noise floor per room/microphone.
 * - Uses onset confirmation + short hangover hysteresis so quick inhales/clicks don't keep
 *   Hands-Free alive forever, while natural pauses mid-sentence don't cut speech off early.
 * - Subtracts the ambient noise floor from visualizer bars so the overlay wave stays calm
 *   during fan hum and breathing and animates cleanly when you speak.
 */

export interface VoiceActivityFrame {
  /** Whether human speech is currently detected above the adaptive room noise floor */
  isSpeech: boolean;
  /** Speech-band energy normalized to 0..1 after noise-floor subtraction */
  voiceLevel: number;
  /** Current estimated ambient speech-band noise floor (0..1) */
  noiseFloor: number;
  /** Ready-to-render visualizer bar heights (0.14..1.0), noise-gated */
  bars: number[];
}

export interface AdaptiveVadConfig {
  /** Number of visualizer bars to output (default: 10) */
  barCount?: number;
  /** Minimum vocal frequency in Hz (default: 300 Hz — filters out fan/AC rumble) */
  minSpeechHz?: number;
  /** Maximum vocal frequency in Hz (default: 3400 Hz — filters out hiss) */
  maxSpeechHz?: number;
  /** Speech must exceed `noiseFloor * onsetMultiplier + onsetMargin` to trigger */
  onsetMultiplier?: number;
  /** Additive margin above noise floor for speech onset (0..1 scale) */
  onsetMargin?: number;
  /** Lower margin to sustain already-active speech (hysteresis prevents choppy cutoffs) */
  sustainMargin?: number;
  /** Minimum absolute speech-band energy required to ever count as speech */
  minAbsoluteEnergy?: number;
  /** Consecutive frames above onset threshold required before confirming speech (ignores clicks/breaths) */
  onsetConfirmFrames?: number;
  /** Frames to keep speech active after dipping below sustain threshold (bridges word gaps) */
  hangoverFrames?: number;
}

const DEFAULT_VAD_CONFIG: Required<AdaptiveVadConfig> = {
  barCount: 10,
  minSpeechHz: 300,
  maxSpeechHz: 3400,
  onsetMultiplier: 1.45,
  onsetMargin: 0.055,
  sustainMargin: 0.03,
  minAbsoluteEnergy: 0.065,
  onsetConfirmFrames: 3,
  hangoverFrames: 8,
};

/**
 * Computes normalized time-domain RMS (0..1) from an AnalyserNode byte time-domain buffer.
 */
export function computeByteTimeDomainRms(timeData: Uint8Array): number {
  if (timeData.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < timeData.length; i += 1) {
    const centered = (timeData[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / timeData.length);
}

/**
 * Pure adaptive noise-floor VAD & visualizer helper.
 * Call `analyze(freqData, timeData, sampleRate, fftSize)` on each animation frame.
 */
export class AdaptiveVoiceActivityDetector {
  private readonly cfg: Required<AdaptiveVadConfig>;
  private noiseFloor = 0.025;
  private initialized = false;
  private speechActive = false;
  private onsetStreak = 0;
  private hangoverRemaining = 0;
  private smoothedBars: number[];

  constructor(config: AdaptiveVadConfig = {}) {
    this.cfg = { ...DEFAULT_VAD_CONFIG, ...config };
    this.smoothedBars = Array(this.cfg.barCount).fill(0.14);
  }

  /**
   * Resets speech hysteresis for a new recording session while optionally keeping
   * the already-learned room noise floor from a warm microphone pipeline.
   */
  reset(options: { keepNoiseFloor?: boolean } = {}): void {
    this.speechActive = false;
    this.onsetStreak = 0;
    this.hangoverRemaining = 0;
    this.smoothedBars = Array(this.cfg.barCount).fill(0.14);
    if (!options.keepNoiseFloor) {
      this.noiseFloor = 0.025;
      this.initialized = false;
    }
  }

  get currentNoiseFloor(): number {
    return this.noiseFloor;
  }

  /**
   * Analyzes one frame of FFT + time-domain data and returns speech detection + noise-gated bars.
   */
  analyze(
    freqData: Uint8Array,
    timeData: Uint8Array,
    sampleRate: number,
    fftSize: number
  ): VoiceActivityFrame {
    const binCount = freqData.length;
    const safeSampleRate = sampleRate > 0 ? sampleRate : 16000;
    const safeFftSize = fftSize > 0 ? fftSize : Math.max(2, binCount * 2);
    const hzPerBin = safeSampleRate / safeFftSize;

    // 1. Identify FFT bins inside the human vocal range (300 Hz – 3,400 Hz)
    const startBin = Math.min(
      Math.max(1, Math.floor(this.cfg.minSpeechHz / hzPerBin)),
      Math.max(0, binCount - 1)
    );
    const endBin = Math.min(
      binCount - 1,
      Math.max(startBin, Math.ceil(this.cfg.maxSpeechHz / hzPerBin))
    );

    // Compute speech-band average & peak energy (0..1)
    let bandSum = 0;
    let bandPeak = 0;
    const bandWidth = Math.max(1, endBin - startBin + 1);
    for (let i = startBin; i <= endBin; i += 1) {
      const mag = freqData[i] / 255;
      bandSum += mag;
      if (mag > bandPeak) bandPeak = mag;
    }
    const bandMean = bandSum / bandWidth;

    // Blend speech-band mean (70%) + peak (30%) so narrow vocal formants register cleanly
    // while ignoring low-frequency fan rumble below 300 Hz.
    const speechBandEnergy = bandMean * 0.7 + bandPeak * 0.3;

    // Compute broadband time-domain RMS solely as a sanity gate against dead-silent mics
    const timeRms = computeByteTimeDomainRms(timeData);
    const effectiveEnergy = speechBandEnergy * (timeRms < 0.002 ? 0.35 : 1);

    // 2. Asymmetric ambient noise floor adaptation
    if (!this.initialized) {
      // Seed slightly conservatively on the first frame so an immediate opening word still triggers
      this.noiseFloor = Math.min(0.22, effectiveEnergy);
      this.initialized = true;
    } else if (effectiveEnergy < this.noiseFloor) {
      // Room became quieter -> adapt downward quickly
      this.noiseFloor = this.noiseFloor * 0.85 + effectiveEnergy * 0.15;
    } else if (!this.speechActive) {
      // Steady background noise (fan / AC) -> drift upward slowly, clamped so speech never pulls floor up
      const cappedSample = Math.min(effectiveEnergy, this.noiseFloor + 0.035);
      this.noiseFloor = this.noiseFloor * 0.985 + cappedSample * 0.015;
    }

    // 3. Hysteresis thresholds relative to ambient noise floor
    const onsetThreshold = Math.max(
      this.cfg.minAbsoluteEnergy,
      this.noiseFloor * this.cfg.onsetMultiplier + this.cfg.onsetMargin
    );
    const sustainThreshold = Math.max(
      this.cfg.minAbsoluteEnergy * 0.7,
      this.noiseFloor * 1.2 + this.cfg.sustainMargin
    );

    if (this.speechActive) {
      if (effectiveEnergy >= sustainThreshold) {
        this.hangoverRemaining = this.cfg.hangoverFrames;
      } else if (this.hangoverRemaining > 0) {
        this.hangoverRemaining -= 1;
      } else {
        this.speechActive = false;
        this.onsetStreak = 0;
      }
    } else if (effectiveEnergy >= onsetThreshold) {
      this.onsetStreak += 1;
      if (this.onsetStreak >= this.cfg.onsetConfirmFrames) {
        this.speechActive = true;
        this.hangoverRemaining = this.cfg.hangoverFrames;
      }
    } else {
      this.onsetStreak = 0;
    }

    // 4. Noise-gated normalized voice level & 10-bar waveform heights
    //    Fan hum / steady breath below the threshold stays calm at baseline (~0.14)
    const gateBaseline = this.noiseFloor * 1.25 + 0.025;
    const rawVoiceAboveFloor = Math.max(0, effectiveEnergy - gateBaseline);
    const voiceLevel = this.speechActive
      ? Math.min(1, rawVoiceAboveFloor / Math.max(0.18, 0.55 - gateBaseline))
      : Math.min(0.12, rawVoiceAboveFloor * 0.8);

    const bars: number[] = [];
    const barCount = this.cfg.barCount;
    for (let i = 0; i < barCount; i += 1) {
      const t0 = i / barCount;
      const t1 = (i + 1) / barCount;
      const bStart = Math.min(endBin, startBin + Math.floor(t0 * bandWidth));
      const bEnd = Math.min(endBin, Math.max(bStart, startBin + Math.floor(t1 * bandWidth)));

      let binMax = 0;
      for (let b = bStart; b <= bEnd; b += 1) {
        const val = freqData[b] / 255;
        if (val > binMax) binMax = val;
      }

      const gatedBin = Math.max(0, binMax - gateBaseline);
      const targetHeight = this.speechActive
        ? Math.min(1, 0.16 + Math.max(gatedBin * 2.2, voiceLevel * 0.85))
        : 0.14 + Math.min(0.06, gatedBin * 0.35);

      // Smooth release so bars glide naturally without twitching on background hiss
      const prev = this.smoothedBars[i] ?? 0.14;
      const alpha = targetHeight > prev ? 0.55 : 0.25;
      const next = prev + (targetHeight - prev) * alpha;
      this.smoothedBars[i] = next;
      bars.push(Math.max(0.14, Math.min(1, next)));
    }

    return {
      isSpeech: this.speechActive,
      voiceLevel,
      noiseFloor: this.noiseFloor,
      bars,
    };
  }
}
