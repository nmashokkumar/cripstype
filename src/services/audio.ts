import {
  PCM_PACKET_SAMPLES,
  PRE_ROLL_SAMPLES,
  PcmPacketizer,
  PcmPreRollBuffer,
  TARGET_SAMPLE_RATE,
  downsampleFloat32To16kInt16,
  encodePcm16ToWavBlob,
} from '../utils/pcmAudio';
import { AdaptiveVoiceActivityDetector } from '../utils/voiceActivity';

export interface AudioRecorderCallbacks {
  onLevels: (bars: number[]) => void;
  onPcmPacket?: (packet: ArrayBuffer) => void;
  onElapsedMs?: (elapsedMs: number) => void;
  onSilenceTimeout?: () => void;
  onMaxDurationTimeout?: () => void;
  onError?: (message: string) => void;
}

export interface AudioRecordingResult {
  blob: Blob;
  durationMs: number;
  simulated: boolean;
}

export interface MicDeviceOption {
  deviceId: string;
  label: string;
}

const BAR_COUNT = 10;
const ANALYSER_FFT_SIZE = 256; // 62.5 Hz resolution @ 16 kHz -> clean 300–3400 Hz speech isolation
export const MAX_MONOLOGUE_DURATION_MS = 5 * 60 * 1000; // 5 minutes safety limit
export const WARM_IDLE_TTL_MS = 2 * 60 * 1000; // Keep mic warm for 2 minutes after dictation

const WORKLET_PROCESSOR_CODE = `
class PcmStreamProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Copy mono channel samples to post cleanly off the audio thread
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('flow-pcm-stream-processor', PcmStreamProcessor);
`;

export async function listAudioInputDevices(): Promise<MicDeviceOption[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [{ deviceId: 'default', label: 'System Default Microphone' }];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, idx) => ({
        deviceId: d.deviceId || 'default',
        label: d.label || `Microphone ${idx + 1}`,
      }));
    if (inputs.length === 0) {
      return [{ deviceId: 'default', label: 'System Default Microphone' }];
    }
    return inputs;
  } catch {
    return [{ deviceId: 'default', label: 'System Default Microphone' }];
  }
}

/**
 * Plays a crisp, subtle two-tone Web Audio completion chime when final text is pasted.
 */
export function playCompletionChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();
    const now = ctx.currentTime;

    const notes = [
      { freq: 880, start: 0, duration: 0.09, gain: 0.07 },
      { freq: 1174.66, start: 0.075, duration: 0.14, gain: 0.08 },
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, now + note.start);

      gain.gain.setValueAtTime(0.0001, now + note.start);
      gain.gain.exponentialRampToValueAtTime(note.gain, now + note.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.start + note.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + note.start);
      osc.stop(now + note.start + note.duration + 0.02);
    }

    setTimeout(() => {
      ctx.close().catch(() => undefined);
    }, 400);
  } catch {
    // Ignore autoplay / audio context restrictions silently
  }
}

/**
 * Dual-mode audio capture controller with:
 * - Warm microphone standby (2-min idle TTL) + 220 ms circular pre-roll buffer for instant start
 * - Adaptive speech-band (300–3,400 Hz) noise-floor VAD so fans, AC, and light breathing don't
 *   animate waveform bars or block Hands-Free auto-stop
 * - Live 16 kHz Int16 mono streaming in exact 1,024-byte (512-sample = 32 ms) WebSocket packets
 * - Parallel local audio Blob recording (audio/webm with WAV fallback) for IndexedDB playback
 */
export class AudioCaptureController {
  // Persistent warm pipeline resources (kept alive up to WARM_IDLE_TTL_MS between dictations)
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private workletUrl: string | null = null;
  private warmDeviceId: string | null = null;
  private warmIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private unloadHandlerBound = false;

  // Per-session recording state
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private pcmArchive: Int16Array[] = [];
  private packetizer = new PcmPacketizer(PCM_PACKET_SAMPLES);
  private preRollBuffer = new PcmPreRollBuffer(PRE_ROLL_SAMPLES);
  private vad = new AdaptiveVoiceActivityDetector({ barCount: BAR_COUNT });
  private callbacks: AudioRecorderCallbacks | null = null;

  private isRecording = false;
  private rafId: number | null = null;
  private startedAt = 0;
  private lastVoiceAt = 0;
  private lastTimerEmitSec = -1;
  private silenceTriggered = false;
  private maxDurationTriggered = false;
  private isSimulated = false;
  private stopResolver: ((res: AudioRecordingResult) => void) | null = null;

  private readonly handlePageUnload = () => {
    this.releaseWarmPipeline();
  };

  private isWarmPipelineReady(requestedDeviceId: string): boolean {
    if (!this.stream || !this.audioCtx || this.audioCtx.state === 'closed') return false;
    if (!this.analyser || (!this.workletNode && !this.scriptNode)) return false;
    if (this.warmDeviceId !== requestedDeviceId) return false;
    return this.stream.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled);
  }

  private clearWarmIdleTimer(): void {
    if (this.warmIdleTimer !== null) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
  }

  private enterWarmStandby(): void {
    this.clearWarmIdleTimer();
    if (!this.stream || !this.audioCtx || this.audioCtx.state === 'closed') return;

    this.preRollBuffer.clear();
    this.warmIdleTimer = setTimeout(() => {
      if (!this.isRecording) {
        this.releaseWarmPipeline();
      }
    }, WARM_IDLE_TTL_MS);
  }

  private handleIncomingFloatChunk(floatSamples: Float32Array): void {
    const inputRate = this.audioCtx?.sampleRate ?? TARGET_SAMPLE_RATE;
    const pcm16 = downsampleFloat32To16kInt16(floatSamples, inputRate, TARGET_SAMPLE_RATE);
    if (pcm16.length === 0) return;

    if (this.isRecording) {
      this.pcmArchive.push(pcm16);
      const packets = this.packetizer.push(pcm16);
      for (const packet of packets) {
        this.callbacks?.onPcmPacket?.(packet);
      }
    } else {
      // Warm standby: keep only the trailing 220 ms so the opening syllable is never clipped
      this.preRollBuffer.push(pcm16);
    }
  }

  private async ensureAudioPipeline(requestedDeviceId: string): Promise<{ wasWarm: boolean }> {
    this.clearWarmIdleTimer();

    if (this.isWarmPipelineReady(requestedDeviceId)) {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
      return { wasWarm: true };
    }

    // Cold open (or mic device changed): release any previous warm resources cleanly
    this.releaseWarmPipeline();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser context.');
    }

    const baseAudioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: { ideal: TARGET_SAMPLE_RATE },
      channelCount: { ideal: 1 },
    };

    const constraints: MediaStreamConstraints = {
      audio:
        requestedDeviceId !== 'default'
          ? { ...baseAudioConstraints, deviceId: { exact: requestedDeviceId } }
          : baseAudioConstraints,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.warmDeviceId = requestedDeviceId;

    // If OS revokes or unplugs the mic while in warm standby, clean up automatically
    for (const track of stream.getAudioTracks()) {
      track.addEventListener(
        'ended',
        () => {
          if (!this.isRecording && this.stream === stream) {
            this.releaseWarmPipeline();
          }
        },
        { once: true }
      );
    }

    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    try {
      this.audioCtx = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      this.audioCtx = new AudioContextCtor();
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = ANALYSER_FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.72;
    this.sourceNode.connect(this.analyser);

    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(this.audioCtx.destination);

    let workletReady = false;
    if (this.audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const workletBlob = new Blob([WORKLET_PROCESSOR_CODE], {
          type: 'application/javascript',
        });
        this.workletUrl = URL.createObjectURL(workletBlob);
        await this.audioCtx.audioWorklet.addModule(this.workletUrl);
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'flow-pcm-stream-processor');
        this.workletNode.port.onmessage = (event) => {
          if (event.data instanceof Float32Array) {
            this.handleIncomingFloatChunk(event.data);
          }
        };
        this.sourceNode.connect(this.workletNode);
        this.workletNode.connect(this.silentGain);
        workletReady = true;
      } catch {
        workletReady = false;
      }
    }

    if (!workletReady) {
      this.scriptNode = this.audioCtx.createScriptProcessor(1024, 1, 1);
      this.scriptNode.onaudioprocess = (ev) => {
        const channel = ev.inputBuffer.getChannelData(0);
        this.handleIncomingFloatChunk(new Float32Array(channel));
      };
      this.sourceNode.connect(this.scriptNode);
      this.scriptNode.connect(this.silentGain);
    }

    if (typeof window !== 'undefined' && !this.unloadHandlerBound) {
      window.addEventListener('pagehide', this.handlePageUnload);
      this.unloadHandlerBound = true;
    }

    return { wasWarm: false };
  }

  async start(options: {
    deviceId?: string;
    silenceTimeoutMs?: number;
    maxDurationMs?: number;
    allowSimulatedFallback?: boolean;
    callbacks: AudioRecorderCallbacks;
  }): Promise<void> {
    this.resetSessionState();
    this.callbacks = options.callbacks;
    this.startedAt = performance.now();
    this.lastVoiceAt = performance.now();
    this.lastTimerEmitSec = 0;
    this.silenceTriggered = false;
    this.maxDurationTriggered = false;
    this.isSimulated = false;

    const requestedDeviceId = options.deviceId?.trim() || 'default';
    const maxDurationMs = options.maxDurationMs ?? MAX_MONOLOGUE_DURATION_MS;
    options.callbacks.onElapsedMs?.(0);

    try {
      const { wasWarm } = await this.ensureAudioPipeline(requestedDeviceId);
      this.vad.reset({ keepNoiseFloor: wasWarm });

      // Flush the 220 ms warm pre-roll right at the start of the stream so opening syllables are kept
      if (wasWarm) {
        const preRoll = this.preRollBuffer.drain();
        if (preRoll.length > 0) {
          this.pcmArchive.push(preRoll);
          const prePackets = this.packetizer.push(preRoll);
          for (const packet of prePackets) {
            this.callbacks?.onPcmPacket?.(packet);
          }
        }
      } else {
        this.preRollBuffer.clear();
      }

      this.isRecording = true;

      // Record compressed audio Blob in parallel for IndexedDB playback & batch re-transcribe
      const mimeType =
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : '';

      if (typeof MediaRecorder !== 'undefined' && this.stream) {
        this.recorder = mimeType
          ? new MediaRecorder(this.stream, { mimeType })
          : new MediaRecorder(this.stream);

        this.recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            this.chunks.push(ev.data);
          }
        };

        this.recorder.onstop = () => {
          const durationMs = Math.max(400, Math.round(performance.now() - this.startedAt));
          const blob =
            this.chunks.length > 0
              ? new Blob(this.chunks, { type: mimeType || 'audio/webm' })
              : encodePcm16ToWavBlob(this.pcmArchive, TARGET_SAMPLE_RATE);
          const resolve = this.stopResolver;
          this.stopResolver = null;
          this.recorder = null;
          this.chunks = [];
          this.pcmArchive = [];
          this.enterWarmStandby();
          resolve?.({ blob, durationMs, simulated: false });
        };

        this.recorder.start(120);
      }

      this.startMeterLoop(options.silenceTimeoutMs, maxDurationMs, options.callbacks);
    } catch (err) {
      this.isRecording = false;
      const name = err instanceof DOMException ? err.name : '';
      if (options.allowSimulatedFallback) {
        this.isSimulated = true;
        this.startSimulatedMeterLoop(options.silenceTimeoutMs, maxDurationMs, options.callbacks);
        return;
      }

      this.releaseWarmPipeline();
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error('Microphone permission denied. Allow mic access in your browser or OS settings.');
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('No microphone detected. Connect a microphone or enable Mock mode in Settings.');
      }
      throw new Error(err instanceof Error ? err.message : 'Unable to access microphone.');
    }
  }

  private startMeterLoop(
    silenceTimeoutMs: number | undefined,
    maxDurationMs: number,
    callbacks: AudioRecorderCallbacks
  ) {
    const analyser = this.analyser;
    const freqData = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);
    const timeData = new Uint8Array(analyser ? analyser.fftSize : ANALYSER_FFT_SIZE);

    const tick = () => {
      if (!this.isRecording || !this.analyser) return;
      this.analyser.getByteFrequencyData(freqData);
      this.analyser.getByteTimeDomainData(timeData);

      const sampleRate = this.audioCtx?.sampleRate ?? TARGET_SAMPLE_RATE;
      const frame = this.vad.analyze(freqData, timeData, sampleRate, this.analyser.fftSize);
      callbacks.onLevels(frame.bars);

      const now = performance.now();
      const elapsedMs = now - this.startedAt;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      if (elapsedSec !== this.lastTimerEmitSec) {
        this.lastTimerEmitSec = elapsedSec;
        callbacks.onElapsedMs?.(elapsedMs);
      }

      // 5-minute monologue safety limit
      if (maxDurationMs > 0 && !this.maxDurationTriggered && elapsedMs >= maxDurationMs) {
        this.maxDurationTriggered = true;
        callbacks.onMaxDurationTimeout?.();
        return;
      }

      // Adaptive noise-floor silence detection (Hands-Free mode)
      if (frame.isSpeech) {
        this.lastVoiceAt = now;
      } else if (
        silenceTimeoutMs &&
        silenceTimeoutMs > 0 &&
        !this.silenceTriggered &&
        elapsedMs > Math.max(2500, silenceTimeoutMs) &&
        now - this.lastVoiceAt >= silenceTimeoutMs
      ) {
        this.silenceTriggered = true;
        callbacks.onSilenceTimeout?.();
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private startSimulatedMeterLoop(
    silenceTimeoutMs: number | undefined,
    maxDurationMs: number,
    callbacks: AudioRecorderCallbacks
  ) {
    const tick = () => {
      if (!this.isSimulated) return;
      const elapsed = performance.now() - this.startedAt;
      const elapsedSec = Math.floor(elapsed / 1000);
      if (elapsedSec !== this.lastTimerEmitSec) {
        this.lastTimerEmitSec = elapsedSec;
        callbacks.onElapsedMs?.(elapsed);
      }

      const t = elapsed / 140;
      const bars: number[] = [];
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const centerWeight = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / (BAR_COUNT / 1.7);
        const wave = 0.32 + 0.52 * Math.abs(Math.sin(t + i * 0.65)) * centerWeight;
        bars.push(Math.max(0.18, Math.min(0.98, wave)));
      }
      callbacks.onLevels(bars);

      if (maxDurationMs > 0 && !this.maxDurationTriggered && elapsed >= maxDurationMs) {
        this.maxDurationTriggered = true;
        callbacks.onMaxDurationTimeout?.();
        return;
      }

      if (
        silenceTimeoutMs &&
        silenceTimeoutMs > 0 &&
        !this.silenceTriggered &&
        elapsed >= silenceTimeoutMs + 3000
      ) {
        this.silenceTriggered = true;
        callbacks.onSilenceTimeout?.();
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  async stop(): Promise<AudioRecordingResult> {
    // Flip recording gate off first so no new live chunks enter packetizer after flush
    this.isRecording = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Flush any remaining buffered 16 kHz PCM samples before stopping MediaRecorder
    const tailPacket = this.packetizer.flush();
    if (tailPacket) {
      this.callbacks?.onPcmPacket?.(tailPacket);
    }
    this.callbacks = null;

    if (this.isSimulated) {
      const durationMs = Math.max(900, Math.round(performance.now() - this.startedAt));
      this.isSimulated = false;
      this.resetSessionState();
      return {
        blob: new Blob(['simulated-audio-webm'], { type: 'audio/webm;codecs=opus' }),
        durationMs,
        simulated: true,
      };
    }

    if (!this.recorder || this.recorder.state === 'inactive') {
      const durationMs = Math.max(400, Math.round(performance.now() - this.startedAt));
      const blob =
        this.chunks.length > 0
          ? new Blob(this.chunks, { type: 'audio/webm;codecs=opus' })
          : encodePcm16ToWavBlob(this.pcmArchive, TARGET_SAMPLE_RATE);
      this.recorder = null;
      this.chunks = [];
      this.pcmArchive = [];
      this.enterWarmStandby();
      return {
        blob,
        durationMs,
        simulated: false,
      };
    }

    return new Promise<AudioRecordingResult>((resolve) => {
      this.stopResolver = resolve;
      try {
        this.recorder?.stop();
      } catch {
        const durationMs = Math.max(400, Math.round(performance.now() - this.startedAt));
        const blob =
          this.chunks.length > 0
            ? new Blob(this.chunks, { type: 'audio/webm;codecs=opus' })
            : encodePcm16ToWavBlob(this.pcmArchive, TARGET_SAMPLE_RATE);
        this.stopResolver = null;
        this.recorder = null;
        this.chunks = [];
        this.pcmArchive = [];
        this.enterWarmStandby();
        resolve({
          blob,
          durationMs,
          simulated: false,
        });
      }
    });
  }

  cancel(): void {
    this.isRecording = false;
    this.stopResolver = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.onstop = null;
        this.recorder.stop();
      } catch {
        // Ignore recorder stop errors on cancel
      }
    }
    this.resetSessionState();
    if (this.stream) {
      this.enterWarmStandby();
    }
  }

  /**
   * Immediately releases the warm microphone stream & AudioContext (e.g., on mic change,
   * idle timeout, offline demo switch, or window unload).
   */
  releaseWarmPipeline(): void {
    this.clearWarmIdleTimer();
    this.isRecording = false;
    this.resetSessionState();
    this.preRollBuffer.clear();
    this.warmDeviceId = null;

    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // Ignore
      }
      this.workletNode = null;
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.onaudioprocess = null;
        this.scriptNode.disconnect();
      } catch {
        // Ignore
      }
      this.scriptNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore
      }
      this.sourceNode = null;
    }
    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch {
        // Ignore
      }
      this.silentGain = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.analyser = null;

    if (typeof window !== 'undefined' && this.unloadHandlerBound) {
      window.removeEventListener('pagehide', this.handlePageUnload);
      this.unloadHandlerBound = false;
    }
  }

  private resetSessionState(): void {
    this.isSimulated = false;
    this.callbacks = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.recorder = null;
    this.chunks = [];
    this.pcmArchive = [];
    this.packetizer.reset();
  }
}
