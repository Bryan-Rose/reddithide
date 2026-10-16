// Output schema built dynamically from the enabled attributes (SPEC §7.5).
// Two flavors: a strict JSON Schema sent to the model, and a lenient zod validator for what comes back.
import { z } from 'zod';
import type { AttributeDef } from '../shared/types';

export const SCHEMA_NAME = 'record_classification';

export function llmAttributes(attrs: AttributeDef[]): AttributeDef[] {
  return attrs.filter((a) => a.enabled && a.source === 'llm');
}

export function optionsFor(attr: AttributeDef, topics: string[]): string[] {
  return attr.id === 'topic' ? topics : (attr.options ?? []);
}

function strictValue(attr: AttributeDef, topics: string[]): z.ZodType {
  const opts = optionsFor(attr, topics);
  const enumOrString = opts.length ? z.enum(opts as [string, ...string[]]) : z.string();
  switch (attr.type) {
    case 'boolean':
      return z.boolean();
    case 'enum':
      return enumOrString;
    case 'multi_enum':
      return z.array(enumOrString);
  }
}

function strictEntry(value: z.ZodType): z.ZodType {
  return z.strictObject({ value, confidence: z.number(), reason: z.string() });
}

/**
 * JSON Schema in the conservative form strict modes accept: every property required,
 * additionalProperties false, no oneOf, enums as plain string enums, no numeric/array bounds.
 */
export function buildJsonSchema(attrs: AttributeDef[], topics: string[], includeLanguageGuess: boolean): object {
  const attributes: Record<string, z.ZodType> = {};
  for (const a of llmAttributes(attrs)) attributes[a.id] = strictEntry(strictValue(a, topics));
  const shape: Record<string, z.ZodType> = {
    summary: z.string(),
    attributes: z.strictObject(attributes),
  };
  if (includeLanguageGuess) shape.language_guess = strictEntry(z.string());
  const json = z.toJSONSchema(z.strictObject(shape), { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// ---- Lenient validation ----

const lenientBool = z.union([
  z.boolean(),
  z.enum(['true', 'false', 'True', 'False', 'yes', 'no']).transform((s) => ['true', 'yes'].includes(s.toLowerCase())),
]);
const lenientString = z.union([z.string(), z.number().transform(String)]);
const lenientList = z.union([z.array(lenientString), lenientString.transform((s) => [s])]);
const confidence = z.coerce.number().catch(0.5);
const reason = z.string().catch('');

function lenientValue(attr: AttributeDef): z.ZodType {
  switch (attr.type) {
    case 'boolean':
      return lenientBool;
    case 'enum':
      return lenientString;
    case 'multi_enum':
      return lenientList;
  }
}

export type RawEntry = { value: boolean | string | string[]; confidence: number; reason: string };
export interface RawClassification {
  summary: string;
  attributes: Record<string, RawEntry>;
  language_guess?: RawEntry;
}

export function buildValidator(
  attrs: AttributeDef[],
  includeLanguageGuess: boolean,
): z.ZodType<RawClassification> {
  const attributes: Record<string, z.ZodType> = {};
  for (const a of llmAttributes(attrs)) {
    attributes[a.id] = z.object({ value: lenientValue(a), confidence, reason });
  }
  const shape: Record<string, z.ZodType> = {
    summary: z.string().catch(''),
    attributes: z.object(attributes),
  };
  if (includeLanguageGuess) {
    shape.language_guess = z.object({ value: lenientString, confidence, reason }).optional();
  }
  return z.object(shape) as unknown as z.ZodType<RawClassification>;
}

/** Short, model-readable summary of a zod error for the retry prompt. */
export function summarizeZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
