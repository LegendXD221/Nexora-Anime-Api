import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { HttpClient } from '../../src/transport/http.js';
import { MegaPlayProvider } from '../../src/providers/MegaPlayProvider.js';
import { captureStreamScreenshot } from './screenshotHelper.js';

describe('MegaPlayProvider E2E', () => {
  const http = new HttpClient({ timeoutMs: 30000 });
  const provider = new MegaPlayProvider(http);

  it('should search for Frieren', async () => {
    const results = await provider.search('Frieren');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title.toLowerCase()).toContain('frieren');
    expect(results[0].id).toBe('154587');
  });

  it('should fetch content units for Frieren', async () => {
    const units = await provider.fetchContentUnits('154587');
    expect(units.length).toBeGreaterThan(0);
    expect(units[0].number).toBe(1);
    expect(units[0].id).toBe('154587:1');
  });

  it('should resolve and capture sub stream for Frieren episode 1', async () => {
    const stream = await provider.resolveStream('154587:1', 'sub');
    expect(stream.type).toBe('video');
    if (stream.type === 'video') {
      const result = await captureStreamScreenshot('megaplay_sub', stream.streams);
      expect(fs.existsSync(result.outputPath)).toBe(true);
      expect(fs.statSync(result.outputPath).size).toBeGreaterThan(1024);
    }
  }, 30000);

  it('should resolve and capture dub stream for Frieren episode 1', async () => {
    const stream = await provider.resolveStream('154587:1', 'dub');
    expect(stream.type).toBe('video');
    if (stream.type === 'video') {
      const result = await captureStreamScreenshot('megaplay_dub', stream.streams);
      expect(fs.existsSync(result.outputPath)).toBe(true);
      expect(fs.statSync(result.outputPath).size).toBeGreaterThan(1024);
    }
  }, 30000);
});
