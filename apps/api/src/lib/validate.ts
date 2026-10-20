import type { Context } from 'hono';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '@recap/core';

export async function body<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest('Validation failed', r.error.flatten());
  return r.data;
}

export function query<T extends ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw badRequest('Invalid query parameters', r.error.flatten());
  return r.data;
}

export { z };
