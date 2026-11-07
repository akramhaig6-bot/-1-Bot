import type { ButtonBoard, MenuPageDefinition, MenuSettings } from './types.js';

export interface ResolvedMenuPage extends MenuPageDefinition {
  index: number;
  total: number;
}

export function orderedButtonIds(board: ButtonBoard): string[] {
  const known = new Set(board.buttons.map((button) => button.id));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of board.rows) {
    for (const id of row) {
      if (known.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  for (const button of board.buttons) {
    if (!seen.has(button.id)) ordered.push(button.id);
  }
  return ordered;
}

function rowsForIds(board: ButtonBoard, ids: string[], preferredRows?: string[][]): string[][] {
  const targetIds = new Set(ids);
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const row of preferredRows ?? board.rows) {
    const filtered = row.filter((id) => targetIds.has(id) && !seen.has(id));
    if (filtered.length) {
      filtered.forEach((id) => seen.add(id));
      result.push(filtered);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) result.push([id]);
  }
  return result;
}

export function resolveMenuPages(board: ButtonBoard): ResolvedMenuPage[] {
  const settings = board.menuSettings;
  const allIds = orderedButtonIds(board);

  if (!settings || settings.pageMode === 'off') {
    return [{
      id: 'all',
      buttonIds: allIds,
      rows: rowsForIds(board, allIds),
      index: 0,
      total: 1,
    }];
  }

  if (settings.pageMode === 'automatic') {
    if (!allIds.length) return [];
    const size = Math.max(1, Math.floor(settings.itemsPerPage) || 1);
    const slices: string[][] = [];
    for (let index = 0; index < allIds.length; index += size) {
      slices.push(allIds.slice(index, index + size));
    }
    return slices.map((buttonIds, index) => ({
      id: `auto:${index}`,
      buttonIds,
      rows: rowsForIds(board, buttonIds),
      index,
      total: slices.length,
    }));
  }

  const known = new Set(allIds);
  const assigned = new Set<string>();
  const pages = settings.manualPages.map((page, index) => {
    const buttonIds = page.buttonIds.filter((id) => {
      if (!known.has(id) || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    });
    return {
      id: page.id,
      buttonIds,
      rows: rowsForIds(board, buttonIds, page.rows),
      index,
      total: settings.manualPages.length,
    };
  });

  const missingIds = allIds.filter((id) => !assigned.has(id));
  if (pages.length === 0) {
    pages.push({ id: 'manual:empty', buttonIds: missingIds, rows: rowsForIds(board, missingIds), index: 0, total: 1 });
  } else if (missingIds.length) {
    const last = pages[pages.length - 1];
    last.buttonIds.push(...missingIds);
    last.rows = rowsForIds(board, last.buttonIds, [...last.rows, ...missingIds.map((id) => [id])]);
  }

  const total = pages.length;
  return pages.map((page, index) => ({ ...page, index, total }));
}

export function resolveCurrentPage(board: ButtonBoard, pageIndex: number, pageId: string | null): ResolvedMenuPage | null {
  const pages = resolveMenuPages(board);
  if (!pages.length) return null;
  if (pageId && board.menuSettings?.pageMode === 'manual') {
    const exact = pages.find((page) => page.id === pageId);
    if (exact) return exact;
  }
  const safeIndex = Math.max(0, Math.min(Math.floor(pageIndex) || 0, pages.length - 1));
  return pages[safeIndex];
}

export function manualPagesFromBoard(board: ButtonBoard, settings: MenuSettings): MenuPageDefinition[] {
  if (settings.manualPages.length) {
    const current = resolveMenuPages({ ...board, menuSettings: { ...settings, pageMode: 'manual' } });
    return current.map(({ id, buttonIds, rows }) => ({ id, buttonIds: [...buttonIds], rows: rows.map((row) => [...row]) }));
  }
  const ids = orderedButtonIds(board);
  const chunkSize = settings.pageMode === 'automatic' ? Math.max(1, Math.floor(settings.itemsPerPage) || 1) : Math.max(1, ids.length);
  const pages: MenuPageDefinition[] = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const buttonIds = ids.slice(offset, offset + chunkSize);
    pages.push({
      id: `page-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${offset}`}`,
      buttonIds,
      rows: rowsForIds(board, buttonIds),
    });
  }
  if (!pages.length) {
    pages.push({ id: `page-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, buttonIds: [], rows: [] });
  }
  return pages;
}
