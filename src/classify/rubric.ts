// rubricVersion = first 12 hex chars of SHA-256 over the prompt template, the enabled attribute
// definitions and the topic list (SPEC §7.5). Any edit changes it.
import type { AttributeDef } from '../shared/types';
import { SYSTEM_TEMPLATE } from './prompt';

export function rubricInput(attrs: AttributeDef[], topics: string[]): string {
  const enabled = attrs
    .filter((a) => a.enabled)
    .map(({ id, type, options, maxSelections, definition, source }) => ({
      id,
      type,
      options: id === 'topic' ? undefined : options,
      maxSelections,
      definition,
      source,
    }));
  return JSON.stringify({ template: SYSTEM_TEMPLATE, attributes: enabled, topics });
}

export async function computeRubricVersion(attrs: AttributeDef[], topics: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(rubricInput(attrs, topics));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}
