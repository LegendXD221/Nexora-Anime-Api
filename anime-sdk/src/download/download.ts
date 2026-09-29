import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IVideoPayload, IMangaPayload } from '../types/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DownloadVideoOptions {
  /** Called periodically with progress info. */
  onProgress?: (info: { phase: string; detail?: string }) => void;
  /** Timeout in ms for the overall ffmpeg process. Default 300000 (5 min). */
  timeoutMs?: number;
}

export interface DownloadVideoResult {
  outputPath: string;
  stream: IVideoPayload;
  fileSize: number;
}

export interface DownloadMangaPageOptions {
  /** Custom headers to use instead of the ones on IMangaPayload. */
  headers?: Record<string, string>;
  /** Timeout in ms for the fetch. Default 30000. */
  timeoutMs?: number;
}

export interface DownloadMangaPageResult {
  outputPath: string;
  pageIndex: number;
  fileSize: number;
  contentType: string;
}

export interface DownloadMangaChapterOptions {
  /** Called periodically with progress info. */
  onProgress?: (info: { downloaded: number; total: number }) => void;
  /** Timeout in ms per page fetch. Default 30000. */
  timeoutMs?: number;
}

export interface DownloadMangaChapterResult {
  outputPath: string;
  pageCount: number;
  fileSize: number;
}

// ─── HLS Helpers ─────────────────────────────────────────────────────────────

interface HlsSegment {
  url: string;
  duration: number;
}

/**
 * Parse an M3U8 master playlist and return variant playlist URLs,
 * ordered as they appear (typically lowest → highest quality).
 */
export function parseHlsMaster(content: string, baseUrl: string): string[] {
  const variants: string[] = [];
  for (const line of content.split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    try {
      variants.push(new URL(line, baseUrl).toString());
    } catch {
      variants.push(line);
    }
  }
  return variants;
}

/**
 * Parse an M3U8 media playlist and return segment URLs with durations.
 */
export function parseHlsSegments(content: string, baseUrl: string): HlsSegment[] {
  const segments: HlsSegment[] = [];
  let dur = 0;
  for (const line of content.split('\n').map((l) => l.trim())) {
    if (line.startsWith('#EXTINF:')) {
      const m = line.match(/#EXTINF:([0-9.]+)/);
      if (m) dur = parseFloat(m[1]);
    } else if (line && !line.startsWith('#')) {
      try {
        segments.push({ url: new URL(line, baseUrl).toString(), duration: dur });
      } catch {
        segments.push({ url: line, duration: dur });
      }
    }
  }
  return segments;
}

/**
 * Detect image file extension from Content-Type header.
 */
export function detectImageExtension(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('bmp')) return '.bmp';
  if (ct.includes('avif')) return '.avif';
  // Default to jpg for jpeg, octet-stream, or unknown
  return '.jpg';
}

// ─── Default fetch headers ──────────────────────────────────────────────────

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function mergeHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'User-Agent': DEFAULT_UA, ...(extra ?? {}) };
}

// ─── Video Download ─────────────────────────────────────────────────────────

/**
 * Download a video stream to a `.mp4` file. Tries each stream candidate in
 * order until one succeeds. HLS streams are muxed via `ffmpeg -i <url> -c copy`.
 * Direct MP4 streams are downloaded via fetch.
 *
 * @param streams - One or more `IVideoPayload` candidates (from `resolveStream`)
 * @param outputPath - Destination file path (must end in `.mp4`)
 * @param options - Optional progress/timeout configuration
 * @returns Info about the successful download
 */
export async function downloadVideo(
  streams: IVideoPayload | IVideoPayload[],
  outputPath: string,
  options?: DownloadVideoOptions,
): Promise<DownloadVideoResult> {
  const list = Array.isArray(streams) ? streams : [streams];
  if (list.length === 0) throw new Error('downloadVideo: streams array is empty');

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timeout = options?.timeoutMs ?? 300_000;
  const errors: string[] = [];

  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    options?.onProgress?.({
      phase: 'resolving',
      detail: `Trying candidate ${i + 1}/${list.length}: ${candidate.sourceUrl.slice(0, 120)}`,
    });

    try {
      let target = candidate.sourceUrl;
      let isHls = candidate.isHLS;
      const headers = candidate.headers ?? {};

      // Probe if we're not sure
      if (!isHls && !target.includes('.m3u8') && !target.includes('.mp4')) {
        const probed = await probeIsVideo(target, headers);
        if (!probed.isVideo) {
          const scraped = await scrapeForStreamUrl(target, headers);
          if (scraped) {
            target = scraped.url;
            isHls = scraped.isHls;
          }
        }
      }

      if (isHls || target.includes('.m3u8')) {
        options?.onProgress?.({
          phase: 'downloading',
          detail: 'Downloading HLS segments manually',
        });
        await downloadHlsSegments(target, outputPath, headers, timeout, options?.onProgress);
      } else {
        options?.onProgress?.({ phase: 'downloading', detail: 'Downloading MP4 directly' });
        await downloadMp4Direct(target, outputPath, headers, timeout);
      }

      const stat = fs.statSync(outputPath);
      if (stat.size < 1024) {
        throw new Error(`Downloaded file is too small (${stat.size} bytes)`);
      }

      options?.onProgress?.({ phase: 'complete', detail: outputPath });
      return { outputPath, stream: candidate, fileSize: stat.size };
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`#${i + 1} (${candidate.sourceUrl.slice(0, 60)}…): ${msg}`);
    }
  }

  throw new Error(
    `downloadVideo exhausted all ${list.length} candidate(s).\n` +
      errors.map((e) => `  - ${e}`).join('\n'),
  );
}

/** Probe a URL to check if it serves video bytes. */
async function probeIsVideo(
  url: string,
  headers: Record<string, string>,
): Promise<{ isVideo: boolean }> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...mergeHeaders(headers), Range: 'bytes=0-2048' },
    });
    if (res.status !== 200 && res.status !== 206) return { isVideo: false };
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.startsWith('text/html') || ct.startsWith('application/xhtml')) return { isVideo: false };
    if (
      ct.startsWith('video/') ||
      ct.includes('mpegurl') ||
      ct.includes('mp2t') ||
      ct.startsWith('application/octet-stream')
    ) {
      return { isVideo: true };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
      return { isVideo: true };
    }
    return { isVideo: false };
  } catch {
    return { isVideo: false };
  }
}

/** Scrape an HTML embed page for a stream URL. */
async function scrapeForStreamUrl(
  pageUrl: string,
  headers: Record<string, string>,
): Promise<{ url: string; isHls: boolean } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let html = '';
    try {
      const res = await fetch(pageUrl, {
        headers: mergeHeaders(headers),
        signal: ctrl.signal,
      });
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const pickFirst = (text: string, re: RegExp): string | null => {
      const a = text.match(re);
      if (a) return a[0];
      const b = text.replace(/\\\//g, '/').match(re);
      return b ? b[0] : null;
    };

    const m3u8 = pickFirst(
      html,
      /https?:\/\/[^"'\s<>\\]+?\/[^"'\s<>\\/]+\.m3u8(?:[?#][^"'\s<>\\]*)?/i,
    );
    if (m3u8) return { url: m3u8.replace(/&amp;/g, '&'), isHls: true };

    const mp4 = pickFirst(
      html,
      /https?:\/\/[^"'\s<>\\]+?\/[^"'\s<>\\/]+\.mp4(?:[?#][^"'\s<>\\]*)?/i,
    );
    if (mp4) return { url: mp4.replace(/&amp;/g, '&'), isHls: false };

    return null;
  } catch {
    return null;
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND_MAGIC = Buffer.from([0x49, 0x45, 0x4e, 0x44]);

function stripPngHeader(buffer: Buffer): Buffer {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    const idx = buffer.indexOf(IEND_MAGIC);
    if (idx !== -1) {
      const offset = idx + 8;
      if (offset < buffer.length) return buffer.subarray(offset);
    }
  }
  return buffer;
}

/**
 * Download an HLS stream by manually downloading segments, stripping PNG headers,
 * and concatenating them into a temp file, then muxing to MP4 using ffmpeg.
 */
async function downloadHlsSegments(
  playlistUrl: string,
  outputPath: string,
  headers: Record<string, string>,
  timeoutMs: number,
  onProgress?: (info: { phase: string; detail?: string }) => void,
): Promise<void> {
  let currentUrl = playlistUrl;
  let res = await fetch(currentUrl, { headers: mergeHeaders(headers) });
  if (!res.ok)
    throw new Error(`Playlist ${res.status} ${res.statusText} (${currentUrl.slice(0, 120)})`);
  let playlist = await res.text();

  // Walk down master → variant playlists (max 2 hops)
  for (let hops = 0; hops < 2 && playlist.includes('#EXT-X-STREAM-INF'); hops++) {
    const variants = parseHlsMaster(playlist, currentUrl);
    if (variants.length === 0) throw new Error('Master playlist has no variants');
    currentUrl = variants[variants.length - 1]; // pick highest quality (last)
    res = await fetch(currentUrl, { headers: mergeHeaders(headers) });
    if (!res.ok) throw new Error(`Variant ${res.status} (${currentUrl.slice(0, 120)})`);
    playlist = await res.text();
  }

  const segments = parseHlsSegments(playlist, currentUrl);
  if (segments.length === 0) throw new Error('No segments in playlist');

  const dir = path.dirname(outputPath);
  const tmpTs = path.join(dir, `tmp_${path.basename(outputPath, '.mp4')}_concat.ts`);

  if (fs.existsSync(tmpTs)) fs.unlinkSync(tmpTs);

  const fd = fs.openSync(tmpTs, 'a');
  try {
    for (let i = 0; i < segments.length; i++) {
      onProgress?.({
        phase: 'downloading',
        detail: `Segment ${i + 1}/${segments.length}`,
      });

      const seg = segments[i];
      const segRes = await fetch(seg.url, { headers: mergeHeaders(headers) });
      if (!segRes.ok) throw new Error(`Segment ${i} failed: HTTP ${segRes.status}`);

      const arrayBuf = await segRes.arrayBuffer();
      const bytes = stripPngHeader(Buffer.from(arrayBuf as ArrayBuffer));
      fs.writeSync(fd, bytes, 0, bytes.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }

  onProgress?.({ phase: 'muxing', detail: 'Muxing segments to MP4 via ffmpeg' });

  const cmd = [
    'ffmpeg -y',
    '-loglevel error',
    `-i ${JSON.stringify(tmpTs)}`,
    '-c copy',
    '-movflags +faststart',
    JSON.stringify(outputPath),
  ]
    .filter(Boolean)
    .join(' ');

  try {
    execSync(cmd, { stdio: 'pipe', timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });
  } catch (e: any) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    throw new Error(`ffmpeg failed: ${e.message}\n${stderr}`);
  }

  if (fs.existsSync(tmpTs)) fs.unlinkSync(tmpTs);
}

/**
 * Download a direct MP4 URL to disk using fetch streaming.
 */
async function downloadMp4Direct(
  mp4Url: string,
  outputPath: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(mp4Url, {
      headers: mergeHeaders(headers),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('Response body is null');

    const fileStream = fs.createWriteStream(outputPath);
    const reader = res.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
      }
    } finally {
      fileStream.close();
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── Manga Download ─────────────────────────────────────────────────────────

/**
 * Download a single manga page image to disk.
 *
 * @param pages - The `IMangaPayload` from `resolveStream`
 * @param pageIndex - 0-based page index
 * @param outputDir - Directory to save the image (filename is auto-generated)
 * @param options - Optional configuration
 */
export async function downloadMangaPage(
  pages: IMangaPayload,
  pageIndex: number,
  outputDir: string,
  options?: DownloadMangaPageOptions,
): Promise<DownloadMangaPageResult> {
  if (pageIndex < 0 || pageIndex >= pages.imageUrls.length) {
    throw new Error(`Page index ${pageIndex} out of range (0-${pages.imageUrls.length - 1})`);
  }

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const url = pages.imageUrls[pageIndex];
  const headers = options?.headers ?? pages.headers ?? {};
  const timeout = options?.timeoutMs ?? 30_000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: mergeHeaders(headers),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching page ${pageIndex}`);

    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const ext = detectImageExtension(contentType);
    const paddedIndex = String(pageIndex + 1).padStart(3, '0');
    const filename = `page_${paddedIndex}${ext}`;
    const outputPath = path.join(outputDir, filename);

    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outputPath, buf);

    return { outputPath, pageIndex, fileSize: buf.length, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download an entire manga chapter as a `.zip` archive.
 * Uses a minimal zero-dependency ZIP writer (STORE method — images are
 * already compressed, so no deflation needed).
 *
 * @param pages - The `IMangaPayload` from `resolveStream`
 * @param outputPath - Destination `.zip` file path
 * @param options - Optional configuration
 */
export async function downloadMangaChapter(
  pages: IMangaPayload,
  outputPath: string,
  options?: DownloadMangaChapterOptions,
): Promise<DownloadMangaChapterResult> {
  if (pages.imageUrls.length === 0) {
    throw new Error('downloadMangaChapter: no pages to download');
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const headers = pages.headers ?? {};
  const timeout = options?.timeoutMs ?? 30_000;
  const entries: ZipEntry[] = [];

  for (let i = 0; i < pages.imageUrls.length; i++) {
    options?.onProgress?.({ downloaded: i, total: pages.imageUrls.length });

    const url = pages.imageUrls[i];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const res = await fetch(url, {
        headers: mergeHeaders(headers),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching page ${i}`);

      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      const ext = detectImageExtension(contentType);
      const paddedIndex = String(i + 1).padStart(3, '0');
      const filename = `${paddedIndex}${ext}`;

      const data = Buffer.from(await res.arrayBuffer());
      entries.push({ filename, data });
    } finally {
      clearTimeout(timer);
    }
  }

  options?.onProgress?.({ downloaded: pages.imageUrls.length, total: pages.imageUrls.length });

  const zipBuffer = createZipBuffer(entries);
  fs.writeFileSync(outputPath, zipBuffer);

  return {
    outputPath,
    pageCount: entries.length,
    fileSize: zipBuffer.length,
  };
}

// ─── Minimal ZIP Writer (STORE, no compression) ─────────────────────────────
// Implements the ZIP spec just enough for uncompressed archives.
// Images are already compressed (JPEG/PNG/WebP), so STORE is optimal.

interface ZipEntry {
  filename: string;
  data: Buffer;
}

/** CRC-32 lookup table. */
const crc32Table: number[] = [];
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crc32Table[i] = c;
}

/** Compute CRC-32 for a buffer. */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Create a ZIP file buffer from an array of entries using the STORE method.
 * No compression — perfect for already-compressed image data.
 */
export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDirEntries: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.filename, 'utf8');
    const crcVal = crc32(entry.data);
    const size = entry.data.length;

    // Local File Header (30 bytes + filename)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // Local file header signature
    local.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    local.writeUInt16LE(0, 6); // General purpose bit flag
    local.writeUInt16LE(0, 8); // Compression method: STORE
    local.writeUInt16LE(0, 10); // Last mod file time
    local.writeUInt16LE(0, 12); // Last mod file date
    local.writeUInt32LE(crcVal, 14); // CRC-32
    local.writeUInt32LE(size, 18); // Compressed size
    local.writeUInt32LE(size, 22); // Uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // Filename length
    local.writeUInt16LE(0, 28); // Extra field length
    nameBytes.copy(local, 30);

    parts.push(local, entry.data);

    // Central Directory File Header (46 bytes + filename)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // Central directory signature
    central.writeUInt16LE(20, 4); // Version made by
    central.writeUInt16LE(20, 6); // Version needed
    central.writeUInt16LE(0, 8); // General purpose bit flag
    central.writeUInt16LE(0, 10); // Compression method: STORE
    central.writeUInt16LE(0, 12); // Last mod file time
    central.writeUInt16LE(0, 14); // Last mod file date
    central.writeUInt32LE(crcVal, 16); // CRC-32
    central.writeUInt32LE(size, 20); // Compressed size
    central.writeUInt32LE(size, 24); // Uncompressed size
    central.writeUInt16LE(nameBytes.length, 28); // Filename length
    central.writeUInt16LE(0, 30); // Extra field length
    central.writeUInt16LE(0, 32); // File comment length
    central.writeUInt16LE(0, 34); // Disk number start
    central.writeUInt16LE(0, 36); // Internal file attributes
    central.writeUInt32LE(0, 38); // External file attributes
    central.writeUInt32LE(offset, 42); // Relative offset of local header
    nameBytes.copy(central, 46);

    centralDirEntries.push(central);

    offset += local.length + entry.data.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralDirEntries);
  const centralDirSize = centralDir.length;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // Entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12); // Central directory size
  eocd.writeUInt32LE(centralDirOffset, 16); // Central directory offset
  eocd.writeUInt16LE(0, 20); // ZIP file comment length

  parts.push(centralDir, eocd);
  return Buffer.concat(parts);
}
