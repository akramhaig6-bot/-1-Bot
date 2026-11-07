import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMenuSettings, emptyFlow, type BotButton, type ButtonBoard, type BotConfig } from '@shared/types';
import { boardWithButton, moveButtonBetweenManualPages, moveButtonToRow, reorderButtonInManualPage, deleteButtonInBot } from './utils';

function button(id: string, type: 'inline' | 'reply' = 'inline', child?: BotButton): BotButton {
  const flow = emptyFlow();
  if (child) flow.inline = { buttons: [child], rows: [[child.id]] };
  return { id, label: id, type, flow };
}

function manualBoard(): ButtonBoard {
  return {
    buttons: [button('a'), button('b'), button('c')],
    rows: [['a'], ['b'], ['c']],
    menuSettings: {
      ...defaultMenuSettings(),
      pageMode: 'manual',
      manualPages: [
        { id: 'one', buttonIds: ['a', 'b'], rows: [['a'], ['b']] },
        { id: 'two', buttonIds: ['c'], rows: [['c']] },
      ],
    },
  };
}

test('legacy row reorder still supports combining buttons and creating a row', () => {
  const input = { buttons: [button('a'), button('b'), button('c')], rows: [['a'], ['b'], ['c']] };
  assert.deepEqual(moveButtonToRow(input, 'b', 0, 'a').rows, [['b', 'a'], ['c']]);
  assert.deepEqual(moveButtonToRow(input, 'a', 3, undefined, true).rows, [['b'], ['c'], ['a']]);
});

test('manual page membership can move without changing button actions', () => {
  const input = manualBoard();
  const moved = moveButtonBetweenManualPages(input, 'b', 'two');
  assert.deepEqual(moved.menuSettings?.manualPages.map((page) => page.buttonIds), [['a'], ['c', 'b']]);
  assert.equal(moved.buttons.find((item) => item.id === 'b')?.flow.message, null);
  assert.deepEqual(moved.rows.flat(), ['a', 'c', 'b']);
});

test('manual row reorder changes only the selected page layout', () => {
  const input = manualBoard();
  const reordered = reorderButtonInManualPage(input, 'one', 'b', 0, 'a');
  assert.deepEqual(reordered.menuSettings?.manualPages[0].rows, [['b', 'a']]);
  assert.deepEqual(reordered.menuSettings?.manualPages[1].rows, [['c']]);
  assert.deepEqual(reordered.menuSettings?.manualPages[0].buttonIds, ['b', 'a']);
});

test('adding a button in manual mode places it on the final page and retains its flow', () => {
  const input = manualBoard();
  const created = button('new');
  created.flow.message = 'Saved action';
  const next = boardWithButton(input, created);
  assert.deepEqual(next.menuSettings?.manualPages.map((page) => page.buttonIds), [['a', 'b'], ['c', 'new']]);
  assert.equal(next.buttons.find((item) => item.id === 'new')?.flow.message, 'Saved action');
});

test('deleting a button also removes it from manual page references and keeps other nested flows', () => {
  const nested = button('nested');
  const root = button('root', 'inline', nested);
  const bot: BotConfig = {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startMessage: 'Start',
    inline: { buttons: [root], rows: [['root']] },
    reply: manualBoard(),
    startKeyboardPreference: null,
    connection: { state: 'unconnected', username: null, displayName: null, lastError: null, checkedAt: null },
  };
  const next = deleteButtonInBot(bot, 'root');
  assert.deepEqual(next.inline.buttons, []);
  assert.deepEqual(next.reply.buttons.map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(next.reply.menuSettings?.manualPages.map((page) => page.buttonIds), [['a', 'b'], ['c']]);
  assert.equal(next.startMessage, 'Start');
});
