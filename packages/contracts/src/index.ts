import { z } from 'zod';

export const scopeSchema = z.enum(['internet', 'lan', 'combined', 'reported', 'unknown']);
export const qualitySchema = z.enum(['valid', 'baseline', 'reset', 'gap', 'unsupported']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}
export const clientListQuerySchema = z.object({
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  connection: z.enum(['all', 'wired', 'wireless']).default('all'),
  deviceId: z.preprocess(value => value === '' || value === 'all' ? undefined : value,
    z.string().regex(uuidPattern).optional()),
  sort: z.enum(['recent', 'name']).default('recent'),
});
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

/** Read list filters from page URL parameters. Each missing or invalid value gets its default. */
export function parseClientListQuery(params: Record<string, string | string[] | undefined>): ClientListQuery {
  const shape = clientListQuerySchema.shape;
  const field = <K extends keyof typeof shape>(key: K): ClientListQuery[K] => {
    const raw = params[key];
    const parsed = shape[key].safeParse(Array.isArray(raw) ? raw[0] : raw);
    return (parsed.success ? parsed.data : shape[key].parse(undefined)) as ClientListQuery[K];
  };
  return {q: field('q'), page: field('page'), limit: field('limit'), connection: field('connection'),
    deviceId: field('deviceId'), sort: field('sort')};
}
