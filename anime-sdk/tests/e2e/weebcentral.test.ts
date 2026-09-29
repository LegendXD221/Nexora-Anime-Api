import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { DomRegistry } from '../../src/transport/dom.js';
import { WeebcentralProvider } from '../../src/providers/WeebcentralProvider.js';

describe('Weebcentral E2E', () => {
  it('searches, fetches chapters, and resolves a stream with accessible images', async () => {
    const http = new HttpClient({
      timeoutMs: 25000,
      defaultHeaders: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    const provider = new WeebcentralProvider(http);

    const query = 'Frieren';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    const target = searchResults[0];
    expect(target.providerId).toBe('weebcentral');
    console.log(`Weebcentral selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    expect(units.length).toBeGreaterThan(0);

    const ep1 = units[0];
    const stream = await provider.resolveStream(ep1.id);
    expect(stream.type).toBe('manga');
    if (stream.type !== 'manga') return;

    expect(stream.pages.imageUrls.length).toBeGreaterThan(0);

    // Verify image accessibility
    const imgUrl = stream.pages.imageUrls[0];
    const imgRes = await http.get(imgUrl, { headers: stream.pages.headers });
    expect(imgRes.status).toBe(200);
    const contentType = imgRes.headers.get('content-type');
    expect(contentType).toMatch(/^image\//);

    console.log(
      `Weebcentral resolved ${stream.pages.imageUrls.length} pages; top: ${imgUrl.slice(0, 80)} (${contentType})`,
    );
  }, 90000);
});
