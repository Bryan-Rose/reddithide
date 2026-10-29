// Content script for www.reddit.com: capture subreddits (SPEC §5.1) and hide posts (§9).
// Runs at document_start so the MutationObserver marks posts before they are first painted.
import browser from '../shared/browser';
import type { ContentToBackground, PageStats, SeenName } from '../shared/messages';
import { subredditsFromPath } from '../shared/names';
import { BLOCKSET_KEY, loadBlockSet } from '../shared/settings';
import type { BlockSet } from '../shared/types';
import { extractPosts, extractSubredditHeader, type ExtractedPost } from './extract';
import { applyHide, HIDE_ATTR, makeContext, PRELOAD_STYLESHEET, STYLESHEET, type HideContext } from './hide';
import { ANY_INTERESTING, SUBREDDIT_HEADER } from './selectors';

const BATCH_MAX_NAMES = 50;
const FLUSH_INTERVAL_MS = 1000;
const URL_POLL_MS = 500;
const PRELOAD_TIMEOUT_MS = 1500;

let blockSet: BlockSet | undefined;
let blockSetLoaded = false;
let ctx: HideContext = makeContext(undefined, subredditsFromPath(location.pathname));

// Per page view (reset on SPA navigation).
let currentUrl = location.href;
let sightedNames = new Set<string>();
let seenPostIds = new Set<string>();
let hiddenPostIds = new Set<string>();
let headerSentFor: string | null = null;

const pending = new Map<string, SeenName>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let lastReportedHidden = -1;

function send(msg: ContentToBackground): void {
  browser.runtime.sendMessage(msg).catch(() => {
    // Background may be restarting; the next batch will carry on.
  });
}

// ---- Styles ----

function injectStyles(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = STYLESHEET;
  const preload = document.createElement('style');
  preload.textContent = PRELOAD_STYLESHEET;
  preload.id = 'reddithide-preload';
  const parent = document.head ?? document.documentElement;
  parent.append(style, preload);
  return preload;
}

const preloadStyle = injectStyles();
const preloadTimeout = setTimeout(() => preloadStyle.remove(), PRELOAD_TIMEOUT_MS);

// ---- Capture ----

function capture(post: ExtractedPost): void {
  let entry = pending.get(post.name);
  const firstSighting = !sightedNames.has(post.name);
  if (firstSighting) sightedNames.add(post.name);
  const newPost = post.title && !seenPostIds.has(post.postId);
  if (newPost) seenPostIds.add(post.postId);
  if (!firstSighting && !newPost && post.over18 === undefined) return;

  if (!entry) {
    entry = { name: post.name, displayName: post.displayName, sighting: false };
    pending.set(post.name, entry);
  }
  if (firstSighting) entry.sighting = true;
  if (post.over18 !== undefined) entry.over18 = post.over18;
  if (post.quarantined !== undefined) entry.quarantined = post.quarantined;
  if (newPost && post.title) {
    (entry.posts ??= []).push({ id: post.postId, title: post.title, lang: post.lang });
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush(): void {
  flushTimer = null;
  if (!pending.size) return;
  const names: SeenName[] = [];
  for (const [k, v] of pending) {
    names.push(v);
    pending.delete(k);
    if (names.length >= BATCH_MAX_NAMES) break;
  }
  send({ type: 'seen', names, url: location.href });
  if (pending.size) scheduleFlush();
}

function captureHeader(root: Element | Document): void {
  const header = extractSubredditHeader(root);
  if (!header || headerSentFor === header.name) return;
  headerSentFor = header.name;
  send({ type: 'subredditMeta', name: header.name, displayName: header.displayName, meta: header.meta });
  if (!sightedNames.has(header.name)) {
    sightedNames.add(header.name);
    const entry = pending.get(header.name) ?? {
      name: header.name,
      displayName: header.displayName,
      sighting: false,
    };
    entry.sighting = true;
    pending.set(header.name, entry);
    scheduleFlush();
  }
}

// ---- Hiding ----

function hide(post: ExtractedPost): void {
  if (!blockSetLoaded) return; // processed again once the block set arrives
  if (applyHide(ctx, post)) hiddenPostIds.add(post.postId);
  else hiddenPostIds.delete(post.postId);
}

function reportStats(): void {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    if (hiddenPostIds.size === lastReportedHidden) return;
    lastReportedHidden = hiddenPostIds.size;
    send({ type: 'pageStats', hidden: hiddenPostIds.size });
  }, 300);
}

function processRoot(root: Element | Document): void {
  for (const post of extractPosts(root)) {
    capture(post);
    hide(post);
  }
  reportStats();
}

function rescanAll(): void {
  processRoot(document);
  captureHeader(document);
}

// ---- Observers ----

const observer = new MutationObserver((mutations) => {
  // SPA navigation often inserts the new page's posts before the URL poll fires.
  if (location.href !== currentUrl) onUrlChange();
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      // Fast path: skip subtrees with nothing we care about.
      if (!el.matches(ANY_INTERESTING) && !el.querySelector(ANY_INTERESTING)) continue;
      processRoot(el);
      if (el.matches(SUBREDDIT_HEADER) || el.querySelector(SUBREDDIT_HEADER)) captureHeader(el);
    }
  }
});
observer.observe(document, { childList: true, subtree: true });

function onUrlChange(): void {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  sightedNames = new Set();
  seenPostIds = new Set();
  hiddenPostIds = new Set();
  headerSentFor = null;
  ctx = makeContext(blockSet, subredditsFromPath(location.pathname));
  rescanAll();
}
setInterval(onUrlChange, URL_POLL_MS);
addEventListener('popstate', onUrlChange);

// Clicking a collapsed placeholder reveals the post. Its children are display:none, so the click lands on it.
addEventListener(
  'click',
  (e) => {
    const target = e.target as Element | null;
    const el = target?.closest?.(`[${HIDE_ATTR}="collapse"]`);
    if (!el || el !== target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    el.setAttribute(HIDE_ATTR, 'shown');
    for (const post of extractPosts(el)) hiddenPostIds.delete(post.postId);
    reportStats();
  },
  true,
);

// ---- Block set ----

function setBlockSet(bs: BlockSet | undefined): void {
  blockSet = bs;
  blockSetLoaded = true;
  ctx = makeContext(blockSet, subredditsFromPath(location.pathname));
  processRoot(document);
  clearTimeout(preloadTimeout);
  preloadStyle.remove();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[BLOCKSET_KEY])
    setBlockSet(changes[BLOCKSET_KEY].newValue as BlockSet | undefined);
});

loadBlockSet()
  .then(setBlockSet)
  .catch(() => setBlockSet(undefined));

browser.runtime.onMessage.addListener((msg: unknown) => {
  if ((msg as { type?: string })?.type === 'getPageStats') {
    const stats: PageStats = {
      hidden: hiddenPostIds.size,
      pageSubreddits: subredditsFromPath(location.pathname),
    };
    return Promise.resolve(stats);
  }
  return undefined;
});

if (document.readyState !== 'loading') rescanAll();
else document.addEventListener('DOMContentLoaded', rescanAll, { once: true });
