/**
 * Pure PCM audio conversion, 16kHz mono downsampling, 1,024-byte (512 Int16 samples = 32ms)
 * WebSocket packetization, WAV blob fallback encoding, and WebSocket URL derivation.
 */

export const TARGET_SAMPLE_RATE = 16000;
export const PCM_PACKET_SAMPLES = 512; // 32ms at 16kHz mono
export const PCM_PACKET_BYTES = PCM_PACKET_SAMPLES * 2; // 1,024 bytes (16-bit signed LE)
export const PRE_ROLL_MS = 220; // ~0.22s rolling pre-roll so the first syllable is never clipped
export const PRE_ROLL_SAMPLES = Math.round((TARGET_SAMPLE_RATE * PRE_ROLL_MS) / 1000);

/**
 * Fixed-capacity circular ring buffer holding the most recent 16 kHz Int16 PCM samples
 * while the microphone is in warm standby. Drained immediately on dictation start so
 * opening syllables spoken right as the hotkey is pressed are preserved.
 */
export class PcmPreRollBuffer {
  private readonly buffer: Int16Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(capacitySamples: number = PRE_ROLL_SAMPLES) {
    this.buffer = new Int16Array(Math.max(1, capacitySamples));
  }

  get capacity(): number {
    return this.buffer.length;
  }

  get length(): number {
    return this.filled;
  }

  push(samples: Int16Array): void {
    const cap = this.buffer.length;
    if (samples.length === 0) return;

    if (samples.length >= cap) {
      // Only the trailing `cap` samples fit
      this.buffer.set(samples.subarray(samples.length - cap), 0);
      this.writeIndex = 0;
      this.filled = cap;
      return;
    }

    const firstPart = Math.min(samples.length, cap - this.writeIndex);
    this.buffer.set(samples.subarray(0, firstPart), this.writeIndex);

    const remaining = samples.length - firstPart;
    if (remaining > 0) {
      this.buffer.set(samples.subarray(firstPart), 0);
    }

    this.writeIndex = (this.writeIndex + samples.length) % cap;
    this.filled = Math.min(cap, this.filled + samples.length);
  }

  /**
   * Returns all currently buffered samples in chronological order and clears the buffer.
   */
  drain(): Int16Array {
    if (this.filled === 0) return new Int16Array(0);

    const cap = this.buffer.length;
    const out = new Int16Array(this.filled);

    if (this.filled < cap) {
      const start = (this.writeIndex - this.filled + cap) % cap;
      const firstPart = Math.min(this.filled, cap - start);
      out.set(this.buffer.subarray(start, start + firstPart), 0);
      if (firstPart < this.filled) {
        out.set(this.buffer.subarray(0, this.filled - firstPart), firstPart);
      }
    } else {
      // Buffer is full: oldest sample starts at writeIndex
      const firstPart = cap - this.writeIndex;
      out.set(this.buffer.subarray(this.writeIndex, cap), 0);
      if (this.writeIndex > 0) {
        out.set(this.buffer.subarray(0, this.writeIndex), firstPart);
      }
    }

    this.clear();
    return out;
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
    this.buffer.fill(0);
  }
}

/**
 * Downsamples mono Float32 PCM audio from an arbitrary device sample rate
 * (e.g. 48000 Hz or 44100 Hz) to exact 16,000 Hz 16-bit signed PCM.
 */
export function downsampleFloat32To16kInt16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number = TARGET_SAMPLE_RATE
): Int16Array {
  if (input.length === 0) return new Int16Array(0);

  if (inputSampleRate <= 0 || Math.round(inputSampleRate) === targetSampleRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
    return out;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(input.length - 1, idx0 + 1);
    const frac = srcPos - idx0;
    const sample = input[idx0] * (1 - frac) + input[idx1] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }

  return out;
}

/**
 * Buffers incoming 16kHz Int16 samples and emits fixed-size 1,024-byte (512-sample = 32ms)
 * little-endian ArrayBuffer packets suitable for continuous WebSocket binary streaming.
 */
export class PcmPacketizer {
  private buffer: Int16Array;
  private offset = 0;
  private readonly packetSamples: number;

  constructor(packetSamples: number = PCM_PACKET_SAMPLES) {
    this.packetSamples = packetSamples;
    this.buffer = new Int16Array(packetSamples);
  }

  /**
   * Pushes Int16 samples and returns zero or more exact 1,024-byte ArrayBuffer packets.
   */
  push(samples: Int16Array): ArrayBuffer[] {
    const packets: ArrayBuffer[] = [];
    let readIdx = 0;

    while (readIdx < samples.length) {
      const remainingSpace = this.packetSamples - this.offset;
      const toCopy = Math.min(remainingSpace, samples.length - readIdx);
      this.buffer.set(samples.subarray(readIdx, readIdx + toCopy), this.offset);
      this.offset += toCopy;
      readIdx += toCopy;

      if (this.offset === this.packetSamples) {
        const packet = new ArrayBuffer(this.packetSamples * 2);
        const view = new DataView(packet);
        for (let i = 0; i < this.packetSamples; i += 1) {
          view.setInt16(i * 2, this.buffer[i], true);
        }
        packets.push(packet);
        this.offset = 0;
      }
    }

    return packets;
  }

  /**
   * Flushes any trailing buffered samples (zero-padded to a full 1,024-byte packet).
   * Returns null if buffer is empty.
   */
  flush(): ArrayBuffer | null {
    if (this.offset === 0) return null;
    const packet = new ArrayBuffer(this.packetSamples * 2);
    const view = new DataView(packet);
    for (let i = 0; i < this.offset; i += 1) {
      view.setInt16(i * 2, this.buffer[i], true);
    }
    this.offset = 0;
    return packet;
  }

  reset(): void {
    this.offset = 0;
    this.buffer.fill(0);
  }
}

/**
 * Encodes collected 16kHz mono Int16 chunks into a standard RIFF WAVE Blob
 * so audio playback and batch re-transcribe always work even if MediaRecorder fails.
 */
export function encodePcm16ToWavBlob(
  chunks: Int16Array[],
  sampleRate: number = TARGET_SAMPLE_RATE
): Blob {
  let totalSamples = 0;
  for (const chunk of chunks) {
    totalSamples += chunk.length;
  }

  const dataByteLength = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let writeOffset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      view.setInt16(writeOffset, chunk[i], true);
      writeOffset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Derives the streaming transcription WebSocket URL from any Base HTTPS/HTTP API URL.
 * Example:
 *   https://dictate.example.com
 *   -> wss://dictate.example.com/api/v1/meetings/transcribe
 */
export function deriveWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:api\/v1\/meetings\/transcribe|transcribe|health)$/i, '');

  if (!trimmed) {
    throw new Error('Server URL is empty.');
  }

  if (/^wss?:\/\//i.test(trimmed)) {
    return `${trimmed}/api/v1/meetings/transcribe`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Server URL must be a valid http:// or https:// URL.');
  }

  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = parsed.pathname.replace(/\/+$/, '');
  return `${wsProtocol}//${parsed.host}${basePath}/api/v1/meetings/transcribe`;
}

/**
 * Formats elapsed recording milliseconds into MM:SS (e.g. "0:04", "1:23").
 */
export function formatElapsedTimer(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
