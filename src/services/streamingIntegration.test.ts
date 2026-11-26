import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import {
  PCM_PACKET_BYTES,
  PCM_PACKET_SAMPLES,
  PcmPacketizer,
  TARGET_SAMPLE_RATE,
  downsampleFloat32To16kInt16,
} from '../utils/pcmAudio.ts';
import { DEFAULT_CLEANUP_CONFIG, StreamingDictationSession } from './api.ts';
import { DEFAULT_STYLES_BY_CONTEXT } from '../utils/appClassifier.ts';

function encodeWsTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

interface ParsedWsFrame {
  opcode: number;
  payload: Buffer;
}

function parseWsFrames(buf: Buffer): { frames: ParsedWsFrame[]; remainder: Buffer } {
  const frames: ParsedWsFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const totalLen = headerLen + maskLen + payloadLen;
    if (offset + totalLen > buf.length) break;

    const payloadStart = offset + headerLen + maskLen;
    const payload = Buffer.from(buf.subarray(payloadStart, payloadStart + payloadLen));
    if (masked) {
      const mask = buf.subarray(offset + headerLen, offset + headerLen + 4);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    frames.push({ opcode, payload });
    offset += totalLen;
  }

  return { frames, remainder: buf.subarray(offset) };
}

test('StreamingDictationSession streams exact 1,024-byte (32ms @ 16kHz) PCM packets and receives final transcript', async () => {
  let receivedStart: Record<string, unknown> | null = null;
  let receivedStop = false;
  let upgradeUrl = '';
  const binaryFrameSizes: number[] = [];

  const server = http.createServer();
  server.on('upgrade', (req, socket: Duplex) => {
    upgradeUrl = req.url ?? '';
    const key = req.headers['sec-websocket-key'];
    assert.ok(typeof key === 'string');
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, remainder } = parseWsFrames(pending);
      pending = Buffer.from(remainder);

      for (const frame of frames) {
        if (frame.opcode === 0x01) {
          const msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
          if (msg.type === 'start') {
            receivedStart = msg;
            socket.write(encodeWsTextFrame(JSON.stringify({ status: 'ready', session: 'active' })));
          } else if (msg.type === 'stop') {
            receivedStop = true;
            const totalSamples = binaryFrameSizes.reduce((sum, sz) => sum + sz / 2, 0);
            const durationMs = Math.round((totalSamples / TARGET_SAMPLE_RATE) * 1000);
            socket.write(
              encodeWsTextFrame(
                JSON.stringify({
                  status: 'ok',
                  is_final: true,
                  text: 'Send the report by Friday.',
                  formatted_text: 'Send the report by Friday.',
                  raw_text: 'um send the report by uh Friday',
                  num_words: 5,
                  duration_ms: durationMs,
                  filler_removed_count: 2,
                  language: 'en',
                })
              )
            );
          }
        } else if (frame.opcode === 0x02) {
          binaryFrameSizes.push(frame.payload.byteLength);
        } else if (frame.opcode === 0x08) {
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const session = new StreamingDictationSession({
      baseUrl,
      apiKey: 'ct_test_secret_key',
      appContext: 'Gmail',
      appCategory: 'email',
      preset: 'formal',
      styleMap: DEFAULT_STYLES_BY_CONTEXT,
      cleanup: DEFAULT_CLEANUP_CONFIG,
      dictionary: [{ id: '1', type: 'word', trigger: 'Wispr', starred: false, scope: 'personal', createdAt: 0 }],
    });
    session.connect();

    // Simulate 350ms of 48kHz mic audio downsampled to 16kHz and packetized into 32ms (1,024-byte) packets
    const packetizer = new PcmPacketizer(PCM_PACKET_SAMPLES);
    const total48kSamples = Math.round(48000 * 0.35);
    const fakeMic = new Float32Array(total48kSamples);
    for (let i = 0; i < total48kSamples; i += 1) {
      fakeMic[i] = Math.sin(i * 0.05) * 0.25;
    }

    const pcm16 = downsampleFloat32To16kInt16(fakeMic, 48000, TARGET_SAMPLE_RATE);
    for (const pkt of packetizer.push(pcm16)) {
      session.sendPcmPacket(pkt);
    }
    const tail = packetizer.flush();
    if (tail) {
      session.sendPcmPacket(tail);
    }

    const result = await session.finish(350);

    assert.equal(upgradeUrl.includes('api_key'), false, 'API key must never appear in WebSocket URL query string');
    assert.ok(receivedStart, 'Server must receive start handshake JSON');
    assert.equal(receivedStart['api_key'], 'ct_test_secret_key');
    assert.equal(receivedStart['app_context'], 'Gmail');
    assert.equal(receivedStart['app_category'], 'email');
    assert.equal(receivedStart['preset'], 'formal');
    assert.equal(receivedStop, true, 'Server must receive stop command');

    // 350ms at 16kHz = 5,600 samples -> 10 full packets + 1 flushed tail = 11 packets of exact 1,024 bytes
    assert.equal(binaryFrameSizes.length, 11);
    assert.ok(
      binaryFrameSizes.every((size) => size === PCM_PACKET_BYTES),
      `Every binary frame must be exact ${PCM_PACKET_BYTES} bytes (32ms), got ${binaryFrameSizes.join(',')}`
    );
    assert.equal(session.packetsSent, 11);
    assert.equal(session.bytesSent, 11 * PCM_PACKET_BYTES);

    assert.equal(result.formatted_text, 'Send the report by Friday.');
    assert.equal(result.duration_ms, 352);
    assert.equal(result.fillerRemovedCount, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
