export type ListQuery = {
  limit: number;
  offset: number;
  search: string | null;
  sort: string | null;
  tags: string[];
  start: string | null;
  end: string | null;
};

export type FilterBuilder = {
  clauses: string[];
  params: (string | number)[];
};

type ListQueryOptions = {
  defaultLimit?: number;
  maxLimit?: number;
};

/**
 * A page size from `?limit=`: whole numbers only (rounded down), at least 1,
 * at most `max`; missing, zero or not a number is `fallback`. The one rule for
 * every list (lib/http.ts limitFrom uses it too). A negative limit used to
 * reach SQL, where LIMIT -1 means no limit.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number(raw)) || fallback, 1), max);
}

/** `?offset=` as a whole number, at least 0. */
export function clampOffset(raw: unknown): number {
  return Math.max(Math.floor(Number(raw)) || 0, 0);
}

export function parseListQuery(
  query: Record<string, string | undefined>,
  options: ListQueryOptions = {}
): ListQuery {
  const defaultLimit = options.defaultLimit ?? 100;
  const maxLimit = options.maxLimit ?? 1000;
  const limit = clampLimit(query.limit, defaultLimit, maxLimit);
  const offset = clampOffset(query.offset);
  const search = query.search?.trim() || null;
  const sort = query.sort?.trim() || null;
  const start = query.start?.trim() || null;
  const end = query.end?.trim() || null;
  const tags = parseTags(query.tags);

  return { limit, offset, search, sort, tags, start, end };
}

export function parseTags(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function createFilterBuilder(): FilterBuilder {
  return { clauses: [], params: [] };
}

export function addSearchFilter(
  builder: FilterBuilder,
  search: string | null,
  columns: string[]
): void {
  if (!search || columns.length === 0) {
    return;
  }
  const like = `%${search}%`;
  builder.clauses.push(columns.map((column) => `${column} LIKE ?`).join(" OR "));
  columns.forEach(() => builder.params.push(like));
}

export function addTagsFilter(
  builder: FilterBuilder,
  tags: string[],
  column = "tags_json"
): void {
  if (!tags.length) {
    return;
  }
  tags.forEach((tag) => {
    builder.clauses.push(`${column} LIKE ?`);
    builder.params.push(`%${tag}%`);
  });
}

// Adds `published = 1` to the filter unless the caller passes
// `?include_unpublished=true`. Both the public site and the OS
// authenticate with the same token; the distinction is a query param.
export function addPublishedFilter(
  builder: FilterBuilder,
  query: Record<string, string | undefined>,
  column = "published"
): void {
  const raw = query.include_unpublished?.toLowerCase();
  const includeAll = raw === "true" || raw === "1" || raw === "yes";
  if (!includeAll) {
    builder.clauses.push(`${column} = 1`);
  }
}

export function addDateRangeFilter(
  builder: FilterBuilder,
  column: string,
  start: string | null,
  end: string | null
): void {
  if (start && end) {
    builder.clauses.push(`${column} BETWEEN ? AND ?`);
    builder.params.push(start, end);
    return;
  }
  if (start) {
    builder.clauses.push(`${column} >= ?`);
    builder.params.push(start);
    return;
  }
  if (end) {
    builder.clauses.push(`${column} <= ?`);
    builder.params.push(end);
  }
}

export function buildWhereClause(builder: FilterBuilder): string {
  if (!builder.clauses.length) {
    return "";
  }
  return ` WHERE ${builder.clauses.join(" AND ")}`;
}

export function parseSort(
  sort: string | null,
  allowed: Record<string, string>,
  fallback: string
): string {
  if (!sort) {
    return fallback;
  }
  const trimmed = sort.trim();
  if (!trimmed) {
    return fallback;
  }
  let direction = "ASC";
  let key = trimmed;
  if (trimmed.startsWith("-")) {
    direction = "DESC";
    key = trimmed.slice(1);
  }
  const column = allowed[key];
  if (!column) {
    return fallback;
  }
  return `${column} ${direction}`;
}

export function parseId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/** How a PATCH field is written: to a column of another name, and/or through a transform. */
export type PatchColumn = true | string | { column?: string; to?: (value: any) => unknown };

/**
 * The `SET` assignments for the fields a PATCH body carries (present, even if
 * null), in the order `columns` lists them. A field maps to the column of its
 * own name, written as `value ?? null`, unless its entry names another column
 * or a transform. Fields not listed are ignored.
 */
export function patchAssignments(data: Record<string, unknown>, columns: Record<string, PatchColumn>): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [field, spec] of Object.entries(columns)) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    const column = typeof spec === "string" ? spec : spec === true ? field : spec.column ?? field;
    const to = typeof spec === "object" && spec.to ? spec.to : (value: unknown) => value ?? null;
    sets.push(`${column} = ?`);
    params.push(to(data[field]));
  }
  return { sets, params };
}

/** `published` as the 0/1 column: anything but an explicit false is published. */
export const publishedFlag = (value: unknown) => (value === false ? 0 : 1);
