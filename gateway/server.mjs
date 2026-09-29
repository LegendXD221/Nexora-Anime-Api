import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import worker from '../anivexa/index.js';
import {
  HttpClient,
  startServer,
  GogoanimeProvider,
  GoyabuProvider,
  AllmangaProvider,
  AnimeParadiseProvider,
  AnikotoProvider,
  MegaPlayProvider,
  MangadexProvider,
  WeebcentralProvider,
  MangapillProvider,
} from '../anime-sdk/dist/index.js';

const PORT = Number(process.env.PORT || 8080);
const ANIVEXA_PORT = Number(process.env.ANIVEXA_PORT || 4001);
const SDK_PORT = Number(process.env.SDK_PORT || 3001);
const KUHI_PORT = Number(process.env.KUHI_PORT || 8001);
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS || 30000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const rateBuckets = new Map();
const services = {
  gateway: { ok: true, ready: true },
  anivexa: { ok: false, ready: false },
  animeSdk: { ok: false, ready: false },
  kuhi: { ok: false, ready: false },
};

function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function securityHeaders(res) {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function allowed(req) {
  if (!RATE_LIMIT || RATE_LIMIT < 1) return true;
  const now = Date.now();
  const key = clientIp(req);
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.started >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { started: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.started < cutoff) rateBuckets.delete(key);
  }
}, RATE_WINDOW_MS).unref();

async function startAnivexa() {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${ANIVEXA_PORT}`;
      const request = new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      const response = await worker.fetch(request, {});
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      json(res, 500, { error: 'Anivexa upstream error', detail: error?.message || String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ANIVEXA_PORT, '127.0.0.1', resolve);
  });
  services.anivexa.ready = true;
  return server;
}

async function startSdk() {
  const httpClient = new HttpClient({ timeoutMs: 30_000 });
  const providers = [
    new GogoanimeProvider(httpClient),
    new GoyabuProvider(httpClient),
    new AllmangaProvider(httpClient),
    new AnimeParadiseProvider(httpClient),
    new AnikotoProvider(httpClient),
    new MegaPlayProvider(httpClient),
    new MangadexProvider(httpClient),
    new WeebcentralProvider(httpClient),
    new MangapillProvider(httpClient),
  ];
  const server = startServer({ providers, port: SDK_PORT, proxy: true, cache: memoryCache() });
  services.animeSdk.ready = true;
  return server;
}

function memoryCache() {
  const map = new Map();
  return {
    get: async key => {
      const item = map.get(key);
      if (!item) return undefined;
      if (item.expiresAt && item.expiresAt < Date.now()) {
        map.delete(key);
        return undefined;
      }
      return item.value;
    },
    set: async (key, value, ttlMs) => {
      map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
    },
  };
}

function startKuhi() {
  const cwd = new URL('../kuhi/', import.meta.url);
  const command = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const py = spawn(command, ['-m', 'uvicorn', 'api:app', '--host', '127.0.0.1', '--port', String(KUHI_PORT)], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  py.on('error', error => console.error('[kuhi] process error:', error.message));
  py.on('spawn', () => { services.kuhi.ready = true; });
  py.on('exit', code => {
    services.kuhi.ready = false;
    if (code && !shuttingDown) console.error(`[kuhi] exited with code ${code}`);
  });
  return py;
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function refreshHealth() {
  services.anivexa.ok = await probe(`http://127.0.0.1:${ANIVEXA_PORT}/`);
  services.animeSdk.ok = await probe(`http://127.0.0.1:${SDK_PORT}/health`);
  services.kuhi.ok = await probe(`http://127.0.0.1:${KUHI_PORT}/`);
  return services;
}

async function waitForKuhi() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(`http://127.0.0.1:${KUHI_PORT}/`)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}



async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 30000)),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const message = data?.error || data?.detail || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function normalizeStreams(payload, provider, engine, episode, audio) {
  if (!payload) return [];
  if (Array.isArray(payload.streams)) {
    return payload.streams.map((s) => ({
      url: s.url || s.sourceUrl || s.file || s.src,
      type: s.type || (s.isHLS ? 'hls' : 'mp4'),
      quality: s.quality || 'auto',
      language: s.audio || s.language || audio,
      headers: s.headers || (s.referer ? { Referer: s.referer } : undefined),
      subtitles: s.subtitles || [],
      server: s.server || provider,
    })).filter((s) => typeof s.url === 'string' && /^https?:\/\//i.test(s.url));
  }
  if (payload.type === 'video' && Array.isArray(payload.streams)) return normalizeStreams(payload, provider, engine, episode, audio);
  return [];
}

async function validateStream(stream, timeoutMs = 7000) {
  if (!stream?.url) return false;
  try {
    const response = await fetch(stream.url, {
      method: 'GET',
      headers: stream.headers || {},
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const url = stream.url.toLowerCase();
    if (stream.type === 'hls' || stream.type === 'm3u8' || url.includes('.m3u8')) {
      const body = await response.text();
      return body.includes('#EXTM3U');
    }
    return contentType.startsWith('video/') || contentType.includes('mpegurl') || contentType.includes('octet-stream') || url.includes('.mp4') || url.includes('.mkv');
  } catch {
    return false;
  }
}

async function validateAndReturn(streams, provider, engine, episode, audio, attempts) {
  if (!streams.length) throw new Error('No streams returned');
  const ordered = [...streams].sort((a, b) => {
    const q = (v) => Number(String(v.quality || '').replace(/[^0-9]/g, '')) || 0;
    return q(b) - q(a);
  });
  const checks = await Promise.all(ordered.map(async (stream) => ({ stream, ok: await validateStream(stream) })));
  const working = checks.find((x) => x.ok)?.stream;
  if (!working) throw new Error('Returned streams failed validation');
  return {
    ok: true,
    provider,
    engine,
    episode: Number(episode),
    audio,
    stream: working,
    streams: ordered,
    attempts,
  };
}

async function tryKuhi(anilistId, episode, audio, attempts) {
  const data = await fetchJson(`http://127.0.0.1:${KUHI_PORT}/anime/extract/${encodeURIComponent(anilistId)}?e=${encodeURIComponent(episode)}&type=${encodeURIComponent(audio)}`);
  const streams = normalizeStreams(data, data?.provider || 'kuhi', 'kuhi', episode, audio);
  attempts.push({ engine: 'kuhi', provider: data?.provider || null, streams: streams.length });
  return validateAndReturn(streams, data?.provider || 'kuhi', 'kuhi', episode, audio, attempts);
}

async function tryAnivexa(anilistId, episode, audio, attempts) {
  const data = await fetchJson(`http://127.0.0.1:${ANIVEXA_PORT}/episodes/${encodeURIComponent(anilistId)}`);
  const candidates = [];
  for (const [provider, entry] of Object.entries(data || {})) {
    const lists = entry?.episodes?.[audio] || [];
    const match = lists.find((ep) => Number(ep?.number) === Number(episode));
    if (match?.id) candidates.push({ provider, id: match.id });
  }
  for (const candidate of candidates) {
    try {
      const path = candidate.id.startsWith('/') ? candidate.id : `/${candidate.id}`;
      const result = await fetchJson(`http://127.0.0.1:${ANIVEXA_PORT}${path}`);
      const streams = normalizeStreams(result, candidate.provider, 'anivexa', episode, audio);
      attempts.push({ engine: 'anivexa', provider: candidate.provider, streams: streams.length });
      try { return await validateAndReturn(streams, candidate.provider, 'anivexa', episode, audio, attempts); } catch {}
    } catch (error) {
      attempts.push({ engine: 'anivexa', provider: candidate.provider, error: error.message });
    }
  }
  throw new Error('No validated Anivexa provider stream');
}

async function trySdk(anilistId, episode, audio, attempts) {
  let titleData;
  try {
    titleData = await fetchJson(`http://127.0.0.1:${KUHI_PORT}/info/${encodeURIComponent(anilistId)}`);
  } catch {
    titleData = null;
  }
  const title = titleData?.title?.userPreferred || titleData?.title?.english || titleData?.title?.romaji;
  if (!title) throw new Error('Unable to resolve anime title for SDK fallback');

  const sdkProviders = [
    'gogoanime', 'goyabu', 'allmanga', 'animeparadise', 'anikoto', 'megaplay', 'mangadex', 'weebcentral', 'mangapill'
  ];
  for (const provider of sdkProviders) {
    try {
      const results = await fetchJson(`http://127.0.0.1:${SDK_PORT}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(title)}`);
      const match = Array.isArray(results) ? results[0] : null;
      if (!match?.id) { attempts.push({ engine: 'anime-sdk', provider, error: 'no title match' }); continue; }
      const units = await fetchJson(`http://127.0.0.1:${SDK_PORT}/content?provider=${encodeURIComponent(provider)}&mediaId=${encodeURIComponent(match.id)}`);
      const unit = Array.isArray(units) ? units.find((u) => Number(u.number) === Number(episode)) : null;
      if (!unit?.id) { attempts.push({ engine: 'anime-sdk', provider, error: 'episode not found' }); continue; }
      const stream = await fetchJson(`http://127.0.0.1:${SDK_PORT}/stream?provider=${encodeURIComponent(provider)}&unitId=${encodeURIComponent(unit.id)}&language=${encodeURIComponent(audio)}`);
      const streams = normalizeStreams(stream, provider, 'anime-sdk', episode, audio);
      attempts.push({ engine: 'anime-sdk', provider, streams: streams.length });
      try { return await validateAndReturn(streams, provider, 'anime-sdk', episode, audio, attempts); } catch {}
    } catch (error) {
      attempts.push({ engine: 'anime-sdk', provider, error: error.message });
    }
  }
  throw new Error('No validated anime-sdk provider stream');
}

async function unifiedWatch(req, res, url) {
  const anilistId = url.searchParams.get('anilistId') || url.searchParams.get('id');
  const episode = url.searchParams.get('episode') || url.searchParams.get('ep') || '1';
  const audio = (url.searchParams.get('type') || url.searchParams.get('language') || 'sub').toLowerCase();
  if (!/^\d+$/.test(String(anilistId || ''))) return json(res, 400, { error: 'anilistId must be numeric' });
  if (!/^\d+(?:\.\d+)?$/.test(String(episode))) return json(res, 400, { error: 'episode must be numeric' });
  if (!['sub', 'dub', 'raw'].includes(audio)) return json(res, 400, { error: 'type must be sub, dub, or raw' });

  const attempts = [];
  const engines = [
    () => tryKuhi(anilistId, episode, audio, attempts),
    () => tryAnivexa(anilistId, episode, audio, attempts),
    () => trySdk(anilistId, episode, audio, attempts),
  ];
  for (const attempt of engines) {
    try { return json(res, 200, await attempt()); } catch (error) {
      attempts.push({ error: error.message });
    }
  }
  return json(res, 502, {
    ok: false,
    error: 'No provider returned a validated stream',
    anilistId: Number(anilistId),
    episode: Number(episode),
    audio,
    attempts,
  });
}

async function proxy(req, res, targetBase, prefix) {
  const suffix = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url;
  const target = new URL(suffix, targetBase);
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  delete headers['content-length'];

  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : req;
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    res.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) {
      if (key !== 'transfer-encoding' && key !== 'content-length') res.setHeader(key, value);
    }
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    json(res, 502, { error: 'upstream unavailable', detail: error?.message || String(error) });
  }
}

let shuttingDown = false;
const servers = [];

const anivexaServer = await startAnivexa();
servers.push(anivexaServer);
const sdkServer = await startSdk();
servers.push(sdkServer);
const kuhi = startKuhi();
const kuhiStarted = await waitForKuhi();
services.kuhi.ready = kuhiStarted;
await refreshHealth();
services.anivexa.ready = services.anivexa.ok;
services.animeSdk.ready = services.animeSdk.ok;
services.kuhi.ready = kuhiStarted && services.kuhi.ok;

const publicServer = http.createServer(async (req, res) => {
  securityHeaders(res);

  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (!allowed(req)) return json(res, 429, { error: 'rate limit exceeded', retryAfterMs: RATE_WINDOW_MS });

  const p = (req.url || '/').split('?')[0];

  if (p === '/health') {
    await refreshHealth();
    const allReady = services.anivexa.ready && services.animeSdk.ready && services.kuhi.ready;
    return json(res, allReady ? 200 : 503, {
      ok: allReady,
      name: 'Unified Anime API',
      version: process.env.API_VERSION || '2.1.1',
      services,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  }

  if (p === '/ready') {
    const ready = services.anivexa.ready && services.animeSdk.ready && services.kuhi.ready;
    return json(res, ready ? 200 : 503, { ready });
  }

  if (p === '/api/watch' || p === '/api/stream') return unifiedWatch(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`));

  if (p === '/') {
    return json(res, 200, {
      name: 'Unified Anime API',
      version: process.env.API_VERSION || '2.1.1',
      status: 'online',
      endpoints: {
        watch: '/api/watch?anilistId=21&episode=1&type=sub',
        health: '/health',
        ready: '/ready',
        anivexa: '/anivexa/*',
        animeSdk: '/sdk/*',
        kuhi: '/kuhi/*',
      },
    });
  }

  if (p.startsWith('/anivexa/')) return proxy(req, res, `http://127.0.0.1:${ANIVEXA_PORT}`, '/anivexa');
  if (p.startsWith('/sdk/')) return proxy(req, res, `http://127.0.0.1:${SDK_PORT}`, '/sdk');
  if (p.startsWith('/kuhi/')) return proxy(req, res, `http://127.0.0.1:${KUHI_PORT}`, '/kuhi');

  return json(res, 404, { error: 'route not found', path: p });
});

publicServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] Unified Anime API listening on :${PORT}`);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gateway] ${signal}: shutting down`);
  publicServer.close();
  for (const server of servers) server.close?.();
  kuhi.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
