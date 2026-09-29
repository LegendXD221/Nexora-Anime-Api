import { BaseExtractor } from './BaseExtractor.js';
import { IVideoPayload } from '../types/index.js';

/**
 * Extracts the direct googlevideo.com URL from a Blogger video embed
 * (https://www.blogger.com/video.g?token=...).
 *
 * The flow mirrors the GoAnime reference (internal/player/scraper.go,
 * extractBloggerGoogleVideoURL):
 *   1. Fetch the embed page; pull `FdrFJe` (SID) and `cfb2h` (build) values.
 *   2. POST to Blogger's batchexecute endpoint with the `WcwnYd` RPC, asking
 *      for the video stream variants for our token.
 *   3. Parse the WcwnYd response, walk every index of the inner data array
 *      until we find an array-of-arrays (the stream list), then pick the best
 *      MP4 (preferring itag=22 ≈ 720p).
 *
 * Returns a list of payloads in quality-best-first order.
 */

const TOKEN_RE = /token=([A-Za-z0-9_-]+)/;
const SID_RE = /"FdrFJe"\s*:\s*"([^"]+)"/;
const BH_RE = /"cfb2h"\s*:\s*"([^"]+)"/;
const AT_RE = /"SNlM0e"\s*:\s*"([^"]+)"/;
const GOOGLE_VIDEO_RE = /https:\/\/[^"'\\\s<>]+?\.googlevideo\.com\/[^"'\\\s<>]+/;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class BloggerExtractor extends BaseExtractor {
  public readonly id = 'blogger';

  static matches(url: string): boolean {
    return /(?:^|\.)blogger\.com\/video\.g\?token=/i.test(url);
  }

  public async extract(embedUrl: string): Promise<IVideoPayload[]> {
    const tokenMatch = embedUrl.match(TOKEN_RE);
    if (!tokenMatch) return [];
    // The token isn't actually used directly — Google identifies the request by
    // the inner JSON we send. We still validate it exists so we fail fast on a
    // malformed embed URL.

    // Step 1: fetch the embed page for FdrFJe / cfb2h.
    const pageRes = await this.http.get(embedUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (pageRes.status !== 200) {
      throw new Error(`Failed to fetch Blogger embed page, status ${pageRes.status}`);
    }
    const html = await pageRes.text();

    const sid = html.match(SID_RE)?.[1];
    const bh = html.match(BH_RE)?.[1];
    const at = html.match(AT_RE)?.[1] ?? '';

    if (!sid || !bh) {
      // Sometimes Blogger returns "Video not found" or "Removed"
      if (html.includes('video-not-found') || html.includes('deleted')) {
        throw new Error('Video has been deleted or not found on Blogger');
      }
      throw new Error(`Failed to extract SID (${!!sid}) or BH (${!!bh}) from Blogger embed`);
    }

    // Step 2: call batchexecute.
    const innerJson = JSON.stringify([tokenMatch[1], '', 0]);
    const fReq = JSON.stringify([[['WcwnYd', innerJson, null, 'generic']]]);
    const params = new URLSearchParams();
    params.append('f.req', fReq);
    if (at) params.append('at', at);

    const batchUrl =
      `https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?` +
      `rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid=${encodeURIComponent(sid)}` +
      `&bl=${encodeURIComponent(bh)}&hl=en-US&_reqid=100001&rt=c`;

    const batchRes = await this.http.post(batchUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
        Origin: 'https://www.blogger.com',
        Referer: embedUrl,
        'User-Agent': UA,
      },
    });
    if (batchRes.status !== 200) {
      throw new Error(`Blogger batchexecute failed with status ${batchRes.status}`);
    }
    const body = await batchRes.text();

    const results = this.parseBatchexecuteResponse(body);
    if (results.length === 0) {
      throw new Error('Blogger batchexecute returned no stream URLs');
    }
    return results;
  }

  /**
   * Parse the WcwnYd RPC response. Google's response shape evolves; we walk
   * every index of `data` looking for the first element that's an array of
   * arrays (= streams). Falls back to a raw-text googlevideo.com regex if
   * structured parsing yields nothing.
   */
  private parseBatchexecuteResponse(body: string): IVideoPayload[] {
    const headers = { Referer: 'https://www.blogger.com/', 'User-Agent': UA };
    const result: IVideoPayload[] = [];
    const seen = new Set<string>();

    const lines = body.split('\n');
    for (const line of lines) {
      if (!line.includes('wrb.fr')) continue;
      let outer: unknown;
      try {
        outer = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(outer)) continue;
      for (const entry of outer) {
        if (
          !Array.isArray(entry) ||
          entry.length < 3 ||
          entry[0] !== 'wrb.fr' ||
          entry[1] !== 'WcwnYd'
        ) {
          continue;
        }
        let inner: unknown;
        try {
          inner = JSON.parse(entry[2] as string);
        } catch {
          continue;
        }
        if (!Array.isArray(inner)) continue;
        const streams = this.findStreamsArray(inner);
        if (!streams) continue;

        const mp4s: Array<{ url: string; quality: IVideoPayload['quality'] }> = [];
        for (const s of streams) {
          if (!Array.isArray(s) || s.length < 1) continue;
          const u = s[0];
          if (typeof u !== 'string') continue;
          if (!u.includes('mime=video%2Fmp4') && !u.includes('mime=video/mp4')) continue;
          let q: IVideoPayload['quality'] = 'auto';
          if (u.includes('itag=22')) q = '720p';
          else if (u.includes('itag=18')) q = '360p';
          mp4s.push({ url: u, quality: q });
        }

        // Prefer 720p over 360p
        mp4s.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
        for (const m of mp4s) {
          if (seen.has(m.url)) continue;
          seen.add(m.url);
          result.push({
            sourceUrl: m.url,
            isHLS: false,
            quality: m.quality,
            headers,
          });
        }
      }
    }

    // Regex fallback against the raw body.
    if (result.length === 0) {
      const m = body.match(GOOGLE_VIDEO_RE);
      if (m) {
        result.push({
          sourceUrl: m[0],
          isHLS: false,
          quality: 'auto',
          headers,
        });
      }
    }
    return result;
  }

  private findStreamsArray(data: unknown[]): unknown[] | null {
    for (const elem of data) {
      if (Array.isArray(elem) && elem.length > 0 && Array.isArray(elem[0])) {
        return elem;
      }
    }
    return null;
  }
}

function qualityRank(q: IVideoPayload['quality']): number {
  switch (q) {
    case '1080p':
      return 4;
    case '720p':
      return 3;
    case '480p':
      return 2;
    case '360p':
      return 1;
    default:
      return 0;
  }
}
