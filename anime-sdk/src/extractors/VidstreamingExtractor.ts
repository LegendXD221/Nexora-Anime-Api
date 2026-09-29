import { BaseExtractor } from './BaseExtractor.js';
import { IVideoPayload } from '../types/index.js';
import { aesEncrypt, aesDecrypt } from '../utils/crypto.js';

export class VidstreamingExtractor extends BaseExtractor {
  public readonly id = 'vidstreaming';

  public async extract(embedUrl: string): Promise<IVideoPayload[]> {
    const urlObj = new URL(embedUrl);
    const contentId = urlObj.searchParams.get('id');
    if (!contentId) {
      throw new Error('Vidstreaming embed URL is missing the "id" parameter');
    }

    const host = `${urlObj.protocol}//${urlObj.host}/`;
    const response = await this.http.get(embedUrl, {
      headers: { Referer: embedUrl },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to load Vidstreaming embed page: ${response.status}`);
    }

    const html = await response.text();

    // Find the keys (encryption key, iv, decryption key)
    const keys = [...html.matchAll(/(?:container|videocontent)-(\d+)/g)].map((m) => m[1]);

    if (keys.length < 3) {
      throw new Error(
        'Failed to extract AES keys/IV from Vidstreaming page. The site layout might have changed.',
      );
    }

    const encryptionKey = keys[0];
    const iv = keys[1];
    const decryptionKey = keys[2];

    const dataValueMatch = html.match(/data-value="([^"]+)"/);
    if (!dataValueMatch) {
      throw new Error('Failed to find data-value attribute in Vidstreaming page HTML');
    }
    const encryptedData = dataValueMatch[1];

    // Decrypt the page data
    const decryptedData = await aesDecrypt(encryptedData, encryptionKey, iv);

    // Encrypt the contentId
    const encryptedContentId = await aesEncrypt(contentId, encryptionKey, iv);

    // Build the query component
    const fullComponent = `${decryptedData}&id=${encryptedContentId}&alias=${contentId}`;
    const firstAmpersand = fullComponent.indexOf('&');
    if (firstAmpersand === -1) {
      throw new Error('Invalid decrypted data format');
    }
    const component = fullComponent.substring(firstAmpersand + 1);

    // Fetch the stream sources from the AJAX endpoint
    const ajaxUrl = `${host}encrypt-ajax.php?${component}`;
    const ajaxResponse = await this.http.get(ajaxUrl, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: embedUrl,
      },
    });

    if (ajaxResponse.status !== 200) {
      throw new Error(`AJAX request to encrypt-ajax.php failed: ${ajaxResponse.status}`);
    }

    const ajaxJson = await ajaxResponse.json();
    if (!ajaxJson.data) {
      throw new Error('AJAX response missing "data" field');
    }

    // Decrypt the sources list
    const decryptedResult = await aesDecrypt(ajaxJson.data, decryptionKey, iv);

    let content: any;
    try {
      content = JSON.parse(decryptedResult);
    } catch (e) {
      throw new Error(`Failed to parse decrypted AJAX response JSON: ${(e as Error).message}`);
    }

    const streams: IVideoPayload[] = [];

    const mapQuality = (label: string): '1080p' | '720p' | '360p' | 'auto' => {
      const normalized = label.toLowerCase();
      if (normalized.includes('1080')) return '1080p';
      if (normalized.includes('720')) return '720p';
      if (normalized.includes('360')) return '360p';
      return 'auto';
    };

    const processSourceList = (list: any[]) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item.file) continue;
        streams.push({
          sourceUrl: item.file,
          isHLS: item.file.includes('.m3u8'),
          quality: mapQuality(item.label || ''),
          headers: {
            Referer: embedUrl,
            'User-Agent':
              this.http.getDefaultHeaders()['User-Agent'] ||
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
        });
      }
    };

    processSourceList(content.source);
    processSourceList(content.source_bk);

    return streams;
  }
}
