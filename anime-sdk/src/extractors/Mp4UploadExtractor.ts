import { BaseExtractor } from './BaseExtractor.js';
import { IVideoPayload } from '../types/index.js';

/**
 * Extracts the direct MP4 URL from an mp4upload.com / www.mp4upload.com embed page.
 *
 * The embed HTML contains a line like:
 *   player.src({ src: "https://a4.mp4upload.com:183/d/.../video.mp4" })
 * which is parsed directly.
 */
export class Mp4UploadExtractor extends BaseExtractor {
  public readonly id = 'mp4upload';

  static matches(url: string): boolean {
    return /(?:^|\.)mp4upload\.com\//i.test(url);
  }

  public async extract(embedUrl: string): Promise<IVideoPayload[]> {
    const res = await this.http.get(embedUrl, {
      redirect: 'follow',
      headers: {
        Referer: 'https://allmanga.to/',
        'User-Agent':
          this.http.getDefaultHeaders()['User-Agent'] ??
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      },
    });
    if (res.status !== 200) return [];
    const html = await res.text();

    // Mp4Upload's player snippet emits exactly one direct stream URL ending in
    // `/video.mp4` (sometimes followed by query params). Be strict so we don't
    // pick up `mp4upload.com/...` static asset URLs that happen to contain "mp4".
    const match = html.match(/src:\s*"(https?:\/\/[^"]+\/video\.mp4(?:\?[^"]*)?)"/);
    if (!match) return [];

    return [
      {
        sourceUrl: match[1],
        isHLS: false,
        quality: 'auto',
        headers: {
          Referer: 'https://mp4upload.com/',
          'User-Agent':
            this.http.getDefaultHeaders()['User-Agent'] ??
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        },
      },
    ];
  }
}
