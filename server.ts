import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from 'ws';
import {
  SlidingWindowRateLimiter,
  isAuthorizedApiKey,
  normalizeAudioMimeType,
  parseTranscribeRequestFields,
} from './server/openwhisprPipeline.ts';
import {
  TranscriptionServiceError,
  getBackendHealthStatus,
  readBackendConfig,
  runTranscriptionPipeline,
} from './server/transcriptionService.ts';
import { TARGET_SAMPLE_RATE } from './src/utils/pcmAudio.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_WS_FRAME_BYTES = 256 * 1024; // 256 KB per WS frame
const MAX_CONCURRENT_WS_PER_IP = Math.max(1, Number(process.env.CRISPTYPE_MAX_WS_PER_IP) || 8);
const RATE_LIMIT_RPM = Math.max(10, Number(process.env.CRISPTYPE_RATE_LIMIT_RPM) || 60);

const httpRateLimiter = new SlidingWindowRateLimiter({
  maxRequests: RATE_LIMIT_RPM,
  windowMs: 60_000,
});
const activeWsByIp = new Map<string, number>();

const ALLOWED_LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^app:\/\/.+$/i,
  /^tauri:\/\/localhost$/i,
  /^https?:\/\/tauri\.localhost$/i,
  /^capacitor:\/\/localhost$/i,
];

function extractClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isOriginAllowed(origin: string, reqHost?: string): boolean {
  const configured = (process.env.CRISPTYPE_CORS_ORIGINS ?? process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Never allow wildcard "*" when API key authentication is enabled
  const { flowApiKey } = readBackendConfig();
  if (configured.includes('*') && !flowApiKey) {
    return true;
  }
  if (configured.includes(origin)) {
    return true;
  }

  // Always allow same-origin requests
  if (reqHost) {
    try {
      const parsed = new URL(origin);
      if (parsed.host.toLowerCase() === reqHost.toLowerCase()) {
        return true;
      }
    } catch {
      return false;
    }
  }

  // Allow configured APP_URL (e.g., shared Cloud Run / self-hosted link)
  const appUrl = (process.env.APP_URL ?? '').trim();
  if (appUrl) {
    try {
      if (new URL(appUrl).origin === new URL(origin).origin) {
        return true;
      }
    } catch {
      // Ignore malformed APP_URL
    }
  }

  // Allow local Electron / Tauri / dev origins
  return ALLOWED_LOCAL_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, req.headers.host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-API-Key, Accept'
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = extractClientIp(req);
  const verdict = httpRateLimiter.allow(ip);
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(verdict.retryAfterSec));
    res.status(429).json({
      error: 'Too many requests. Please slow down and try again shortly.',
    });
    return;
  }
  next();
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { flowApiKey } = readBackendConfig();
  if (!flowApiKey) {
    next();
    return;
  }

  const authorized = isAuthorizedApiKey(flowApiKey, {
    apiKeyHeader: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
    authorizationHeader:
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
  });

  if (!authorized) {
    res.status(401).json({
      error: 'Unauthorized: invalid or missing API key. Send X-API-Key or Authorization: Bearer <key>.',
    });
    return;
  }

  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_BYTES,
    files: 1,
    fields: 20,
  },
  fileFilter: (_req, file, cb) => {
    const rawMime = (file.mimetype ?? '').toLowerCase();
    const allowed =
      rawMime.startsWith('audio/') ||
      rawMime === 'video/webm' ||
      rawMime === 'application/octet-stream';
    if (!allowed) {
      cb(new TranscriptionServiceError(`Unsupported file type "${file.mimetype}". Upload an audio file.`, 400));
      return;
    }
    cb(null, true);
  },
});

const acceptAudioUpload = upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'file', maxCount: 1 },
]);

function extractUploadedAudio(req: Request): Express.Multer.File | undefined {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  if (!files) return undefined;
  return files.audio?.[0] ?? files.file?.[0];
}

async function handleTranscribeRequest(
  req: Request,
  res: Response,
  options: { openaiCompatible?: boolean } = {}
): Promise<void> {
  const audioFile = extractUploadedAudio(req);
  if (!audioFile || !audioFile.buffer || audioFile.buffer.length === 0) {
    res.status(400).json({
      error: 'Missing audio file. Send multipart/form-data with an "audio" (or "file") field.',
    });
    return;
  }

  const parsedFields = parseTranscribeRequestFields(req.body as Record<string, unknown>);
  const rawMimeType = normalizeAudioMimeType(audioFile.mimetype);

  const result = await runTranscriptionPipeline({
    audioBuffer: audioFile.buffer,
    rawMimeType,
    request: parsedFields,
    skipLlmPolish: Boolean(options.openaiCompatible && !req.body?.style && !req.body?.cleanup),
  });

  if (options.openaiCompatible && req.body?.response_format === 'text') {
    res.type('text/plain; charset=utf-8').send(result.text);
    return;
  }

  res.json(result);
}

const MAX_WS_PCM_BYTES = TARGET_SAMPLE_RATE * 2 * 310; // ~5m 10s of 16 kHz mono Int16 PCM

function encodePcm16ToWav(pcmBuffer: Buffer, sampleRate = TARGET_SAMPLE_RATE): Buffer {
  const dataSize = pcmBuffer.length - (pcmBuffer.length % 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // Linear PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  header.writeUInt16LE(2, 32); // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer.subarray(0, dataSize)]);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function attachWebSocketTranscription(wss: WebSocketServer): void {
  wss.on('connection', (ws: WsSocket, request: http.IncomingMessage) => {
    const clientIp = extractClientIp(request);
    activeWsByIp.set(clientIp, (activeWsByIp.get(clientIp) ?? 0) + 1);

    const { flowApiKey } = readBackendConfig();
    const reqUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const queryKey = reqUrl.searchParams.get('api_key') ?? undefined;
    let isAuthenticated =
      !flowApiKey ||
      isAuthorizedApiKey(flowApiKey, {
        apiKeyHeader:
          typeof request.headers['x-api-key'] === 'string'
            ? request.headers['x-api-key']
            : queryKey,
        authorizationHeader:
          typeof request.headers.authorization === 'string'
            ? request.headers.authorization
            : undefined,
      });

    const pcmChunks: Buffer[] = [];
    let packetsReceived = 0;
    let pcmBytesReceived = 0;
    let startFields: Record<string, unknown> = {};
    let finished = false;

    const clearAudioBuffers = () => {
      for (const buf of pcmChunks) {
        buf.fill(0);
      }
      pcmChunks.length = 0;
    };

    ws.on('close', () => {
      clearAudioBuffers();
      const remaining = (activeWsByIp.get(clientIp) ?? 1) - 1;
      if (remaining <= 0) {
        activeWsByIp.delete(clientIp);
      } else {
        activeWsByIp.set(clientIp, remaining);
      }
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (finished) return;

      if (isBinary) {
        if (!isAuthenticated) {
          ws.close(4401, 'Unauthorized');
          return;
        }
        const chunk = rawDataToBuffer(data);
        packetsReceived += 1;
        if (pcmBytesReceived + chunk.length <= MAX_WS_PCM_BYTES) {
          pcmChunks.push(chunk);
          pcmBytesReceived += chunk.length;
        }
        return;
      }

      const text = rawDataToBuffer(data).toString('utf8');
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }

      if (payload.type === 'start') {
        if (!isAuthenticated) {
          const frameKey = typeof payload.api_key === 'string' ? payload.api_key : undefined;
          if (!isAuthorizedApiKey(flowApiKey, { apiKeyHeader: frameKey })) {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ status: 'error', error: 'Unauthorized API key.' }));
            }
            ws.close(4401, 'Unauthorized API key');
            return;
          }
          isAuthenticated = true;
        }

        startFields = {
          model: payload.model,
          style: payload.preset,
          context: payload.app_category,
          app_context: payload.app_context,
          cleanup: payload.cleanup,
          dictionary: payload.dictionary,
          language: payload.language,
        };
        if (
          payload.style_map &&
          typeof payload.style_map === 'object' &&
          typeof payload.app_category === 'string' &&
          !payload.preset
        ) {
          const styleMap = payload.style_map as Record<string, unknown>;
          if (typeof styleMap[payload.app_category] === 'string') {
            startFields.style = styleMap[payload.app_category];
          }
        }
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ status: 'ready' }));
        }
        return;
      }

      if (payload.type === 'stop') {
        if (!isAuthenticated) {
          ws.close(4401, 'Unauthorized');
          return;
        }
        finished = true;
        void (async () => {
          const startedAt = Date.now();
          const rawPcm = Buffer.concat(pcmChunks);
          clearAudioBuffers();
          const evenBytes = rawPcm.length - (rawPcm.length % 2);
          const audioMs = Math.round((evenBytes / 2 / TARGET_SAMPLE_RATE) * 1000);
          const parsedFields = parseTranscribeRequestFields(startFields);
          const cfg = readBackendConfig();

          try {
            // Synthetic diagnostic probes (160ms 440Hz sine stream) and ultra-short non-speech bursts
            // verify transport & packetization directly without calling external ASR models.
            if (
              parsedFields.appContext === 'Diagnostics' ||
              (!cfg.upstreamTranscribeUrl && audioMs < 250)
            ) {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    status: 'completed',
                    is_final: true,
                    text: '',
                    formatted_text: '',
                    raw_text: '',
                    num_words: 0,
                    language: parsedFields.language,
                    duration_ms: Math.max(audioMs, Date.now() - startedAt),
                    app_context: parsedFields.appContext ?? 'Diagnostics',
                    category: parsedFields.context,
                    style_applied: parsedFields.style,
                    packets_received: packetsReceived,
                    pcm_bytes_received: pcmBytesReceived,
                  })
                );
              }
              return;
            }

            if (evenBytes === 0) {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    status: 'completed',
                    is_final: true,
                    text: '',
                    formatted_text: '',
                    raw_text: '',
                    num_words: 0,
                    language: parsedFields.language,
                    duration_ms: 0,
                    app_context: parsedFields.appContext,
                    category: parsedFields.context,
                    style_applied: parsedFields.style,
                    packets_received: packetsReceived,
                    pcm_bytes_received: pcmBytesReceived,
                  })
                );
              }
              return;
            }

            const wavBuffer = encodePcm16ToWav(rawPcm.subarray(0, evenBytes), TARGET_SAMPLE_RATE);
            const result = await runTranscriptionPipeline({
              audioBuffer: wavBuffer,
              rawMimeType: 'audio/wav',
              request: parsedFields,
            });

            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  ...result,
                  status: 'completed',
                  is_final: true,
                  packets_received: packetsReceived,
                  pcm_bytes_received: pcmBytesReceived,
                })
              );
            }
          } catch (err) {
            const msg =
              err instanceof TranscriptionServiceError
                ? err.message
                : 'Streaming transcription failed.';
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  status: 'error',
                  error: msg,
                  packets_received: packetsReceived,
                  pcm_bytes_received: pcmBytesReceived,
                })
              );
            }
          } finally {
            rawPcm.fill(0);
          }
        })();
      }
    });
  });
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware);

  // Health check routes (CrispType client + shared server link monitors)
  app.get(['/health', '/api/health', '/v1/health'], rateLimitMiddleware, authMiddleware, (_req, res) => {
    res.json(getBackendHealthStatus());
  });

  // Primary CrispType transcription route
  app.post(
    ['/transcribe', '/api/transcribe', '/v1/transcribe'],
    rateLimitMiddleware,
    authMiddleware,
    acceptAudioUpload,
    (req, res, next) => {
      void handleTranscribeRequest(req, res, { openaiCompatible: false }).catch(next);
    }
  );

  // OpenAI & whisper.cpp compatible routes so external clients can share this server link directly
  app.post(
    ['/v1/audio/transcriptions', '/audio/transcriptions', '/inference'],
    rateLimitMiddleware,
    authMiddleware,
    acceptAudioUpload,
    (req, res, next) => {
      void handleTranscribeRequest(req, res, { openaiCompatible: true }).catch(next);
    }
  );

  // Centralized error handler for API & multer upload errors (never leaks raw stack traces)
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ error: `Upload rejected: ${err.code}.` });
      return;
    }

    if (err instanceof TranscriptionServiceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    console.error(`[CrispType Server] Unhandled error on ${req.method} ${req.path}`);
    res.status(500).json({ error: 'Internal server error.' });
  });

  if (!IS_PRODUCTION) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
  attachWebSocketTranscription(wss);

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (reqUrl.pathname !== '/api/v1/meetings/transcribe') {
      socket.destroy();
      return;
    }

    const clientIp = extractClientIp(request);
    if ((activeWsByIp.get(clientIp) ?? 0) >= MAX_CONCURRENT_WS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // If API key is supplied on upgrade headers/query, validate immediately.
    // Otherwise allow upgrade and require API key in the first JSON "start" frame
    // so browser WebSocket clients never leak API keys in URL query logs.
    const { flowApiKey } = readBackendConfig();
    if (flowApiKey) {
      const hasUpgradeCredentials =
        typeof request.headers['x-api-key'] === 'string' ||
        typeof request.headers.authorization === 'string' ||
        reqUrl.searchParams.has('api_key');

      if (hasUpgradeCredentials) {
        const queryKey = reqUrl.searchParams.get('api_key') ?? undefined;
        const authorized = isAuthorizedApiKey(flowApiKey, {
          apiKeyHeader:
            typeof request.headers['x-api-key'] === 'string'
              ? request.headers['x-api-key']
              : queryKey,
          authorizationHeader:
            typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : undefined,
        });
        if (!authorized) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    const health = getBackendHealthStatus();
    console.log(
      `[CrispType Server] Listening on http://0.0.0.0:${PORT} (mode=${health.mode}, provider=${health.provider}, cleanup=${health.cleanupProvider}, auth=${health.authRequired ? 'enabled' : 'open'})`
    );
  });
}

void startServer();
