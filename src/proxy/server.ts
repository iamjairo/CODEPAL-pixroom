/**
 * pixroom proxy — the Node front door (planning/end_product.md §4.2–§4.3).
 *
 * Owns upstream transport, streaming, and (via the optical stage) the single
 * Anthropic `cache_control` breakpoint. For transformable POSTs it parses the body,
 * runs the ContentRouter (semantic → optical), and forwards the transformed body;
 * everything else is proxied through untouched. Responses stream straight back —
 * neither engine rewrites model output. On any transform error it forwards the
 * ORIGINAL body, so the proxy never fails closed.
 *
 * API keys are forwarded from the client to the upstream; pixroom holds none, and
 * the headroom sidecar (loopback `/v1/compress`) never sees keys or the response.
 */

import http from 'node:http';
import { Readable } from 'node:stream';

import type { PixroomConfigOverrides } from '../config.js';
import { createPixroom, type Pixroom } from '../pixroom.js';
import { parseBody, readModel, serializeBody } from '../anthropic.js';
import { classifyAuthMode } from './auth-mode.js';
import type { Provider } from '../types.js';

/** Request headers we must not forward verbatim (hop-by-hop + recomputed).
 *  Note: `accept-encoding` is deliberately preserved so the forwarded request
 *  stays native-looking for stealth (oauth/subscription) traffic. */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Response headers we must not copy (we stream decoded, re-chunked bytes). */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

function detectProvider(pathname: string, headers: http.IncomingHttpHeaders): Provider {
  if (headers['x-api-key'] != null || headers['anthropic-version'] != null) return 'anthropic';
  if (pathname.includes('/chat/completions') || pathname.includes('/responses')) return 'openai';
  if (pathname.includes('/messages')) return 'anthropic';
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return 'openai';
  return 'anthropic';
}

/** Which POST paths pixroom transforms (count_tokens is explicitly excluded). */
function isTransformablePath(pathname: string): boolean {
  if (pathname.includes('count_tokens')) return false;
  return pathname.endsWith('/messages') || pathname.endsWith('/chat/completions');
}

function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function requestHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

export interface ProxyServer {
  readonly pixroom: Pixroom;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createProxyServer(overrides: PixroomConfigOverrides = {}): ProxyServer {
  const pixroom = createPixroom(overrides);
  const { config, log } = pixroom;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error(`unhandled proxy error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'pixroom_error', message: 'internal error' } }));
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') return sendHealth(res);
    if (req.method === 'GET' && (pathname === '/stats' || pathname === '/')) return sendStats(res);

    const provider = detectProvider(pathname, req.headers);
    const bodyBytes = await readBody(req);
    let outBytes = bodyBytes;

    if (req.method === 'POST' && isTransformablePath(pathname) && bodyBytes.byteLength > 0) {
      try {
        const parsed = parseBody(bodyBytes);
        const model = readModel(parsed);
        const authMode = classifyAuthMode(req.headers);
        const routed = await pixroom.route(provider, model, parsed, authMode);
        outBytes = serializeBody(routed.body);
      } catch (err) {
        // Never fail closed — forward the original request.
        log.warn(`transform failed, forwarding original: ${err instanceof Error ? err.message : String(err)}`);
        outBytes = bodyBytes;
      }
    }

    await forward(req, res, provider, pathname + url.search, outBytes);
  }

  async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    provider: Provider,
    pathAndQuery: string,
    bodyBytes: Uint8Array,
  ): Promise<void> {
    const base = config.upstreams[provider].replace(/\/+$/, '');
    const target = `${base}${pathAndQuery}`;
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';

    try {
      const upstream = await fetch(target, {
        method,
        headers: requestHeaders(req.headers),
        body: hasBody ? bodyBytes : undefined,
      });
      res.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (upstream.body) {
        Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      log.error(`upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { type: 'upstream_error', message: 'failed to reach upstream' } }),
        );
      }
    }
  }

  function sendHealth(res: http.ServerResponse): void {
    const body = {
      status: 'ok',
      optical: { enabled: config.optical.enabled },
      semantic: { enabled: config.semantic.enabled, sidecar: pixroom.sidecar.status, url: pixroom.sidecar.url },
      upstreams: config.upstreams,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function sendStats(res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pixroom.stats(), null, 2));
  }

  return {
    pixroom,
    async listen() {
      await pixroom.warmup();
      await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
      log.info(`pixroom proxy listening on http://${config.host}:${config.port}`);
      log.info(`  anthropic → ${config.upstreams.anthropic}`);
      log.info(`  openai    → ${config.upstreams.openai}`);
      log.info(`  semantic sidecar: ${pixroom.sidecar.status} (${pixroom.sidecar.url})`);
      return { host: config.host, port: config.port };
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await pixroom.shutdown();
    },
  };
}
