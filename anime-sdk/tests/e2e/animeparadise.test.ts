/**
 * E2E integration tests for AnimeParadiseProvider.
 *
 * To run: npx vitest run tests/e2e/animeparadise.test.ts
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { AnimeParadiseProvider } from '../../src/providers/AnimeParadiseProvider.js';
import { captureStreamScreenshot } from './screenshotHelper.js';

describe('AnimeParadise E2E', () => {
  it('searches, fetches episodes, resolves a stream, and captures a screenshot', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new AnimeParadiseProvider(http);

    const searchResults = await provider.search('Frieren');
    expect(searchResults.length).toBeGreaterThan(0);

    const target =
      searchResults.find((r) => !r.title.toLowerCase().includes('season 2')) ?? searchResults[0];

    expect(target.providerId).toBe('animeparadise');
    console.log(`AnimeParadise selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    const stream = await provider.resolveStream(ep1.id);
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;

    expect(stream.streams.length).toBeGreaterThan(0);
    console.log(`AnimeParadise resolved stream: ${stream.streams[0].sourceUrl.slice(0, 80)}`);

    const result = await captureStreamScreenshot('animeparadise', stream.streams);
    expect(result.outputPath).toMatch(/screenshot_animeparadise\.png$/);
  }, 90000);
});
