import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BotConfig, ButtonBoard, ButtonType, KeyboardPreference, NavigationAction, UserNavigationFrame, UserNavigationState } from '../shared/types.js';
import { resolveCurrentPage, resolveMenuPages } from '../shared/menu.js';
import {
  decryptToken,
  encryptToken,
  getStoredBot,
  getUserNavigationState,
  listStoredBots,
  mediaDiskPath,
  saveUserNavigationState,
  toPublicBot,
  updateStoredBot,
  type StoredBot,
  type StoredButton,
  type StoredButtonBoard,
  type StoredMediaItem,
} from './store.js';

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramIncomingMessage {
  message_id: number;
  chat: TelegramChat;
  from?: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: TelegramChat };
}

interface TelegramSentMessage {
  message_id: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramSendOptions {
  reply_markup?: Record<string, unknown>;
  caption?: string;
}

class TelegramApiError extends Error {
  code: number;

  constructor(code: number, description: string) {
    super(description);
    this.name = 'TelegramApiError';
    this.code = code;
  }
}

function telegramApiUrl(token: string, method: string): string {
  const configuredBase = process.env.TELEGRAM_API_BASE_URL?.trim();
  let base = configuredBase || 'https://api.telegram.org';
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/bot${token}/${method}`;
}

class TelegramPollingClient {
  readonly token: string;
  private running = false;
  private offset = 0;
  private loopPromise: Promise<void> | null = null;
  private activeRequest: AbortController | null = null;
  private updateHandler: ((update: TelegramUpdate) => Promise<void>) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;
  private healthyHandler: (() => void) | null = null;
  private hasReportedError = false;

  constructor(token: string) {
    this.token = token;
  }

  onUpdate(handler: (update: TelegramUpdate) => Promise<void>): void {
    this.updateHandler = handler;
  }

  onPollingError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }

  onHealthy(handler: () => void): void {
    this.healthyHandler = handler;
  }

  private async call<T>(method: string, payload: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<T> {
    const controller = new AbortController();
    this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(telegramApiUrl(this.token, method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const result = await response.json() as TelegramApiResponse<T>;
      if (!response.ok || !result.ok || result.result === undefined) {
        throw new TelegramApiError(result.error_code ?? response.status, result.description ?? 'Telegram API request failed.');
      }
      return result.result;
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) this.activeRequest = null;
    }
  }

  private async callWithFile<T>(
    method: string,
    payload: Record<string, unknown>,
    fieldName: string,
    filePath: string,
    timeoutMs = 70_000,
  ): Promise<T> {
    const controller = new AbortController();
    this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      const bytes = await fs.readFile(filePath);
      const file = new Blob([bytes]);
      form.append(fieldName, file, path.basename(filePath));
      const response = await fetch(telegramApiUrl(this.token, method), {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const result = await response.json() as TelegramApiResponse<T>;
      if (!response.ok || !result.ok || result.result === undefined) {
        throw new TelegramApiError(result.error_code ?? response.status, result.description ?? 'Telegram API request failed.');
      }
      return result.result;
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) this.activeRequest = null;
    }
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe');
  }

  async start(): Promise<TelegramUser> {
    const user = await this.getMe();
    // A short getUpdates request verifies that this token can actually poll,
    // rather than treating getMe alone as a successful connection.
    const initialUpdates = await this.call<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: 0,
      allowed_updates: ['message', 'callback_query'],
    }, 12_000);
    this.running = true;
    for (const update of initialUpdates) await this.processUpdate(update);
    this.loopPromise = this.pollLoop();
    return user;
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    this.offset = Math.max(this.offset, update.update_id + 1);
    if (!this.updateHandler) return;
    try {
      await this.updateHandler(update);
    } catch (error) {
      // A failed delivery for one chat must not stop polling for every other chat.
      console.error('تعذر تسليم تحديث تيليجرام:', summarizeError(error));
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.call<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        }, 40_000);
        if (this.hasReportedError) {
          this.hasReportedError = false;
          this.healthyHandler?.();
        }
        for (const update of updates) {
          if (!this.running) break;
          await this.processUpdate(update);
        }
      } catch (error) {
        if (!this.running) break;
        this.hasReportedError = true;
        this.errorHandler?.(error);
        if (error instanceof TelegramApiError && (error.code === 401 || error.code === 409)) {
          this.running = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }
    }
  }

  async sendMessage(chatId: number, text: string, options: TelegramSendOptions = {}): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>('sendMessage', { chat_id: chatId, text, ...options });
  }

  async sendPhoto(chatId: number, filePath: string, options: TelegramSendOptions = {}): Promise<TelegramSentMessage> {
    return this.callWithFile<TelegramSentMessage>('sendPhoto', { chat_id: chatId, ...options }, 'photo', filePath);
  }

  async sendVideo(chatId: number, filePath: string, options: TelegramSendOptions = {}): Promise<TelegramSentMessage> {
    return this.callWithFile<TelegramSentMessage>('sendVideo', { chat_id: chatId, ...options }, 'video', filePath);
  }

  async sendVoice(chatId: number, filePath: string, options: TelegramSendOptions = {}): Promise<TelegramSentMessage> {
    return this.callWithFile<TelegramSentMessage>('sendVoice', { chat_id: chatId, ...options }, 'voice', filePath);
  }

  async sendAudio(chatId: number, filePath: string, options: TelegramSendOptions = {}): Promise<TelegramSentMessage> {
    return this.callWithFile<TelegramSentMessage>('sendAudio', { chat_id: chatId, ...options }, 'audio', filePath);
  }

  async editMessageText(chatId: number, messageId: number, text: string, options: TelegramSendOptions = {}): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options });
  }

  async editMessageCaption(chatId: number, messageId: number, caption: string, options: TelegramSendOptions = {}): Promise<void> {
    await this.call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, ...options });
  }

  async editMessageReplyMarkup(chatId: number, messageId: number, markup?: Record<string, unknown>): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, ...(markup ? { reply_markup: markup } : {}) });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.activeRequest?.abort();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
  }
}

interface BotRuntime {
  client: TelegramPollingClient;
  username: string | null;
}

const runtimes = new Map<string, BotRuntime>();

function hasItems(board: ButtonBoard | StoredButtonBoard): boolean {
  return board.buttons.length > 0;
}

function findButtonInBoard(board: StoredButtonBoard, id: string): StoredButton | undefined {
  for (const button of board.buttons) {
    if (button.id === id) return button;
    const nested = findButtonInBoard(button.flow.inline, id) ?? findButtonInBoard(button.flow.reply, id);
    if (nested) return nested;
  }
  return undefined;
}

function findButton(bot: StoredBot, id: string): StoredButton | undefined {
  return findButtonInBoard(bot.inline, id) ?? findButtonInBoard(bot.reply, id);
}

interface KeyboardContext {
  inline: StoredButtonBoard;
  reply: StoredButtonBoard;
  preference: KeyboardPreference | null;
}

function findButtonContextInBoard(
  board: StoredButtonBoard,
  id: string,
  parent: KeyboardContext,
): KeyboardContext | undefined {
  for (const button of board.buttons) {
    if (button.id === id) return parent;
    const childContext: KeyboardContext = {
      inline: button.flow.inline,
      reply: button.flow.reply,
      preference: button.flow.keyboardPreference,
    };
    const nested = findButtonContextInBoard(button.flow.inline, id, childContext)
      ?? findButtonContextInBoard(button.flow.reply, id, childContext);
    if (nested) return nested;
  }
  return undefined;
}

function findButtonContext(bot: StoredBot, id: string): KeyboardContext {
  const rootContext: KeyboardContext = {
    inline: bot.inline,
    reply: bot.reply,
    preference: bot.startKeyboardPreference,
  };
  return findButtonContextInBoard(bot.inline, id, rootContext)
    ?? findButtonContextInBoard(bot.reply, id, rootContext)
    ?? rootContext;
}

function findReplyButtonByTextInBoard(board: StoredButtonBoard, text: string): StoredButton | undefined {
  for (const button of board.buttons) {
    if (button.type === 'reply' && button.label === text) return button;
    const nested = findReplyButtonByTextInBoard(button.flow.inline, text)
      ?? findReplyButtonByTextInBoard(button.flow.reply, text);
    if (nested) return nested;
  }
  return undefined;
}

function findReplyButtonByText(bot: StoredBot, text: string): StoredButton | undefined {
  return findReplyButtonByTextInBoard(bot.reply, text)
    ?? findReplyButtonByTextInBoard(bot.inline, text);
}

function buildKeyboardMarkup(
  inlineBoard: StoredButtonBoard,
  replyBoard: StoredButtonBoard,
  preference: KeyboardPreference | null,
): TelegramSendOptions['reply_markup'] | undefined {
  const hasInline = hasItems(inlineBoard);
  const hasReply = hasItems(replyBoard);
  if (!hasInline && !hasReply) return undefined;
  if (hasInline && hasReply && !preference) return undefined;

  const selected: ButtonType = hasInline && hasReply
    ? preference as ButtonType
    : hasInline ? 'inline' : 'reply';

  if (selected === 'inline') {
    const buttons = new Map(inlineBoard.buttons.map((button) => [button.id, button]));
    const rows = inlineBoard.rows
      .map((row) => row.flatMap((id) => {
        const button = buttons.get(id);
        if (!button) return [];
        return [{ text: button.label, callback_data: `b:${button.id}` }];
      }))
      .filter((row) => row.length > 0);
    return rows.length ? { inline_keyboard: rows } : undefined;
  }

  const buttons = new Map(replyBoard.buttons.map((button) => [button.id, button]));
  const rows = replyBoard.rows
    .map((row) => row.flatMap((id) => {
      const button = buttons.get(id);
      return button ? [{ text: button.label }] : [];
    }))
    .filter((row) => row.length > 0);
  return rows.length ? { keyboard: rows, resize_keyboard: true } : undefined;
}

function makeKeyboardForFlow(
  bot: StoredBot,
  button: StoredButton,
  parentContext: KeyboardContext,
): TelegramSendOptions['reply_markup'] | undefined {
  const flow = button.flow;
  const hasInline = hasItems(flow.inline);
  const hasReply = hasItems(flow.reply);
  if (hasInline || hasReply) {
    return buildKeyboardMarkup(flow.inline, flow.reply, flow.keyboardPreference);
  }

  // Telegram shows one keyboard type per message. If both types were designed
  // for the parent message, show the selected type there and the other type on
  // the reply sent after a button press, so neither one is silently discarded.
  const parentHasInline = hasItems(parentContext.inline);
  const parentHasReply = hasItems(parentContext.reply);
  if (parentHasInline && parentHasReply && parentContext.preference) {
    return parentContext.preference === 'inline'
      ? buildKeyboardMarkup({ buttons: [], rows: [] }, parentContext.reply, null)
      : buildKeyboardMarkup(parentContext.inline, { buttons: [], rows: [] }, null);
  }
  if (parentHasInline || parentHasReply) {
    return buildKeyboardMarkup(parentContext.inline, parentContext.reply, parentContext.preference);
  }
  if (hasItems(bot.reply)) return buildKeyboardMarkup({ buttons: [], rows: [] }, bot.reply, null);
  return undefined;
}

const pageActions: NavigationAction[] = ['first', 'previous', 'next', 'last'];
const menuActions: NavigationAction[] = ['back', 'home'];

function buttonCallbackData(buttonId: string): string {
  const direct = `b:${buttonId}`;
  if (Buffer.byteLength(direct, 'utf8') <= 64) return direct;
  const digest = crypto.createHash('sha256').update(buttonId).digest('base64url').slice(0, 32);
  return `b#${digest}`;
}

function findButtonByCallback(bot: StoredBot, data: string): StoredButton | undefined {
  if (data.startsWith('b:')) return findButton(bot, data.slice(2));
  if (!data.startsWith('b#')) return undefined;
  const target = data.slice(2);
  const walk = (board: StoredButtonBoard): StoredButton | undefined => {
    for (const button of board.buttons) {
      if (buttonCallbackData(button.id) === `b#${target}`) return button;
      const nested = walk(button.flow.inline) ?? walk(button.flow.reply);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(bot.inline) ?? walk(bot.reply);
}

function boardsForScope(bot: StoredBot, scopeButtonId: string | null): KeyboardContext {
  if (!scopeButtonId) return { inline: bot.inline, reply: bot.reply, preference: bot.startKeyboardPreference };
  const owner = findButton(bot, scopeButtonId);
  return owner
    ? { inline: owner.flow.inline, reply: owner.flow.reply, preference: owner.flow.keyboardPreference }
    : { inline: { buttons: [], rows: [] }, reply: { buttons: [], rows: [] }, preference: null };
}

function boardForFrame(bot: StoredBot, frame: UserNavigationFrame): StoredButtonBoard {
  const context = boardsForScope(bot, frame.scopeButtonId);
  return frame.boardType === 'inline' ? context.inline : context.reply;
}

function controlLabel(board: StoredButtonBoard, action: NavigationAction): string | null {
  const settings = board.menuSettings;
  if (!settings) return null;
  if (pageActions.includes(action)) return settings.pageControls[action as 'first' | 'previous' | 'next' | 'last'].label;
  return settings.menuControls[action as 'back' | 'home'].label;
}

function controlEnabled(board: StoredButtonBoard, action: NavigationAction): boolean {
  const settings = board.menuSettings;
  if (!settings) return false;
  if (pageActions.includes(action)) return settings.pageMode !== 'off' && settings.pageControls[action as 'first' | 'previous' | 'next' | 'last'].enabled;
  return settings.menuControls[action as 'back' | 'home'].enabled;
}

function controlAvailable(
  board: StoredButtonBoard,
  action: NavigationAction,
  page: ReturnType<typeof resolveCurrentPage>,
  stackDepth: number,
): boolean {
  if (!controlEnabled(board, action)) return false;
  if (action === 'back' || action === 'home') return stackDepth > 1;
  if (!page || page.total <= 1) return false;
  if (action === 'first' || action === 'previous') return page.index > 0;
  return page.index < page.total - 1;
}

function menuMarkup(
  board: StoredButtonBoard,
  frame: UserNavigationFrame,
  page: ReturnType<typeof resolveCurrentPage>,
  stackDepth: number,
): TelegramSendOptions['reply_markup'] | undefined {
  const buttonMap = new Map(board.buttons.map((button) => [button.id, button]));
  const itemRows = (page?.rows ?? []).map((row) => row.flatMap((id) => {
    const button = buttonMap.get(id);
    if (!button) return [];
    return frame.boardType === 'inline'
      ? [{ text: button.label, callback_data: buttonCallbackData(button.id) }]
      : [{ text: button.label }];
  })).filter((row) => row.length > 0);

  const settings = board.menuSettings;
  const seen = new Set<NavigationAction>();
  const rows: Array<Array<{ text: string; callback_data?: string }>> = (settings?.controlRows ?? []).map((row) => row.flatMap((action) => {
    if (!controlAvailable(board, action, page, stackDepth)) return [];
    seen.add(action);
    const label = controlLabel(board, action);
    if (!label) return [];
    if (frame.boardType === 'inline') {
      const callback_data = pageActions.includes(action) ? `pg:${action}` : `mn:${action}`;
      return [{ text: label, callback_data }];
    }
    return [{ text: label }];
  })).filter((row) => row.length > 0);

  for (const action of [...pageActions, ...menuActions]) {
    if (seen.has(action) || !controlAvailable(board, action, page, stackDepth)) continue;
    const label = controlLabel(board, action);
    if (!label) continue;
    rows.push([frame.boardType === 'inline'
      ? { text: label, callback_data: pageActions.includes(action) ? `pg:${action}` : `mn:${action}` }
      : { text: label }]);
  }

  const navigationRows = rows;
  const allRows = settings?.controlsPosition === 'before'
    ? [...navigationRows, ...itemRows]
    : [...itemRows, ...navigationRows];
  if (!allRows.length) return undefined;
  return frame.boardType === 'inline'
    ? { inline_keyboard: allRows }
    : { keyboard: allRows, resize_keyboard: true };
}

interface FrameContent {
  text: string | null;
  media: StoredMediaItem[];
}

function contentForFrame(bot: StoredBot, frame: UserNavigationFrame): FrameContent {
  if (frame.messageSourceButtonId) {
    const source = findButton(bot, frame.messageSourceButtonId);
    return source ? { text: source.flow.message, media: source.flow.media } : { text: null, media: [] };
  }
  return { text: bot.startMessage, media: [] };
}

function pageIndicator(board: StoredButtonBoard, page: ReturnType<typeof resolveCurrentPage>): { text: string | null; position: 'before' | 'after' | 'separate' } {
  const settings = board.menuSettings;
  if (!settings || settings.pageMode === 'off' || !settings.pageIndicator.enabled || !page?.total) {
    return { text: null, position: 'after' };
  }
  const text = settings.pageIndicator.template
    .replaceAll('{current}', String(page.index + 1))
    .replaceAll('{total}', String(page.total));
  return { text, position: settings.pageIndicator.position };
}

function composeMessageText(text: string | null, indicator: ReturnType<typeof pageIndicator>): string | null {
  if (!indicator.text || indicator.position === 'separate' || !text) return text;
  return indicator.position === 'before'
    ? `${indicator.text}\n\n${text}`
    : `${text}\n\n${indicator.text}`;
}

async function sendStoredMedia(
  client: TelegramPollingClient,
  botId: string,
  chatId: number,
  media: StoredMediaItem,
  options: TelegramSendOptions = {},
): Promise<TelegramSentMessage> {
  const filePath = mediaDiskPath(botId, media);
  if (media.type === 'image') return client.sendPhoto(chatId, filePath, options);
  if (media.type === 'video') return client.sendVideo(chatId, filePath, options);
  if (media.type === 'voice') return client.sendVoice(chatId, filePath, options);
  return client.sendAudio(chatId, filePath, options);
}

async function bestEffortClearInlineKeyboard(client: TelegramPollingClient, chatId: number, messageId: number | null): Promise<void> {
  if (!messageId) return;
  try {
    await client.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
  } catch {
    // Old, deleted, or otherwise uneditable messages must not block navigation.
  }
}

async function renderMenuFrame(
  client: TelegramPollingClient,
  botId: string,
  chatId: number,
  session: UserNavigationState,
  frame: UserNavigationFrame,
  forceNewMessage: boolean,
): Promise<UserNavigationFrame> {
  const bot = getStoredBot(botId);
  if (!bot) return frame;
  const board = boardForFrame(bot, frame);
  const page = resolveCurrentPage(board, frame.pageIndex, frame.pageId);
  if (page) {
    frame.pageIndex = page.index;
    frame.pageId = page.id;
  } else {
    frame.pageIndex = 0;
    frame.pageId = null;
  }
  const depth = session.stack.length;
  const markup = menuMarkup(board, frame, page, depth);
  const content = contentForFrame(bot, frame);
  const indicator = pageIndicator(board, page);
  let messageText = composeMessageText(content.text, indicator);
  let separateIndicator = indicator.position === 'separate' ? indicator.text : null;
  if (!content.text && !content.media.length && indicator.text && indicator.position !== 'separate') {
    messageText = indicator.text;
  }
  if (!messageText && !content.media.length && separateIndicator) {
    messageText = separateIndicator;
    separateIndicator = null;
  }
  const primaryMedia = content.text ? null : content.media[0] ?? null;
  const mediaCaption = primaryMedia && indicator.text && indicator.position !== 'separate' ? indicator.text : null;
  const hasContent = Boolean(messageText) || Boolean(primaryMedia);
  if (!hasContent) {
    frame.messageId = null;
    frame.messageKind = null;
    frame.indicatorMessageId = null;
    return frame;
  }

  const settings = board.menuSettings;
  const previousMessageId = frame.messageId;
  const shouldEdit = !forceNewMessage
    && frame.boardType === 'inline'
    && settings?.renderMode !== 'send'
    && frame.messageId !== null
    && frame.messageKind !== null;
  if (shouldEdit) {
    try {
      const editMarkup = markup ?? { inline_keyboard: [] };
      if (frame.messageKind === 'text' && messageText) {
        await client.editMessageText(chatId, frame.messageId as number, messageText, { reply_markup: editMarkup });
      } else if (frame.messageKind === 'text' && !messageText && frame.messageId) {
        await client.editMessageReplyMarkup(chatId, frame.messageId, editMarkup);
      } else if (frame.messageKind !== 'text' && primaryMedia && frame.messageKind === primaryMedia.type) {
        if (mediaCaption) await client.editMessageCaption(chatId, frame.messageId as number, mediaCaption, { reply_markup: editMarkup });
        else await client.editMessageReplyMarkup(chatId, frame.messageId as number, editMarkup);
      } else {
        throw new Error('Telegram cannot edit this message content in place.');
      }

      if (separateIndicator) {
        if (frame.indicatorMessageId) {
          try {
            await client.editMessageText(chatId, frame.indicatorMessageId, separateIndicator);
          } catch {
            const sentIndicator = await client.sendMessage(chatId, separateIndicator);
            frame.indicatorMessageId = sentIndicator.message_id;
          }
        } else {
          const sentIndicator = await client.sendMessage(chatId, separateIndicator);
          frame.indicatorMessageId = sentIndicator.message_id;
        }
      }
      return frame;
    } catch (error) {
      console.warn('تعذر تحديث رسالة القائمة؛ سيُرسل النظام رسالة جديدة:', summarizeError(error));
    }
  }

  let sent: TelegramSentMessage;
  let messageKind: UserNavigationFrame['messageKind'];
  if (messageText) {
    sent = await client.sendMessage(chatId, messageText, markup ? { reply_markup: markup } : {});
    messageKind = 'text';
  } else if (primaryMedia) {
    const mediaOptions: TelegramSendOptions = {};
    if (markup) mediaOptions.reply_markup = markup;
    if (mediaCaption) mediaOptions.caption = mediaCaption;
    sent = await sendStoredMedia(client, botId, chatId, primaryMedia, mediaOptions);
    messageKind = primaryMedia.type;
  } else {
    return frame;
  }

  if (frame.boardType === 'inline' && previousMessageId && previousMessageId !== sent.message_id) {
    await bestEffortClearInlineKeyboard(client, chatId, previousMessageId);
  }
  frame.messageId = sent.message_id;
  frame.messageKind = messageKind;
  if (content.media.length && !content.text) {
    for (const media of content.media.slice(1)) await sendStoredMedia(client, botId, chatId, media);
  } else if (content.media.length && content.text) {
    for (const media of content.media) await sendStoredMedia(client, botId, chatId, media);
  }

  if (separateIndicator) {
    if (frame.indicatorMessageId) {
      try {
        await client.editMessageText(chatId, frame.indicatorMessageId, separateIndicator);
      } catch {
        const sentIndicator = await client.sendMessage(chatId, separateIndicator);
        frame.indicatorMessageId = sentIndicator.message_id;
      }
    } else {
      const sentIndicator = await client.sendMessage(chatId, separateIndicator);
      frame.indicatorMessageId = sentIndicator.message_id;
    }
  } else {
    frame.indicatorMessageId = null;
  }
  return frame;
}

function selectedBoardType(inline: StoredButtonBoard, reply: StoredButtonBoard, preference: KeyboardPreference | null): ButtonType | null {
  const hasInline = hasItems(inline);
  const hasReply = hasItems(reply);
  if (hasInline && hasReply) return preference;
  if (hasInline) return 'inline';
  if (hasReply) return 'reply';
  return null;
}

function navigationFrame(
  scopeButtonId: string | null,
  messageSourceButtonId: string | null,
  boardType: ButtonType,
): UserNavigationFrame {
  return {
    scopeButtonId,
    messageSourceButtonId,
    boardType,
    pageIndex: 0,
    pageId: null,
    messageId: null,
    messageKind: null,
    indicatorMessageId: null,
  };
}

function saveNavigationState(session: UserNavigationState): void {
  session.updatedAt = new Date().toISOString();
  saveUserNavigationState(session);
}

function emptyNavigationState(botId: string, userId: number, chatId: number, bot: StoredBot): UserNavigationState {
  const type = selectedBoardType(bot.inline, bot.reply, bot.startKeyboardPreference)
    ?? (hasItems(bot.inline) ? 'inline' : 'reply');
  return {
    botId,
    userId,
    chatId,
    stack: [navigationFrame(null, null, type)],
    selectedButtonId: null,
    updatedAt: new Date().toISOString(),
  };
}

function frameCanRender(bot: StoredBot, frame: UserNavigationFrame): boolean {
  const content = contentForFrame(bot, frame);
  if (content.text || content.media.length) return true;
  const page = resolveCurrentPage(boardForFrame(bot, frame), frame.pageIndex, frame.pageId);
  const indicator = pageIndicator(boardForFrame(bot, frame), page);
  return Boolean(indicator.text);
}

async function startUserMenu(client: TelegramPollingClient, botId: string, userId: number, chatId: number): Promise<void> {
  const bot = getStoredBot(botId);
  if (!bot) return;
  const session = emptyNavigationState(botId, userId, chatId, bot);
  const frame = session.stack[0];
  if (frameCanRender(bot, frame)) {
    await renderMenuFrame(client, botId, chatId, session, frame, true);
  }
  saveNavigationState(session);
}

async function sendFlowAction(client: TelegramPollingClient, botId: string, chatId: number, button: StoredButton): Promise<void> {
  if (button.flow.message) await client.sendMessage(chatId, button.flow.message);
  for (const media of button.flow.media) await sendStoredMedia(client, botId, chatId, media);
}

function fallbackBoardType(context: KeyboardContext): ButtonType | null {
  const hasInline = hasItems(context.inline);
  const hasReply = hasItems(context.reply);
  if (hasInline && hasReply) {
    if (!context.preference) return null;
    return context.preference === 'inline' ? 'reply' : 'inline';
  }
  if (hasInline) return 'inline';
  if (hasReply) return 'reply';
  return null;
}

async function handleMenuButton(
  client: TelegramPollingClient,
  botId: string,
  session: UserNavigationState,
  buttonId: string,
): Promise<void> {
  const bot = getStoredBot(botId);
  const frame = session.stack.at(-1);
  if (!bot || !frame) return;
  const board = boardForFrame(bot, frame);
  const page = resolveCurrentPage(board, frame.pageIndex, frame.pageId);
  if (!page?.buttonIds.includes(buttonId)) return;
  const button = board.buttons.find((item) => item.id === buttonId);
  if (!button || button.type !== frame.boardType) return;
  session.selectedButtonId = button.id;

  const hasInlineChildren = hasItems(button.flow.inline);
  const hasReplyChildren = hasItems(button.flow.reply);
  if (hasInlineChildren || hasReplyChildren) {
    const childType = selectedBoardType(button.flow.inline, button.flow.reply, button.flow.keyboardPreference);
    if (childType) {
      const childFrame = navigationFrame(button.id, button.id, childType);
      if (frameCanRender(bot, { ...childFrame, scopeButtonId: button.id })) {
        if (frame.boardType === 'inline') await bestEffortClearInlineKeyboard(client, session.chatId, frame.messageId);
        session.stack.push(childFrame);
        await renderMenuFrame(client, botId, session.chatId, session, childFrame, true);
        saveNavigationState(session);
        return;
      }
      // Telegram needs a message or media to attach the submenu keyboard to.
      if (button.flow.message || button.flow.media.length) await sendFlowAction(client, botId, session.chatId, button);
      saveNavigationState(session);
      return;
    }
    // Preserve the prior behavior for unresolved dual keyboards: deliver the action,
    // but never silently choose one of the two child keyboard types.
    if (button.flow.message || button.flow.media.length) await sendFlowAction(client, botId, session.chatId, button);
    saveNavigationState(session);
    return;
  }

  const parentContext = boardsForScope(bot, frame.scopeButtonId);
  const alternateType = fallbackBoardType(parentContext);
  const alternateBoard = alternateType === 'inline' ? parentContext.inline : alternateType === 'reply' ? parentContext.reply : null;
  const flowHasContent = Boolean(button.flow.message) || button.flow.media.length > 0;
  if (alternateType && alternateBoard && flowHasContent) {
    const fallbackFrame = navigationFrame(frame.scopeButtonId, button.id, alternateType);
    if (frame.boardType === 'inline') await bestEffortClearInlineKeyboard(client, session.chatId, frame.messageId);
    session.stack.push(fallbackFrame);
    await renderMenuFrame(client, botId, session.chatId, session, fallbackFrame, true);
    saveNavigationState(session);
    return;
  }

  if (flowHasContent) await sendFlowAction(client, botId, session.chatId, button);
  saveNavigationState(session);
}

async function handleNavigationAction(
  client: TelegramPollingClient,
  botId: string,
  session: UserNavigationState,
  action: NavigationAction,
): Promise<void> {
  const bot = getStoredBot(botId);
  const frame = session.stack.at(-1);
  if (!bot || !frame) return;
  const board = boardForFrame(bot, frame);
  const page = resolveCurrentPage(board, frame.pageIndex, frame.pageId);
  if (!controlAvailable(board, action, page, session.stack.length)) return;

  if (action === 'back' || action === 'home') {
    if (frame.boardType === 'inline') await bestEffortClearInlineKeyboard(client, session.chatId, frame.messageId);
    session.stack = action === 'home' ? [session.stack[0]] : session.stack.slice(0, -1);
    const target = session.stack.at(-1);
    if (!target) return;
    session.selectedButtonId = target.scopeButtonId;
    await renderMenuFrame(client, botId, session.chatId, session, target, false);
    saveNavigationState(session);
    return;
  }

  if (!page) return;
  const pages = resolveMenuPages(board);
  let targetIndex = page.index;
  if (action === 'first') targetIndex = 0;
  else if (action === 'previous') targetIndex = Math.max(0, page.index - 1);
  else if (action === 'next') targetIndex = Math.min(pages.length - 1, page.index + 1);
  else if (action === 'last') targetIndex = pages.length - 1;
  const targetPage = pages[targetIndex];
  if (!targetPage || targetIndex === page.index) return;
  frame.pageIndex = targetPage.index;
  frame.pageId = targetPage.id;
  await renderMenuFrame(client, botId, session.chatId, session, frame, false);
  saveNavigationState(session);
}

async function routeReplyMessage(
  client: TelegramPollingClient,
  botId: string,
  userId: number,
  chatId: number,
  text: string,
): Promise<boolean> {
  const session = getUserNavigationState(botId, userId);
  const frame = session?.stack.at(-1);
  if (!session || session.chatId !== chatId || !frame) return false;
  if (frame.boardType !== 'reply') return true;
  const bot = getStoredBot(botId);
  if (!bot) return false;
  const board = boardForFrame(bot, frame);
  const page = resolveCurrentPage(board, frame.pageIndex, frame.pageId);
  if (!page) return true;

  for (const action of [...pageActions, ...menuActions]) {
    if (controlAvailable(board, action, page, session.stack.length) && controlLabel(board, action) === text) {
      await handleNavigationAction(client, botId, session, action);
      return true;
    }
  }
  const visibleIds = new Set(page.buttonIds);
  const button = board.buttons.find((item) => visibleIds.has(item.id) && item.type === 'reply' && item.label === text);
  if (button) await handleMenuButton(client, botId, session, button.id);
  return true;
}

function currentCallbackFrame(session: UserNavigationState | undefined, chatId: number, messageId: number): UserNavigationFrame | null {
  if (!session || session.chatId !== chatId) return null;
  const frame = session.stack.at(-1);
  return frame?.messageId === messageId ? frame : null;
}

async function routeCallbackQuery(client: TelegramPollingClient, botId: string, query: TelegramCallbackQuery): Promise<void> {
  try {
    await client.answerCallbackQuery(query.id);
  } catch {
    // Callback acknowledgement can time out independently; still process the action.
  }
  if (!query.message || !query.data) return;
  const chatId = query.message.chat.id;
  const state = getUserNavigationState(botId, query.from.id);
  const frame = currentCallbackFrame(state, chatId, query.message.message_id);
  if (state && frame) {
    if (query.data.startsWith('pg:')) {
      const action = query.data.slice(3) as NavigationAction;
      if (pageActions.includes(action)) await handleNavigationAction(client, botId, state, action);
      return;
    }
    if (query.data.startsWith('mn:')) {
      const action = query.data.slice(3) as NavigationAction;
      if (menuActions.includes(action)) await handleNavigationAction(client, botId, state, action);
      return;
    }
    const bot = getStoredBot(botId);
    if (bot) {
      const button = findButtonByCallback(bot, query.data);
      const board = boardForFrame(bot, frame);
      const page = resolveCurrentPage(board, frame.pageIndex, frame.pageId);
      if (button && button.type === 'inline' && page?.buttonIds.includes(button.id)) {
        await handleMenuButton(client, botId, state, button.id);
      }
    }
    return;
  }
  if (state && state.chatId === chatId) return;

  // Old Telegram messages can outlive a process restart or an earlier /start.
  // Keep their existing button actions working without inventing a navigation state.
  if (query.data.startsWith('b:')) {
    await sendCurrentFlow(client, botId, chatId, query.data.slice(2));
  }
}

function summarizeError(error: unknown): string {
  const code = error instanceof TelegramApiError ? error.code : 0;
  if (code === 401) return 'تعذر التحقق من التوكن. تأكد من صحته ثم أعد المحاولة.';
  if (code === 409) return 'هذا التوكن قيد التشغيل في اتصال آخر. أوقف الاتصال الآخر ثم أعد المحاولة.';
  return 'تعذر الاتصال بواجهة تيليجرام. تحقق من الشبكة والتوكن ثم أعد المحاولة.';
}

function setRuntimeError(botId: string, client: TelegramPollingClient, error: unknown): void {
  if (runtimes.get(botId)?.client !== client) return;
  const message = summarizeError(error);
  updateStoredBot(botId, (record) => ({
    ...record,
    connection: {
      ...record.connection,
      state: 'error',
      lastError: message,
      checkedAt: new Date().toISOString(),
    },
  }));
}

function setRuntimeHealthy(botId: string, client: TelegramPollingClient): void {
  if (runtimes.get(botId)?.client !== client) return;
  updateStoredBot(botId, (record) => ({
    ...record,
    connection: {
      ...record.connection,
      state: 'connected',
      lastError: null,
      checkedAt: new Date().toISOString(),
    },
  }));
}

async function sendCurrentFlow(
  client: TelegramPollingClient,
  botId: string,
  chatId: number,
  selectedButtonId: string,
): Promise<void> {
  const bot = getStoredBot(botId);
  if (!bot) return;
  const button = findButton(bot, selectedButtonId);
  if (!button) return;

  const flow = button.flow;
  const markup = makeKeyboardForFlow(bot, button, findButtonContext(bot, selectedButtonId));
  const options: TelegramSendOptions = markup ? { reply_markup: markup } : {};

  if (flow.message) {
    await client.sendMessage(chatId, flow.message, options);
  }

  for (let index = 0; index < flow.media.length; index += 1) {
    const media = flow.media[index];
    const filePath = mediaDiskPath(botId, media);
    const mediaOptions: TelegramSendOptions = index === 0 && !flow.message ? options : {};
    if (media.type === 'image') await client.sendPhoto(chatId, filePath, mediaOptions);
    else if (media.type === 'video') await client.sendVideo(chatId, filePath, mediaOptions);
    else if (media.type === 'voice') await client.sendVoice(chatId, filePath, mediaOptions);
    else await client.sendAudio(chatId, filePath, mediaOptions);
  }
}

function bindHandlers(botId: string, client: TelegramPollingClient): void {
  client.onUpdate(async (update) => {
    const message = update.message;
    if (message?.chat?.id && typeof message.text === 'string') {
      const text = message.text;
      const userId = message.from?.id ?? message.chat.id;
      if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)) {
        await startUserMenu(client, botId, userId, message.chat.id);
        return;
      }

      if (await routeReplyMessage(client, botId, userId, message.chat.id, text)) return;
      const config = getStoredBot(botId);
      if (!config) return;
      const matchingButton = findReplyButtonByText(config, text);
      if (matchingButton) await sendCurrentFlow(client, botId, message.chat.id, matchingButton.id);
    }

    const query = update.callback_query;
    if (query) await routeCallbackQuery(client, botId, query);
  });

  client.onPollingError((error) => {
    setRuntimeError(botId, client, error);
    console.error(`[telegram:${botId.slice(0, 8)}] تعذر تنفيذ polling:`, summarizeError(error));
  });
  client.onHealthy(() => setRuntimeHealthy(botId, client));
}

export interface ConnectResult {
  bot: BotConfig;
  username: string | null;
  displayName: string | null;
}

export async function connectTelegramBot(botId: string, token: string): Promise<ConnectResult> {
  const current = getStoredBot(botId);
  if (!current) throw new Error('لم يتم العثور على البوت المطلوب.');
  if (!token.trim()) throw new Error('أدخل توكن البوت أولاً.');

  const normalizedToken = token.trim();
  const previous = runtimes.get(botId);
  if (previous && current.tokenCiphertext) {
    try {
      if (decryptToken(current.tokenCiphertext) === normalizedToken) {
        if (current.connection.state === 'connected') {
          return {
            bot: toPublicBot(current),
            username: current.connection.username,
            displayName: current.connection.displayName,
          };
        }
        await previous.client.stop();
        runtimes.delete(botId);
      }
    } catch {
      // If a saved token cannot be decrypted, continue with a fresh verification.
    }
  }

  const candidate = new TelegramPollingClient(normalizedToken);
  bindHandlers(botId, candidate);
  let me: TelegramUser;
  try {
    me = await candidate.start();
  } catch (error) {
    await candidate.stop();
    throw new Error(summarizeError(error));
  }

  const candidateUsername = me.username ?? null;
  const updated = updateStoredBot(botId, (record) => ({
    ...record,
    tokenCiphertext: encryptToken(normalizedToken),
    connection: {
      state: 'connected',
      username: candidateUsername,
      displayName: me.first_name ?? null,
      lastError: null,
      checkedAt: new Date().toISOString(),
    },
  }));

  if (!updated) {
    await candidate.stop();
    throw new Error('لم يتم العثور على البوت المطلوب.');
  }

  runtimes.set(botId, { client: candidate, username: candidateUsername });
  if (previous) await previous.client.stop();

  return { bot: toPublicBot(updated), username: candidateUsername, displayName: me.first_name ?? null };
}

export function unresolvedKeyboardPreference(bot: StoredBot): boolean {
  const walkBoard = (board: StoredButtonBoard): boolean => board.buttons.some((button) => {
    const bothChildTypes = hasItems(button.flow.inline) && hasItems(button.flow.reply);
    if (bothChildTypes && !button.flow.keyboardPreference) return true;
    return walkBoard(button.flow.inline) || walkBoard(button.flow.reply);
  });
  const bothRootTypes = hasItems(bot.inline) && hasItems(bot.reply);
  return (bothRootTypes && !bot.startKeyboardPreference)
    || walkBoard(bot.inline)
    || walkBoard(bot.reply);
}

export async function restoreTelegramBots(): Promise<void> {
  const bots = listStoredBots();
  for (const bot of bots) {
    if (!bot.tokenCiphertext) continue;
    updateStoredBot(bot.id, (record) => ({
      ...record,
      connection: {
        ...record.connection,
        state: 'connecting',
        lastError: null,
        checkedAt: new Date().toISOString(),
      },
    }));
    try {
      await connectTelegramBot(bot.id, decryptToken(bot.tokenCiphertext));
    } catch (error) {
      const message = summarizeError(error);
      updateStoredBot(bot.id, (record) => ({
        ...record,
        connection: {
          ...record.connection,
          state: 'error',
          lastError: message,
          checkedAt: new Date().toISOString(),
        },
      }));
      console.error(`[telegram:${bot.id.slice(0, 8)}] تعذر استعادة الاتصال المحفوظ:`, message);
    }
  }
}

export async function stopTelegramBots(): Promise<void> {
  const active = [...runtimes.values()];
  runtimes.clear();
  await Promise.all(active.map(async ({ client }) => client.stop()));
}
