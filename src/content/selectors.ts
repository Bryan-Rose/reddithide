// Every new-Reddit selector and attribute name lives here (SPEC §5.1).
// Verified against the live site on 2026-10-16 (logged out). Update here when Reddit changes its markup.

/** Feed/listing post. Attributes below are on this element. */
export const POST = 'shreddit-post';
export const POST_ATTR = {
  subreddit: 'subreddit-name', // "AskHistorians"
  prefixed: 'subreddit-prefixed-name', // "r/AskHistorians" or "u/someone"
  id: 'id', // "t3_abc123"
  title: 'post-title',
  language: 'post-language', // "en"
  viewContext: 'view-context', // "AggregateFeed" | "SubredditFeed" | "CommentsPage" | ...
} as const;
/** view-context value of the main post on a comments page. We record it but never hide it. */
export const VIEW_CONTEXT_COMMENTS = 'CommentsPage';

/**
 * In feeds each post is `shreddit-feed > article > shreddit-post`, followed by an `<hr>` sibling.
 * We hide the article (and the hr after it in remove mode) so no empty card or double divider remains.
 * Reddit virtualizes the feed: off-screen articles are swapped for `div.virtualized-placeholder`
 * elements sized to the measured height, so a hidden (zero-height) article leaves no gap.
 */
export const POST_WRAPPER = 'article';

/** Search results don't use shreddit-post. Each result is one of these, followed by an `<hr>`. */
export const SEARCH_UNIT = 'search-telemetry-tracker[view-events="search/view/post"]';
/** JSON attribute on SEARCH_UNIT: { post: {id, title, nsfw}, subreddit: {id, name, nsfw, quarantined} }. */
export const SEARCH_CONTEXT_ATTR = 'data-faceplate-tracking-context';

/** Subreddit page header with public metadata. */
export const SUBREDDIT_HEADER = 'shreddit-subreddit-header';
export const HEADER_ATTR = {
  name: 'name',
  displayName: 'display-name',
  prefixed: 'prefixed-name',
  description: 'description',
  weeklyActiveUsers: 'weekly-active-users',
} as const;

/** Selector matching anything the content script cares about, for the MutationObserver fast path. */
export const ANY_INTERESTING = `${POST}, ${SEARCH_UNIT}, ${SUBREDDIT_HEADER}`;
