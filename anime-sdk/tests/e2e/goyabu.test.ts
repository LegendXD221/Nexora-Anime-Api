/**
 * E2E integration tests for GoyabuProvider.
 *
 * To run: npx vitest run tests/e2e/goyabu.test.ts
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { GoyabuProvider } from '../../src/providers/GoyabuProvider.js';
import { captureStreamScreenshot } from './screenshotHelper.js';

describe('Goyabu E2E', () => {
  it('searches, fetches episodes, resolves a stream, and captures a screenshot', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new GoyabuProvider(http);

    // Confirm the site is even up before exercising the scraper.
    const ping = await fetch('https://goyabu.io', {
      method: 'HEAD',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
    expect(ping.status, 'goyabu.io must be reachable').toBeLessThan(500);

    const query = 'Naruto';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    const target = searchResults[0];
    expect(target.providerId).toBe('goyabu');
    console.log(`Goyabu selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    const stream = await provider.resolveStream(ep1.id);
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;
    expect(stream.streams.length).toBeGreaterThan(0);

    console.log(
      `Goyabu resolved ${stream.streams.length} stream candidate(s); ` +
        `top: ${stream.streams[0].sourceUrl.slice(0, 80)}`,
    );

    const result = await captureStreamScreenshot('goyabu', stream.streams);
    expect(result.outputPath).toMatch(/screenshot_goyabu\.png$/);
  }, 90000);
});
