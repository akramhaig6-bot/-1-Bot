import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultMenuSettings, emptyFlow, type ButtonBoard, type MenuSettings } from '../shared/types.js';

test('API adds optional menu settings, preserves omitted settings, and rejects ambiguous navigation safely', async (t) => {
  const originalCwd = process.cwd();
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'botmakers-api-test-'));
  process.chdir(tempDirectory);

  const expressModule = await import('express');
  const { apiRouter, apiErrorHandler } = await import('./api.js');
  const app = expressModule.default();
  app.use('/api', apiRouter);
  app.use('/api', apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(originalCwd);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address();
      if (address && typeof address !== 'string') resolve(address.port);
      else reject(new Error('Test API server did not bind.'));
    });
    server.once('error', reject);
  });
  const root = `http://127.0.0.1:${port}/api`;
  const send = async (url: string, init?: RequestInit) => {
    const response = await fetch(`${root}${url}`, init);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  const created = await send('/bots', { method: 'POST' });
  assert.equal(created.status, 201);
  const bot = created.body.bot as { id: string; inline: ButtonBoard; reply: ButtonBoard };
  assert.deepEqual(bot.inline, { buttons: [], rows: [] });
  assert.deepEqual(bot.reply, { buttons: [], rows: [] });

  const action = emptyFlow();
  action.message = 'Saved action';
  const settings: MenuSettings = {
    ...defaultMenuSettings(),
    pageMode: 'manual',
    manualPages: [{ id: 'manual-one', buttonIds: ['button-one'], rows: [['button-one']] }],
  };
  const inline: ButtonBoard = {
    buttons: [{ id: 'button-one', label: 'Open', type: 'inline', flow: action }],
    rows: [['button-one']],
    menuSettings: settings,
  };
  const saved = await send(`/bots/${bot.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startMessage: 'Start', inline }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.bot.inline.menuSettings.pageMode, 'manual');
  assert.deepEqual(saved.body.bot.inline.menuSettings.manualPages[0].buttonIds, ['button-one']);

  const legacyClientBoard = structuredClone(saved.body.bot.inline) as ButtonBoard;
  delete legacyClientBoard.menuSettings;
  const compatible = await send(`/bots/${bot.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startMessage: 'Updated start', inline: legacyClientBoard }),
  });
  assert.equal(compatible.status, 200);
  assert.equal(compatible.body.bot.startMessage, 'Updated start');
  assert.equal(compatible.body.bot.inline.menuSettings.pageMode, 'manual');

  const invalidBoard = structuredClone(compatible.body.bot.inline) as ButtonBoard;
  invalidBoard.menuSettings!.manualPages[0].buttonIds = ['missing-button'];
  const rejected = await send(`/bots/${bot.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inline: invalidBoard }),
  });
  assert.equal(rejected.status, 400);
  const afterRejected = await send(`/bots/${bot.id}`);
  assert.equal(afterRejected.body.bot.startMessage, 'Updated start');
  assert.deepEqual(afterRejected.body.bot.inline.menuSettings.manualPages[0].buttonIds, ['button-one']);

  const replyAction = emptyFlow();
  const conflictingReply: ButtonBoard = {
    buttons: [{ id: 'reply-one', label: 'Next', type: 'reply', flow: replyAction }],
    rows: [['reply-one']],
    menuSettings: {
      ...defaultMenuSettings(),
      pageMode: 'automatic',
      itemsPerPage: 1,
      pageControls: {
        ...defaultMenuSettings().pageControls,
        next: { enabled: true, label: 'Next' },
      },
    },
  };
  const conflict = await send(`/bots/${bot.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reply: conflictingReply }),
  });
  assert.equal(conflict.status, 409);
  const afterConflict = await send(`/bots/${bot.id}`);
  assert.deepEqual(afterConflict.body.bot.reply, { buttons: [], rows: [] });
});
