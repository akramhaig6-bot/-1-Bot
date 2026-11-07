import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BotButton,
  BotConfig,
  ButtonBoard,
  ButtonFlow,
  ConnectionStatus,
  MediaItem,
  MenuSettings,
  UserNavigationState,
} from '../shared/types.js';


export interface StoredMediaItem extends MediaItem {
  storageName: string;
}

export interface StoredButtonBoard {
  buttons: StoredButton[];
  rows: string[][];
  menuSettings?: MenuSettings;
}

export interface StoredButtonFlow extends Omit<ButtonFlow, 'media' | 'inline' | 'reply'> {
  media: StoredMediaItem[];
  inline: StoredButtonBoard;
  reply: StoredButtonBoard;
}

export interface StoredButton extends Omit<BotButton, 'flow'> {
  flow: StoredButtonFlow;
}

export interface StoredBot extends Omit<BotConfig, 'inline' | 'reply'> {
  inline: StoredButtonBoard;
  reply: StoredButtonBoard;
  tokenCiphertext: string | null;
}

const dataDirectory = path.resolve(process.cwd(), 'data');
const storeFile = path.join(dataDirectory, 'bots.json');
const navigationFile = path.join(dataDirectory, 'navigation.json');
const keyFile = path.join(dataDirectory, '.token.key');

function ensureDataDirectory(): void {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDirectory, 0o700);
  } catch {
    // Some filesystems do not support chmod; the application still works locally.
  }
}

function encryptionKey(): Buffer {
  const fromEnvironment = process.env.BOT_TOKEN_ENCRYPTION_KEY;
  if (fromEnvironment) return crypto.createHash('sha256').update(fromEnvironment).digest();

  ensureDataDirectory();
  if (fs.existsSync(keyFile)) {
    const value = fs.readFileSync(keyFile);
    if (value.length === 32) return value;
  }

  const value = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, value, { mode: 0o600, flag: 'w' });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {
    // Best effort on platforms with POSIX permissions.
  }
  return value;
}

export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptToken(ciphertext: string): string {
  const [ivPart, tagPart, dataPart] = ciphertext.split('.');
  if (!ivPart || !tagPart || dataPart === undefined) throw new Error('تعذر قراءة بيانات اعتماد البوت المحفوظة.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function emptyStoredBoard(): StoredButtonBoard {
  return { buttons: [], rows: [] };
}

export function emptyStoredBot(now = new Date().toISOString()): StoredBot {
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    startMessage: null,
    inline: emptyStoredBoard(),
    reply: emptyStoredBoard(),
    startKeyboardPreference: null,
    connection: {
      state: 'unconnected',
      username: null,
      displayName: null,
      lastError: null,
      checkedAt: null,
    },
    tokenCiphertext: null,
  };
}

function readRecords(): Record<string, StoredBot> {
  ensureDataDirectory();
  if (!fs.existsSync(storeFile)) return {};
  const raw = fs.readFileSync(storeFile, 'utf8');
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ملف البيانات المحلي غير صالح.');
  }
  return parsed as Record<string, StoredBot>;
}

function writeRecords(records: Record<string, StoredBot>): void {
  ensureDataDirectory();
  const temporaryFile = `${storeFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(records, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(temporaryFile, 0o600);
  } catch {
    // Best effort on platforms with POSIX permissions.
  }
  fs.renameSync(temporaryFile, storeFile);
}

export function listStoredBots(): StoredBot[] {
  return Object.values(readRecords()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getStoredBot(id: string): StoredBot | undefined {
  return readRecords()[id];
}

function readNavigationRecords(): Record<string, UserNavigationState> {
  ensureDataDirectory();
  if (!fs.existsSync(navigationFile)) return {};
  const raw = fs.readFileSync(navigationFile, 'utf8');
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ملف حالة التنقل المحلي غير صالح.');
  }
  return parsed as Record<string, UserNavigationState>;
}

function writeNavigationRecords(records: Record<string, UserNavigationState>): void {
  ensureDataDirectory();
  const temporaryFile = `${navigationFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(records, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(temporaryFile, 0o600);
  } catch {
    // Best effort on platforms with restricted filesystem permissions.
  }
  fs.renameSync(temporaryFile, navigationFile);
}

function navigationKey(botId: string, userId: number): string {
  return `${botId}:${userId}`;
}

export function getUserNavigationState(botId: string, userId: number): UserNavigationState | undefined {
  return readNavigationRecords()[navigationKey(botId, userId)];
}

export function saveUserNavigationState(state: UserNavigationState): void {
  const records = readNavigationRecords();
  records[navigationKey(state.botId, state.userId)] = state;
  writeNavigationRecords(records);
}

export function deleteUserNavigationState(botId: string, userId: number): void {
  const records = readNavigationRecords();
  delete records[navigationKey(botId, userId)];
  writeNavigationRecords(records);
}

export function createStoredBot(): StoredBot {
  const records = readRecords();
  const bot = emptyStoredBot();
  records[bot.id] = bot;
  writeRecords(records);
  return bot;
}

export function updateStoredBot(id: string, update: (current: StoredBot) => StoredBot): StoredBot | undefined {
  const records = readRecords();
  const current = records[id];
  if (!current) return undefined;
  const next = update(current);
  next.updatedAt = new Date().toISOString();
  records[id] = next;
  writeRecords(records);
  return next;
}

export function allPublicMediaIds(bot: StoredBot): Set<string> {
  const ids = new Set<string>();
  const walkBoard = (board: StoredButtonBoard): void => {
    for (const button of board.buttons) {
      for (const media of button.flow.media) ids.add(media.id);
      walkBoard(button.flow.inline);
      walkBoard(button.flow.reply);
    }
  };
  walkBoard(bot.inline);
  walkBoard(bot.reply);
  return ids;
}

function publicBoard(board: StoredButtonBoard): ButtonBoard {
  return {
    rows: board.rows.map((row) => [...row]),
    buttons: board.buttons.map((button) => publicButton(button)),
    ...(board.menuSettings ? { menuSettings: structuredClone(board.menuSettings) } : {}),
  };
}

function publicFlow(flow: StoredButtonFlow): ButtonFlow {
  return {
    message: flow.message,
    media: flow.media.map(({ storageName: _storageName, ...media }) => media),
    inline: publicBoard(flow.inline),
    reply: publicBoard(flow.reply),
    keyboardPreference: flow.keyboardPreference,
  };
}

function publicButton(button: StoredButton): BotButton {
  return {
    id: button.id,
    label: button.label,
    type: button.type,
    flow: publicFlow(button.flow),
  };
}

export function toPublicBot(bot: StoredBot): BotConfig {
  return {
    id: bot.id,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    startMessage: bot.startMessage,
    inline: publicBoard(bot.inline),
    reply: publicBoard(bot.reply),
    startKeyboardPreference: bot.startKeyboardPreference,
    connection: { ...bot.connection },
  };
}

export function findStoredMedia(bot: StoredBot, mediaId: string): StoredMediaItem | undefined {
  let found: StoredMediaItem | undefined;
  const walk = (board: StoredButtonBoard): void => {
    for (const button of board.buttons) {
      found ??= button.flow.media.find((media) => media.id === mediaId);
      if (!found) walk(button.flow.inline);
      if (!found) walk(button.flow.reply);
    }
  };
  walk(bot.inline);
  if (!found) walk(bot.reply);
  return found;
}

export function findStoredButton(bot: StoredBot, buttonId: string): StoredButton | undefined {
  let found: StoredButton | undefined;
  const walk = (board: StoredButtonBoard): void => {
    for (const button of board.buttons) {
      if (button.id === buttonId) {
        found = button;
        return;
      }
      walk(button.flow.inline);
      if (!found) walk(button.flow.reply);
      if (found) return;
    }
  };
  walk(bot.inline);
  if (!found) walk(bot.reply);
  return found;
}

export function removeStoredMedia(bot: StoredBot, mediaId: string): StoredMediaItem | undefined {
  let removed: StoredMediaItem | undefined;
  const walk = (board: StoredButtonBoard): void => {
    for (const button of board.buttons) {
      const index = button.flow.media.findIndex((media) => media.id === mediaId);
      if (index >= 0) {
        [removed] = button.flow.media.splice(index, 1);
        return;
      }
      walk(button.flow.inline);
      if (!removed) walk(button.flow.reply);
      if (removed) return;
    }
  };
  walk(bot.inline);
  if (!removed) walk(bot.reply);
  return removed;
}

export function updateButtonMedia(bot: StoredBot, buttonId: string, media: StoredMediaItem): boolean {
  const button = findStoredButton(bot, buttonId);
  if (!button) return false;
  button.flow.media.push(media);
  return true;
}

export function mediaDiskPath(botId: string, media: StoredMediaItem): string {
  return path.resolve(dataDirectory, 'uploads', botId, media.storageName);
}

export function ensureMediaDirectory(botId: string): string {
  const directory = path.resolve(dataDirectory, 'uploads', botId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function removeMediaFile(botId: string, media: StoredMediaItem): void {
  const file = mediaDiskPath(botId, media);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function removeTemporaryUpload(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Temporary cleanup is best effort.
  }
}

export function safeUnlinkUploadFolder(botId: string): void {
  const directory = path.resolve(dataDirectory, 'uploads', botId);
  if (!directory.startsWith(path.resolve(dataDirectory, 'uploads') + path.sep)) return;
  fs.rmSync(directory, { recursive: true, force: true });
}

export function createStoredButton(id: string, label: string, type: 'inline' | 'reply'): StoredButton {
  return {
    id,
    label,
    type,
    flow: {
      message: null,
      media: [],
      inline: emptyStoredBoard(),
      reply: emptyStoredBoard(),
      keyboardPreference: null,
    },
  };
}

export function defaultConnection(): ConnectionStatus {
  return {
    state: 'unconnected',
    username: null,
    displayName: null,
    lastError: null,
    checkedAt: null,
  };
}
