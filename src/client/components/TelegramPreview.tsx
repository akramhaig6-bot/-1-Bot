import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Check, ChevronRight, GripVertical, MessageCircle, Play, Send, Signal, Wifi, X } from 'lucide-react';
import type { BotButton, BotConfig, ButtonBoard, ButtonType, KeyboardPreference, MediaItem, NavigationAction } from '@shared/types';
import { resolveMenuPages } from '@shared/menu';
import { findButton, getButtonFromPath } from '../utils';

interface TelegramPreviewProps {
  bot: BotConfig;
  currentButton: BotButton | null;
  onOpenButton: (id: string) => void;
  onReorder: (type: ButtonType, buttonId: string, rowIndex: number, beforeButtonId?: string, forceNewRow?: boolean, pageId?: string) => void;
}

interface KeyboardSet {
  type: ButtonType;
  board: ButtonBoard;
  pageId: string;
  pageIndex: number;
  totalPages: number;
  label?: string;
}

function KeyboardRows({
  set,
  onOpenButton,
  onReorder,
  onControl,
  simulate,
}: {
  set: KeyboardSet;
  onOpenButton: (id: string) => void;
  onReorder: TelegramPreviewProps['onReorder'];
  onControl: (action: NavigationAction, type: ButtonType) => void;
  simulate: boolean;
}) {
  const draggedId = useRef<string | null>(null);
  const suppressClickUntil = useRef(0);
  const buttonMap = new Map(set.board.buttons.map((button) => [button.id, button]));
  const rows = set.board.rows.map((row) => row.filter((id) => buttonMap.has(id))).filter((row) => row.length > 0);
  const placed = new Set(rows.flat());
  for (const button of set.board.buttons) if (!placed.has(button.id)) rows.push([button.id]);

  const settings = set.board.menuSettings;
  const available = (action: NavigationAction): boolean => {
    if (action === 'back' || action === 'home') return Boolean(settings?.menuControls[action].enabled);
    if (!settings || settings.pageMode === 'off' || set.totalPages <= 1) return false;
    if (!settings.pageControls[action].enabled) return false;
    if (action === 'first' || action === 'previous') return set.pageIndex > 0;
    return set.pageIndex < set.totalPages - 1;
  };
  const controlRows = settings?.controlRows
    .map((row) => row.filter((action) => available(action)))
    .filter((row) => row.length > 0) ?? [];

  const dropOnRow = (event: DragEvent<HTMLDivElement>, rowIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    const buttonId = event.dataTransfer.getData('text/plain') || draggedId.current;
    if (buttonId) onReorder(set.type, buttonId, rowIndex, undefined, false, set.pageId);
    draggedId.current = null;
    suppressClickUntil.current = Date.now() + 250;
  };

  const contentRows = rows.map((row, rowIndex) => (
    <div className="telegram-keyboard-row" key={`${set.type}-${set.pageId}-${rowIndex}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOnRow(event, rowIndex)}>
      {row.map((id) => {
        const button = buttonMap.get(id);
        if (!button) return null;
        return (
          <button
            key={button.id}
            type="button"
            className="telegram-keyboard-button"
            draggable={!simulate}
            onDragStart={(event) => {
              draggedId.current = button.id;
              suppressClickUntil.current = Date.now() + 500;
              event.dataTransfer.setData('text/plain', button.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => { draggedId.current = null; suppressClickUntil.current = Date.now() + 250; }}
            onDragOver={(event) => { if (!simulate) event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const sourceId = event.dataTransfer.getData('text/plain') || draggedId.current;
              if (sourceId && !simulate) onReorder(set.type, sourceId, rowIndex, button.id, false, set.pageId);
              draggedId.current = null;
              suppressClickUntil.current = Date.now() + 250;
            }}
            onClick={() => {
              if (Date.now() < suppressClickUntil.current) return;
              onOpenButton(button.id);
            }}
            title={simulate ? 'جرّب الضغط على هذا الزر' : 'اسحب لإعادة الترتيب أو اضغط لفتح التدفق'}
          >
            {!simulate && <GripVertical size={12} className="keyboard-grip" />}
            <span>{button.label}</span>
          </button>
        );
      })}
    </div>
  ));

  const navigationRows = controlRows.map((row, rowIndex) => (
    <div className="telegram-keyboard-row telegram-navigation-row" key={`nav-${set.type}-${rowIndex}`}>
      {row.map((action) => {
        const value = action === 'back' || action === 'home'
          ? settings?.menuControls[action]
          : settings?.pageControls[action];
        if (!value) return null;
        return <button className="telegram-keyboard-button telegram-navigation-button" type="button" key={action} onClick={() => onControl(action, set.type)}>{value.label}</button>;
      })}
    </div>
  ));

  const allRows = settings?.controlsPosition === 'before'
    ? [...navigationRows, ...contentRows]
    : [...contentRows, ...navigationRows];

  return (
    <div className={`telegram-keyboard telegram-keyboard-${set.type}`}>
      {allRows}
      {!simulate && set.board.buttons.length > 1 && (
        <div className="keyboard-new-row-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const sourceId = event.dataTransfer.getData('text/plain') || draggedId.current;
          if (sourceId) onReorder(set.type, sourceId, rows.length, undefined, true, set.pageId);
          draggedId.current = null;
          suppressClickUntil.current = Date.now() + 250;
        }}>أفلت هنا لإنشاء صف جديد</div>
      )}
      {!set.board.buttons.length && !navigationRows.length && <div className="telegram-empty-keyboard">لا توجد أزرار في هذه الصفحة.</div>}
    </div>
  );
}

function PreviewMedia({ media, caption }: { media: MediaItem; caption?: string | null }) {
  if (media.type === 'image') return <div className="telegram-media-stack"><img className="telegram-image" src={media.url} alt={media.name} />{caption && <div className="telegram-media-caption">{caption}</div>}</div>;
  if (media.type === 'video') return <div className="telegram-media-stack"><video className="telegram-video" src={media.url} controls preload="metadata" />{caption && <div className="telegram-media-caption">{caption}</div>}</div>;
  return (
    <div className="telegram-media-stack">
      <div className="telegram-audio">
        <div className="audio-file-icon"><MessageCircle size={15} /></div>
        <div className="audio-file-info"><span>{media.name}</span><audio src={media.url} controls preload="metadata" /></div>
      </div>
      {caption && <div className="telegram-media-caption">{caption}</div>}
    </div>
  );
}

function indicatorText(template: string, current: number, total: number): string {
  return template.replaceAll('{current}', String(current)).replaceAll('{total}', String(total));
}

function renderIndicator(message: string | null, hasMedia: boolean, enabled: boolean, template: string, position: 'before' | 'after' | 'separate', current: number, total: number): { message: string | null; separate: string | null; caption: string | null } {
  if (!enabled || total < 1) return { message, separate: null, caption: null };
  const text = indicatorText(template, current, total);
  if (position === 'separate') return { message, separate: text, caption: null };
  if (!message && hasMedia) return { message: null, separate: null, caption: text };
  if (!message) return { message: text, separate: null, caption: null };
  return { message: position === 'before' ? `${text}\n\n${message}` : `${message}\n\n${text}`, separate: null, caption: null };
}

function chooseKeyboardSets(
  inline: ButtonBoard,
  reply: ButtonBoard,
  preference: KeyboardPreference | null,
  pageIndexes: Record<ButtonType, number>,
  allowBoth: boolean,
): KeyboardSet[] {
  const hasInline = inline.buttons.length > 0 || Boolean(inline.menuSettings?.pageMode !== 'off' && inline.menuSettings?.pageMode);
  const hasReply = reply.buttons.length > 0 || Boolean(reply.menuSettings?.pageMode !== 'off' && reply.menuSettings?.pageMode);
  let choices: Array<{ type: ButtonType; board: ButtonBoard; label?: string }> = [];
  if (hasInline && hasReply && !preference) {
    choices = allowBoth
      ? [{ type: 'inline', board: inline, label: 'خيار Inline' }, { type: 'reply', board: reply, label: 'خيار Reply Keyboard' }]
      : [];
  } else if (hasInline && hasReply) {
    choices = preference === 'reply' ? [{ type: 'reply', board: reply }] : [{ type: 'inline', board: inline }];
  } else if (hasInline) choices = [{ type: 'inline', board: inline }];
  else if (hasReply) choices = [{ type: 'reply', board: reply }];

  return choices.flatMap(({ type, board, label }) => {
    const pages = resolveMenuPages(board);
    const index = Math.max(0, Math.min(pageIndexes[type], Math.max(0, pages.length - 1)));
    const page = pages[index];
    if (!page) return [];
    const ids = new Set(page.buttonIds);
    const displayBoard: ButtonBoard = {
      ...board,
      buttons: board.buttons.filter((button) => ids.has(button.id)),
      rows: page.rows,
    };
    return [{ type, board: displayBoard, pageId: page.id, pageIndex: page.index, totalPages: page.total, label }];
  });
}

function findChildBoardType(button: BotButton): ButtonType | null {
  const hasInline = button.flow.inline.buttons.length > 0;
  const hasReply = button.flow.reply.buttons.length > 0;
  if (hasInline && hasReply) return button.flow.keyboardPreference ?? 'inline';
  if (hasInline) return 'inline';
  if (hasReply) return 'reply';
  return null;
}

export function TelegramPreview({ bot, currentButton, onOpenButton, onReorder }: TelegramPreviewProps) {
  const scopeKey = currentButton?.id ?? 'root';
  const [pageIndexes, setPageIndexes] = useState<Record<ButtonType, number>>({ inline: 0, reply: 0 });
  const [testMode, setTestMode] = useState(false);
  const [simulatedPath, setSimulatedPath] = useState<string[]>([]);
  const [simulatedActionId, setSimulatedActionId] = useState<string | null>(null);
  const [simulatedType, setSimulatedType] = useState<ButtonType | null>(null);
  const [simulatedNotice, setSimulatedNotice] = useState('');

  useEffect(() => {
    setPageIndexes({ inline: 0, reply: 0 });
    setSimulatedPath([]);
    setSimulatedActionId(null);
    setSimulatedType(null);
    setSimulatedNotice('');
  }, [scopeKey]);

  const simulatedParent = simulatedPath.length ? getButtonFromPath(bot, simulatedPath) : null;
  const actionButton = testMode && simulatedActionId ? findButton(bot, simulatedActionId) : null;
  const contextButton = testMode ? simulatedParent : currentButton;
  const contextFlow = contextButton?.flow;
  let message: string | null = contextButton ? contextFlow?.message ?? null : bot.startMessage;
  let media = contextButton ? contextFlow?.media ?? [] : [];
  let inline = contextButton ? contextFlow?.inline ?? { buttons: [], rows: [] } : bot.inline;
  let reply = contextButton ? contextFlow?.reply ?? { buttons: [], rows: [] } : bot.reply;
  let preference: KeyboardPreference | null = contextButton ? contextFlow?.keyboardPreference ?? null : bot.startKeyboardPreference;
  if (testMode && actionButton) {
    message = actionButton.flow.message;
    media = actionButton.flow.media;
  }
  if (testMode && simulatedType) {
    const preferredBoard = simulatedType === 'inline' ? inline : reply;
    const otherBoard = simulatedType === 'inline' ? reply : inline;
    inline = simulatedType === 'inline' ? preferredBoard : { buttons: [], rows: [] };
    reply = simulatedType === 'reply' ? preferredBoard : { buttons: [], rows: [] };
    if (otherBoard.buttons.length === 0) preference = simulatedType;
  }

  const keyboardSets = chooseKeyboardSets(inline, reply, preference, pageIndexes, true);
  const primarySet = keyboardSets[0];
  const primarySettings = primarySet?.board.menuSettings;
  const pageText = primarySet && primarySettings?.pageMode !== 'off'
    ? renderIndicator(message, media.length > 0, primarySettings?.pageIndicator.enabled ?? false, primarySettings?.pageIndicator.template ?? 'صفحة {current} من {total}', primarySettings?.pageIndicator.position ?? 'after', primarySet.pageIndex + 1, primarySet.totalPages)
    : { message, separate: null, caption: null };
  const displayedMessage = pageText.message;
  const displayedMedia = media;

  const handlePreviewAction = (buttonId: string) => {
    if (!testMode) {
      onOpenButton(buttonId);
      return;
    }
    const button = findButton(bot, buttonId);
    if (!button) return;
    const childType = findChildBoardType(button);
    if (childType) {
      setSimulatedPath((path) => [...path, button.id]);
      setSimulatedActionId(null);
      setSimulatedType(childType);
      setPageIndexes({ inline: 0, reply: 0 });
      setSimulatedNotice(`فتحت القائمة الفرعية: ${button.label}`);
      return;
    }
    setSimulatedActionId(button.id);
    setSimulatedNotice(button.flow.message || button.flow.media.length ? `عُرض إجراء الزر: ${button.label}` : `لا يوجد إجراء محفوظ للزر: ${button.label}`);
  };

  const handleControl = (action: NavigationAction, type: ButtonType) => {
    const set = keyboardSets.find((item) => item.type === type);
    if (!set) return;
    if (action === 'back' || action === 'home') {
      if (!testMode) {
        setTestMode(true);
        setSimulatedPath([]);
        setSimulatedActionId(null);
        setSimulatedType(null);
        setSimulatedNotice('وضع التجربة يعرض التنقل كما يراه المستخدم.');
        return;
      }
      if (action === 'home') {
        setSimulatedPath([]);
        setSimulatedActionId(null);
        setSimulatedType(null);
        setSimulatedNotice('عدت إلى القائمة الرئيسية.');
      } else if (simulatedPath.length) {
        setSimulatedPath((path) => path.slice(0, -1));
        setSimulatedActionId(null);
        const parentPath = simulatedPath.slice(0, -1);
        const parent = parentPath.length ? getButtonFromPath(bot, parentPath) : null;
        const childType = parent ? findChildBoardType(parent) : bot.startKeyboardPreference ?? (bot.inline.buttons.length ? 'inline' : 'reply');
        setSimulatedType(childType ?? null);
        setSimulatedNotice('رجعت إلى القائمة السابقة.');
      }
      return;
    }
    const total = set.totalPages;
    let index = set.pageIndex;
    if (action === 'first') index = 0;
    else if (action === 'previous') index = Math.max(0, index - 1);
    else if (action === 'next') index = Math.min(total - 1, index + 1);
    else if (action === 'last') index = total - 1;
    setPageIndexes((current) => ({ ...current, [type]: index }));
    if (testMode) setSimulatedNotice(`الصفحة ${index + 1} من ${total}`);
  };

  const beginTest = () => {
    setTestMode(true);
    setSimulatedPath([]);
    setSimulatedActionId(null);
    setSimulatedType(bot.startKeyboardPreference ?? null);
    setPageIndexes({ inline: 0, reply: 0 });
    setSimulatedNotice('تجربة محلية فقط؛ لا تُرسل أي رسالة إلى تيليجرام.');
  };

  const visiblePreviewText = displayedMessage;
  const hasContent = Boolean(visiblePreviewText) || displayedMedia.length > 0 || Boolean(pageText.separate) || Boolean(pageText.caption);
  const stackDepth = testMode ? simulatedPath.length : 0;

  return (
    <div className="preview-card">
      <div className="preview-card-topline">
        <div><span className="eyebrow">المعاينة الحية</span><h3>محاكي تيليجرام</h3></div>
        <div className="preview-toolbar">
          {testMode ? (
            <button className="preview-mode-button preview-mode-active" type="button" onClick={() => { setTestMode(false); setSimulatedPath([]); setSimulatedActionId(null); setSimulatedType(null); }}><X size={13} /> إيقاف التجربة</button>
          ) : <button className="preview-mode-button" type="button" onClick={beginTest}><Play size={13} /> تجربة التنقل</button>}
          <span className={`preview-live-dot ${testMode ? 'preview-test-dot' : ''}`}><i />{testMode ? 'تجربة' : 'معاينة'}</span>
        </div>
      </div>
      <div className="phone-frame" aria-label="معاينة شكل البوت في تيليجرام">
        <div className="phone-speaker" />
        <div className="telegram-screen">
          <div className="telegram-statusbar"><span>9:41</span><div className="status-icons"><Signal size={14} /><Wifi size={14} /><span className="battery-shape" /></div></div>
          <div className="telegram-header"><div className="telegram-back-arrow">‹</div><div className="telegram-avatar"><Send size={17} fill="currentColor" /></div><div className="telegram-contact"><strong>{bot.connection.displayName || 'معاينة البوت'}</strong><span>{testMode ? 'محاكاة محلية' : bot.connection.state === 'connected' ? 'متصل في تيليجرام' : 'معاينة محلية'}</span></div><div className="telegram-header-menu">•••</div></div>
          <div className="telegram-chat-area">
            <div className="telegram-date-pill">اليوم</div>
            {hasContent ? (
              <div className="telegram-message-stack">
                {visiblePreviewText && <div className="telegram-bubble">{visiblePreviewText}<span className="telegram-message-time">12:00 <Check size={11} /></span></div>}
                {displayedMedia.map((item, index) => <PreviewMedia key={item.id} media={item} caption={index === 0 ? pageText.caption : null} />)}
                {pageText.separate && <div className="telegram-page-indicator">{pageText.separate}</div>}
                {simulatedNotice && testMode && <div className="telegram-simulation-note">{simulatedNotice}</div>}
              </div>
            ) : (
              <div className="telegram-empty-preview"><div className="empty-preview-symbol"><MessageCircle size={20} /></div><p>لا توجد رسالة أو وسائط محفوظة في هذا التدفق بعد.</p>{simulatedNotice && testMode && <small>{simulatedNotice}</small>}</div>
            )}
            {keyboardSets.some((item) => item.type === 'inline') && (
              <div className="telegram-inline-wrap">
                {keyboardSets.filter((item) => item.type === 'inline').map((set) => <div className="telegram-keyboard-option" key="inline">{set.label && <span className="keyboard-option-label">{set.label}</span>}<KeyboardRows set={set} onOpenButton={handlePreviewAction} onReorder={onReorder} onControl={handleControl} simulate={testMode} /></div>)}
              </div>
            )}
          </div>
          {keyboardSets.some((item) => item.type === 'reply') && (
            <div className="telegram-reply-wrap">
              {keyboardSets.filter((item) => item.type === 'reply').map((set) => <div className="telegram-keyboard-option" key="reply">{set.label && <span className="keyboard-option-label">{set.label}</span>}<KeyboardRows set={set} onOpenButton={handlePreviewAction} onReorder={onReorder} onControl={handleControl} simulate={testMode} /></div>)}
            </div>
          )}
          {testMode && stackDepth > 0 && <button className="preview-sim-back" type="button" onClick={() => handleControl('back', simulatedType ?? 'inline')}><ChevronRight size={14} /> رجوع إلى القائمة السابقة</button>}
          <div className="telegram-inputbar"><span className="telegram-attach">＋</span><span className="telegram-input-placeholder">رسالة</span><span className="telegram-mic">●</span></div>
        </div>
        <div className="phone-home-indicator" />
      </div>
      <div className="preview-footnote"><span className="tiny-grip"><GripVertical size={13} /></span><span>{testMode ? 'هذه تجربة محلية للصفحات والقوائم الفرعية؛ لا تنفذ اتصالًا حقيقيًا بتيليجرام.' : 'اسحب أزرار الصفحة لترتيب صفوفها، أو فعّل تجربة التنقل لمعاينة الإجراء والرجوع.'}</span></div>
    </div>
  );
}
