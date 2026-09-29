/**
 * E2E integration tests for AnikotoProvider (anikototv.to backend).
 *
 * To run: npx vitest run tests/e2e/anikoto.test.ts
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { AnikotoProvider } from '../../src/providers/AnikotoProvider.js';
import { captureStreamScreenshot } from './screenshotHelper.js';

describe('Anikoto E2E', () => {
  it('searches, fetches episodes, resolves a sub stream, and captures a screenshot', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new AnikotoProvider(http);

    const query = 'Solo Leveling';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    const target = searchResults[0];
    expect(target.providerId).toBe('anikoto');
    console.log(`Anikoto selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    const stream = await provider.resolveStream(ep1.id, 'sub');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;
    expect(stream.streams.length).toBeGreaterThan(0);

    console.log(
      `Anikoto (sub) resolved ${stream.streams.length} stream candidate(s); ` +
        `top: ${stream.streams[0].sourceUrl.slice(0, 80)}`,
    );

    const result = await captureStreamScreenshot('anikoto_sub', stream.streams);
    expect(result.outputPath).toMatch(/screenshot_anikoto_sub\.png$/);
  }, 90000);

  it('resolves a dub stream, and captures a screenshot', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new AnikotoProvider(http);

    // Using a known ID for Solo Leveling to save time
    const targetId = '7457';
    const units = await provider.fetchContentUnits(targetId);
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    // Check if dub is available for this episode
    if (!ep1.availableLanguages.includes('dub')) {
      console.warn('Dub not available for this episode, skipping dub test');
      return;
    }

    const stream = await provider.resolveStream(ep1.id, 'dub');
    expect(stream.type).toBe('video');
    if (stream.type !== 'video') return;
    expect(stream.streams.length).toBeGreaterThan(0);

    console.log(
      `Anikoto (dub) resolved ${stream.streams.length} stream candidate(s); ` +
        `top: ${stream.streams[0].sourceUrl.slice(0, 80)}`,
    );

    const result = await captureStreamScreenshot('anikoto_dub', stream.streams);
    expect(result.outputPath).toMatch(/screenshot_anikoto_dub\.png$/);
  }, 90000);
});
