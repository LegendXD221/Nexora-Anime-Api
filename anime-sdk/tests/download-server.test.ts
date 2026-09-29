/**
 * Unit tests for the download-related server routes.
 *
 * Uses a real (but ephemeral) HTTP server with mocked providers to verify
 * the /download/* endpoints produce the correct response shapes without
 * hitting the network.
 *
 * To run: npx vitest run tests/download-server.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import { BaseProvider } from '../src/providers/BaseProvider.js';
import { HttpClient } from '../src/transport/http.js';
import {
  IMediaSearchResult,
  IContentUnit,
  ResolvedMediaStream,
  MediaCatalogType,
  ContentLanguage,
} from '../src/types/index.js';
import { startServer } from '../src/server/index.js';

// ─── Mock provider helpers ──────────────────────────────────────────────────

/** Tiny PNG: 1×1 pixel, valid PNG file (67 bytes). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Start a tiny HTTP server that serves the TINY_PNG on any GET. */
function startImageServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': TINY_PNG.length,
      });
      res.end(TINY_PNG);
    });
    s.listen(0, () => {
      const addr = s.address() as { port: number };
      resolve({ server: s, port: addr.port });
    });
  });
}

class MockMangaProvider extends BaseProvider {
  readonly id = 'mock-manga';
  readonly supportedTypes: MediaCatalogType[] = ['MANGA'];
  private imgPort: number;

  constructor(http: HttpClient, imgPort: number) {
    super(http);
    this.imgPort = imgPort;
  }

  async search(): Promise<IMediaSearchResult[]> {
    return [
      {
        id: 'manga-1',
        title: 'Test Manga',
        catalogType: 'MANGA',
        providerId: this.id,
      },
    ];
  }

  async fetchContentUnits(): Promise<IContentUnit[]> {
    return [{ id: 'ch-1', title: 'Chapter 1', number: 1 }];
  }

  async resolveStream(): Promise<ResolvedMediaStream> {
    return {
      type: 'manga',
      pages: {
        imageUrls: [
          `http://localhost:${this.imgPort}/page1.png`,
          `http://localhost:${this.imgPort}/page2.png`,
          `http://localhost:${this.imgPort}/page3.png`,
        ],
      },
    };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Server download routes', () => {
  let sdkServer: http.Server;
  let imgServer: http.Server;
  let sdkPort: number;

  // Stand up both servers before any tests
  const setup = (async () => {
    const img = await startImageServer();
    imgServer = img.server;

    const httpClient = new HttpClient({ timeoutMs: 10000 });
    const manga = new MockMangaProvider(httpClient, img.port);

    sdkServer = startServer({ providers: [manga], port: 0 });

    // Wait for the SDK server to be listening
    await new Promise<void>((resolve) => {
      sdkServer.on('listening', () => {
        sdkPort = (sdkServer.address() as { port: number }).port;
        resolve();
      });
    });
  })();

  afterAll(async () => {
    await setup; // ensure setup is complete before teardown
    sdkServer?.close();
    imgServer?.close();
  });

  it('GET /download/manga/page returns an image with Content-Disposition', async () => {
    await setup;
    const url = `http://localhost:${sdkPort}/download/manga/page?provider=mock-manga&unitId=ch-1&page=0`;
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const disp = res.headers.get('content-disposition') ?? '';
    expect(disp).toContain('attachment');
    expect(disp).toContain('.png');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // Verify PNG magic
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
  }, 15000);

  it('GET /download/manga/chapter returns a ZIP', async () => {
    await setup;
    const url = `http://localhost:${sdkPort}/download/manga/chapter?provider=mock-manga&unitId=ch-1`;
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const disp = res.headers.get('content-disposition') ?? '';
    expect(disp).toContain('attachment');
    expect(disp).toContain('.zip');

    const buf = Buffer.from(await res.arrayBuffer());
    // ZIP magic: PK\x03\x04
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  }, 15000);

  it('GET /download/manga/page returns 400 for out-of-range page', async () => {
    await setup;
    const url = `http://localhost:${sdkPort}/download/manga/page?provider=mock-manga&unitId=ch-1&page=99`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('out of range');
  }, 15000);

  it('GET /download/manga/page returns 400 for missing params', async () => {
    await setup;
    const res1 = await fetch(`http://localhost:${sdkPort}/download/manga/page?provider=mock-manga`);
    expect(res1.status).toBe(400);

    const res2 = await fetch(`http://localhost:${sdkPort}/download/manga/page?unitId=ch-1`);
    expect(res2.status).toBe(400);
  }, 15000);

  it('GET /download/manga/chapter returns 400 for unknown provider', async () => {
    await setup;
    const url = `http://localhost:${sdkPort}/download/manga/chapter?provider=nonexistent&unitId=ch-1`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
  }, 15000);

  it('GET /download/video returns 400 for manga provider', async () => {
    await setup;
    const url = `http://localhost:${sdkPort}/download/video?provider=mock-manga&unitId=ch-1`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('not video');
  }, 15000);
});
