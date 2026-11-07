import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type ErrorRequestHandler, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import {
  defaultMenuSettings,
  type ButtonType,
  type KeyboardPreference,
  type MediaType,
  type MenuControlAction,
  type MenuSettings,
  type NavigationAction,
  type PageControlAction,
  type PageIndicatorPosition,
  type PageMode,
} from '../shared/types.js';
import {
  createStoredBot,
  ensureMediaDirectory,
  findStoredButton,
  findStoredMedia,
  getStoredBot,
  listStoredBots,
  mediaDiskPath,
  removeMediaFile,
  removeStoredMedia,
  removeTemporaryUpload,
  toPublicBot,
  updateButtonMedia,
  updateStoredBot,
  type StoredBot,
  type StoredButton,
  type StoredButtonBoard,
  type StoredButtonFlow,
  type StoredMediaItem,
} from './store.js';
import { connectTelegramBot, unresolvedKeyboardPreference } from './telegram.js';

class HttpError extends Error {
  status: number;
  details?: string;

  constructor(status: number, message: string, details?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isButtonType(value: unknown): value is ButtonType {
  return value === 'inline' || value === 'reply';
}

function isMediaType(value: unknown): value is MediaType {
  return value === 'image' || value === 'video' || value === 'voice' || value === 'music';
}

function isKeyboardPreference(value: unknown): value is KeyboardPreference | null {
  return value === null || value === 'inline' || value === 'reply';
}

function flattenMedia(bot: StoredBot): Map<string, StoredMediaItem> {
  const media = new Map<string, StoredMediaItem>();
  const walk = (board: StoredButtonBoard): void => {
    for (const button of board.buttons) {
      for (const item of button.flow.media) media.set(item.id, item);
      walk(button.flow.inline);
      walk(button.flow.reply);
    }
  };
  walk(bot.inline);
  walk(bot.reply);
  return media;
}

const pageControlActions: PageControlAction[] = ['first', 'previous', 'next', 'last'];
const menuControlActions: MenuControlAction[] = ['back', 'home'];
const navigationActions: NavigationAction[] = [...pageControlActions, ...menuControlActions];

function sanitizeMenuSettings(
  value: unknown,
  buttons: StoredButton[],
  rows: string[][],
  expectedType: ButtonType,
): MenuSettings {
  if (!isObject(value)) throw new HttpError(400, 'إعدادات الصفحات والتنقل غير صالحة.');
  const defaults = defaultMenuSettings();
  const pageMode = value.pageMode;
  if (pageMode !== 'off' && pageMode !== 'automatic' && pageMode !== 'manual') {
    throw new HttpError(400, 'طريقة تقسيم الصفحات غير صالحة.');
  }
  const itemsPerPage = value.itemsPerPage;
  if (typeof itemsPerPage !== 'number' || !Number.isSafeInteger(itemsPerPage) || itemsPerPage < 1) {
    throw new HttpError(400, 'عدد الأزرار في الصفحة يجب أن يكون عددًا صحيحًا موجبًا.');
  }
  if (value.controlsPosition !== 'before' && value.controlsPosition !== 'after') {
    throw new HttpError(400, 'موضع صفوف التنقل غير صالح.');
  }
  if (value.renderMode !== 'edit' && value.renderMode !== 'send') {
    throw new HttpError(400, 'طريقة تحديث رسالة القائمة غير صالحة.');
  }

  const sanitizeControl = (raw: unknown, fallback: { enabled: boolean; label: string }) => {
    if (raw === undefined) return { ...fallback };
    if (!isObject(raw) || typeof raw.enabled !== 'boolean' || typeof raw.label !== 'string') {
      throw new HttpError(400, 'إعداد أحد أزرار التنقل غير صالح.');
    }
    const label = raw.label.trim();
    if (!label || Array.from(label).length > 64) {
      throw new HttpError(400, 'نص زر التنقل يجب أن يكون بين حرف واحد و64 حرفًا وفق قيود تيليجرام.');
    }
    return { enabled: raw.enabled, label };
  };

  const rawPageControls = value.pageControls;
  const rawMenuControls = value.menuControls;
  if (rawPageControls !== undefined && !isObject(rawPageControls)) throw new HttpError(400, 'أزرار الصفحات غير صالحة.');
  if (rawMenuControls !== undefined && !isObject(rawMenuControls)) throw new HttpError(400, 'أزرار الرجوع والرئيسية غير صالحة.');
  const pageControls = Object.fromEntries(pageControlActions.map((action) => [
    action,
    sanitizeControl(
      (rawPageControls as Record<string, unknown> | undefined)?.[action],
      defaults.pageControls[action],
    ),
  ])) as MenuSettings['pageControls'];
  const menuControls = Object.fromEntries(menuControlActions.map((action) => [
    action,
    sanitizeControl(
      (rawMenuControls as Record<string, unknown> | undefined)?.[action],
      defaults.menuControls[action],
    ),
  ])) as MenuSettings['menuControls'];

  const validIds = new Set(buttons.map((button) => button.id));
  let manualPages: MenuSettings['manualPages'] = [];
  if (value.manualPages !== undefined && !Array.isArray(value.manualPages)) {
    throw new HttpError(400, 'قائمة الصفحات اليدوية غير صالحة.');
  }
  const rawPages = Array.isArray(value.manualPages) ? value.manualPages : [];
  const pageIds = new Set<string>();
  const assignedButtonIds = new Set<string>();
  manualPages = rawPages.map((rawPage): MenuSettings['manualPages'][number] => {
    if (!isObject(rawPage) || typeof rawPage.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(rawPage.id)) {
      throw new HttpError(400, 'معرّف إحدى الصفحات اليدوية غير صالح.');
    }
    if (pageIds.has(rawPage.id)) throw new HttpError(400, 'يوجد معرّف مكرر لإحدى الصفحات.');
    pageIds.add(rawPage.id);
    if (!Array.isArray(rawPage.buttonIds) || !Array.isArray(rawPage.rows)) {
      throw new HttpError(400, 'عناصر أو صفوف إحدى الصفحات اليدوية غير صالحة.');
    }
    const buttonIds = rawPage.buttonIds.map((id) => {
      if (typeof id !== 'string' || !validIds.has(id) || assignedButtonIds.has(id)) {
        throw new HttpError(400, 'يحتوي توزيع الصفحات على زر غير موجود أو مكرر.');
      }
      assignedButtonIds.add(id);
      return id;
    });
    const pageButtonIds = new Set(buttonIds);
    const seenInRows = new Set<string>();
    const pageRows = rawPage.rows.map((rawRow) => {
      if (!Array.isArray(rawRow)) throw new HttpError(400, 'صف إحدى الصفحات اليدوية غير صالح.');
      return rawRow.map((id) => {
        if (typeof id !== 'string' || !pageButtonIds.has(id) || seenInRows.has(id)) {
          throw new HttpError(400, 'صفوف الصفحة تحتوي على زر خارج الصفحة أو مكرر.');
        }
        seenInRows.add(id);
        return id;
      }).filter(Boolean);
    }).filter((row) => row.length > 0);
    for (const id of buttonIds) if (!seenInRows.has(id)) pageRows.push([id]);
    return { id: rawPage.id, buttonIds, rows: pageRows };
  });

  if (pageMode === 'manual') {
    if (!manualPages.length) {
      const buttonIds = buttons.map((button) => button.id);
      const allowedIds = new Set(buttonIds);
      const seen = new Set<string>();
      const initialRows = rows.map((row) => row.filter((id) => {
        if (!allowedIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })).filter((row) => row.length > 0);
      for (const id of buttonIds) if (!seen.has(id)) initialRows.push([id]);
      manualPages = [{ id: 'page-1', buttonIds, rows: initialRows }];
      buttonIds.forEach((id) => assignedButtonIds.add(id));
    }
    const missingIds = buttons.map((button) => button.id).filter((id) => !assignedButtonIds.has(id));
    if (missingIds.length) {
      const last = manualPages[manualPages.length - 1];
      last.buttonIds.push(...missingIds);
      last.rows.push(...missingIds.map((id) => [id]));
    }
  }

  let controlRows: NavigationAction[][] = [];
  if (value.controlRows !== undefined && !Array.isArray(value.controlRows)) {
    throw new HttpError(400, 'ترتيب صفوف أزرار التنقل غير صالح.');
  }
  const controlActionsSeen = new Set<NavigationAction>();
  const rawControlRows = Array.isArray(value.controlRows) ? value.controlRows : defaults.controlRows;
  controlRows = rawControlRows.map((rawRow) => {
    if (!Array.isArray(rawRow)) throw new HttpError(400, 'صف أزرار التنقل غير صالح.');
    return rawRow.map((action) => {
      if (typeof action !== 'string' || !navigationActions.includes(action as NavigationAction) || controlActionsSeen.has(action as NavigationAction)) {
        throw new HttpError(400, 'ترتيب أزرار التنقل يحتوي على إجراء غير صالح أو مكرر.');
      }
      controlActionsSeen.add(action as NavigationAction);
      return action as NavigationAction;
    });
  }).filter((row) => row.length > 0);
  for (const action of navigationActions) {
    const enabled = pageControlActions.includes(action as PageControlAction)
      ? pageControls[action as PageControlAction].enabled && pageMode !== 'off'
      : menuControls[action as MenuControlAction].enabled;
    if (enabled && !controlActionsSeen.has(action)) controlRows.push([action]);
  }

  if (!isObject(value.pageIndicator)
    || typeof value.pageIndicator.enabled !== 'boolean'
    || typeof value.pageIndicator.template !== 'string'
    || !['before', 'after', 'separate'].includes(String(value.pageIndicator.position))) {
    throw new HttpError(400, 'مؤشر الصفحة غير صالح.');
  }
  const indicatorTemplate = value.pageIndicator.template.trim();
  if (value.pageIndicator.enabled && (!indicatorTemplate || Array.from(indicatorTemplate).length > 256)) {
    throw new HttpError(400, 'نص مؤشر الصفحة يجب أن يكون بين حرف واحد و256 حرفًا.');
  }
  const indicatorPosition = value.pageIndicator.position as PageIndicatorPosition;

  if (expectedType === 'reply') {
    const replyLabels = new Set(buttons.map((button) => button.label));
    const enabledLabels = [
      ...pageControlActions.filter((action) => pageMode !== 'off' && pageControls[action].enabled).map((action) => pageControls[action].label),
      ...menuControlActions.filter((action) => menuControls[action].enabled).map((action) => menuControls[action].label),
    ];
    if (enabledLabels.some((label) => replyLabels.has(label))) {
      throw new HttpError(409, 'يوجد تعارض بين نص زر Reply ونص زر تنقل. غيّر أحد النصين لتجنب تنفيذ إجراء ملتبس.');
    }
    if (new Set(enabledLabels).size !== enabledLabels.length) {
      throw new HttpError(409, 'نصوص أزرار Reply والتنقل متطابقة؛ استخدم نصوصًا مختلفة لكل إجراء.');
    }
  }

  return {
    pageMode: pageMode as PageMode,
    itemsPerPage,
    manualPages,
    pageControls,
    menuControls,
    controlRows,
    controlsPosition: value.controlsPosition,
    pageIndicator: {
      enabled: value.pageIndicator.enabled,
      template: indicatorTemplate || defaults.pageIndicator.template,
      position: indicatorPosition,
    },
    renderMode: value.renderMode,
  };
}

function sanitizeBoard(
  value: unknown,
  expectedType: ButtonType,
  allowedMedia: Map<string, StoredMediaItem>,
  usedIds: Set<string>,
  currentBoard?: StoredButtonBoard,
): StoredButtonBoard {
  if (!isObject(value) || !Array.isArray(value.buttons)) {
    throw new HttpError(400, 'بيانات الأزرار غير مكتملة.');
  }
  if (!Array.isArray(value.rows)) throw new HttpError(400, 'بيانات ترتيب الأزرار غير مكتملة.');

  const buttons: StoredButton[] = value.buttons.map((candidate): StoredButton => {
    if (!isObject(candidate)) throw new HttpError(400, 'بيانات أحد الأزرار غير صالحة.');
    const { id, label, type, flow } = candidate;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new HttpError(400, 'معرّف أحد الأزرار غير صالح.');
    }
    if (usedIds.has(id)) throw new HttpError(400, 'يوجد معرّف مكرر لأحد الأزرار.');
    usedIds.add(id);
    if (typeof label !== 'string' || !label.trim()) {
      throw new HttpError(400, 'لا يمكن حفظ اسم زر فارغ.');
    }
    if (Array.from(label).length > 64) {
      throw new HttpError(400, 'نص الزر يتجاوز حد تيليجرام البالغ 64 حرفًا.');
    }
    if (!isButtonType(type) || type !== expectedType) {
      throw new HttpError(400, 'نوع أحد الأزرار لا يطابق القسم الذي ينتمي إليه.');
    }
    const previousButton = currentBoard?.buttons.find((existing) => existing.id === id);
    if (!isObject(flow)) throw new HttpError(400, 'إعدادات تدفق أحد الأزرار غير صالحة.');
    if (!(flow.message === null || typeof flow.message === 'string')) {
      throw new HttpError(400, 'نص الرسالة غير صالح.');
    }
    if (typeof flow.message === 'string' && !flow.message.trim()) {
      throw new HttpError(400, 'لا يمكن حفظ رسالة فارغة.');
    }
    if (!Array.isArray(flow.media)) throw new HttpError(400, 'قائمة الوسائط غير صالحة.');
    const storedMedia = flow.media.map((item) => {
      if (!isObject(item) || typeof item.id !== 'string') {
        throw new HttpError(400, 'بيانات إحدى الوسائط غير صالحة.');
      }
      const existing = allowedMedia.get(item.id);
      if (!existing) throw new HttpError(400, 'تعذر العثور على ملف وسائط محفوظ.');
      return existing;
    });
    if (!isKeyboardPreference(flow.keyboardPreference)) {
      throw new HttpError(400, 'اختيار نوع لوحة المفاتيح غير صالح.');
    }

    return {
      id,
      label,
      type,
      flow: {
        message: flow.message as string | null,
        media: storedMedia,
        keyboardPreference: flow.keyboardPreference,
        inline: sanitizeBoard(flow.inline, 'inline', allowedMedia, usedIds, previousButton?.flow.inline),
        reply: sanitizeBoard(flow.reply, 'reply', allowedMedia, usedIds, previousButton?.flow.reply),
      } as StoredButtonFlow,
    };
  });

  const buttonIds = new Set(buttons.map((button) => button.id));
  const seenInRows = new Set<string>();
  const rows: string[][] = [];
  for (const candidateRow of value.rows) {
    if (!Array.isArray(candidateRow)) throw new HttpError(400, 'صف الأزرار غير صالح.');
    const row = candidateRow.map((id) => {
      if (typeof id !== 'string' || !buttonIds.has(id) || seenInRows.has(id)) {
        throw new HttpError(400, 'ترتيب الأزرار يحتوي على عنصر غير صالح أو مكرر.');
      }
      seenInRows.add(id);
      return id;
    });
    if (row.length) rows.push(row);
  }
  for (const button of buttons) {
    if (!seenInRows.has(button.id)) rows.push([button.id]);
  }

  let menuSettings = currentBoard?.menuSettings;
  if (Object.hasOwn(value, 'menuSettings')) {
    menuSettings = sanitizeMenuSettings(value.menuSettings, buttons, rows, expectedType);
  }
  return { buttons, rows, ...(menuSettings ? { menuSettings } : {}) };
}

function parseBotPatch(current: StoredBot, value: unknown): Partial<StoredBot> {
  if (!isObject(value)) throw new HttpError(400, 'بيانات التحديث غير صالحة.');
  const allowed = new Set(['startMessage', 'inline', 'reply', 'startKeyboardPreference']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'تحتوي بيانات التحديث على حقول غير مدعومة.');
  }

  const allowedMedia = flattenMedia(current);
  const usedIds = new Set<string>();
  const next: Partial<StoredBot> = {};

  if (Object.hasOwn(value, 'startMessage')) {
    const message = value.startMessage;
    if (!(message === null || typeof message === 'string')) {
      throw new HttpError(400, 'رسالة البداية غير صالحة.');
    }
    if (typeof message === 'string' && !message.trim()) {
      throw new HttpError(400, 'لا يمكن حفظ رسالة بداية فارغة.');
    }
    next.startMessage = message as string | null;
  }

  if (Object.hasOwn(value, 'startKeyboardPreference')) {
    if (!isKeyboardPreference(value.startKeyboardPreference)) {
      throw new HttpError(400, 'اختيار لوحة البداية غير صالح.');
    }
    next.startKeyboardPreference = value.startKeyboardPreference;
  }

  const inlineValue = Object.hasOwn(value, 'inline') ? value.inline : current.inline;
  const replyValue = Object.hasOwn(value, 'reply') ? value.reply : current.reply;
  if (Object.hasOwn(value, 'inline') || Object.hasOwn(value, 'reply')) {
    next.inline = sanitizeBoard(inlineValue, 'inline', allowedMedia, usedIds, current.inline);
    next.reply = sanitizeBoard(replyValue, 'reply', allowedMedia, usedIds, current.reply);
  }

  return next;
}

function safeBotId(value: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(value);
}

const temporaryUploadDirectory = path.resolve(process.cwd(), 'data', '.uploads-temp');
fs.mkdirSync(temporaryUploadDirectory, { recursive: true, mode: 0o700 });
const maximumUploadBytes = Number.parseInt(process.env.MAX_MEDIA_FILE_BYTES ?? `${50 * 1024 * 1024}`, 10);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, temporaryUploadDirectory),
    filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { fileSize: Number.isFinite(maximumUploadBytes) && maximumUploadBytes > 0 ? maximumUploadBytes : 50 * 1024 * 1024 },
});

function validateMediaMime(type: MediaType, mimeType: string): boolean {
  if (type === 'image') return mimeType.startsWith('image/');
  if (type === 'video') return mimeType.startsWith('video/');
  return mimeType.startsWith('audio/');
}

export const apiRouter = Router();
apiRouter.use(express.json({ limit: '5mb' }));

apiRouter.get('/health', (_request, response) => response.json({ ok: true }));

apiRouter.get('/bots', (_request, response) => {
  response.json({ bots: listStoredBots().map(toPublicBot) });
});

apiRouter.post('/bots', (_request, response) => {
  const bot = createStoredBot();
  response.status(201).json({ bot: toPublicBot(bot) });
});

apiRouter.get('/bots/:botId', (request, response) => {
  const botId = String(request.params.botId);
  const bot = safeBotId(botId) ? getStoredBot(botId) : undefined;
  if (!bot) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
  response.json({ bot: toPublicBot(bot) });
});

apiRouter.patch('/bots/:botId', (request, response) => {
  const botId = String(request.params.botId);
  if (!safeBotId(botId)) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
  const current = getStoredBot(botId);
  if (!current) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
  const previousMedia = flattenMedia(current);
  const patch = parseBotPatch(current, request.body);
  const updated = updateStoredBot(botId, (record) => ({ ...record, ...patch }));
  if (!updated) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
  const retainedMedia = flattenMedia(updated);
  for (const [mediaId, media] of previousMedia) {
    if (!retainedMedia.has(mediaId)) removeMediaFile(botId, media);
  }
  response.json({ bot: toPublicBot(updated) });
});

apiRouter.post('/bots/:botId/connect', asyncRoute(async (request, response) => {
  const botId = String(request.params.botId);
  if (!safeBotId(botId)) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
  const current = getStoredBot(botId);
  if (!current) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
  const token = request.body?.token;
  if (typeof token !== 'string' || !token.trim()) throw new HttpError(400, 'أدخل توكن البوت أولاً.');
  if (unresolvedKeyboardPreference(current)) {
    throw new HttpError(409, 'حدّد لوحة المفاتيح التي ستظهر عند وجود أزرار Inline وReply معًا قبل الربط.');
  }
  try {
    const result = await connectTelegramBot(botId, token);
    response.json({ bot: result.bot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'تعذر ربط البوت بتيليجرام.';
    throw new HttpError(400, message);
  }
}));

apiRouter.get('/bots/:botId/media/:mediaId/file', (request, response, next) => {
  const botId = String(request.params.botId);
  const mediaId = String(request.params.mediaId);
  if (!safeBotId(botId)) return next(new HttpError(404, 'لم يتم العثور على الملف.'));
  const bot = getStoredBot(botId);
  const media = bot && findStoredMedia(bot, mediaId);
  if (!bot || !media) return next(new HttpError(404, 'لم يتم العثور على الملف.'));
  const file = mediaDiskPath(botId, media);
  if (!fs.existsSync(file)) return next(new HttpError(404, 'ملف الوسائط غير موجود على الخادم.'));
  response.setHeader('Content-Type', media.mimeType);
  response.setHeader('Cache-Control', 'private, max-age=300');
  response.sendFile(file, (error) => {
    if (error) next(error);
  });
});

apiRouter.post('/bots/:botId/media', upload.single('file'), (request, response, next) => {
  const uploaded = request.file;
  try {
    const botId = String(request.params.botId);
    if (!safeBotId(botId)) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
    if (!uploaded) throw new HttpError(400, 'اختر ملف وسائط أولاً.');
    const bot = getStoredBot(botId);
    if (!bot) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
    const buttonId = request.body?.buttonId;
    const type = request.body?.type;
    if (typeof buttonId !== 'string' || !findStoredButton(bot, buttonId)) {
      throw new HttpError(404, 'لم يتم العثور على تدفق الزر المطلوب.');
    }
    if (!isMediaType(type)) throw new HttpError(400, 'اختر نوع الوسائط.');
    const mimeType = uploaded.mimetype || 'application/octet-stream';
    if (!validateMediaMime(type, mimeType)) {
      throw new HttpError(400, 'نوع الملف لا يطابق نوع الوسائط المحدد.');
    }

    const mediaId = crypto.randomUUID();
    const originalExtension = path.extname(uploaded.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const storageName = `${mediaId}${originalExtension}`;
    const destination = path.join(ensureMediaDirectory(botId), storageName);
    fs.renameSync(uploaded.path, destination);

    const item: StoredMediaItem = {
      id: mediaId,
      type,
      name: path.basename(uploaded.originalname).slice(0, 180) || 'media',
      mimeType,
      size: uploaded.size,
      url: `/api/bots/${botId}/media/${mediaId}/file`,
      storageName,
    };
    let updated: StoredBot | undefined;
    let attached = false;
    updated = updateStoredBot(botId, (record) => {
      attached = updateButtonMedia(record, buttonId, item);
      return record;
    });
    if (!updated || !attached) {
      fs.rmSync(destination, { force: true });
      throw new HttpError(404, 'تعذر ربط الملف بتدفق الزر.');
    }
    response.status(201).json({ bot: toPublicBot(updated) });
  } catch (error) {
    if (uploaded?.path) removeTemporaryUpload(uploaded.path);
    next(error);
  }
});

apiRouter.delete('/bots/:botId/media/:mediaId', (request, response, next) => {
  try {
    const botId = String(request.params.botId);
    const mediaId = String(request.params.mediaId);
    if (!safeBotId(botId)) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
    const current = getStoredBot(botId);
    if (!current) throw new HttpError(404, 'لم يتم العثور على هذا البوت.');
    if (!findStoredMedia(current, mediaId)) throw new HttpError(404, 'لم يتم العثور على الوسائط.');
    let removed: StoredMediaItem | undefined;
    const updated = updateStoredBot(botId, (record) => {
      removed = removeStoredMedia(record, mediaId);
      return record;
    });
    if (!updated || !removed) throw new HttpError(404, 'لم يتم العثور على الوسائط.');
    removeMediaFile(botId, removed);
    response.json({ bot: toPublicBot(updated) });
  } catch (error) {
    next(error);
  }
});

export const apiErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'حجم الملف يتجاوز الحد التشغيلي المسموح به.'
      : 'تعذر رفع الملف. تحقق من نوعه وحاول مرة أخرى.';
    response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  console.error('API request failed:', error instanceof Error ? error.message : 'Unknown error');
  response.status(500).json({ error: 'حدث خطأ غير متوقع. لم يتم تأكيد نجاح العملية.' });
};
