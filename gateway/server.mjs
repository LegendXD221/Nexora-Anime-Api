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
const DISCOVERY_TIMEOUT_MS = Number(process.env.DISCOVERY_TIMEOUT_MS || 10000);
const EXTRACTION_TIMEOUT_MS = Number(process.env.EXTRACTION_TIMEOUT_MS || 25000);
const STREAM_VALIDATION_TIMEOUT_MS = Number(process.env.STREAM_VALIDATION_TIMEOUT_MS || 7000);
const HLS_VALIDATION_TIMEOUT_MS = Number(process.env.HLS_VALIDATION_TIMEOUT_MS || 5000);
const TOTAL_REQUEST_DEADLINE_MS = Number(process.env.TOTAL_REQUEST_DEADLINE_MS || 60000);
const MAX_VALIDATION_CANDIDATES = Number(process.env.MAX_VALIDATION_CANDIDATES || 6);
const METADATA_TIMEOUT_MS = Number(process.env.METADATA_TIMEOUT_MS || 10000);
const METADATA_CACHE_TTL_MS = Number(process.env.METADATA_CACHE_TTL_MS || 300000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const rateBuckets = new Map();
const metadataCache = memoryCache();
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
      json(res, 500, { error: 'Anivexa upstream error', detail: safeError(error) });
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



class TimeoutError extends Error {
  constructor(stage) {
    super(`${stage} timeout`);
    this.name = 'TimeoutError';
    this.stage = stage;
  }
}

function safeError(error) {
  if (error instanceof TimeoutError) return error.message;
  const message = error?.message || String(error || 'provider error');
  if (/abort|timeout/i.test(message)) return 'provider timeout';
  if (/HTTP \d{3}/i.test(message)) return message.match(/HTTP \d{3}/i)[0];
  return message.replace(/https?:\/\/\S+/gi, '[upstream]').slice(0, 160);
}

function stageTimeout(stage, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(stage)), timeoutMs);
  const abortParent = () => controller.abort(parentSignal.reason || new Error('request aborted'));
  if (parentSignal) {
    if (parentSignal.aborted) abortParent();
    else parentSignal.addEventListener('abort', abortParent, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortParent);
    },
  };
}

async function fetchJson(url, { timeoutMs = EXTRACTION_TIMEOUT_MS, stage = 'provider', signal, headers, ...options } = {}) {
  const timed = stageTimeout(stage, timeoutMs, signal);
  try {
    const response = await fetch(url, { ...options, headers, signal: timed.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (timed.signal.aborted) {
      if (timed.signal.reason instanceof TimeoutError) throw timed.signal.reason;
      throw new Error('request aborted');
    }
    throw error;
  } finally {
    timed.cleanup();
  }
}

function streamKey(stream) {
  return `${String(stream.url).replace(/[?#].*$/, '').toLowerCase()}|${String(stream.server || '').toLowerCase()}`;
}

function normalizeStreams(payload, provider, engine, episode, audio) {
  if (!payload || !Array.isArray(payload.streams)) return [];
  const seen = new Set();
  const result = [];
  for (const s of payload.streams) {
    const url = s?.url || s?.sourceUrl || s?.file || s?.src;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const stream = {
      url,
      type: s.type || (s.isHLS || /\.m3u8(?:$|\?)/i.test(url) ? 'hls' : 'mp4'),
      quality: s.quality || 'auto',
      language: s.audio || s.language || audio,
      headers: s.headers || (s.referer ? { Referer: s.referer } : undefined),
      subtitles: Array.isArray(s.subtitles) ? s.subtitles : [],
      server: s.server || provider,
    };
    const key = streamKey(stream);
    if (!seen.has(key)) { seen.add(key); result.push(stream); }
  }
  return result;
}

function orderStreams(streams) {
  return [...streams].sort((a, b) => {
    const typeRank = (s) => s.type === 'embed' ? 0 : s.type === 'hls' || /\.m3u8/i.test(s.url) ? 3 : 2;
    const q = (v) => Number(String(v.quality || '').replace(/[^0-9]/g, '')) || 0;
    return typeRank(b) - typeRank(a) || q(b) - q(a);
  });
}

async function validateStream(stream, signal) {
  if (!stream?.url) return false;
  const isHls = stream.type === 'hls' || stream.type === 'm3u8' || /\.m3u8(?:$|\?)/i.test(stream.url);
  const timed = stageTimeout(isHls ? 'HLS validation' : 'stream validation', isHls ? HLS_VALIDATION_TIMEOUT_MS : STREAM_VALIDATION_TIMEOUT_MS, signal);
  try {
    const response = await fetch(stream.url, {
      method: isHls ? 'GET' : 'GET',
      headers: { ...(stream.headers || {}), ...(isHls ? {} : { Range: 'bytes=0-1' }) },
      redirect: 'follow',
      signal: timed.signal,
    });
    if (!response.ok) return false;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (isHls) return (await response.text()).includes('#EXTM3U');
    return contentType.startsWith('video/') || contentType.includes('mpegurl') || contentType.includes('octet-stream') || /\.(mp4|mkv)(?:$|\?)/i.test(stream.url);
  } catch {
    return false;
  } finally {
    timed.cleanup();
  }
}

async function validateAndReturn(streams, provider, engine, episode, audio, attempts, signal) {
  const ordered = orderStreams(streams);
  if (!ordered.length) throw new Error('No streams returned');
  const candidates = ordered.slice(0, Math.max(1, MAX_VALIDATION_CANDIDATES));
  for (const stream of candidates) {
    if (signal?.aborted) throw signal.reason || new Error('request deadline exceeded');
    if (await validateStream(stream, signal)) {
      return { ok: true, provider, engine, episode: Number(episode), audio, stream, streams: ordered, attempts };
    }
  }
  throw new Error('Returned streams failed validation');
}

async function tryKuhi(anilistId, episode, audio, attempts, ctx) {
  const data = await fetchJson(`http://127.0.0.1:${KUHI_PORT}/anime/extract/${encodeURIComponent(anilistId)}?e=${encodeURIComponent(episode)}&type=${encodeURIComponent(audio)}`, { timeoutMs: EXTRACTION_TIMEOUT_MS, stage: 'Kuhi extraction', signal: ctx.signal });
  const provider = data?.provider || 'kuhi';
  const streams = normalizeStreams(data, provider, 'kuhi', episode, audio);
  attempts.push({ engine: 'kuhi', provider, streams: streams.length });
  return validateAndReturn(streams, provider, 'kuhi', episode, audio, attempts, ctx.signal);
}

async function tryAnivexa(anilistId, episode, audio, attempts, ctx) {
  const data = await fetchJson(`http://127.0.0.1:${ANIVEXA_PORT}/episodes/${encodeURIComponent(anilistId)}`, { timeoutMs: DISCOVERY_TIMEOUT_MS, stage: 'Anivexa discovery', signal: ctx.signal });
  const candidates = [];
  for (const [provider, entry] of Object.entries(data || {})) {
    const lists = entry?.episodes?.[audio] || [];
    const match = lists.find((ep) => Number(ep?.number) === Number(episode));
    if (match?.id) candidates.push({ provider, id: match.id });
  }
  for (const candidate of candidates) {
    try {
      const path = candidate.id.startsWith('/') ? candidate.id : `/${candidate.id}`;
      const result = await fetchJson(`http://127.0.0.1:${ANIVEXA_PORT}${path}`, { timeoutMs: EXTRACTION_TIMEOUT_MS, stage: 'Anivexa extraction', signal: ctx.signal });
      const streams = normalizeStreams(result, candidate.provider, 'anivexa', episode, audio);
      attempts.push({ engine: 'anivexa', provider: candidate.provider, streams: streams.length });
      try { return await validateAndReturn(streams, candidate.provider, 'anivexa', episode, audio, attempts, ctx.signal); } catch (error) { attempts.push({ engine: 'anivexa', provider: candidate.provider, error: safeError(error) }); }
    } catch (error) {
      attempts.push({ engine: 'anivexa', provider: candidate.provider, error: safeError(error) });
    }
  }
  throw new Error('No validated Anivexa provider stream');
}

async function trySdk(anilistId, episode, audio, attempts, ctx) {
  let titleData;
  try { titleData = await fetchJson(`http://127.0.0.1:${KUHI_PORT}/info/${encodeURIComponent(anilistId)}`, { timeoutMs: DISCOVERY_TIMEOUT_MS, stage: 'SDK title discovery', signal: ctx.signal }); } catch { titleData = null; }
  const title = titleData?.title?.userPreferred || titleData?.title?.english || titleData?.title?.romaji;
  if (!title) throw new Error('Unable to resolve anime title for SDK fallback');
  const sdkProviders = ['gogoanime', 'goyabu', 'allmanga', 'animeparadise', 'anikoto', 'megaplay', 'mangadex', 'weebcentral', 'mangapill'];
  for (const provider of sdkProviders) {
    try {
      const results = await fetchJson(`http://127.0.0.1:${SDK_PORT}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(title)}`, { timeoutMs: DISCOVERY_TIMEOUT_MS, stage: 'SDK provider discovery', signal: ctx.signal });
      const match = Array.isArray(results) ? results[0] : null;
      if (!match?.id) { attempts.push({ engine: 'anime-sdk', provider, error: 'no title match' }); continue; }
      const units = await fetchJson(`http://127.0.0.1:${SDK_PORT}/content?provider=${encodeURIComponent(provider)}&mediaId=${encodeURIComponent(match.id)}`, { timeoutMs: DISCOVERY_TIMEOUT_MS, stage: 'SDK episode discovery', signal: ctx.signal });
      const unit = Array.isArray(units) ? units.find((u) => Number(u.number) === Number(episode)) : null;
      if (!unit?.id) { attempts.push({ engine: 'anime-sdk', provider, error: 'episode not found' }); continue; }
      const stream = await fetchJson(`http://127.0.0.1:${SDK_PORT}/stream?provider=${encodeURIComponent(provider)}&unitId=${encodeURIComponent(unit.id)}&language=${encodeURIComponent(audio)}`, { timeoutMs: EXTRACTION_TIMEOUT_MS, stage: 'SDK extraction', signal: ctx.signal });
      const streams = normalizeStreams(stream, provider, 'anime-sdk', episode, audio);
      attempts.push({ engine: 'anime-sdk', provider, streams: streams.length });
      try { return await validateAndReturn(streams, provider, 'anime-sdk', episode, audio, attempts, ctx.signal); } catch (error) { attempts.push({ engine: 'anime-sdk', provider, error: safeError(error) }); }
    } catch (error) {
      attempts.push({ engine: 'anime-sdk', provider, error: safeError(error) });
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
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new TimeoutError('total request')), TOTAL_REQUEST_DEADLINE_MS);
  const ctx = { signal: deadline.signal };
  const engines = [
    () => tryKuhi(anilistId, episode, audio, attempts, ctx),
    () => tryAnivexa(anilistId, episode, audio, attempts, ctx),
    () => trySdk(anilistId, episode, audio, attempts, ctx),
  ];
  try {
    for (const attempt of engines) {
      if (deadline.signal.aborted) break;
      try { return json(res, 200, await attempt()); } catch (error) { attempts.push({ error: safeError(error) }); }
    }
    return json(res, 502, { ok: false, error: 'No working stream found', anilistId: Number(anilistId), episode: Number(episode), audio, attempts });
  } finally {
    clearTimeout(timer);
  }
}


function forwardQuery(url, names, aliases = {}) {
  const params = new URLSearchParams();
  for (const name of names) {
    const source = aliases[name] || name;
    const value = url.searchParams.get(source);
    if (value !== null && value !== '') params.set(name, value);
  }
  return params.toString();
}

async function metadataFetch(path, cacheKey) {
  const hit = await metadataCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const data = await fetchJson(`http://127.0.0.1:${KUHI_PORT}${path}`, {
    timeoutMs: METADATA_TIMEOUT_MS,
    stage: 'metadata',
  });
  await metadataCache.set(cacheKey, data, METADATA_CACHE_TTL_MS);
  return data;
}

function metadataResult(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ok: true, ...data };
  return { ok: true, data };
}

function metadataError(error, animeRoute = false) {
  if (/HTTP 404/.test(safeError(error))) return { status: 404, body: { ok: false, error: animeRoute ? 'Anime not found' : 'Metadata not found' } };
  return { status: 502, body: { ok: false, error: 'Metadata provider unavailable' } };
}

async function unifiedMetadata(res, url) {
  const path = url.pathname;
  try {
    if (path === '/api/search') {
      const query = url.searchParams.get('q') || url.searchParams.get('query');
      if (!query) return json(res, 400, { ok: false, error: 'q is required' });
      const qs = forwardQuery(url, ['page', 'per_page'], { page: 'page' });
      const suffix = qs ? `?query=${encodeURIComponent(query)}&${qs}` : `?query=${encodeURIComponent(query)}`;
      return json(res, 200, metadataResult(await metadataFetch(`/anime/search${suffix}`, `search:${query}:${qs}`)));
    }

    if (path === '/api/suggestions') {
      const query = url.searchParams.get('q') || url.searchParams.get('query');
      if (!query) return json(res, 400, { ok: false, error: 'q is required' });
      const data = await metadataFetch(`/anime/suggestions?query=${encodeURIComponent(query)}`, `suggestions:${query}`);
      return json(res, 200, { ok: true, results: data?.suggestions || [] });
    }

    const animeMatch = path.match(/^\/api\/anime\/(\d+)(?:\/(characters|relations|recommendations|episodes))?$/);
    if (animeMatch) {
      const id = animeMatch[1];
      const section = animeMatch[2];
      if (!section) {
        const data = await metadataFetch(`/anime/info/${id}`, `anime:${id}`);
        return json(res, 200, { ok: true, data });
      }
      const endpoint = section === 'episodes' ? `/anime/episodes/${id}` : `/anime/anime/${id}/${section}`;
      const data = await metadataFetch(endpoint, `${section}:${id}`);
      if (section === 'episodes') {
        const episodes = Array.isArray(data) ? data : data?.episodes || data?.results || [];
        return json(res, 200, Array.isArray(data) ? { ok: true, episodes } : { ok: true, ...data, episodes });
      }
      return json(res, 200, metadataResult(data));
    }

    const simpleRoutes = {
      '/api/genres': { target: '/anime/genres', key: 'genres', shape: data => ({ ok: true, results: data?.genres || [] }) },
      '/api/spotlight': { target: '/anime/spotlight', key: 'spotlight' },
      '/api/trending': { target: '/anime/trending', key: 'trending' },
      '/api/popular': { target: '/anime/popular', key: 'popular' },
      '/api/upcoming': { target: '/anime/upcoming', key: 'upcoming' },
      '/api/recent': { target: '/anime/recent', key: 'recent' },
      '/api/schedule': { target: '/anime/schedule', key: 'schedule' },
      '/api/filter': { target: '/anime/filter', key: 'filter' },
    };
    const route = simpleRoutes[path];
    if (route) {
      const names = path === '/api/filter'
        ? ['genre', 'tag', 'year', 'season', 'format', 'status', 'sort', 'page', 'per_page']
        : ['page', 'per_page'];
      const qs = forwardQuery(url, names);
      const target = qs ? `${route.target}?${qs}` : route.target;
      const data = await metadataFetch(target, `${route.key}:${qs}`);
      return json(res, 200, route.shape ? route.shape(data) : metadataResult(data));
    }

    return json(res, 404, { ok: false, error: 'route not found' });
  } catch (error) {
    const failure = metadataError(error, /^\/api\/anime\//.test(path));
    return json(res, failure.status, failure.body);
  }
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
    json(res, 502, { error: 'upstream unavailable', detail: safeError(error) });
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
  if (p.startsWith('/api/')) return unifiedMetadata(res, new URL(req.url, `http://${req.headers.host || 'localhost'}`));

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
