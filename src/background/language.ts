// Language detection stage (SPEC §5.2 step 3, §7.3).
import { languageFromPostTags } from '../classify/parse';
import browser from '../shared/browser';
import type { DetectedLanguage, SubredditRecord } from '../shared/types';

/**
 * Reddit's own per-post `post-language` tags win when they agree, because DOM titles may be
 * machine-translated for logged-in users. Otherwise browser.i18n.detectLanguage runs on the
 * description plus titles.
 */
export async function detectLanguage(rec: SubredditRecord): Promise<DetectedLanguage | undefined> {
  const tags = languageFromPostTags(rec.samples?.items);
  if (tags?.reliable) return tags;
  const text = [rec.meta?.title, rec.meta?.publicDescription, ...(rec.samples?.titles ?? [])]
    .filter(Boolean)
    .join('\n');
  if (text.trim().length < 20) return tags;
  try {
    const r = await browser.i18n.detectLanguage(text);
    const top = r.languages[0];
    if (!top) return tags;
    const code = top.language === 'und' ? 'und' : top.language.toLowerCase().slice(0, 2);
    return { code, percentage: top.percentage, reliable: r.isReliable, source: 'browser.i18n' };
  } catch (e) {
    console.warn('[RedditHide] detectLanguage failed', e);
    return tags;
  }
}
