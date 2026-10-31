// Required environment settings. The server refuses to start without them (SPEC §12).
const MIN_TOKEN_LENGTH = 32;

export function readConfig(env: Record<string, string | undefined>): { token: string } {
  const token = env.SERVER_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`SERVER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long.`);
  }
  // #22 compares this with the browser's Origin header, so a trailing slash could never match.
  const origin = env.PUBLIC_ORIGIN ?? '';
  if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must be an origin such as https://reddithide.example.ts.net');
  }
  return { token };
}
