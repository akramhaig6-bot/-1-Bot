import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { defaultMenuSettings, emptyFlow, type ButtonBoard, type BotButton, type MenuSettings } from '../shared/types.js';

interface MockEvent {
  token: string;
  method: string;
  body: Record<string, any>;
  result?: any;
}

interface MockUpdate {
  update_id: number;
  message?: Record<string, any>;
  callback_query?: Record<string, any>;
}

function makeButton(id: string, label: string, type: 'inline' | 'reply' = 'inline'): BotButton {
  return { id, label, type, flow: emptyFlow() };
}

function withPages(settings: MenuSettings, pageMode: MenuSettings['pageMode'], manualPages: MenuSettings['manualPages'] = []): MenuSettings {
  return { ...settings, pageMode, manualPages };
}

function parseMockBody(contentType: string, raw: string): Record<string, any> {
  if (contentType.includes('application/json')) return JSON.parse(raw || '{}') as Record<string, any>;
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  if (!boundary) return {};
  const body: Record<string, any> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const splitAt = part.indexOf('\r\n\r\n');
    if (splitAt < 0) continue;
    const header = part.slice(0, splitAt);
    const field = header.match(/name="([^"]+)"/)?.[1];
    if (!field) continue;
    const value = part.slice(splitAt + 4).replace(/\r\n$/, '');
    body[field] = field === 'reply_markup' ? JSON.parse(value) : field === 'chat_id' ? Number(value) : value;
  }
  return body;
}

async function waitForEvent(events: MockEvent[], start: number, predicate: (event: MockEvent) => boolean): Promise<MockEvent> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (let index = start; index < events.length; index += 1) {
      if (predicate(events[index])) return events[index];
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a mocked Telegram Bot API request.');
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for navigation state to be persisted.');
}

test('Telegram polling routes page, submenu, back, and Reply Keyboard navigation per bot/user', async (t) => {
  const originalCwd = process.cwd();
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'botmakers-telegram-test-'));
  process.chdir(tempDirectory);

  const events: MockEvent[] = [];
  const queuedUpdates = new Map<string, MockUpdate[]>();
  let nextMessageId = 1;
  const mockServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const contentType = String(request.headers['content-type'] ?? '');
    const body = parseMockBody(contentType, Buffer.concat(chunks).toString('utf8'));
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const routeMatch = url.pathname.match(/^\/bot([^/]+)\/([^/]+)$/);
    const token = routeMatch?.[1];
    const method = routeMatch?.[2];
    if (!token || !method) {
      response.writeHead(404).end();
      return;
    }
    const event: MockEvent = { token, method, body };
    events.push(event);
    let result: unknown;
    if (method === 'getMe') {
      result = { id: 123456, is_bot: true, first_name: 'Mock Bot', username: 'mock_bot' };
    } else if (method === 'getUpdates') {
      const next = queuedUpdates.get(token)?.shift();
      if (!next) await new Promise((resolve) => setTimeout(resolve, 3));
      result = next ? [next] : [];
    } else if (method === 'sendMessage') {
      result = { message_id: nextMessageId++, chat: { id: body.chat_id }, text: body.text };
    } else if (method === 'sendPhoto') {
      result = { message_id: nextMessageId++, chat: { id: Number(body.chat_id) }, caption: body.caption };
    } else if (method.startsWith('editMessage')) {
      result = { message_id: body.message_id, chat: { id: body.chat_id }, text: body.text ?? body.caption };
    } else if (method === 'answerCallbackQuery') {
      result = true;
    } else {
      result = true;
    }
    event.result = result;
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result }));
    }
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const address = mockServer.address();
  if (!address || typeof address === 'string') throw new Error('Mock Telegram server did not bind.');
  const previousApiBase = process.env.TELEGRAM_API_BASE_URL;
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  let stopTelegramBots: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stopTelegramBots?.();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    process.chdir(originalCwd);
    await fs.rm(tempDirectory, { recursive: true, force: true });
    if (previousApiBase === undefined) delete process.env.TELEGRAM_API_BASE_URL;
    else process.env.TELEGRAM_API_BASE_URL = previousApiBase;
  });

  const store = await import('./store.js');
  const telegram = await import('./telegram.js');
  stopTelegramBots = telegram.stopTelegramBots;
  const enqueue = (token: string, update: MockUpdate) => {
    const queue = queuedUpdates.get(token) ?? [];
    queue.push(update);
    queuedUpdates.set(token, queue);
  };
  const makeBot = (startMessage: string, inline: ButtonBoard, reply: ButtonBoard, startKeyboardPreference: 'inline' | 'reply' | null = null) => {
    const bot = store.createStoredBot();
    const updated = store.updateStoredBot(bot.id, (current) => ({
      ...current,
      startMessage,
      inline: inline as typeof current.inline,
      reply: reply as typeof current.reply,
      startKeyboardPreference,
    }));
    if (!updated) throw new Error('Test bot could not be saved.');
    return updated;
  };

  const pageSettings: MenuSettings = {
    ...withPages(defaultMenuSettings(), 'manual', [
      { id: 'first-page', buttonIds: ['a', 'b'], rows: [['a', 'b']] },
      { id: 'second-page', buttonIds: ['c'], rows: [['c']] },
    ]),
    pageControls: {
      ...defaultMenuSettings().pageControls,
      previous: { enabled: true, label: 'السابق' },
      next: { enabled: true, label: 'التالي' },
    },
    menuControls: {
      back: { enabled: true, label: 'رجوع' },
      home: { enabled: true, label: 'الرئيسية' },
    },
    pageIndicator: { enabled: true, template: 'صفحة {current} من {total}', position: 'after' },
  };
  const a = makeButton('a', 'ألف');
  const b = makeButton('b', 'باء');
  const c = makeButton('c', 'قائمة فرعية');
  c.flow.message = 'محتوى القائمة الفرعية';
  const child = makeButton('child', 'زر فرعي');
  child.flow.message = 'إجراء فرعي';
  const childSettings = {
    ...defaultMenuSettings(),
    pageMode: 'off' as const,
    menuControls: { back: { enabled: true, label: 'رجوع' }, home: { enabled: true, label: 'الرئيسية' } },
  };
  c.flow.inline = { buttons: [child], rows: [['child']], menuSettings: childSettings };
  const inlineBoard: ButtonBoard = { buttons: [a, b, c], rows: [['a', 'b'], ['c']], menuSettings: pageSettings };
  const rootToken = 'mock-root-token';
  const rootBot = makeBot('القائمة الرئيسية', inlineBoard, { buttons: [], rows: [] });
  const rootConnected = await telegram.connectTelegramBot(rootBot.id, rootToken);
  assert.equal(rootConnected.bot.connection.state, 'connected');

  let updateId = 10;
  const startUser = (token: string, userId: number, text = '/start') => enqueue(token, {
    update_id: updateId++,
    message: { message_id: 100 + userId, chat: { id: userId }, from: { id: userId }, text },
  });
  const callback = (token: string, userId: number, messageId: number, data: string) => enqueue(token, {
    update_id: updateId++,
    callback_query: { id: `callback-${updateId}`, from: { id: userId }, data, message: { message_id: messageId, chat: { id: userId } } },
  });

  let marker = events.length;
  startUser(rootToken, 700);
  const rootSent = await waitForEvent(events, marker, (event) => event.token === rootToken && event.method === 'sendMessage' && event.body.chat_id === 700);
  const rootMessageId = rootSent.result.message_id as number;
  assert.match(rootSent.body.text, /صفحة 1 من 2/);
  assert.deepEqual(rootSent.body.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text), ['ألف', 'باء']);
  const user700State = store.getUserNavigationState(rootBot.id, 700);
  assert.equal(user700State?.stack[0].pageIndex, 0);

  marker = events.length;
  callback(rootToken, 700, rootMessageId, 'pg:next');
  const nextPageEvent = await waitForEvent(events, marker, (event) => event.token === rootToken && event.method === 'editMessageText' && String(event.body.text).includes('صفحة 2 من 2'));
  assert.deepEqual(nextPageEvent.body.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text), ['قائمة فرعية']);
  await waitUntil(() => store.getUserNavigationState(rootBot.id, 700)?.stack[0].pageIndex === 1);
  assert.equal(store.getUserNavigationState(rootBot.id, 700)?.stack[0].pageIndex, 1);

  marker = events.length;
  startUser(rootToken, 701);
  const otherUserMenu = await waitForEvent(events, marker, (event) => event.token === rootToken && event.method === 'sendMessage' && event.body.chat_id === 701);
  assert.match(otherUserMenu.body.text, /صفحة 1 من 2/);
  await waitUntil(() => Boolean(store.getUserNavigationState(rootBot.id, 701)?.stack[0]?.messageId));
  assert.equal(store.getUserNavigationState(rootBot.id, 701)?.stack[0].pageIndex, 0);
  assert.equal(store.getUserNavigationState(rootBot.id, 700)?.stack[0].pageIndex, 1);

  marker = events.length;
  callback(rootToken, 700, rootMessageId, 'b:c');
  const submenuMessage = await waitForEvent(events, marker, (event) => event.token === rootToken && event.method === 'sendMessage' && event.body.chat_id === 700 && event.body.text === 'محتوى القائمة الفرعية');
  const submenuId = submenuMessage.result as { message_id: number };
  assert.ok(submenuMessage.body.reply_markup.inline_keyboard.flat().some((button: { text: string }) => button.text === 'رجوع'));
  await waitUntil(() => store.getUserNavigationState(rootBot.id, 700)?.stack.length === 2);
  assert.equal(store.getUserNavigationState(rootBot.id, 700)?.stack.length, 2);
  assert.equal(store.getUserNavigationState(rootBot.id, 700)?.stack[0].pageIndex, 1);

  marker = events.length;
  callback(rootToken, 700, submenuId.message_id, 'mn:back');
  const returned = await waitForEvent(events, marker, (event) => event.token === rootToken && event.method === 'editMessageText' && event.body.message_id === rootMessageId);
  assert.match(returned.body.text, /صفحة 2 من 2/);
  assert.deepEqual(returned.body.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text), ['قائمة فرعية']);
  await waitUntil(() => store.getUserNavigationState(rootBot.id, 700)?.stack.length === 1);
  assert.equal(store.getUserNavigationState(rootBot.id, 700)?.stack.length, 1);
  assert.equal(store.getUserNavigationState(rootBot.id, 700)?.stack[0].pageIndex, 1);

  const replySettings: MenuSettings = {
    ...defaultMenuSettings(),
    pageMode: 'automatic',
    itemsPerPage: 1,
    pageControls: {
      ...defaultMenuSettings().pageControls,
      previous: { enabled: true, label: 'السابق' },
      next: { enabled: true, label: 'التالي' },
    },
    pageIndicator: { enabled: true, template: 'صفحة {current}/{total}', position: 'after' },
  };
  const replyBoard: ButtonBoard = {
    buttons: [makeButton('r1', 'خيار 1', 'reply'), makeButton('r2', 'خيار 2', 'reply')],
    rows: [['r1'], ['r2']],
    menuSettings: replySettings,
  };
  const replyToken = 'mock-reply-token';
  const replyBot = makeBot('قائمة الرد', { buttons: [], rows: [] }, replyBoard);
  await telegram.connectTelegramBot(replyBot.id, replyToken);
  marker = events.length;
  startUser(replyToken, 900);
  const replyInitial = await waitForEvent(events, marker, (event) => event.token === replyToken && event.method === 'sendMessage' && event.body.chat_id === 900);
  const replyInitialId = events.slice(marker).find((event) => event.token === replyToken && event.method === 'sendMessage' && event.body.chat_id === 900)?.result?.message_id as number;
  assert.deepEqual(replyInitial.body.reply_markup.keyboard[0].map((button: { text: string }) => button.text), ['خيار 1']);
  await waitUntil(() => Boolean(store.getUserNavigationState(replyBot.id, 900)?.stack[0]?.messageId));
  assert.equal(store.getUserNavigationState(replyBot.id, 900)?.stack[0].boardType, 'reply');

  marker = events.length;
  startUser(replyToken, 900, 'التالي');
  const replyNext = await waitForEvent(events, marker, (event) => event.token === replyToken && event.method === 'sendMessage' && event.body.chat_id === 900 && String(event.body.text).includes('صفحة 2/2'));
  assert.ok(replyNext.result.message_id > replyInitialId);
  assert.deepEqual(replyNext.body.reply_markup.keyboard[0].map((button: { text: string }) => button.text), ['خيار 2']);
  assert.equal(events.slice(marker).some((event) => event.token === replyToken && event.method.startsWith('editMessage')), false);
  await waitUntil(() => store.getUserNavigationState(replyBot.id, 900)?.stack[0].pageIndex === 1);
  assert.equal(store.getUserNavigationState(replyBot.id, 900)?.stack[0].pageIndex, 1);

  const imageFirst = makeButton('img1', 'صورة 1');
  const imageSecond = makeButton('img2', 'صورة 2');
  const imagePages: MenuSettings = {
    ...defaultMenuSettings(),
    pageMode: 'manual',
    manualPages: [
      { id: 'image-page-one', buttonIds: ['img1'], rows: [['img1']] },
      { id: 'image-page-two', buttonIds: ['img2'], rows: [['img2']] },
    ],
    pageIndicator: { enabled: true, template: 'الوسيط · صفحة {current}/{total}', position: 'after' },
  };
  const imageMenu = makeButton('image-menu', 'قائمة الصور');
  imageMenu.flow.media = [{
    id: 'media-image-1',
    type: 'image',
    name: 'tiny.png',
    mimeType: 'image/png',
    size: 10,
    url: '/local-media/tiny.png',
    storageName: 'tiny.png',
  } as typeof imageMenu.flow.media[number] & { storageName: string }];
  imageMenu.flow.inline = { buttons: [imageFirst, imageSecond], rows: [['img1'], ['img2']], menuSettings: imagePages };
  const imageToken = 'mock-image-token';
  const imageBot = makeBot('قائمة الصور', { buttons: [imageMenu], rows: [['image-menu']] }, { buttons: [], rows: [] });
  const mediaDirectory = store.ensureMediaDirectory(imageBot.id);
  await fs.writeFile(path.join(mediaDirectory, 'tiny.png'), Buffer.from('mock-image-payload'));
  await telegram.connectTelegramBot(imageBot.id, imageToken);

  marker = events.length;
  startUser(imageToken, 910);
  const imageRoot = await waitForEvent(events, marker, (event) => event.token === imageToken && event.method === 'sendMessage' && event.body.chat_id === 910);
  marker = events.length;
  callback(imageToken, 910, imageRoot.result.message_id, 'b:image-menu');
  const imageMenuMessage = await waitForEvent(events, marker, (event) => event.token === imageToken && event.method === 'sendPhoto' && event.body.chat_id === 910);
  assert.ok(String(imageMenuMessage.body.caption).includes('الوسيط · صفحة 1/2'));
  assert.deepEqual(imageMenuMessage.body.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text), ['صورة 1']);
  const imageMessageId = imageMenuMessage.result.message_id as number;

  marker = events.length;
  callback(imageToken, 910, imageMessageId, 'pg:next');
  const imagePageUpdate = await waitForEvent(events, marker, (event) => event.token === imageToken && event.method === 'editMessageCaption' && event.body.message_id === imageMessageId);
  assert.ok(String(imagePageUpdate.body.caption).includes('الوسيط · صفحة 2/2'));
  assert.deepEqual(imagePageUpdate.body.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text), ['صورة 2']);
  assert.equal(events.slice(marker).some((event) => event.token === imageToken && event.method === 'sendPhoto' && event.body.chat_id === 910), false);
  await waitUntil(() => store.getUserNavigationState(imageBot.id, 910)?.stack.at(-1)?.pageIndex === 1);
});
