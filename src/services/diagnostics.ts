export type DiagnosticDirection = 'out' | 'in' | 'info';

export type DiagnosticEventKind =
  | 'ws_connect'
  | 'ws_handshake'
  | 'ws_ready'
  | 'pcm_chunk'
  | 'ws_stop'
  | 'ws_final'
  | 'http_batch'
  | 'health'
  | 'error';

export interface DiagnosticLogEntry {
  id: string;
  timestamp: number;
  direction: DiagnosticDirection;
  kind: DiagnosticEventKind;
  endpoint: string;
  bytes?: number;
  durationMs?: number;
  packetSeq?: number;
  summary: string;
  detail?: string;
  hexPreview?: string;
}

export interface DiagnosticSummaryStats {
  activeSessionStatus: 'idle' | 'connecting' | 'streaming' | 'awaiting_final' | 'completed' | 'error';
  targetEndpoint: string;
  totalPacketsSent: number;
  sessionPacketsSent: number;
  totalBytesSent: number;
  lastRoundTripMs: number | null;
  lastServerAckPackets: number | null;
  lastServerAckBytes: number | null;
}

const MAX_LOG_ENTRIES = 500;

class DiagnosticsStore {
  private logs: DiagnosticLogEntry[] = [];
  private listeners = new Set<() => void>();
  private paused = false;
  private stats: DiagnosticSummaryStats = {
    activeSessionStatus: 'idle',
    targetEndpoint: '',
    totalPacketsSent: 0,
    sessionPacketsSent: 0,
    totalBytesSent: 0,
    lastRoundTripMs: null,
    lastServerAckPackets: null,
    lastServerAckBytes: null,
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  getSnapshot(): {
    logs: DiagnosticLogEntry[];
    stats: DiagnosticSummaryStats;
    paused: boolean;
  } {
    return {
      logs: this.logs,
      stats: this.stats,
      paused: this.paused,
    };
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.emit();
  }

  updateStats(partial: Partial<DiagnosticSummaryStats>): void {
    this.stats = { ...this.stats, ...partial };
    this.emit();
  }

  startSession(targetEndpoint: string): void {
    this.stats = {
      ...this.stats,
      activeSessionStatus: 'connecting',
      targetEndpoint,
      sessionPacketsSent: 0,
      lastServerAckPackets: null,
      lastServerAckBytes: null,
    };
    this.emit();
  }

  record(entry: Omit<DiagnosticLogEntry, 'id' | 'timestamp'>): void {
    if (entry.kind === 'pcm_chunk' && entry.direction === 'out') {
      this.stats = {
        ...this.stats,
        activeSessionStatus: 'streaming',
        totalPacketsSent: this.stats.totalPacketsSent + 1,
        sessionPacketsSent: this.stats.sessionPacketsSent + 1,
        totalBytesSent: this.stats.totalBytesSent + (entry.bytes ?? 0),
      };
    }

    if (!this.paused) {
      const item: DiagnosticLogEntry = {
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        ...entry,
      };
      this.logs = [item, ...this.logs].slice(0, MAX_LOG_ENTRIES);
    }

    this.emit();
  }

  clear(): void {
    this.logs = [];
    this.stats = {
      ...this.stats,
      totalPacketsSent: 0,
      sessionPacketsSent: 0,
      totalBytesSent: 0,
      lastRoundTripMs: null,
      lastServerAckPackets: null,
      lastServerAckBytes: null,
    };
    this.emit();
  }
}

export const diagnostics = new DiagnosticsStore();

export function formatPacketHexPreview(buffer: ArrayBuffer, maxBytes = 12): string {
  const bytes = new Uint8Array(buffer, 0, Math.min(maxBytes, buffer.byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

export function computePcmPacketRms(buffer: ArrayBuffer): number {
  const view = new DataView(buffer);
  const sampleCount = Math.floor(buffer.byteLength / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / sampleCount);
}
