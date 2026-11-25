import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Pause,
  Play,
  Radio,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  diagnostics,
  type DiagnosticEventKind,
  type DiagnosticLogEntry,
} from '../services/diagnostics';
import { runLiveStreamDiagnosticTest } from '../services/api';
import { platform } from '../services/platform';
import { useFlowStore } from '../store/useFlowStore';
import { deriveWebSocketUrl } from '../utils/pcmAudio';

type FilterKind = 'all' | 'chunks' | 'control' | 'errors';

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function kindBadgeLabel(kind: DiagnosticEventKind): string {
  switch (kind) {
    case 'pcm_chunk':
      return 'PCM 32ms';
    case 'ws_connect':
      return 'CONNECT';
    case 'ws_handshake':
      return 'WS START';
    case 'ws_ready':
      return 'WS READY';
    case 'ws_stop':
      return 'WS STOP';
    case 'ws_final':
      return 'WS FINAL';
    case 'http_batch':
      return 'HTTP POST';
    case 'health':
      return 'HEALTH';
    case 'error':
      return 'ERROR';
  }
}

export function DiagnosticsPage() {
  const settings = useFlowStore((s) => s.settings);
  const dictionary = useFlowStore((s) => s.dictionary);
  const stylesByContext = useFlowStore((s) => s.stylesByContext);
  const pushToast = useFlowStore((s) => s.pushToast);

  const [snapshot, setSnapshot] = useState(() => diagnostics.getSnapshot());
  const [filter, setFilter] = useState<FilterKind>('all');
  const [runningTest, setRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    return diagnostics.subscribe(() => {
      setSnapshot(diagnostics.getSnapshot());
    });
  }, []);

  const filteredLogs = useMemo(() => {
    return snapshot.logs.filter((entry) => {
      if (filter === 'chunks') return entry.kind === 'pcm_chunk';
      if (filter === 'control') {
        return (
          entry.kind === 'ws_connect' ||
          entry.kind === 'ws_handshake' ||
          entry.kind === 'ws_ready' ||
          entry.kind === 'ws_stop' ||
          entry.kind === 'ws_final' ||
          entry.kind === 'http_batch' ||
          entry.kind === 'health'
        );
      }
      if (filter === 'errors') return entry.kind === 'error';
      return true;
    });
  }, [snapshot.logs, filter]);

  const targetWsDisplay = useMemo(() => {
    try {
      return deriveWebSocketUrl(settings.serverUrl);
    } catch {
      return settings.serverUrl || 'Not configured';
    }
  }, [settings.serverUrl]);

  const handleRunStreamTest = async () => {
    setRunningTest(true);
    setTestResult(null);

    const res = await runLiveStreamDiagnosticTest({
      baseUrl: settings.serverUrl,
      apiKey: settings.apiKey,
      model: 'auto',
      dictionary,
      styleMap: stylesByContext,
    });

    setTestResult({ ok: res.ok, message: res.message });
    setRunningTest(false);
    pushToast(res.ok ? '32ms stream test passed' : 'Stream test failed', res.ok ? 'success' : 'error');
  };

  const handleCopyJson = async () => {
    const payload = JSON.stringify(
      {
        stats: snapshot.stats,
        logs: filteredLogs.slice(0, 200),
      },
      null,
      2
    );
    await platform.copyToClipboard(payload);
    pushToast('Diagnostic logs copied as JSON');
  };

  const { stats } = snapshot;

  return (
    <div className="max-w-[1020px] mx-auto w-full px-6 md:px-10 pt-8 pb-24 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-[var(--flow-text)]">
            Stream Diagnostics
          </h1>
          <p className="mt-1 text-[13.5px] text-[var(--flow-text-muted)]">
            Live packet-level trace of 32 ms (1,024-byte @ 16 kHz Int16) audio frames sent to the
            backend
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRunStreamTest()}
            disabled={runningTest}
            className="inline-flex items-center gap-2 rounded-[11px] bg-[var(--flow-primary-btn)] hover:bg-[var(--flow-primary-btn-hover)] text-[var(--flow-primary-btn-text)] px-4 py-2 text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-60"
          >
            <Radio size={14} className={runningTest ? 'animate-pulse' : ''} />
            {runningTest ? 'Streaming 5 × 32ms chunks…' : 'Test 32ms WebSocket stream'}
          </button>
        </div>
      </div>

      {/* Live test banner */}
      {testResult && (
        <div
          className={`flex items-center gap-2.5 rounded-[14px] px-4 py-3 text-[13px] border ${
            testResult.ok
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-500/10 border-red-500/25 text-red-700 dark:text-red-300'
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 size={16} className="shrink-0" />
          ) : (
            <XCircle size={16} className="shrink-0" />
          )}
          <span className="font-medium">{testResult.message}</span>
        </div>
      )}

      {/* KPI strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-[16px] bg-[var(--flow-surface)] border border-[var(--flow-border)] p-4">
          <span className="text-[12px] text-[var(--flow-text-muted)]">32ms PCM chunks sent</span>
          <div className="mt-1.5 font-serif-display text-[28px] leading-none text-[var(--flow-text)] tabular-nums">
            {stats.totalPacketsSent.toLocaleString()}
          </div>
          <p className="mt-1.5 text-[11.5px] text-[var(--flow-text-secondary)] tabular-nums">
            Session: {stats.sessionPacketsSent} chunks
          </p>
        </div>

        <div className="rounded-[16px] bg-[var(--flow-surface)] border border-[var(--flow-border)] p-4">
          <span className="text-[12px] text-[var(--flow-text-muted)]">Total PCM streamed</span>
          <div className="mt-1.5 font-serif-display text-[28px] leading-none text-[var(--flow-text)] tabular-nums">
            {(stats.totalBytesSent / 1024).toFixed(1)}{' '}
            <span className="text-[14px] font-sans text-[var(--flow-text-secondary)]">KB</span>
          </div>
          <p className="mt-1.5 text-[11.5px] text-[var(--flow-text-secondary)] tabular-nums">
            {stats.lastServerAckBytes !== null
              ? `Last ack: ${stats.lastServerAckPackets ?? 0} pkts (${stats.lastServerAckBytes.toLocaleString()} B)`
              : '1,024 B / 512 samples per frame'}
          </p>
        </div>

        <div className="rounded-[16px] bg-[var(--flow-surface)] border border-[var(--flow-border)] p-4">
          <span className="text-[12px] text-[var(--flow-text-muted)]">Stop → Final latency</span>
          <div className="mt-1.5 font-serif-display text-[28px] leading-none text-[var(--flow-text)] tabular-nums">
            {stats.lastRoundTripMs !== null ? stats.lastRoundTripMs : '—'}{' '}
            {stats.lastRoundTripMs !== null && (
              <span className="text-[14px] font-sans text-[var(--flow-text-secondary)]">ms</span>
            )}
          </div>
          <p className="mt-1.5 text-[11.5px] text-[var(--flow-text-secondary)] capitalize">
            Status: {stats.activeSessionStatus.replace('_', ' ')}
          </p>
        </div>

        <div className="rounded-[16px] bg-[var(--flow-surface)] border border-[var(--flow-border)] p-4">
          <span className="text-[12px] text-[var(--flow-text-muted)]">WebSocket endpoint</span>
          <div
            title={targetWsDisplay}
            className="mt-2 text-[12px] font-mono text-[var(--flow-text)] truncate"
          >
            {targetWsDisplay}
          </div>
          <p className="mt-2 text-[11.5px] text-[var(--flow-text-secondary)]">
            Live 16 kHz PCM stream
          </p>
        </div>
      </section>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Filter packet logs"
          className="inline-flex items-center gap-1 p-1 rounded-[11px] bg-[var(--flow-surface-muted)] border border-[var(--flow-border)]"
        >
          {(
            [
              { id: 'all', label: 'All events' },
              { id: 'chunks', label: '32ms PCM chunks' },
              { id: 'control', label: 'Handshakes & JSON' },
              { id: 'errors', label: 'Errors' },
            ] as Array<{ id: FilterKind; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className={`rounded-[8px] px-3 py-1 text-[12.5px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                filter === tab.id
                  ? 'bg-[var(--flow-surface)] text-[var(--flow-text)] shadow-xs'
                  : 'text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => diagnostics.setPaused(!snapshot.paused)}
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-[var(--flow-border)] bg-[var(--flow-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--flow-text)] hover:bg-[var(--flow-surface-hover)] cursor-pointer"
          >
            {snapshot.paused ? <Play size={13} /> : <Pause size={13} />}
            {snapshot.paused ? 'Resume' : 'Pause'}
          </button>

          <button
            type="button"
            onClick={() => void handleCopyJson()}
            disabled={filteredLogs.length === 0}
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-[var(--flow-border)] bg-[var(--flow-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--flow-text)] hover:bg-[var(--flow-surface-hover)] cursor-pointer disabled:opacity-40"
          >
            <Copy size={13} />
            Copy JSON
          </button>

          <button
            type="button"
            onClick={() => diagnostics.clear()}
            disabled={snapshot.logs.length === 0}
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-[var(--flow-border)] bg-[var(--flow-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--flow-text-secondary)] hover:text-red-600 dark:hover:text-red-400 cursor-pointer disabled:opacity-40"
          >
            <Trash2 size={13} />
            Clear
          </button>
        </div>
      </div>

      {/* Packet log stream table */}
      <section className="rounded-[18px] bg-[var(--flow-surface)] border border-[var(--flow-border)] overflow-hidden">
        {filteredLogs.length === 0 ? (
          <div className="px-6 py-14 text-center space-y-2">
            <Activity size={24} className="mx-auto text-[var(--flow-text-muted)]" />
            <p className="text-[14.5px] font-medium text-[var(--flow-text)]">
              No transmission packets captured yet
            </p>
            <p className="text-[13px] text-[var(--flow-text-muted)] max-w-[440px] mx-auto">
              Start a dictation or click <strong>Test 32ms WebSocket stream</strong> above to inspect
              live 1,024-byte PCM chunks and server acknowledgments.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--flow-border-subtle)] max-h-[480px] overflow-y-auto font-mono text-[12px]">
            {filteredLogs.map((entry: DiagnosticLogEntry) => (
              <div
                key={entry.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-2.5 hover:bg-[var(--flow-surface-hover)]"
              >
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--flow-text-muted)] tabular-nums">
                    {formatLogTime(entry.timestamp)}
                  </span>

                  {entry.direction === 'out' ? (
                    <span
                      title="Sent to backend"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold bg-[var(--flow-accent-soft)] text-[var(--flow-accent)]"
                    >
                      <ArrowUpRight size={11} />
                      OUT
                    </span>
                  ) : entry.direction === 'in' ? (
                    <span
                      title="Received from backend"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    >
                      <ArrowDownLeft size={11} />
                      IN
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-semibold bg-[var(--flow-surface-muted)] text-[var(--flow-text-secondary)]">
                      SYS
                    </span>
                  )}

                  <span
                    className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
                      entry.kind === 'error'
                        ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                        : 'bg-[var(--flow-surface-muted)] text-[var(--flow-text)]'
                    }`}
                  >
                    {kindBadgeLabel(entry.kind)}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-[var(--flow-text)] truncate font-sans font-medium text-[12.5px]">
                    {entry.summary}
                  </div>
                  {(entry.detail || entry.hexPreview) && (
                    <div className="text-[11px] text-[var(--flow-text-muted)] truncate">
                      {entry.detail}
                      {entry.hexPreview ? ` · hex[${entry.hexPreview}]` : ''}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0 text-[11px] text-[var(--flow-text-secondary)] tabular-nums">
                  {typeof entry.bytes === 'number' && <span>{entry.bytes.toLocaleString()} B</span>}
                  {typeof entry.durationMs === 'number' && <span>{entry.durationMs} ms</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
