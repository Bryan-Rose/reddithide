// Hiding on new Reddit (SPEC §9). We only set data attributes; one static stylesheet does the rest.
import type { BlockSet } from '../shared/types';
import type { ExtractedPost } from './extract';

export const HIDE_ATTR = 'data-reddithide'; // "remove" | "collapse" | "shown"
export const LABEL_ATTR = 'data-reddithide-label';

export const STYLESHEET = `
[${HIDE_ATTR}="remove"], [${HIDE_ATTR}="remove"] + hr { display: none !important; }
[${HIDE_ATTR}="collapse"] > * { display: none !important; }
[${HIDE_ATTR}="collapse"] { display: block !important; cursor: pointer; }
[${HIDE_ATTR}="collapse"]::before {
  content: attr(${LABEL_ATTR});
  display: block;
  padding: 6px 16px;
  font-size: 12px;
  line-height: 18px;
  color: var(--color-neutral-content-weak, #8a8a8a);
}
[${HIDE_ATTR}="collapse"]:hover::before { text-decoration: underline; }
`;

/** Hides feeds and search results until the block set has loaded, to avoid a flash at page load. */
export const PRELOAD_STYLESHEET = `shreddit-feed, ${'search-telemetry-tracker[view-events="search/view/post"]'} { visibility: hidden !important; }`;

export interface HideContext {
  blockSet: BlockSet | undefined;
  /** Subreddits the user deliberately navigated to (from the URL). */
  pageSubreddits: string[];
  blocked: Set<string>;
  ok: Set<string> | undefined;
}

export function makeContext(blockSet: BlockSet | undefined, pageSubreddits: string[]): HideContext {
  return {
    blockSet,
    pageSubreddits,
    blocked: new Set(blockSet?.names ?? []),
    ok: blockSet?.okNames ? new Set(blockSet.okNames) : undefined,
  };
}

/** Returns the reason to hide `name`, or null to show it. */
export function hideReason(ctx: HideContext, name: string): string | null {
  const bs = ctx.blockSet;
  if (!bs || !bs.behavior.enabled) return null;
  if (bs.behavior.exemptOwnSubredditPage && ctx.pageSubreddits.includes(name)) return null;
  if (ctx.blocked.has(name)) return bs.reasons[name] || 'blocked';
  if (bs.behavior.hideUnclassified && ctx.ok && !ctx.ok.has(name)) return 'unclassified';
  return null;
}

/** Applies or clears hiding on one post. Returns true when the post ends up hidden. */
export function applyHide(ctx: HideContext, post: ExtractedPost): boolean {
  const el = post.target;
  const current = el.getAttribute(HIDE_ATTR);
  const reason = post.hideable ? hideReason(ctx, post.name) : null;
  if (!reason) {
    if (current) {
      el.removeAttribute(HIDE_ATTR);
      el.removeAttribute(LABEL_ATTR);
    }
    return false;
  }
  if (current === 'shown') return false; // user clicked [show]
  const mode = ctx.blockSet!.behavior.hideMode;
  if (current !== mode) el.setAttribute(HIDE_ATTR, mode);
  if (mode === 'collapse') {
    const label = `Hidden: r/${post.displayName} — ${reason}   [show]`;
    if (el.getAttribute(LABEL_ATTR) !== label) el.setAttribute(LABEL_ATTR, label);
  }
  return true;
}
