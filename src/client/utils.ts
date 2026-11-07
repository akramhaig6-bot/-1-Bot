import { emptyFlow, type BotButton, type BotConfig, type ButtonBoard, type ButtonType, type MenuPageDefinition } from '@shared/types';
import { manualPagesFromBoard } from '@shared/menu';

export function createButton(label: string, type: ButtonType): BotButton {
  return {
    id: crypto.randomUUID(),
    label,
    type,
    flow: emptyFlow(),
  };
}

export function boardWithButton(board: ButtonBoard, button: BotButton): ButtonBoard {
  const next: ButtonBoard = {
    ...board,
    buttons: [...board.buttons, button],
    rows: [...normalizeRows(board), [button.id]],
  };
  if (board.menuSettings?.pageMode === 'manual') {
    const pages = manualPagesFromBoard(board, board.menuSettings);
    if (!pages.length) pages.push({ id: `page-${crypto.randomUUID()}`, buttonIds: [], rows: [] });
    const last = pages[pages.length - 1];
    last.buttonIds.push(button.id);
    last.rows.push([button.id]);
    next.menuSettings = { ...board.menuSettings, manualPages: pages };
  }
  return next;
}

export function normalizeRows(board: ButtonBoard): string[][] {
  const ids = new Set(board.buttons.map((button) => button.id));
  const seen = new Set<string>();
  const rows = board.rows
    .map((row) => row.filter((id) => {
      if (!ids.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }))
    .filter((row) => row.length > 0);
  for (const button of board.buttons) {
    if (!seen.has(button.id)) rows.push([button.id]);
  }
  return rows;
}

export function moveButtonToRow(
  board: ButtonBoard,
  buttonId: string,
  destinationRowIndex: number,
  beforeButtonId?: string,
  forceNewRow = false,
): ButtonBoard {
  if (!board.buttons.some((button) => button.id === buttonId) || beforeButtonId === buttonId) return board;
  const originalRows = normalizeRows(board);
  const sourceRowIndex = originalRows.findIndex((row) => row.includes(buttonId));
  const rows = originalRows.map((row) => row.filter((id) => id !== buttonId)).filter((row) => row.length > 0);

  if (forceNewRow) {
    rows.push([buttonId]);
    return { ...board, rows };
  }

  let resolvedDestination = -1;
  if (beforeButtonId) {
    resolvedDestination = rows.findIndex((row) => row.includes(beforeButtonId));
  }
  if (resolvedDestination < 0) {
    resolvedDestination = destinationRowIndex - (sourceRowIndex >= 0 && sourceRowIndex < destinationRowIndex ? 1 : 0);
    resolvedDestination = Math.max(0, Math.min(resolvedDestination, rows.length));
  }
  if (!rows[resolvedDestination]) rows.splice(resolvedDestination, 0, []);
  const destination = rows[resolvedDestination];
  const insertionIndex = beforeButtonId ? destination.indexOf(beforeButtonId) : -1;
  if (insertionIndex >= 0) destination.splice(insertionIndex, 0, buttonId);
  else destination.push(buttonId);
  return { ...board, rows: rows.filter((row) => row.length > 0) };
}

function withManualPages(board: ButtonBoard, pages: MenuPageDefinition[]): ButtonBoard {
  const settings = board.menuSettings;
  if (!settings) return board;
  const orderedRows: string[][] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const pageIds = new Set(page.buttonIds);
    for (const row of normalizeRows({
      buttons: board.buttons.filter((button) => pageIds.has(button.id)),
      rows: page.rows,
    })) {
      const filtered = row.filter((id) => !seen.has(id));
      if (filtered.length) {
        filtered.forEach((id) => seen.add(id));
        orderedRows.push(filtered);
      }
    }
  }
  for (const button of board.buttons) if (!seen.has(button.id)) orderedRows.push([button.id]);
  return {
    ...board,
    rows: orderedRows,
    menuSettings: { ...settings, pageMode: 'manual', manualPages: pages },
  };
}

export function moveButtonBetweenManualPages(board: ButtonBoard, buttonId: string, destinationPageId: string): ButtonBoard {
  if (board.menuSettings?.pageMode !== 'manual') return board;
  const pages = manualPagesFromBoard(board, board.menuSettings);
  const destination = pages.find((page) => page.id === destinationPageId);
  if (!destination || !board.buttons.some((button) => button.id === buttonId)) return board;
  const source = pages.find((page) => page.buttonIds.includes(buttonId));
  if (!source || source.id === destination.id) return board;
  source.buttonIds = source.buttonIds.filter((id) => id !== buttonId);
  source.rows = source.rows.map((row) => row.filter((id) => id !== buttonId)).filter((row) => row.length > 0);
  destination.buttonIds.push(buttonId);
  destination.rows.push([buttonId]);
  return withManualPages(board, pages);
}

export function reorderButtonInManualPage(
  board: ButtonBoard,
  pageId: string,
  buttonId: string,
  destinationRowIndex: number,
  beforeButtonId?: string,
  forceNewRow = false,
): ButtonBoard {
  if (board.menuSettings?.pageMode !== 'manual') return board;
  const pages = manualPagesFromBoard(board, board.menuSettings);
  const page = pages.find((item) => item.id === pageId);
  if (!page || !page.buttonIds.includes(buttonId)) return board;
  const pageIds = new Set(page.buttonIds);
  const pageBoard: ButtonBoard = {
    buttons: board.buttons.filter((button) => pageIds.has(button.id)),
    rows: page.rows,
  };
  const moved = moveButtonToRow(pageBoard, buttonId, destinationRowIndex, beforeButtonId, forceNewRow);
  page.rows = normalizeRows(moved);
  page.buttonIds = page.rows.flat();
  return withManualPages(board, pages);
}

export function reorderManualPage(board: ButtonBoard, pageId: string, direction: -1 | 1): ButtonBoard {
  if (board.menuSettings?.pageMode !== 'manual') return board;
  const pages = manualPagesFromBoard(board, board.menuSettings);
  const index = pages.findIndex((page) => page.id === pageId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pages.length) return board;
  [pages[index], pages[target]] = [pages[target], pages[index]];
  return withManualPages(board, pages);
}

export function removeEmptyManualPage(board: ButtonBoard, pageId: string): ButtonBoard {
  if (board.menuSettings?.pageMode !== 'manual') return board;
  const pages = manualPagesFromBoard(board, board.menuSettings);
  if (pages.length <= 1) return board;
  const page = pages.find((item) => item.id === pageId);
  if (!page || page.buttonIds.length) return board;
  return withManualPages(board, pages.filter((item) => item.id !== pageId));
}

export function removeButtonFromBoard(board: ButtonBoard, buttonId: string): ButtonBoard {
  const next: ButtonBoard = {
    ...board,
    buttons: board.buttons.filter((button) => button.id !== buttonId),
    rows: board.rows.map((row) => row.filter((id) => id !== buttonId)).filter((row) => row.length > 0),
  };
  if (board.menuSettings) {
    next.menuSettings = {
      ...board.menuSettings,
      manualPages: board.menuSettings.manualPages.map((page) => ({
        ...page,
        buttonIds: page.buttonIds.filter((id) => id !== buttonId),
        rows: page.rows.map((row) => row.filter((id) => id !== buttonId)).filter((row) => row.length > 0),
      })),
    };
  }
  return next;
}

export function findButtonInBoard(board: ButtonBoard, buttonId: string): BotButton | null {
  for (const button of board.buttons) {
    if (button.id === buttonId) return button;
    const nested = findButtonInBoard(button.flow.inline, buttonId)
      ?? findButtonInBoard(button.flow.reply, buttonId);
    if (nested) return nested;
  }
  return null;
}

export function findButton(bot: BotConfig, buttonId: string): BotButton | null {
  return findButtonInBoard(bot.inline, buttonId) ?? findButtonInBoard(bot.reply, buttonId);
}

export function findButtonPath(bot: BotConfig, buttonId: string): string[] | null {
  const search = (board: ButtonBoard, path: string[]): string[] | null => {
    for (const button of board.buttons) {
      const current = [...path, button.id];
      if (button.id === buttonId) return current;
      const found = search(button.flow.inline, current) ?? search(button.flow.reply, current);
      if (found) return found;
    }
    return null;
  };
  return search(bot.inline, []) ?? search(bot.reply, []);
}

export function getButtonFromPath(bot: BotConfig, path: string[]): BotButton | null {
  let current: BotButton | null = null;
  let inline = bot.inline;
  let reply = bot.reply;
  for (const id of path) {
    current = inline.buttons.find((button) => button.id === id)
      ?? reply.buttons.find((button) => button.id === id)
      ?? null;
    if (!current) return null;
    inline = current.flow.inline;
    reply = current.flow.reply;
  }
  return current;
}

export function updateButtonInBot(
  bot: BotConfig,
  buttonId: string,
  update: (button: BotButton) => BotButton,
): BotConfig {
  const updateBoard = (board: ButtonBoard): ButtonBoard => ({
    ...board,
    buttons: board.buttons.map((button) => {
      if (button.id === buttonId) return update(button);
      return {
        ...button,
        flow: {
          ...button.flow,
          inline: updateBoard(button.flow.inline),
          reply: updateBoard(button.flow.reply),
        },
      };
    }),
  });
  return { ...bot, inline: updateBoard(bot.inline), reply: updateBoard(bot.reply) };
}

export function deleteButtonInBot(bot: BotConfig, buttonId: string): BotConfig {
  const removedRoot = findButton(bot, buttonId);
  const removedIds = new Set<string>();
  const collect = (button: BotButton) => {
    removedIds.add(button.id);
    for (const child of [...button.flow.inline.buttons, ...button.flow.reply.buttons]) collect(child);
  };
  if (removedRoot) collect(removedRoot);
  const updateBoard = (board: ButtonBoard): ButtonBoard => ({
    ...board,
    buttons: board.buttons
      .filter((button) => button.id !== buttonId)
      .map((button) => ({
        ...button,
        flow: {
          ...button.flow,
          inline: updateBoard(button.flow.inline),
          reply: updateBoard(button.flow.reply),
        },
      })),
    rows: board.rows.map((row) => row.filter((id) => !removedIds.has(id))).filter((row) => row.length > 0),
    ...(board.menuSettings ? {
      menuSettings: {
        ...board.menuSettings,
        manualPages: board.menuSettings.manualPages.map((page) => ({
          ...page,
          buttonIds: page.buttonIds.filter((id) => !removedIds.has(id)),
          rows: page.rows.map((row) => row.filter((id) => !removedIds.has(id))).filter((row) => row.length > 0),
        })),
      },
    } : {}),
  });
  return { ...bot, inline: updateBoard(bot.inline), reply: updateBoard(bot.reply) };
}

export function isPreferenceMissing(bot: BotConfig): boolean {
  const walk = (board: ButtonBoard): boolean => board.buttons.some((button) => {
    const both = button.flow.inline.buttons.length > 0 && button.flow.reply.buttons.length > 0;
    return (both && !button.flow.keyboardPreference)
      || walk(button.flow.inline)
      || walk(button.flow.reply);
  });
  const hasBothRootBoards = bot.inline.buttons.length > 0 && bot.reply.buttons.length > 0;
  return (hasBothRootBoards && !bot.startKeyboardPreference) || walk(bot.inline) || walk(bot.reply);
}

export function allButtons(bot: BotConfig): BotButton[] {
  const result: BotButton[] = [];
  const walk = (board: ButtonBoard): void => {
    for (const button of board.buttons) {
      result.push(button);
      walk(button.flow.inline);
      walk(button.flow.reply);
    }
  };
  walk(bot.inline);
  walk(bot.reply);
  return result;
}

export function shortId(id: string): string {
  return id.slice(0, 6).toUpperCase();
}

export function displayBotName(bot: BotConfig): string {
  if (bot.connection.username) return `@${bot.connection.username}`;
  return `مساحة إعداد · ${shortId(bot.id)}`;
}

export function formatDate(dateString: string): string {
  try {
    return new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(dateString));
  } catch {
    return '';
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}
