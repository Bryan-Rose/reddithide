// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPosts, extractSubredditHeader } from '../src/content/extract';

function load(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), 'tests/fixtures', `${name}.html`), 'utf8');
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
}

describe('extractPosts on /r/popular fixture', () => {
  const doc = load('popular');
  const posts = extractPosts(doc);

  it('finds every feed post and skips ads', () => {
    expect(posts.length).toBe(doc.querySelectorAll('shreddit-post').length);
    expect(posts.length).toBeGreaterThan(10);
    expect(doc.querySelectorAll('shreddit-ad-post').length).toBeGreaterThan(0);
  });

  it('normalizes names and keeps display names', () => {
    for (const p of posts) {
      expect(p.name).toBe(p.name.toLowerCase());
      expect(p.displayName.toLowerCase()).toBe(p.name);
      expect(p.postId).toMatch(/^t3_/);
      expect(p.title).toBeTruthy();
      expect(p.hideable).toBe(true);
    }
  });

  it('targets the article wrapper so the following hr can be hidden too', () => {
    for (const p of posts) {
      expect(p.target.tagName).toBe('ARTICLE');
      expect(p.target.nextElementSibling?.tagName).toBe('HR');
    }
  });

  it('reads post-language', () => {
    expect(posts.some((p) => p.lang === 'en')).toBe(true);
  });
});

describe('extractPosts on search fixture', () => {
  const posts = extractPosts(load('search'));
  it('extracts subreddit, post id, title and nsfw flag from the tracking context', () => {
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.name).toMatch(/^[a-z0-9_]+$/);
      expect(p.postId).toMatch(/^t3_/);
      expect(p.title).toBeTruthy();
      expect(typeof p.over18).toBe('boolean');
      expect(p.target.tagName).toBe('SEARCH-TELEMETRY-TRACKER');
    }
  });
});

describe('comments page', () => {
  it('records the post but marks it as not hideable', () => {
    const posts = extractPosts(load('comments'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.name).toBe('python');
    expect(posts[0]!.hideable).toBe(false);
  });
});

describe('subreddit page', () => {
  const doc = load('subreddit');
  it('extracts header metadata', () => {
    const h = extractSubredditHeader(doc)!;
    expect(h.name).toBe('python');
    expect(h.displayName).toBe('Python');
    expect(h.meta.publicDescription).toMatch(/Python/);
    expect(h.meta.weeklyActiveUsers).toBeGreaterThan(0);
  });
  it('extracts posts of the subreddit', () => {
    const posts = extractPosts(doc);
    expect(posts.length).toBeGreaterThan(0);
    expect(new Set(posts.map((p) => p.name))).toEqual(new Set(['python']));
  });
});

describe('edge cases', () => {
  const make = (attrs: string) => {
    const doc = new DOMParser().parseFromString(`<shreddit-post ${attrs}></shreddit-post>`, 'text/html');
    return extractPosts(doc);
  };
  it('ignores user-profile posts', () => {
    expect(make('subreddit-name="u_someone" subreddit-prefixed-name="u/someone" id="t3_x"')).toHaveLength(0);
    expect(make('subreddit-name="someone" subreddit-prefixed-name="u/someone" id="t3_x"')).toHaveLength(0);
  });
  it('ignores posts without a subreddit', () => {
    expect(make('id="t3_x"')).toHaveLength(0);
  });
  it('falls back to the post element when there is no article wrapper', () => {
    const [p] = make('subreddit-name="Foo" id="t3_x" post-title="Hi"');
    expect(p!.target.tagName).toBe('SHREDDIT-POST');
  });
  it('ignores malformed search tracking JSON', () => {
    const doc = new DOMParser().parseFromString(
      `<search-telemetry-tracker view-events="search/view/post" data-faceplate-tracking-context="{bad"></search-telemetry-tracker>`,
      'text/html',
    );
    expect(extractPosts(doc)).toHaveLength(0);
  });
});
