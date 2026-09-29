/**
 * Unit tests for ContentLanguage type system.
 * Verifies that IContentUnit.language, IMediaSearchResult.availableLanguages,
 * and IVideoPayload.language are wired correctly end-to-end.
 */
import { describe, it, expect } from 'vitest';
import type {
  ContentLanguage,
  IContentUnit,
  IMediaSearchResult,
  IVideoPayload,
} from '../src/types/index.js';

describe('ContentLanguage type system', () => {
  it('IContentUnit should carry a language field', () => {
    const unit: IContentUnit = {
      id: 'show-1/ep-1/sub',
      title: 'Episode 1',
      number: 1,
      language: 'sub',
    };
    expect(unit.language).toBe('sub');
  });

  it('IContentUnit supports all three language values', () => {
    const langs: ContentLanguage[] = ['sub', 'dub', 'raw'];
    for (const lang of langs) {
      const unit: IContentUnit = {
        id: `id/${lang}`,
        title: 'Test',
        number: 1,
        language: lang,
      };
      expect(unit.language).toBe(lang);
    }
  });

  it('IMediaSearchResult.availableLanguages is optional', () => {
    const resultNoLang: IMediaSearchResult = {
      id: 'abc',
      title: 'Naruto',
      catalogType: 'ANIME',
      providerId: 'test',
    };
    expect(resultNoLang.availableLanguages).toBeUndefined();

    const resultWithLang: IMediaSearchResult = {
      id: 'abc',
      title: 'Naruto',
      catalogType: 'ANIME',
      providerId: 'test',
      availableLanguages: ['sub', 'dub'],
    };
    expect(resultWithLang.availableLanguages).toContain('sub');
    expect(resultWithLang.availableLanguages).toContain('dub');
  });

  it('IVideoPayload.language is optional', () => {
    const payloadNoLang: IVideoPayload = {
      sourceUrl: 'https://example.com/video.mp4',
      isHLS: false,
      quality: 'auto',
    };
    expect(payloadNoLang.language).toBeUndefined();

    const payloadWithLang: IVideoPayload = {
      sourceUrl: 'https://example.com/video.mp4',
      isHLS: false,
      quality: '1080p',
      language: 'dub',
    };
    expect(payloadWithLang.language).toBe('dub');
  });

  it('IVideoPayload supports 480p quality', () => {
    const payload: IVideoPayload = {
      sourceUrl: 'https://example.com/video.mp4',
      isHLS: false,
      quality: '480p',
    };
    expect(payload.quality).toBe('480p');
  });
});
