import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentPage, resolveMenuPages, manualPagesFromBoard } from './menu.js';
import { defaultMenuSettings, type ButtonBoard, type MenuSettings } from './types.js';

function board(ids: string[], rows: string[][], menuSettings?: MenuSettings): ButtonBoard {
  return {
    buttons: ids.map((id) => ({
      id,
      label: id.toUpperCase(),
      type: 'inline',
      flow: { message: null, media: [], inline: { buttons: [], rows: [] }, reply: { buttons: [], rows: [] }, keyboardPreference: null },
    })),
    rows,
    ...(menuSettings ? { menuSettings } : {}),
  };
}

test('a board without page settings remains one legacy page with its existing rows', () => {
  const input = board(['a', 'b', 'c'], [['a', 'b'], ['c']]);
  const pages = resolveMenuPages(input);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].buttonIds, ['a', 'b', 'c']);
  assert.deepEqual(pages[0].rows, [['a', 'b'], ['c']]);
});

test('automatic pagination keeps button order and only splits rows at page boundaries', () => {
  const settings = { ...defaultMenuSettings(), pageMode: 'automatic' as const, itemsPerPage: 2 };
  const pages = resolveMenuPages(board(['a', 'b', 'c', 'd', 'e'], [['a', 'b', 'c'], ['d', 'e']], settings));
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.buttonIds), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(pages.map((page) => page.rows), [[['a', 'b']], [['c'], ['d']], [['e']]]);
  assert.equal(pages[2].index, 2);
  assert.equal(pages[2].total, 3);
});

test('manual pages retain their own order and append unassigned buttons without losing them', () => {
  const settings: MenuSettings = {
    ...defaultMenuSettings(),
    pageMode: 'manual',
    manualPages: [
      { id: 'page-a', buttonIds: ['c', 'a'], rows: [['c'], ['a']] },
      { id: 'page-b', buttonIds: ['b'], rows: [['b']] },
    ],
  };
  const pages = resolveMenuPages(board(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']], settings));
  assert.deepEqual(pages.map((page) => page.buttonIds), [['c', 'a'], ['b', 'd']]);
  assert.deepEqual(pages.map((page) => page.rows), [[['c'], ['a']], [['b'], ['d']]]);
  assert.deepEqual(resolveCurrentPage(board(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']], settings), 0, 'page-b')?.buttonIds, ['b', 'd']);
});

test('switching a board to manual creates a page definition without dropping its rows', () => {
  const input = board(['a', 'b', 'c'], [['a', 'b'], ['c']]);
  const pages = manualPagesFromBoard(input, { ...defaultMenuSettings(), pageMode: 'manual' });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].buttonIds, ['a', 'b', 'c']);
  assert.deepEqual(pages[0].rows, [['a', 'b'], ['c']]);
  assert.match(pages[0].id, /^page-[a-zA-Z0-9-]+$/);
});
