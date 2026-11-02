// Required environment settings. The server refuses to start without them (SPEC §12).
import { isLocalUrl } from '../shared/constants';

const MIN_TOKEN_LENGTH = 32;

export function readConfig(env: Record<string, string | undefined>): { token: string; origin: string } {
  const token = env.SERVER_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`SERVER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long.`);
  }
  // Compared with the browser's Origin header, so a trailing slash could never match.
  const origin = env.PUBLIC_ORIGIN ?? '';
  if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must be an origin such as https://reddithide.example.ts.net');
  }
  // Over plain HTTP the login cookie is dropped and the pages lose crypto.subtle, so nothing would work.
  if (origin.startsWith('http:') && !isLocalUrl(origin)) {
    throw new Error('PUBLIC_ORIGIN must use https, because login needs a secure page.');
  }
  return { token, origin };
}
