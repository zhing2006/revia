import { expect, it } from 'vitest';
import { systemLocale } from './index';

it('chooses the correct Chinese script and falls back for unsupported system languages', () => {
  expect(systemLocale(['zh-TW'])).toBe('zh-Hant');
  expect(systemLocale(['zh-Hans-SG'])).toBe('zh-Hans');
  expect(systemLocale(['ja-JP'])).toBe('ja');
  expect(systemLocale(['ko-KR'])).toBe('ko');
  expect(systemLocale(['fr-FR'])).toBe('en');
});
