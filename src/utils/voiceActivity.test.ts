import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveVoiceActivityDetector } from './voiceActivity.ts';

const SAMPLE_RATE = 16000;
const FFT_SIZE = 256;
const BIN_COUNT = FFT_SIZE / 2; // 128 bins -> 62.5 Hz per bin

function makeTimeDataWithRms(amplitude: number): Uint8Array {
  const buf = new Uint8Array(FFT_SIZE);
  for (let i = 0; i < buf.length; i += 1) {
    const val = Math.sin(i * 0.35) * amplitude;
    buf[i] = Math.max(0, Math.min(255, Math.round(128 + val * 127)));
  }
  return buf;
}

function makeFreqBins(specs: Array<{ hz: number; magnitude: number }>): Uint8Array {
  const bins = new Uint8Array(BIN_COUNT);
  const hzPerBin = SAMPLE_RATE / FFT_SIZE;
  for (const spec of specs) {
    const idx = Math.min(BIN_COUNT - 1, Math.max(0, Math.round(spec.hz / hzPerBin)));
    bins[idx] = Math.max(bins[idx], Math.min(255, Math.round(spec.magnitude * 255)));
  }
  return bins;
}

describe('AdaptiveVoiceActivityDetector', () => {
  it('ignores steady low-frequency fan hum and keeps waveform bars calm', () => {
    const vad = new AdaptiveVoiceActivityDetector();
    // Loud 60-180 Hz fan rumble + gentle broadband room floor
    const fanFreq = makeFreqBins([
      { hz: 62, magnitude: 0.85 },
      { hz: 125, magnitude: 0.78 },
      { hz: 187, magnitude: 0.65 },
      { hz: 600, magnitude: 0.08 },
      { hz: 1200, magnitude: 0.06 },
    ]);
    const fanTime = makeTimeDataWithRms(0.12);

    let last = vad.analyze(fanFreq, fanTime, SAMPLE_RATE, FFT_SIZE);
    for (let i = 0; i < 40; i += 1) {
      last = vad.analyze(fanFreq, fanTime, SAMPLE_RATE, FFT_SIZE);
    }

    assert.equal(last.isSpeech, false, 'Fan rumble below 300 Hz must not register as speech');
    assert.ok(
      last.bars.every((b) => b <= 0.25),
      `Expected calm idle bars during fan noise, got ${JSON.stringify(last.bars)}`
    );
  });

  it('detects sustained human speech above fan noise and settles cleanly after speech stops', () => {
    const vad = new AdaptiveVoiceActivityDetector();

    // 1. Calibrate on steady room fan noise
    const fanFreq = new Uint8Array(BIN_COUNT);
    for (let i = 0; i < 4; i += 1) fanFreq[i] = 200; // < 250 Hz fan rumble
    for (let i = 5; i < 60; i += 1) fanFreq[i] = 24; // steady ambient hum (~0.094)
    const fanTime = makeTimeDataWithRms(0.06);

    for (let i = 0; i < 30; i += 1) {
      vad.analyze(fanFreq, fanTime, SAMPLE_RATE, FFT_SIZE);
    }

    // 2. Speak clearly in vocal band (500 Hz - 2400 Hz)
    const speechFreq = new Uint8Array(fanFreq);
    for (let i = 8; i <= 38; i += 1) speechFreq[i] = 165;
    const speechTime = makeTimeDataWithRms(0.28);

    let result = vad.analyze(speechFreq, speechTime, SAMPLE_RATE, FFT_SIZE);
    for (let i = 0; i < 6; i += 1) {
      result = vad.analyze(speechFreq, speechTime, SAMPLE_RATE, FFT_SIZE);
    }
    assert.equal(result.isSpeech, true, 'Sustained vocal-band energy must trigger speech');
    assert.ok(
      Math.max(...result.bars) > 0.5,
      `Expected animated bars during speech, got max ${Math.max(...result.bars)}`
    );

    // 3. Stop speaking (only fan remains) -> after hangover frames, speech must turn off
    for (let i = 0; i < 15; i += 1) {
      result = vad.analyze(fanFreq, fanTime, SAMPLE_RATE, FFT_SIZE);
    }
    assert.equal(result.isSpeech, false, 'Speech must turn off cleanly when only fan noise remains');
  });

  it('ignores single-frame sharp breath or click spikes', () => {
    const vad = new AdaptiveVoiceActivityDetector({ onsetConfirmFrames: 3 });
    const quietFreq = new Uint8Array(BIN_COUNT).fill(10);
    const quietTime = makeTimeDataWithRms(0.01);

    for (let i = 0; i < 10; i += 1) {
      vad.analyze(quietFreq, quietTime, SAMPLE_RATE, FFT_SIZE);
    }

    // Single brief spike (1 frame)
    const spikeFreq = new Uint8Array(BIN_COUNT).fill(120);
    const spikeTime = makeTimeDataWithRms(0.2);
    const duringSpike = vad.analyze(spikeFreq, spikeTime, SAMPLE_RATE, FFT_SIZE);
    assert.equal(duringSpike.isSpeech, false, 'Single-frame click/breath must not trigger speech');

    const afterSpike = vad.analyze(quietFreq, quietTime, SAMPLE_RATE, FFT_SIZE);
    assert.equal(afterSpike.isSpeech, false);
  });
});
