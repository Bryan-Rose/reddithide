// Pure DOM extraction: no messaging, no state. Unit-tested against saved fixtures.
import { displayNameOf, normalizeSubreddit } from '../shared/names';
import type { DomSubredditMeta } from '../shared/messages';
import {
  HEADER_ATTR,
  POST,
  POST_ATTR,
  POST_WRAPPER,
  SEARCH_CONTEXT_ATTR,
  SEARCH_UNIT,
  SUBREDDIT_HEADER,
  VIEW_CONTEXT_COMMENTS,
} from './selectors';

export interface ExtractedPost {
  name: string; // normalized, lowercase
  displayName: string;
  postId: string;
  title?: string;
  lang?: string;
  over18?: boolean;
  quarantined?: boolean;
  /** Element to mark for hiding. */
  target: Element;
  /** False for posts we record but must never hide (the main post on a comments page). */
  hideable: boolean;
}

function matchesOrDescendants(root: Element | Document, selector: string): Element[] {
  const out: Element[] = [];
  if (root.nodeType === 1 && (root as Element).matches(selector)) out.push(root as Element);
  out.push(...root.querySelectorAll(selector));
  return out;
}

export function extractFeedPost(el: Element): ExtractedPost | null {
  const rawName = el.getAttribute(POST_ATTR.subreddit);
  const prefixed = el.getAttribute(POST_ATTR.prefixed) ?? '';
  if (prefixed.toLowerCase().startsWith('u/')) return null;
  const name = normalizeSubreddit(rawName);
  if (!name || !rawName) return null;
  const isComments = el.getAttribute(POST_ATTR.viewContext) === VIEW_CONTEXT_COMMENTS;
  const wrapper = el.parentElement?.matches(POST_WRAPPER) ? el.parentElement : el;
  return {
    name,
    displayName: displayNameOf(rawName),
    postId: el.getAttribute(POST_ATTR.id) ?? `${name}:${el.getAttribute(POST_ATTR.title) ?? ''}`,
    title: el.getAttribute(POST_ATTR.title)?.trim() || undefined,
    lang: el.getAttribute(POST_ATTR.language) || undefined,
    target: wrapper,
    hideable: !isComments,
  };
}

interface SearchContext {
  post?: { id?: string; title?: string };
  subreddit?: { name?: string; nsfw?: boolean; quarantined?: boolean };
}

export function extractSearchUnit(el: Element): ExtractedPost | null {
  const raw = el.getAttribute(SEARCH_CONTEXT_ATTR);
  if (!raw) return null;
  let ctx: SearchContext;
  try {
    ctx = JSON.parse(raw) as SearchContext;
  } catch {
    return null;
  }
  const rawName = ctx.subreddit?.name;
  const name = normalizeSubreddit(rawName);
  if (!name || !rawName || !ctx.post?.id) return null;
  return {
    name,
    displayName: displayNameOf(rawName),
    postId: ctx.post.id,
    title: ctx.post.title?.trim() || undefined,
    over18: typeof ctx.subreddit?.nsfw === 'boolean' ? ctx.subreddit.nsfw : undefined,
    quarantined: typeof ctx.subreddit?.quarantined === 'boolean' ? ctx.subreddit.quarantined : undefined,
    target: el,
    hideable: true,
  };
}

/** All posts in or at `root` (feed posts and search results). */
export function extractPosts(root: Element | Document): ExtractedPost[] {
  const out: ExtractedPost[] = [];
  for (const el of matchesOrDescendants(root, POST)) {
    const p = extractFeedPost(el);
    if (p) out.push(p);
  }
  for (const el of matchesOrDescendants(root, SEARCH_UNIT)) {
    const p = extractSearchUnit(el);
    if (p) out.push(p);
  }
  return out;
}

export interface ExtractedHeader {
  name: string;
  displayName: string;
  meta: DomSubredditMeta;
}

export function extractSubredditHeader(root: Element | Document): ExtractedHeader | null {
  const el = matchesOrDescendants(root, SUBREDDIT_HEADER)[0];
  if (!el) return null;
  const rawName = el.getAttribute(HEADER_ATTR.name) ?? el.getAttribute(HEADER_ATTR.prefixed);
  const name = normalizeSubreddit(rawName);
  if (!name || !rawName) return null;
  const wau = Number(el.getAttribute(HEADER_ATTR.weeklyActiveUsers));
  const display = el.getAttribute(HEADER_ATTR.displayName) || displayNameOf(rawName);
  return {
    name,
    displayName: displayNameOf(rawName),
    meta: {
      title: display !== displayNameOf(rawName) ? display : undefined,
      publicDescription: el.getAttribute(HEADER_ATTR.description)?.trim() || undefined,
      weeklyActiveUsers: Number.isFinite(wau) && wau > 0 ? wau : undefined,
    },
  };
}
