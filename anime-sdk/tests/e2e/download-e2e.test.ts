/**
 * E2E download tests for every provider.
 *
 * Anime providers: downloads episode 1 of JJK (dub preferred, sub fallback) as .mp4
 * Manga providers: downloads a chapter of JJK as individual page + .zip
 *
 * Output lands in scratch/downloads/ (gitignored).
 *
 * To run: npx vitest run tests/e2e/download-e2e.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HttpClient } from '../../src/transport/http.js';
import { AllmangaProvider } from '../../src/providers/AllmangaProvider.js';
import { GogoanimeProvider } from '../../src/providers/GogoanimeProvider.js';
import { GoyabuProvider } from '../../src/providers/GoyabuProvider.js';
import { AnikotoProvider } from '../../src/providers/AnikotoProvider.js';
import { MegaPlayProvider } from '../../src/providers/MegaPlayProvider.js';
import { AnimeParadiseProvider } from '../../src/providers/AnimeParadiseProvider.js';
import { MangadexProvider } from '../../src/providers/MangadexProvider.js';
import { WeebcentralProvider } from '../../src/providers/WeebcentralProvider.js';
import { MangapillProvider } from '../../src/providers/MangapillProvider.js';
import {
  downloadVideo,
  downloadMangaPage,
  downloadMangaChapter,
} from '../../src/download/download.js';
import { ContentLanguage, ResolvedMediaStream } from '../../src/types/index.js';
import { BaseProvider } from '../../src/providers/BaseProvider.js';

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'scratch/downloads');

beforeAll(() => {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
});

// ─── Helper: resolve a video stream for an anime provider ────────────────────

async function resolveAnimeStream(
  provider: BaseProvider,
  query: string,
  preferredLang: ContentLanguage = 'dub',
): Promise<{ stream: ResolvedMediaStream; episodeTitle: string }> {
  const results = await provider.search(query);
  expect(results.length).toBeGreaterThan(0);

  // Pick the first result that looks like JJK but is NOT a movie or season 2
  const target =
    results.find((r) => {
      const t = r.title.toLowerCase();
      const isJjk = t.includes('jujutsu') || t.includes('kaisen');
      const isS2OrMovie =
        t.includes('movie') ||
        t.includes('0') ||
        t.includes('2') ||
        t.includes('3') ||
        t.includes('season 2') ||
        t.includes('2nd season') ||
        t.includes('hidden inventory') ||
        t.includes('shibuya') ||
        t.includes('culling game');
      return isJjk && !isS2OrMovie;
    }) ?? results[0];
  console.log(`[${provider.id}] Selected: ${target.title} (${target.id})`);

  const units = await provider.fetchContentUnits(target.id);
  expect(units.length).toBeGreaterThan(0);

  const ep1 = units[0];
  console.log(`[${provider.id}] Episode: ${ep1.title} (${ep1.id})`);

  // Try preferred language, fall back
  let lang: ContentLanguage | undefined = preferredLang;
  if (ep1.availableLanguages && !ep1.availableLanguages.includes(preferredLang)) {
    lang = ep1.availableLanguages[0];
  }

  const stream = await provider.resolveStream(ep1.id, lang);
  return { stream, episodeTitle: ep1.title };
}

// ─── Helper: resolve a manga stream for a manga provider ─────────────────────

async function resolveMangaStream(
  provider: BaseProvider,
  query: string,
): Promise<{ stream: ResolvedMediaStream; chapterTitle: string }> {
  const results = await provider.search(query);
  expect(results.length).toBeGreaterThan(0);

  const target =
    results.find(
      (r) => r.title.toLowerCase().includes('jujutsu') || r.title.toLowerCase().includes('kaisen'),
    ) ?? results[0];
  console.log(`[${provider.id}] Selected: ${target.title} (${target.id})`);

  const units = await provider.fetchContentUnits(target.id);
  expect(units.length).toBeGreaterThan(0);

  const ch1 = units[0];
  console.log(`[${provider.id}] Chapter: ${ch1.title} (${ch1.id})`);

  const stream = await provider.resolveStream(ch1.id);
  return { stream, chapterTitle: ch1.title };
}

// ─── Helper: verify MP4 file ─────────────────────────────────────────────────

function assertValidMp4(filePath: string): void {
  expect(fs.existsSync(filePath)).toBe(true);
  const stat = fs.statSync(filePath);
  // We expect at least a 20MB file. High quality will be > 200MB, but some providers serve 480p/720p.
  expect(stat.size).toBeGreaterThan(20 * 1024 * 1024);
  console.log(`  → ${path.basename(filePath)}: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  // Check for ftyp box (MP4 container signature) at offset 4
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  const ftyp = buf.subarray(4, 8).toString('ascii');
  expect(ftyp).toBe('ftyp');
}

// ─── Helper: verify image file ───────────────────────────────────────────────

function assertValidImage(filePath: string): void {
  expect(fs.existsSync(filePath)).toBe(true);
  const stat = fs.statSync(filePath);
  expect(stat.size).toBeGreaterThan(1024);
  console.log(`  → ${path.basename(filePath)}: ${(stat.size / 1024).toFixed(1)} KB`);
}

// ─── Helper: verify ZIP file ─────────────────────────────────────────────────

function assertValidZip(filePath: string): void {
  expect(fs.existsSync(filePath)).toBe(true);
  const stat = fs.statSync(filePath);
  expect(stat.size).toBeGreaterThan(1024);
  console.log(`  → ${path.basename(filePath)}: ${(stat.size / 1024).toFixed(1)} KB`);

  const buf = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  // PK\x03\x04
  expect(buf[0]).toBe(0x50);
  expect(buf[1]).toBe(0x4b);
  expect(buf[2]).toBe(0x03);
  expect(buf[3]).toBe(0x04);
}

// ─── Anime Provider Download Tests ──────────────────────────────────────────

describe('Anime Downloads (JJK Episode 1)', () => {
  const http = new HttpClient({ timeoutMs: 30000 });

  it('allmanga → .mp4', async () => {
    const provider = new AllmangaProvider(http);
    const { stream } = await resolveAnimeStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    const outPath = path.join(DOWNLOAD_DIR, 'allmanga_jjk_ep1.mp4');
    await downloadVideo(stream.streams, outPath, { timeoutMs: 1_200_000 });
    assertValidMp4(outPath);
  }, 1_200_000);

  it('gogoanime → .mp4', async () => {
    const provider = new GogoanimeProvider(http);
    const { stream } = await resolveAnimeStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    const outPath = path.join(DOWNLOAD_DIR, 'gogoanime_jjk_ep1.mp4');
    await downloadVideo(stream.streams, outPath, { timeoutMs: 1_200_000 });
    assertValidMp4(outPath);
  }, 1_200_000);

  it('goyabu → .mp4', async () => {
    const provider = new GoyabuProvider(http);
    const { stream } = await resolveAnimeStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    const outPath = path.join(DOWNLOAD_DIR, 'goyabu_jjk_ep1.mp4');
    await downloadVideo(stream.streams, outPath, { timeoutMs: 1_200_000 });
    assertValidMp4(outPath);
  }, 1_200_000);

  it('anikoto → .mp4', async () => {
    const provider = new AnikotoProvider(http);
    const { stream } = await resolveAnimeStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    const outPath = path.join(DOWNLOAD_DIR, 'anikoto_jjk_ep1.mp4');
    await downloadVideo(stream.streams, outPath, { timeoutMs: 1_200_000 });
    assertValidMp4(outPath);
  }, 1_200_000);

  it('megaplay → .mp4', async () => {
    const provider = new MegaPlayProvider(http);
    const { stream } = await resolveAnimeStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    const outPath = path.join(DOWNLOAD_DIR, 'megaplay_jjk_ep1.mp4');
    await downloadVideo(stream.streams, outPath, { timeoutMs: 1_200_000 });
    assertValidMp4(outPath);
  }, 1_200_000);

  it('animeparadise → .mp4', async () => {
    const provider = new AnimeParadiseProvider(http);
    const { stream } = await resolveAnimeStream(provider, 'Jujutsu Kaisen', 'sub');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    const outPath = path.join(DOWNLOAD_DIR, 'animeparadise_jjk_ep1.mp4');
    await downloadVideo(stream.streams, outPath, { timeoutMs: 1_200_000 });
    assertValidMp4(outPath);
  }, 1_200_000);
});

// ─── Manga Provider Download Tests ──────────────────────────────────────────

describe('Manga Downloads (JJK Chapter)', () => {
  const http = new HttpClient({ timeoutMs: 30000 });

  it('mangadex → page image + chapter .zip', async () => {
    const provider = new MangadexProvider(http);
    const { stream } = await resolveMangaStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('manga');
    if (stream.type !== 'manga') return;

    // Download single page
    const pageResult = await downloadMangaPage(stream.pages, 0, DOWNLOAD_DIR);
    assertValidImage(pageResult.outputPath);

    // Rename to standard name
    const pageOutPath = path.join(
      DOWNLOAD_DIR,
      `mangadex_jjk_page1${path.extname(pageResult.outputPath)}`,
    );
    if (pageResult.outputPath !== pageOutPath) {
      fs.renameSync(pageResult.outputPath, pageOutPath);
    }

    // Download chapter as ZIP
    const zipPath = path.join(DOWNLOAD_DIR, 'mangadex_jjk_chapter.zip');
    await downloadMangaChapter(stream.pages, zipPath);
    assertValidZip(zipPath);
  }, 120_000);

  it('weebcentral → page image + chapter .zip', async () => {
    const provider = new WeebcentralProvider(http);
    const { stream } = await resolveMangaStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('manga');
    if (stream.type !== 'manga') return;

    // Download single page
    const pageResult = await downloadMangaPage(stream.pages, 0, DOWNLOAD_DIR);
    assertValidImage(pageResult.outputPath);

    const pageOutPath = path.join(
      DOWNLOAD_DIR,
      `weebcentral_jjk_page1${path.extname(pageResult.outputPath)}`,
    );
    if (pageResult.outputPath !== pageOutPath) {
      fs.renameSync(pageResult.outputPath, pageOutPath);
    }

    // Download chapter as ZIP
    const zipPath = path.join(DOWNLOAD_DIR, 'weebcentral_jjk_chapter.zip');
    await downloadMangaChapter(stream.pages, zipPath);
    assertValidZip(zipPath);
  }, 120_000);

  it('mangapill → page image + chapter .zip', async () => {
    const provider = new MangapillProvider(http);
    const { stream } = await resolveMangaStream(provider, 'Jujutsu Kaisen');
    expect(stream.type).toBe('manga');
    if (stream.type !== 'manga') return;

    // Download single page
    const pageResult = await downloadMangaPage(stream.pages, 0, DOWNLOAD_DIR);
    assertValidImage(pageResult.outputPath);

    const pageOutPath = path.join(
      DOWNLOAD_DIR,
      `mangapill_jjk_page1${path.extname(pageResult.outputPath)}`,
    );
    if (pageResult.outputPath !== pageOutPath) {
      fs.renameSync(pageResult.outputPath, pageOutPath);
    }

    // Download chapter as ZIP
    const zipPath = path.join(DOWNLOAD_DIR, 'mangapill_jjk_chapter.zip');
    await downloadMangaChapter(stream.pages, zipPath);
    assertValidZip(zipPath);
  }, 120_000);
});
