import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { MangadexProvider } from '../../src/providers/MangadexProvider.js';

describe('Mangadex E2E', () => {
  it('searches, fetches all chapters, and resolves a stream with accessible images', async () => {
    const http = new HttpClient({ timeoutMs: 25000 });
    const provider = new MangadexProvider(http);

    const query = 'Frieren';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    const target = searchResults[0];
    expect(target.providerId).toBe('mangadex');
    console.log(`Mangadex selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    expect(units.length).toBeGreaterThan(0);
    console.log(`Mangadex found ${units.length} chapters`);

    // Verify pagination if it's a long series (like One Piece)
    if (target.title.toLowerCase().includes('one piece')) {
      expect(units.length).toBeGreaterThan(1000);
    }

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
      `Mangadex resolved ${stream.pages.imageUrls.length} pages; top: ${imgUrl.slice(0, 80)} (${contentType})`,
    );
  }, 90000);
});
