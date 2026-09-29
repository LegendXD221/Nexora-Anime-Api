import { describe, it, expect } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { MangadexProvider } from '../../src/providers/MangadexProvider.js';

describe('Mangadex E2E Pagination', () => {
  it('fetches more than 500 chapters for One Piece', async () => {
    const http = new HttpClient({ timeoutMs: 30000 });
    const provider = new MangadexProvider(http);

    const query = 'Kaguya-sama';
    const searchResults = await provider.search(query);
    expect(searchResults.length).toBeGreaterThan(0);

    const target = searchResults.find((r) => r.title.includes('Kaguya-sama')) || searchResults[0];
    console.log(`Mangadex selected: ${target.title} (${target.id})`);

    const units = await provider.fetchContentUnits(target.id);
    console.log(`Mangadex found ${units.length} chapters for Kaguya-sama`);

    expect(units.length).toBeGreaterThan(500);
  }, 120000);
});
