/** Normalizes "r/Foo", "/r/Foo/", "Foo" to "foo". Returns null for user-profile pseudo-subreddits and junk. */
export function normalizeSubreddit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (/^\/?u(ser)?\//i.test(s)) return null;
  s = s.replace(/^\/?r\//i, '').replace(/\/.*$/, '');
  if (!/^[A-Za-z0-9_]{2,32}$/.test(s)) return null;
  if (/^u_/i.test(s)) return null;
  return s.toLowerCase();
}

/** Strips "r/" from a display name but keeps its case. */
export function displayNameOf(raw: string): string {
  return raw
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/\/.*$/, '');
}

const NON_SUBREDDIT_PAGES = new Set(['popular', 'all', 'mod', 'friends']);

/**
 * Subreddits the user deliberately navigated to, from a URL path such as /r/foo/ or /r/foo+bar/.
 * Returns [] for aggregate feeds (/r/popular, /r/all) and non-subreddit pages.
 */
export function subredditsFromPath(pathname: string): string[] {
  const m = /^\/r\/([^/]+)/i.exec(pathname);
  if (!m || !m[1]) return [];
  return m[1]
    .split('+')
    .map((n) => normalizeSubreddit(n))
    .filter((n): n is string => !!n && !NON_SUBREDDIT_PAGES.has(n));
}

export function isCommentsPath(pathname: string): boolean {
  return /^\/r\/[^/]+\/comments\//i.test(pathname);
}

/** Only http(s) links are rendered as links in the UI (§12). */
export function subredditUrl(name: string): string {
  return `https://www.reddit.com/r/${encodeURIComponent(name)}/`;
}
