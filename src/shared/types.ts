export type ButtonType = 'inline' | 'reply';
export type MediaType = 'image' | 'video' | 'voice' | 'music';
export type KeyboardPreference = ButtonType;
export type ConnectionState = 'unconnected' | 'connecting' | 'connected' | 'error';
export type PageMode = 'off' | 'automatic' | 'manual';
export type PageControlAction = 'first' | 'previous' | 'next' | 'last';
export type MenuControlAction = 'back' | 'home';
export type NavigationAction = PageControlAction | MenuControlAction;
export type PageIndicatorPosition = 'before' | 'after' | 'separate';
export type MenuRenderMode = 'edit' | 'send';

export interface MediaItem {
  id: string;
  type: MediaType;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface MenuPageDefinition {
  id: string;
  buttonIds: string[];
  /** Row layout belongs to the manual page and is independent of page order. */
  rows: string[][];
}

export interface MenuControlDefinition {
  enabled: boolean;
  label: string;
}

export interface MenuSettings {
  pageMode: PageMode;
  itemsPerPage: number;
  manualPages: MenuPageDefinition[];
  pageControls: Record<PageControlAction, MenuControlDefinition>;
  menuControls: Record<MenuControlAction, MenuControlDefinition>;
  /** Shared control rows retain ordering while action kinds remain distinct. */
  controlRows: NavigationAction[][];
  controlsPosition: 'before' | 'after';
  pageIndicator: {
    enabled: boolean;
    template: string;
    position: PageIndicatorPosition;
  };
  /** Reply Keyboard always sends a new message because Telegram cannot edit its markup. */
  renderMode: MenuRenderMode;
}

export interface ButtonBoard {
  buttons: BotButton[];
  /** Legacy/global row layout. Kept unchanged for existing data. */
  rows: string[][];
  /** Optional, additive settings. Missing means the existing unpaginated behavior. */
  menuSettings?: MenuSettings;
}

export interface ButtonFlow {
  message: string | null;
  media: MediaItem[];
  inline: ButtonBoard;
  reply: ButtonBoard;
  /** Required only when this flow has both keyboard types. */
  keyboardPreference: KeyboardPreference | null;
}

export interface BotButton {
  id: string;
  label: string;
  type: ButtonType;
  flow: ButtonFlow;
}

export interface ConnectionStatus {
  state: ConnectionState;
  username: string | null;
  displayName: string | null;
  lastError: string | null;
  checkedAt: string | null;
}

export interface BotConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
  startMessage: string | null;
  inline: ButtonBoard;
  reply: ButtonBoard;
  startKeyboardPreference: KeyboardPreference | null;
  connection: ConnectionStatus;
}

export type BotPatch = Partial<Pick<
  BotConfig,
  'startMessage' | 'inline' | 'reply' | 'startKeyboardPreference'
>>;

export interface UserNavigationFrame {
  /** Button whose flow owns this board; null identifies the root board. */
  scopeButtonId: string | null;
  /** Button whose message/media currently carries this board's keyboard. */
  messageSourceButtonId: string | null;
  boardType: ButtonType;
  pageIndex: number;
  pageId: string | null;
  messageId: number | null;
  messageKind: 'text' | MediaType | null;
  indicatorMessageId: number | null;
}

export interface UserNavigationState {
  botId: string;
  userId: number;
  chatId: number;
  stack: UserNavigationFrame[];
  selectedButtonId: string | null;
  updatedAt: string;
}

export interface ApiErrorBody {
  error: string;
  details?: string;
}

export function defaultMenuSettings(): MenuSettings {
  return {
    pageMode: 'off',
    itemsPerPage: 8,
    manualPages: [],
    pageControls: {
      first: { enabled: false, label: '⏮ الأولى' },
      previous: { enabled: true, label: '⬅️ السابق' },
      next: { enabled: true, label: 'التالي ➡️' },
      last: { enabled: false, label: 'الأخيرة ⏭' },
    },
    menuControls: {
      back: { enabled: false, label: '↩️ رجوع' },
      home: { enabled: false, label: '🏠 الرئيسية' },
    },
    controlRows: [['previous', 'next'], ['first', 'last'], ['back', 'home']],
    controlsPosition: 'after',
    pageIndicator: {
      enabled: true,
      template: 'صفحة {current} من {total}',
      position: 'after',
    },
    renderMode: 'edit',
  };
}

export function emptyBoard(): ButtonBoard {
  return { buttons: [], rows: [] };
}

export function emptyFlow(): ButtonFlow {
  return {
    message: null,
    media: [],
    inline: emptyBoard(),
    reply: emptyBoard(),
    keyboardPreference: null,
  };
}
