export const DEFAULT_PAGE_SIZE = 10;

export interface PaginationSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function paginateItems<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize = DEFAULT_PAGE_SIZE,
): PaginationSlice<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0
    ? Math.max(1, Math.floor(pageSize))
    : DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const safeRequestedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(totalPages, Math.max(1, safeRequestedPage));
  const start = (page - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    page,
    pageSize: safePageSize,
    totalItems: items.length,
    totalPages,
  };
}
