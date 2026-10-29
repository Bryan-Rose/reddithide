// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractPosts } from '../src/content/extract';
import { applyHide, HIDE_ATTR, hideReason, LABEL_ATTR, makeContext } from '../src/content/hide';
import { DEFAULT_BEHAVIOR } from '../src/shared/constants';
import type { BlockSet, Behavior } from '../src/shared/types';

function blockSet(names: string[], behavior: Partial<Behavior> = {}, okNames?: string[]): BlockSet {
  return {
    type: 'blockSet',
    names,
    reasons: Object.fromEntries(names.map((n) => [n, 'gross'])),
    behavior: { ...DEFAULT_BEHAVIOR, ...behavior },
    okNames,
    updatedAt: 0,
  };
}

function feed() {
  const doc = new DOMParser().parseFromString(
    `<shreddit-feed>
      <article><shreddit-post subreddit-name="Gross" id="t3_a" post-title="a"></shreddit-post></article><hr>
      <article><shreddit-post subreddit-name="Nice" id="t3_b" post-title="b"></shreddit-post></article><hr>
    </shreddit-feed>`,
    'text/html',
  );
  return extractPosts(doc);
}

describe('hideReason', () => {
  it('hides blocked names', () => {
    expect(hideReason(makeContext(blockSet(['gross']), []), 'gross')).toBe('gross');
    expect(hideReason(makeContext(blockSet(['gross']), []), 'nice')).toBeNull();
  });
  it('respects the master switch', () => {
    expect(hideReason(makeContext(blockSet(['gross'], { enabled: false }), []), 'gross')).toBeNull();
  });
  it('exempts the subreddit page the user navigated to', () => {
    expect(hideReason(makeContext(blockSet(['gross']), ['gross']), 'gross')).toBeNull();
    expect(
      hideReason(makeContext(blockSet(['gross'], { exemptOwnSubredditPage: false }), ['gross']), 'gross'),
    ).toBe('gross');
  });
  it('hides unclassified subreddits when asked', () => {
    const ctx = makeContext(blockSet([], { hideUnclassified: true }, ['nice']), []);
    expect(hideReason(ctx, 'unknown')).toBe('unclassified');
    expect(hideReason(ctx, 'nice')).toBeNull();
  });
  it('shows everything before the block set loads', () => {
    expect(hideReason(makeContext(undefined, []), 'gross')).toBeNull();
  });
});

describe('applyHide', () => {
  it('collapses with a label', () => {
    const [gross, nice] = feed();
    const ctx = makeContext(blockSet(['gross']), []);
    expect(applyHide(ctx, gross!)).toBe(true);
    expect(applyHide(ctx, nice!)).toBe(false);
    expect(gross!.target.getAttribute(HIDE_ATTR)).toBe('collapse');
    expect(gross!.target.getAttribute(LABEL_ATTR)).toContain('r/Gross — gross');
    expect(nice!.target.hasAttribute(HIDE_ATTR)).toBe(false);
  });
  it('removes in remove mode', () => {
    const [gross] = feed();
    applyHide(makeContext(blockSet(['gross'], { hideMode: 'remove' }), []), gross!);
    expect(gross!.target.getAttribute(HIDE_ATTR)).toBe('remove');
  });
  it('unhides when the block set changes', () => {
    const [gross] = feed();
    applyHide(makeContext(blockSet(['gross']), []), gross!);
    applyHide(makeContext(blockSet([]), []), gross!);
    expect(gross!.target.hasAttribute(HIDE_ATTR)).toBe(false);
  });
  it('keeps a post the user revealed', () => {
    const [gross] = feed();
    gross!.target.setAttribute(HIDE_ATTR, 'shown');
    expect(applyHide(makeContext(blockSet(['gross']), []), gross!)).toBe(false);
    expect(gross!.target.getAttribute(HIDE_ATTR)).toBe('shown');
  });
  it('never hides a non-hideable post', () => {
    const [gross] = feed();
    expect(applyHide(makeContext(blockSet(['gross']), []), { ...gross!, hideable: false })).toBe(false);
  });
});
