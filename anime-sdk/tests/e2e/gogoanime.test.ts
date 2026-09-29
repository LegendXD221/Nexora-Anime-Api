/**
 * E2E integration tests for GogoanimeProvider (anineko.to backend).
 *
 * To run: npx vitest run tests/e2e/gogoanime.test.ts
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { GogoanimeProvider } from '../../src/providers/GogoanimeProvider.js';
import { captureStreamScreenshot } from './screenshotHelper.js';

describe('GogoAnime E2E', () => {
  it('searches, fetches episodes, resolves a stream, and captures a screenshot', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new GogoanimeProvider(http);

    const query = 'Frieren';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    const target = searchResults[0];
    expect(target.providerId).toBe('gogoanime');
    console.log(`GogoAnime selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    const stream = await provider.resolveStream(ep1.id);
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;
    expect(stream.streams.length).toBeGreaterThan(0);

    console.log(
      `GogoAnime resolved ${stream.streams.length} stream candidate(s); ` +
        `top: ${stream.streams[0].sourceUrl.slice(0, 80)}`,
    );

    const result = await captureStreamScreenshot('gogoanime', stream.streams);
    expect(result.outputPath).toMatch(/screenshot_gogoanime\.png$/);
  }, 90000);
});
