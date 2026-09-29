/**
 * E2E integration tests for AllmangaProvider.
 *
 * To run: npx vitest run tests/e2e/allmanga.test.ts
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { AllmangaProvider } from '../../src/providers/AllmangaProvider.js';
import { captureStreamScreenshot } from './screenshotHelper.js';

describe('AllManga E2E', () => {
  it('searches, fetches episodes, resolves a stream, and captures a screenshot', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new AllmangaProvider(http);

    // Pick a long-running show with a robust source mix.
    const query = 'Frieren';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    // Prefer the mainline "Beyond Journey's End" so we don't end up on a
    // promo short with no sources.
    const target =
      searchResults.find(
        (r) =>
          r.title.toLowerCase().includes("beyond journey's end") &&
          !r.title.toLowerCase().includes('mini'),
      ) ?? searchResults[0];

    expect(target.providerId).toBe('allmanga');
    console.log(`AllManga selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id, 'sub');
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    const stream = await provider.resolveStream(ep1.id);
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    expect(stream.streams.length).toBeGreaterThan(0);
    console.log(
      `AllManga resolved ${stream.streams.length} stream candidate(s); ` +
        `top: ${stream.streams[0].sourceUrl.slice(0, 80)}`,
    );

    // Iterate candidates until one yields a real screenshot.
    const result = await captureStreamScreenshot('allmanga', stream.streams);
    expect(result.outputPath).toMatch(/screenshot_allmanga\.png$/);
  }, 90000);
});
