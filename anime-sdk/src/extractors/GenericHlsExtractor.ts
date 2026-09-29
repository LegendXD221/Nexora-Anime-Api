import { BaseExtractor } from './BaseExtractor.js';
import { IVideoPayload } from '../types/index.js';

/**
 * Generic extractor that fetches an embed page and scans the response body
 * for a direct .m3u8 or .mp4 URL. Useful for players that expose their stream
 * link in plain HTML (e.g. vibeplayer.site, bibiemb.xyz, otakuvid.online).
 *
 * Limitations:
 *  - Cannot decrypt obfuscated/packed embeds (filemoon, streamwish, ok.ru, etc.)
 *  - Best-effort: returns an empty array if nothing matches.
 */
export class GenericHlsExtractor extends BaseExtractor {
  public readonly id = 'generic-hls';

  public async extract(embedUrl: string): Promise<IVideoPayload[]> {
    const origin = new URL(embedUrl);
    const referer = `${origin.protocol}//${origin.host}/`;

    const res = await this.http.get(embedUrl, {
      redirect: 'follow',
      headers: {
        Referer: referer,
        'User-Agent':
          this.http.getDefaultHeaders()['User-Agent'] ??
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      },
    });
    if (res.status !== 200) return [];
    const html = await res.text();

    // Try multiple patterns: prefer m3u8 over mp4
    // Require a `/<name>.<ext>` path component so domain hits like
    // `www.mp4upload.com` don't match as if they were `.mp4` files.
    const m3u8 = this.findFirstUrl(
      html,
      /https?:\/\/[^"'\s<>\\]+?\/[^"'\s<>\\/]+\.m3u8(?:[?#][^"'\s<>\\]*)?/i,
    );
    const mp4 = this.findFirstUrl(
      html,
      /https?:\/\/[^"'\s<>\\]+?\/[^"'\s<>\\/]+\.mp4(?:[?#][^"'\s<>\\]*)?/i,
    );

    const headers = {
      Referer: referer,
      'User-Agent':
        this.http.getDefaultHeaders()['User-Agent'] ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    };

    const out: IVideoPayload[] = [];
    if (m3u8) out.push({ sourceUrl: m3u8, isHLS: true, quality: 'auto', headers });
    if (mp4) out.push({ sourceUrl: mp4, isHLS: false, quality: 'auto', headers });
    return out;
  }

  private findFirstUrl(html: string, re: RegExp): string | null {
    const m = html.match(re);
    if (!m) {
      // Try with escaped slashes (JSON-embedded URLs)
      const unescaped = html.replace(/\\\//g, '/');
      const m2 = unescaped.match(re);
      return m2 ? m2[0] : null;
    }
    return m[0];
  }
}
