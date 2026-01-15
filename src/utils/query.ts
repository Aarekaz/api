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

export function parseListQuery(
  query: Record<string, string | undefined>,
  options: ListQueryOptions = {}
): ListQuery {
  const defaultLimit = options.defaultLimit ?? 100;
  const maxLimit = options.maxLimit ?? 1000;
  const limit = Math.min(Number(query.limit) || defaultLimit, maxLimit);
  const offset = Math.max(Number(query.offset) || 0, 0);
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
