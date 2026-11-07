import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpLeft,
  AudioLines,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  CloudUpload,
  Code2,
  Command,
  FileAudio2,
  FileImage,
  FileVideo2,
  FolderOpen,
  Grip,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  MoreHorizontal,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Trash2,
  TriangleAlert,
  Video,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { BotConfig, BotPatch, BotButton, ButtonBoard, ButtonType, KeyboardPreference, MediaType } from '@shared/types';
import { api } from './api';
import {
  boardWithButton,
  deleteButtonInBot,
  displayBotName,
  findButton,
  formatDate,
  formatFileSize,
  getButtonFromPath,
  isPreferenceMissing,
  moveButtonToRow,
  reorderButtonInManualPage,
  shortId,
  updateButtonInBot,
} from './utils';
import { Modal } from './components/Modal';
import { TelegramPreview } from './components/TelegramPreview';
import { MenuSettingsPanel } from './components/MenuSettingsPanel';

 type Section = 'start' | 'inline' | 'reply' | 'token';
 type Screen = 'dashboard' | 'builder';
 type Notice = { kind: 'success' | 'error'; message: string } | null;
 type DialogState =
  | { kind: 'button'; mode: 'create-root'; type: ButtonType }
  | { kind: 'button'; mode: 'create-child' }
  | { kind: 'button'; mode: 'edit'; buttonId: string }
  | { kind: 'confirm'; title: string; description: string; confirmLabel: string; run: () => Promise<void> }
  | null;

type MissingPreference = { target: 'start' } | { target: 'flow'; path: string[] };

const sectionMeta: Record<Section, { label: string; description: string }> = {
  start: { label: 'رسالة البداية', description: 'رسالة البوت عند إرسال /start' },
  inline: { label: 'أزرار Inline', description: 'أزرار تظهر أسفل الرسالة' },
  reply: { label: 'Reply Keyboard', description: 'أزرار تظهر في لوحة الكتابة' },
  token: { label: 'توكن البوت', description: 'تحقق من التوكن وابدأ polling' },
};

function sortButtonsByRows(board: ButtonBoard): BotButton[] {
  const lookup = new Map(board.buttons.map((button) => [button.id, button]));
  const seen = new Set<string>();
  const ordered = board.rows.flatMap((row) => row.flatMap((id) => {
    const button = lookup.get(id);
    if (!button || seen.has(id)) return [];
    seen.add(id);
    return [button];
  }));
  for (const button of board.buttons) if (!seen.has(button.id)) ordered.push(button);
  return ordered;
}

function collectButtonIds(button: BotButton): string[] {
  const ids = [button.id];
  for (const child of [...button.flow.inline.buttons, ...button.flow.reply.buttons]) {
    ids.push(...collectButtonIds(child));
  }
  return ids;
}

function findMissingPreference(bot: BotConfig): MissingPreference | null {
  if (bot.inline.buttons.length && bot.reply.buttons.length && !bot.startKeyboardPreference) {
    return { target: 'start' };
  }
  const walk = (board: ButtonBoard, path: string[]): MissingPreference | null => {
    for (const button of board.buttons) {
      const currentPath = [...path, button.id];
      if (button.flow.inline.buttons.length && button.flow.reply.buttons.length && !button.flow.keyboardPreference) {
        return { target: 'flow', path: currentPath };
      }
      const nested = walk(button.flow.inline, currentPath) ?? walk(button.flow.reply, currentPath);
      if (nested) return nested;
    }
    return null;
  };
  return walk(bot.inline, []) ?? walk(bot.reply, []);
}

function connectionLabel(bot: BotConfig): string {
  switch (bot.connection.state) {
    case 'connected': return 'متصل';
    case 'connecting': return 'جارٍ التحقق';
    case 'error': return 'تعذر الاتصال';
    default: return 'غير مرتبط';
  }
}

function ConnectionBadge({ bot }: { bot: BotConfig }) {
  const status = bot.connection.state;
  const icon = status === 'connected' ? <CheckCircle2 size={14} />
    : status === 'connecting' ? <Loader2 size={14} className="spin" />
      : status === 'error' ? <CircleAlert size={14} /> : <CircleDashed size={14} />;
  return <span className={`connection-badge connection-${status}`}>{icon}{connectionLabel(bot)}</span>;
}

function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  if (!notice) return null;
  const Icon = notice.kind === 'success' ? CheckCircle2 : CircleAlert;
  return (
    <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      <Icon size={17} />
      <span>{notice.message}</span>
      <button className="toast-close" type="button" onClick={onClose} aria-label="إغلاق الإشعار"><X size={15} /></button>
    </div>
  );
}

function EmptyBots({ onCreate, loading }: { onCreate: () => void; loading: boolean }) {
  return (
    <div className="empty-bots-card">
      <div className="empty-bots-art" aria-hidden="true">
        <div className="empty-orbit orbit-one" />
        <div className="empty-orbit orbit-two" />
        <div className="empty-bot-tile"><Bot size={29} strokeWidth={1.65} /></div>
        <span className="empty-spark spark-one"><Sparkles size={16} /></span>
        <span className="empty-spark spark-two"><Send size={17} /></span>
      </div>
      <div className="empty-bots-copy">
        <span className="eyebrow">مساحة العمل جاهزة</span>
        <h3>لا توجد بوتات بعد</h3>
        <p>ابدأ ببوت جديد، ثم أضف رسالة البداية والأزرار والتدفقات التي تريدها. لن نضيف أي محتوى إلى بوتك تلقائيًا.</p>
        <button className="button button-primary" type="button" onClick={onCreate} disabled={loading}>
          {loading ? <Loader2 size={17} className="spin" /> : <Plus size={18} />}
          إنشاء بوت جديد
          <ArrowRight size={15} className="rtl-arrow" />
        </button>
      </div>
    </div>
  );
}

function Dashboard({
  bots,
  loading,
  creating,
  error,
  onCreate,
  onOpen,
}: {
  bots: BotConfig[];
  loading: boolean;
  creating: boolean;
  error: string;
  onCreate: () => void;
  onOpen: (bot: BotConfig) => void;
}) {
  return (
    <main className="dashboard-page">
      <section className="dashboard-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span className="hero-kicker-dot" /> مساحة بناء بوتات تيليجرام</div>
          <h1>من فكرتك،<br /><span>إلى بوت يعمل.</span></h1>
          <p>صمّم الرسائل والأزرار وتدفقاتها بصريًا، ثم اربط بوت تيليجرام الحقيقي بتوكنك.</p>
          <button className="button button-primary hero-button" type="button" onClick={onCreate} disabled={creating}>
            {creating ? <Loader2 size={17} className="spin" /> : <Plus size={18} />}
            إنشاء بوت جديد
            <ArrowRight size={15} className="rtl-arrow" />
          </button>
          <div className="hero-security"><ShieldCheck size={15} /><span>إعداداتك محفوظة محليًا على الخادم</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-grid-lines" />
          <div className="hero-ring ring-large" />
          <div className="hero-ring ring-small" />
          <div className="hero-mini-card mini-card-top"><div className="mini-card-symbol"><MessageSquareText size={16} /></div><span className="mini-line line-short" /><span className="mini-line" /></div>
          <div className="hero-telegram-card">
            <div className="hero-phone-top"><span /><span /><span /></div>
            <div className="hero-preview-orb"><Send size={27} /></div>
            <div className="hero-empty-line line-wide" />
            <div className="hero-empty-line" />
            <div className="hero-button-outline"><span /><span /></div>
          </div>
          <div className="hero-mini-card mini-card-bottom"><div className="mini-card-symbol symbol-green"><Code2 size={16} /></div><span className="mini-line" /><span className="mini-line line-short" /></div>
          <div className="hero-float-dot dot-one" /><div className="hero-float-dot dot-two" />
        </div>
      </section>

      <section className="bots-section">
        <div className="bots-section-heading">
          <div>
            <span className="eyebrow">مساحة العمل</span>
            <h2>بوتاتي</h2>
            <p>كل بوت وإعداداته وتدفقاته في مساحة مستقلة.</p>
          </div>
          {bots.length > 0 && <span className="bots-count">{bots.length} {bots.length === 1 ? 'بوت' : 'بوتات'}</span>}
        </div>
        {error && <div className="inline-alert alert-error"><CircleAlert size={16} />{error}</div>}
        {loading ? (
          <div className="loading-card"><Loader2 size={22} className="spin" /><span>جارٍ تحميل بوتاتك…</span></div>
        ) : bots.length === 0 ? (
          <EmptyBots onCreate={onCreate} loading={creating} />
        ) : (
          <div className="bot-grid">
            {bots.map((bot) => (
              <button type="button" className="bot-card" key={bot.id} onClick={() => onOpen(bot)}>
                <span className="bot-card-top">
                  <span className="bot-card-icon"><Bot size={21} /></span>
                  <MoreHorizontal size={20} className="bot-card-more" />
                </span>
                <span className="bot-card-name">{displayBotName(bot)}</span>
                <span className="bot-card-id">معرّف المساحة · {shortId(bot.id)}</span>
                <span className="bot-card-footer">
                  <ConnectionBadge bot={bot} />
                  <span className="bot-card-date">تعديل {formatDate(bot.updatedAt)}</span>
                </span>
                {bot.connection.lastError && <span className="bot-card-error">{bot.connection.lastError}</span>}
              </button>
            ))}
            <button className="add-bot-card" type="button" onClick={onCreate} disabled={creating}>
              <span className="add-bot-icon"><Plus size={21} /></span>
              <strong>إنشاء بوت آخر</strong>
              <span>مساحة جديدة بإعدادات فارغة</span>
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function SectionNav({
  selected,
  bot,
  onSelect,
}: {
  selected: Section;
  bot: BotConfig;
  onSelect: (section: Section) => void;
}) {
  const items: Array<{ key: Section; icon: typeof MessageSquareText; completed: boolean }> = [
    { key: 'start', icon: MessageSquareText, completed: Boolean(bot.startMessage) },
    { key: 'inline', icon: Command, completed: bot.inline.buttons.length > 0 },
    { key: 'reply', icon: Smartphone, completed: bot.reply.buttons.length > 0 },
    { key: 'token', icon: KeyRound, completed: bot.connection.state === 'connected' },
  ];
  return (
    <nav className="editor-nav" aria-label="أقسام إعداد البوت">
      <span className="nav-section-label">إعداد البوت</span>
      {items.map(({ key, icon: Icon, completed }, index) => (
        <button
          className={`editor-nav-item ${selected === key ? 'active' : ''}`}
          type="button"
          key={key}
          onClick={() => onSelect(key)}
          aria-current={selected === key ? 'page' : undefined}
        >
          <span className="nav-item-icon"><Icon size={17} /></span>
          <span className="nav-item-text"><strong>{sectionMeta[key].label}</strong><small>{sectionMeta[key].description}</small></span>
          {completed ? <span className="nav-check"><Check size={12} /></span> : <span className="nav-index">0{index + 1}</span>}
        </button>
      ))}
    </nav>
  );
}

function PreferenceChooser({
  value,
  onChange,
  compact = false,
}: {
  value: KeyboardPreference | null;
  onChange: (value: KeyboardPreference) => void;
  compact?: boolean;
}) {
  return (
    <div className={`preference-chooser ${compact ? 'preference-compact' : ''}`}>
      <div className="preference-copy">
        <span className="preference-icon"><CircleHelp size={17} /></span>
        <div>
          <strong>أي لوحة تظهر مع هذه الرسالة؟</strong>
          <p>تيليجرام يعرض نوعًا واحدًا من لوحات الأزرار في الرسالة الواحدة. اختر ما يظهر أولًا.</p>
        </div>
      </div>
      <div className="preference-options" role="group" aria-label="اختر لوحة المفاتيح المعروضة">
        <button type="button" className={`preference-option ${value === 'inline' ? 'selected' : ''}`} onClick={() => onChange('inline')} aria-pressed={value === 'inline'}>
          <span className="preference-radio">{value === 'inline' && <i />}</span>
          <span><b>Inline</b><small>أسفل رسالة البوت</small></span>
        </button>
        <button type="button" className={`preference-option ${value === 'reply' ? 'selected' : ''}`} onClick={() => onChange('reply')} aria-pressed={value === 'reply'}>
          <span className="preference-radio">{value === 'reply' && <i />}</span>
          <span><b>Reply Keyboard</b><small>في لوحة الكتابة</small></span>
        </button>
      </div>
      {value && <span className="preference-saved"><CheckCircle2 size={13} /> الاختيار محفوظ</span>}
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {action}
    </div>
  );
}

function EmptyList({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-list-state">
      <span className="empty-list-icon"><FolderOpen size={21} /></span>
      <div><strong>{title}</strong><p>{description}</p></div>
    </div>
  );
}

function ButtonList({
  board,
  onOpen,
  onEdit,
  onDelete,
}: {
  board: ButtonBoard;
  onOpen: (button: BotButton) => void;
  onEdit: (button: BotButton) => void;
  onDelete: (button: BotButton) => void;
}) {
  const buttons = sortButtonsByRows(board);
  if (!buttons.length) return <EmptyList title="لا توجد أزرار هنا بعد" description="أضف زرًا عندما تكون مستعدًا. سيظهر في هذه القائمة وفي المحاكي." />;
  return (
    <div className="button-list">
      {buttons.map((button, index) => (
        <article className="button-list-item" key={button.id}>
          <span className="button-list-number">{String(index + 1).padStart(2, '0')}</span>
          <span className={`button-list-type-icon ${button.type}`}>
            {button.type === 'inline' ? <Command size={16} /> : <Smartphone size={16} />}
          </span>
          <span className="button-list-info"><strong>{button.label}</strong><small>تدفق مستقل · {button.flow.message ? 'رسالة محفوظة' : 'لا توجد رسالة'}</small></span>
          <div className="button-list-actions">
            <button className="button button-quiet button-small" type="button" onClick={() => onOpen(button)}><Code2 size={14} /> التدفق</button>
            <button className="icon-button" type="button" onClick={() => onEdit(button)} aria-label={`تعديل ${button.label}`} title="تعديل الزر"><Pencil size={15} /></button>
            <button className="icon-button danger-icon" type="button" onClick={() => onDelete(button)} aria-label={`حذف ${button.label}`} title="حذف الزر"><Trash2 size={15} /></button>
          </div>
        </article>
      ))}
    </div>
  );
}

function MediaTypeLabel({ type }: { type: MediaType }) {
  const details: Record<MediaType, { label: string; icon: typeof ImageIcon }> = {
    image: { label: 'صورة', icon: ImageIcon },
    video: { label: 'فيديو', icon: Video },
    voice: { label: 'تسجيل صوتي', icon: AudioLines },
    music: { label: 'مقطع موسيقي', icon: Music2 },
  };
  const Icon = details[type].icon;
  return <span className={`media-kind media-kind-${type}`}><Icon size={14} />{details[type].label}</span>;
}

export default function App() {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [loadingBots, setLoadingBots] = useState(true);
  const [creatingBot, setCreatingBot] = useState(false);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [section, setSection] = useState<Section>('start');
  const [flowPath, setFlowPath] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [saving, setSaving] = useState(false);
  const [startDraft, setStartDraft] = useState('');
  const [flowDraft, setFlowDraft] = useState('');
  const [buttonLabelDraft, setButtonLabelDraft] = useState('');
  const [newChildType, setNewChildType] = useState<ButtonType | ''>('');
  const [buttonFormError, setButtonFormError] = useState('');
  const [startError, setStartError] = useState('');
  const [flowError, setFlowError] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [mediaTypeDraft, setMediaTypeDraft] = useState<MediaType | null>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [dirtyDrafts, setDirtyDrafts] = useState<Record<string, boolean>>({});
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const startDraftCache = useRef(new Map<string, string>());
  const flowDraftCache = useRef(new Map<string, string>());
  const activeBot = bots.find((bot) => bot.id === activeBotId) ?? null;
  const activeFlowKey = flowPath.join('/');
  const currentButton = activeBot && flowPath.length ? getButtonFromPath(activeBot, flowPath) : null;
  const startIsDirty = Boolean(activeBot && startDraft !== (activeBot.startMessage ?? ''));
  const flowIsDirty = Boolean(currentButton && flowDraft !== (currentButton.flow.message ?? ''));
  const selectedRootButton = activeBot && flowPath.length ? findButton(activeBot, flowPath[0]) : null;
  const selectedRootType = selectedRootButton?.type ?? section;
  const unresolvedPreference = activeBot ? isPreferenceMissing(activeBot) : false;
  const hasUnsavedDrafts = Object.values(dirtyDrafts).some(Boolean);
  const setDraftDirty = (key: string, isDirty: boolean) => {
    setDirtyDrafts((current) => {
      if (current[key] === isDirty) return current;
      const next = { ...current };
      if (isDirty) next[key] = true;
      else delete next[key];
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    api.listBots()
      .then((items) => { if (!cancelled) setBots(items); })
      .catch((error: unknown) => {
        if (!cancelled) setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'تعذر تحميل البوتات.' });
      })
      .finally(() => { if (!cancelled) setLoadingBots(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === 'error' ? 6500 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!hasUnsavedDrafts) return;
    const warnBeforeExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeExit);
    return () => window.removeEventListener('beforeunload', warnBeforeExit);
  }, [hasUnsavedDrafts]);

  useEffect(() => {
    if (activeBot) setStartDraft(startDraftCache.current.get(activeBot.id) ?? activeBot.startMessage ?? '');
    setStartError('');
    setTokenError('');
    setTokenDraft('');
    setTokenVisible(false);
  }, [activeBot?.id]);

  useEffect(() => {
    const draftKey = activeBot && currentButton ? `${activeBot.id}:${currentButton.id}` : null;
    setFlowDraft(draftKey && flowDraftCache.current.has(draftKey)
      ? flowDraftCache.current.get(draftKey) ?? ''
      : currentButton?.flow.message ?? '');
    setFlowError('');
    setMediaError('');
    setMediaTypeDraft(null);
  }, [activeBot?.id, activeFlowKey]);

  useEffect(() => {
    if (screen !== 'builder' || !activeBotId) return;
    const timer = window.setInterval(() => {
      api.getBot(activeBotId).then((fresh) => {
        setBots((current) => current.map((bot) => bot.id === fresh.id ? fresh : bot));
      }).catch(() => undefined);
    }, 12000);
    return () => window.clearInterval(timer);
  }, [screen, activeBotId]);

  const updateBotInList = (next: BotConfig) => {
    setBots((current) => {
      const exists = current.some((bot) => bot.id === next.id);
      return exists ? current.map((bot) => bot.id === next.id ? next : bot) : [...current, next];
    });
  };

  const persistPatch = async (patch: BotPatch, successMessage?: string): Promise<BotConfig | null> => {
    if (!activeBotId) return null;
    setSaving(true);
    try {
      const updated = await api.updateBot(activeBotId, patch);
      updateBotInList(updated);
      if (successMessage) setNotice({ kind: 'success', message: successMessage });
      return updated;
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'لم يتم حفظ التغييرات.' });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveBoardMenuSettings = async (type: ButtonType, board: ButtonBoard): Promise<boolean> => {
    if (!activeBot) return false;
    let updated: BotConfig | null;
    if (currentButton) {
      const next = updateButtonInBot(activeBot, currentButton.id, (button) => ({
        ...button,
        flow: { ...button.flow, [type]: board },
      }));
      updated = await persistPatch({ inline: next.inline, reply: next.reply }, 'تم حفظ إعدادات الصفحات والتنقل.');
    } else {
      updated = await persistPatch({ [type]: board }, 'تم حفظ إعدادات الصفحات والتنقل.');
    }
    return Boolean(updated);
  };

  const createBot = async () => {
    if (creatingBot) return;
    setCreatingBot(true);
    try {
      const bot = await api.createBot();
      updateBotInList(bot);
      setActiveBotId(bot.id);
      setScreen('builder');
      setSection('start');
      setFlowPath([]);
      setNotice({ kind: 'success', message: 'تم إنشاء مساحة بوت فارغة وجاهزة للإعداد.' });
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'تعذر إنشاء البوت.' });
    } finally {
      setCreatingBot(false);
    }
  };

  const openBot = async (bot: BotConfig) => {
    setActiveBotId(bot.id);
    setScreen('builder');
    setSection('start');
    setFlowPath([]);
    try {
      const fresh = await api.getBot(bot.id);
      updateBotInList(fresh);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'تعذر تحميل إعدادات البوت.' });
    }
  };

  const returnToDashboard = () => {
    setScreen('dashboard');
    setActiveBotId(null);
    setFlowPath([]);
    setDialog(null);
  };

  const saveStartMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!startDraft.trim()) {
      setStartError('أدخل نصًا قبل الحفظ.');
      return;
    }
    setStartError('');
    const updated = await persistPatch({ startMessage: startDraft }, 'تم حفظ رسالة البداية.');
    if (updated) {
      const saved = updated.startMessage ?? '';
      setStartDraft(saved);
      startDraftCache.current.set(updated.id, saved);
      setDraftDirty(`start:${updated.id}`, false);
    }
  };

  const saveFlowMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeBot || !currentButton) return;
    if (!flowDraft.trim()) {
      setFlowError('أدخل نصًا قبل الحفظ.');
      return;
    }
    setFlowError('');
    const next = updateButtonInBot(activeBot, currentButton.id, (button) => ({
      ...button,
      flow: { ...button.flow, message: flowDraft },
    }));
    const updated = await persistPatch({ inline: next.inline, reply: next.reply }, 'تم حفظ رسالة التدفق.');
    if (updated) {
      const key = `${updated.id}:${currentButton.id}`;
      flowDraftCache.current.set(key, flowDraft);
      setFlowDraft(flowDraft);
      setDraftDirty(`flow:${key}`, false);
    }
  };

  const openCreateRootButton = (type: ButtonType) => {
    setButtonLabelDraft('');
    setNewChildType('');
    setButtonFormError('');
    setDialog({ kind: 'button', mode: 'create-root', type });
  };

  const openCreateChildButton = () => {
    setButtonLabelDraft('');
    setNewChildType('');
    setButtonFormError('');
    setDialog({ kind: 'button', mode: 'create-child' });
  };

  const openEditButton = (button: BotButton) => {
    setButtonLabelDraft(button.label);
    setNewChildType(button.type);
    setButtonFormError('');
    setDialog({ kind: 'button', mode: 'edit', buttonId: button.id });
  };

  const saveButton = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'button' || !activeBot) return;
    if (!buttonLabelDraft.trim()) {
      setButtonFormError('اكتب اسمًا للزر قبل الحفظ.');
      return;
    }
    if (dialog.mode === 'create-child' && !newChildType) {
      setButtonFormError('اختر نوع الزر الفرعي.');
      return;
    }
    setButtonFormError('');
    let updated: BotConfig | null = null;

    if (dialog.mode === 'create-root') {
      const type = dialog.type;
      const board = activeBot[type];
      const button: BotButton = {
        id: crypto.randomUUID(),
        label: buttonLabelDraft,
        type,
        flow: {
          message: null,
          media: [],
          inline: { buttons: [], rows: [] },
          reply: { buttons: [], rows: [] },
          keyboardPreference: null,
        },
      };
      updated = await persistPatch({ [type]: boardWithButton(board, button) }, 'تم إنشاء الزر.');
    } else if (dialog.mode === 'create-child') {
      const parent = getButtonFromPath(activeBot, flowPath);
      if (!parent || !newChildType) return;
      const type = newChildType;
      const button: BotButton = {
        id: crypto.randomUUID(),
        label: buttonLabelDraft,
        type,
        flow: {
          message: null,
          media: [],
          inline: { buttons: [], rows: [] },
          reply: { buttons: [], rows: [] },
          keyboardPreference: null,
        },
      };
      const next = updateButtonInBot(activeBot, parent.id, (current) => ({
        ...current,
        flow: { ...current.flow, [type]: boardWithButton(current.flow[type], button) },
      }));
      updated = await persistPatch({ inline: next.inline, reply: next.reply }, 'تم إنشاء الزر الفرعي.');
    } else {
      const target = findButton(activeBot, dialog.buttonId);
      if (!target) return;
      const next = updateButtonInBot(activeBot, dialog.buttonId, (button) => ({ ...button, label: buttonLabelDraft }));
      updated = await persistPatch({ inline: next.inline, reply: next.reply }, 'تم تحديث اسم الزر.');
    }

    if (updated) setDialog(null);
  };

  const askDeleteButton = (button: BotButton) => {
    setDialog({
      kind: 'confirm',
      title: 'حذف هذا الزر؟',
      description: `سيُحذف «${button.label}» مع رسالته ووسائطه وأزراره الفرعية وتدفقاته المتداخلة. لا يمكن التراجع عن هذا الحذف.`,
      confirmLabel: 'نعم، احذف الزر وتوابعه',
      run: async () => {
        if (!activeBot) return;
        const next = deleteButtonInBot(activeBot, button.id);
        const updated = await persistPatch({ inline: next.inline, reply: next.reply }, 'تم حذف الزر وتدفقاته التابعة.');
        if (updated) {
          const deletedIds = collectButtonIds(button);
          for (const deletedId of deletedIds) flowDraftCache.current.delete(`${updated.id}:${deletedId}`);
          setDirtyDrafts((current) => {
            const next = { ...current };
            for (const deletedId of deletedIds) delete next[`flow:${updated.id}:${deletedId}`];
            return next;
          });
          setFlowPath((path) => path.filter((id) => !deletedIds.includes(id)));
          setDialog(null);
        }
      },
    });
  };

  const askDeleteStart = () => {
    setDialog({
      kind: 'confirm',
      title: 'حذف رسالة البداية؟',
      description: 'ستُحذف رسالة /start المحفوظة فقط. ستبقى الأزرار وإعداداتها كما هي، لكن البوت لن يرسل ردًا على /start إلى أن تحفظ رسالة جديدة.',
      confirmLabel: 'نعم، احذف الرسالة',
      run: async () => {
        const updated = await persistPatch({ startMessage: null }, 'تم حذف رسالة البداية.');
        if (updated) {
          setStartDraft('');
          startDraftCache.current.set(updated.id, '');
          setDraftDirty(`start:${updated.id}`, false);
          setDialog(null);
        }
      },
    });
  };

  const askDeleteFlowMessage = () => {
    if (!activeBot || !currentButton) return;
    setDialog({
      kind: 'confirm',
      title: 'حذف رسالة التدفق؟',
      description: 'سيُحذف نص الرسالة فقط. ستبقى الوسائط والأزرار الفرعية المحفوظة في هذا التدفق دون تغيير.',
      confirmLabel: 'نعم، احذف النص',
      run: async () => {
        const next = updateButtonInBot(activeBot, currentButton.id, (button) => ({
          ...button,
          flow: { ...button.flow, message: null },
        }));
        const updated = await persistPatch({ inline: next.inline, reply: next.reply }, 'تم حذف نص الرسالة.');
        if (updated) {
          setFlowDraft('');
          const key = `${updated.id}:${currentButton.id}`;
          flowDraftCache.current.set(key, '');
          setDraftDirty(`flow:${key}`, false);
          setDialog(null);
        }
      },
    });
  };

  const askDeleteMedia = (mediaId: string, name: string) => {
    setDialog({
      kind: 'confirm',
      title: 'حذف ملف الوسائط؟',
      description: `سيُحذف الملف «${name}» من هذا التدفق ومن التخزين المحلي.`,
      confirmLabel: 'نعم، احذف الملف',
      run: async () => {
        if (!activeBot) return;
        try {
          const updated = await api.deleteMedia(activeBot.id, mediaId);
          updateBotInList(updated);
          setNotice({ kind: 'success', message: 'تم حذف ملف الوسائط.' });
          setDialog(null);
        } catch (error) {
          setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'تعذر حذف الوسائط.' });
        }
      },
    });
  };

  const changeRootPreference = async (value: KeyboardPreference) => {
    await persistPatch({ startKeyboardPreference: value }, 'تم حفظ طريقة عرض لوحة البداية.');
  };

  const changeFlowPreference = async (value: KeyboardPreference) => {
    if (!activeBot || !currentButton) return;
    const next = updateButtonInBot(activeBot, currentButton.id, (button) => ({
      ...button,
      flow: { ...button.flow, keyboardPreference: value },
    }));
    await persistPatch({ inline: next.inline, reply: next.reply }, 'تم حفظ طريقة عرض اللوحة في هذا التدفق.');
  };

  const reorderPreviewButtons = async (
    type: ButtonType,
    buttonId: string,
    rowIndex: number,
    beforeButtonId?: string,
    forceNewRow = false,
    pageId?: string,
  ) => {
    if (!activeBot) return;
    const reorder = (board: ButtonBoard) => pageId && board.menuSettings?.pageMode === 'manual'
      ? reorderButtonInManualPage(board, pageId, buttonId, rowIndex, beforeButtonId, forceNewRow)
      : moveButtonToRow(board, buttonId, rowIndex, beforeButtonId, forceNewRow);
    if (currentButton) {
      const next = updateButtonInBot(activeBot, currentButton.id, (button) => ({
        ...button,
        flow: { ...button.flow, [type]: reorder(button.flow[type]) },
      }));
      await persistPatch({ inline: next.inline, reply: next.reply });
    } else {
      await persistPatch({ [type]: reorder(activeBot[type]) });
    }
  };

  const openButtonFlow = (button: BotButton) => {
    setFlowPath((path) => path.length ? [...path, button.id] : [button.id]);
    if (!flowPath.length) setSection(button.type);
  };

  const openButtonById = (buttonId: string) => {
    if (!activeBot) return;
    const button = findButton(activeBot, buttonId);
    if (button) openButtonFlow(button);
  };

  const openTokenPreference = () => {
    if (!activeBot) return;
    const missing = findMissingPreference(activeBot);
    if (!missing) return;
    if (missing.target === 'start') {
      setFlowPath([]);
      setSection('start');
      return;
    }
    const rootButton = findButton(activeBot, missing.path[0]);
    setSection(rootButton?.type ?? 'inline');
    setFlowPath(missing.path);
  };

  const uploadSelectedMedia = async (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (!mediaTypeDraft) {
      setMediaError('اختر نوع الوسائط قبل اختيار الملف.');
      input.value = '';
      return;
    }
    if (!activeBot || !currentButton) return;
    setUploadingMedia(true);
    setMediaError('');
    try {
      const updated = await api.uploadMedia(activeBot.id, currentButton.id, mediaTypeDraft, file);
      updateBotInList(updated);
      setNotice({ kind: 'success', message: 'تم رفع الوسائط وربطها بالتدفق.' });
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'تعذر رفع الملف. يمكنك إعادة المحاولة.');
    } finally {
      setUploadingMedia(false);
      input.value = '';
    }
  };

  const connectBot = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeBot) return;
    setTokenError('');
    if (!tokenDraft.trim()) {
      setTokenError('أدخل توكن البوت قبل الربط.');
      return;
    }
    if (unresolvedPreference) {
      setTokenError('اختر لوحة المفاتيح التي ستظهر عند وجود النوعين قبل الربط.');
      return;
    }
    setConnecting(true);
    try {
      const updated = await api.connectBot(activeBot.id, tokenDraft);
      updateBotInList(updated);
      setTokenDraft('');
      setNotice({ kind: 'success', message: `تم التحقق من التوكن وربط ${displayBotName(updated)} بنجاح.` });
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : 'تعذر ربط البوت. تحقق من التوكن وحاول مجددًا.');
    } finally {
      setConnecting(false);
    }
  };

  const confirmDialog = dialog?.kind === 'confirm' ? dialog : null;
  const buttonDialog = dialog?.kind === 'button' ? dialog : null;
  const [confirming, setConfirming] = useState(false);

  const currentPreviewButton = currentButton;
  const currentFlowNeedsChoice = Boolean(currentButton
    && currentButton.flow.inline.buttons.length
    && currentButton.flow.reply.buttons.length
    && !currentButton.flow.keyboardPreference);

  return (
    <div className="app-shell min-h-screen bg-paper font-sans text-ink" dir="rtl">
      <header className="topbar">
        <button type="button" className="brand-lockup" onClick={returnToDashboard} aria-label="العودة إلى بوتاتي">
          <span className="brand-mark"><Send size={17} fill="currentColor" /></span>
          <span className="brand-name">botmakers<span>.</span></span>
        </button>
        <div className="topbar-right">
          {screen === 'builder' && saving && <span className="saving-indicator"><Loader2 size={14} className="spin" /> جارٍ الحفظ</span>}
          <span className="local-indicator"><span /> مساحة محلية · بلا تسجيل دخول</span>
          <button className="topbar-help" type="button" title="مساعدة"><CircleHelp size={17} /></button>
        </div>
      </header>

      <Toast notice={notice} onClose={() => setNotice(null)} />

      {screen === 'dashboard' ? (
        <Dashboard
          bots={bots}
          loading={loadingBots}
          creating={creatingBot}
          error={notice?.kind === 'error' ? notice.message : ''}
          onCreate={() => void createBot()}
          onOpen={(bot) => void openBot(bot)}
        />
      ) : activeBot ? (
        <div className="builder-shell">
          <aside className="editor-sidebar">
            <button className="sidebar-back" type="button" onClick={returnToDashboard}><ArrowDownLeft size={16} /> كل البوتات</button>
            <div className="workspace-summary">
              <span className="workspace-bot-icon"><Bot size={19} /></span>
              <div className="workspace-summary-copy"><span>أنت تعدّل الآن</span><strong>{displayBotName(activeBot)}</strong></div>
              <ChevronDown size={15} className="workspace-chevron" />
            </div>
            <SectionNav selected={flowPath.length ? selectedRootType : section} bot={activeBot} onSelect={(next) => { setFlowPath([]); setSection(next); }} />
            <div className="sidebar-bottom">
              <div className="sidebar-help-card"><span className="help-card-icon"><ShieldCheck size={16} /></span><div><strong>مساحة مستقلة</strong><small>إعدادات كل بوت محفوظة وحدها.</small></div></div>
              <button className="sidebar-create-another" type="button" onClick={() => void createBot()} disabled={creatingBot}>
                <Plus size={16} /> إنشاء بوت آخر
              </button>
            </div>
          </aside>

          <main className="editor-main">
            <div className="editor-topline">
              <div className="editor-breadcrumbs">
                <button type="button" onClick={returnToDashboard}>بوتاتي</button><ChevronLeft size={14} />
                {flowPath.length ? (
                  <><button type="button" onClick={() => { setFlowPath([]); setSection(selectedRootType); }}>{sectionMeta[selectedRootType].label}</button><ChevronLeft size={14} /><span>{currentButton?.label || 'تدفق الزر'}</span></>
                ) : <span>{sectionMeta[section].label}</span>}
              </div>
              <div className="editor-topline-right"><ConnectionBadge bot={activeBot} /><button className="icon-button" type="button" title="خيارات البوت" aria-label="خيارات البوت"><MoreHorizontal size={18} /></button></div>
            </div>

            {flowPath.length > 0 && currentButton ? (
              <>
                <div className="flow-page-heading">
                  <button className="back-link" type="button" onClick={() => {
                    if (flowPath.length > 1) setFlowPath((path) => path.slice(0, -1));
                    else { setFlowPath([]); setSection(selectedRootType); }
                  }}><ArrowRight size={15} /> رجوع</button>
                  <span className="eyebrow">محرر التدفق · {currentButton.type === 'inline' ? 'Inline' : 'Reply Keyboard'}</span>
                  <h1>{currentButton.label}</h1>
                  <p>حدّد ما يراه المستخدم عند الضغط على هذا الزر. كل تغيير محفوظ يرتبط بهذا التدفق فقط.</p>
                </div>

                <section className="editor-panel flow-message-panel">
                  <div className="panel-heading-row">
                    <div className="panel-title-with-icon"><span className="panel-icon panel-icon-blue"><MessageSquareText size={17} /></span><div><h2>الرسالة</h2><p>نص اختياري يظهر عند الضغط على الزر.</p></div></div>
                    {flowIsDirty && <span className="unsaved-badge"><CircleAlert size={13} /> غير محفوظ</span>}
                    {currentButton.flow.message && <button type="button" className="text-button danger-text" onClick={askDeleteFlowMessage}><Trash2 size={14} /> حذف الرسالة</button>}
                  </div>
                  <form onSubmit={(event) => void saveFlowMessage(event)}>
                    <label className="field-label" htmlFor="flow-message">نص الرسالة</label>
                    <textarea id="flow-message" className="text-area" rows={5} value={flowDraft} onChange={(event) => {
                      const value = event.target.value;
                      setFlowDraft(value);
                      setFlowError('');
                      const key = `${activeBot.id}:${currentButton.id}`;
                      flowDraftCache.current.set(key, value);
                      setDraftDirty(`flow:${key}`, value !== (currentButton.flow.message ?? ''));
                    }} placeholder="اكتب الرسالة التي تظهر بعد الضغط على الزر" />
                    {flowError && <p className="field-error"><CircleAlert size={14} />{flowError}</p>}
                    <div className="form-actions"><span className="field-hint">لن تُرسل الرسالة قبل حفظها.</span><button className="button button-primary" type="submit" disabled={saving}>{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} حفظ الرسالة</button></div>
                  </form>
                </section>

                <section className="editor-panel media-panel">
                  <div className="panel-heading-row">
                    <div className="panel-title-with-icon"><span className="panel-icon panel-icon-violet"><FolderOpen size={17} /></span><div><h2>الوسائط</h2><p>أضف صورًا أو فيديو أو صوتًا إلى هذا التدفق.</p></div></div>
                    <span className="count-pill">{currentButton.flow.media.length} ملف</span>
                  </div>
                  <div className="media-type-picker">
                    <span className="field-label">اختر نوع الوسائط أولًا</span>
                    <div className="media-type-grid">
                      {([
                        ['image', 'صورة', ImageIcon],
                        ['video', 'فيديو', Video],
                        ['voice', 'تسجيل صوتي', AudioLines],
                        ['music', 'مقطع موسيقي', Music2],
                      ] as const).map(([type, label, Icon]) => (
                        <button key={type} type="button" className={`media-type-choice ${mediaTypeDraft === type ? 'selected' : ''}`} onClick={() => { setMediaTypeDraft(type); setMediaError(''); }} aria-pressed={mediaTypeDraft === type}>
                          <Icon size={17} /><span>{label}</span>{mediaTypeDraft === type && <Check size={13} className="media-choice-check" />}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input ref={uploadInputRef} className="visually-hidden" type="file" accept={mediaTypeDraft === 'image' ? 'image/*' : mediaTypeDraft === 'video' ? 'video/*' : mediaTypeDraft ? 'audio/*' : undefined} onChange={(event) => void uploadSelectedMedia(event)} />
                  <button className="upload-dropzone" type="button" onClick={() => uploadInputRef.current?.click()} disabled={!mediaTypeDraft || uploadingMedia}>
                    <span className="upload-icon">{uploadingMedia ? <Loader2 size={19} className="spin" /> : <CloudUpload size={20} />}</span>
                    <span><strong>{uploadingMedia ? 'جارٍ رفع الملف…' : 'اختر ملفًا من جهازك'}</strong><small>صورة أو فيديو أو ملف صوتي حسب النوع المحدد · الحد التشغيلي 50 م.ب</small></span>
                    <span className="button button-quiet button-small">{uploadingMedia ? 'يرفع…' : 'اختيار ملف'}</span>
                  </button>
                  {mediaError && <p className="field-error"><CircleAlert size={14} />{mediaError}</p>}
                  {currentButton.flow.media.length ? (
                    <div className="media-file-list">
                      {currentButton.flow.media.map((media, index) => (
                        <div className="media-file-row" key={media.id}>
                          <span className="media-file-number">{String(index + 1).padStart(2, '0')}</span>
                          <span className="media-file-icon">{media.type === 'image' ? <FileImage size={18} /> : media.type === 'video' ? <FileVideo2 size={18} /> : <FileAudio2 size={18} />}</span>
                          <div className="media-file-info"><strong>{media.name}</strong><span><MediaTypeLabel type={media.type} /> <i /> {formatFileSize(media.size)}</span></div>
                          <button className="icon-button danger-icon" type="button" onClick={() => askDeleteMedia(media.id, media.name)} title="حذف الوسائط" aria-label={`حذف ${media.name}`}><Trash2 size={15} /></button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyList title="لا توجد وسائط في هذا التدفق" description="الملف الذي ترفعه هنا يرتبط بهذا الزر وحده." />
                  )}
                </section>

                {currentFlowNeedsChoice && <PreferenceChooser value={currentButton.flow.keyboardPreference} onChange={(value) => void changeFlowPreference(value)} compact />}
                {!currentButton.flow.message && currentButton.flow.media.length === 0 && (currentButton.flow.inline.buttons.length > 0 || currentButton.flow.reply.buttons.length > 0) && (
                  <div className="inline-alert alert-warning"><TriangleAlert size={16} /><span>تيليجرام يحتاج رسالة أو وسيطًا ليعرض لوحة الأزرار في هذا التدفق. الأزرار محفوظة، ولن يُرسل النظام نصًا افتراضيًا.</span></div>
                )}

                <section className="editor-panel child-buttons-panel">
                  <div className="panel-heading-row">
                    <div className="panel-title-with-icon"><span className="panel-icon panel-icon-green"><Code2 size={17} /></span><div><h2>الأزرار الفرعية</h2><p>يمكن لكل زر فرعي امتلاك رسالة ووسائط وتدفقات أخرى.</p></div></div>
                    <button className="button button-primary button-small" type="button" onClick={openCreateChildButton}><Plus size={16} /> إضافة زر فرعي</button>
                  </div>
                  <div className="child-board-group">
                    <div className="child-board-heading"><span className="child-type-mark inline-mark"><Command size={14} /></span><h3>Inline</h3><span className="count-pill">{currentButton.flow.inline.buttons.length}</span></div>
                    <MenuSettingsPanel board={currentButton.flow.inline} type="inline" onSave={(board) => saveBoardMenuSettings('inline', board)} />
                    <ButtonList board={currentButton.flow.inline} onOpen={openButtonFlow} onEdit={openEditButton} onDelete={askDeleteButton} />
                  </div>
                  <div className="child-board-group">
                    <div className="child-board-heading"><span className="child-type-mark reply-mark"><Smartphone size={14} /></span><h3>Reply Keyboard</h3><span className="count-pill">{currentButton.flow.reply.buttons.length}</span></div>
                    <MenuSettingsPanel board={currentButton.flow.reply} type="reply" onSave={(board) => saveBoardMenuSettings('reply', board)} />
                    <ButtonList board={currentButton.flow.reply} onOpen={openButtonFlow} onEdit={openEditButton} onDelete={askDeleteButton} />
                  </div>
                </section>
              </>
            ) : flowPath.length > 0 ? (
              <div className="not-found-card"><CircleAlert size={20} /><div><strong>تعذر العثور على التدفق</strong><p>ربما حُذف الزر الذي كان مفتوحًا.</p><button className="text-button" type="button" onClick={() => setFlowPath([])}>العودة إلى إعداد البوت</button></div></div>
            ) : section === 'start' ? (
              <>
                <SectionHeading eyebrow="رسالة /start" title="رسالة البداية" description="هذه هي الرسالة التي يرسلها البوت عندما يبدأ المستخدم المحادثة." />
                <section className="editor-panel start-editor-panel">
                  <div className="panel-heading-row">
                    <div className="panel-title-with-icon"><span className="panel-icon panel-icon-blue"><MessageSquareText size={17} /></span><div><h2>نص رسالة البداية</h2><p>لا توجد رسالة محفوظة تلقائيًا.</p></div></div>
                    {startIsDirty ? <span className="unsaved-badge"><CircleAlert size={13} /> تعديلات غير محفوظة</span> : activeBot.startMessage && <span className="saved-badge"><CheckCircle2 size={13} /> محفوظة</span>}
                  </div>
                  <form onSubmit={(event) => void saveStartMessage(event)}>
                    <label className="field-label" htmlFor="start-message">قم بإدخال رسالة البداية</label>
                    <textarea id="start-message" className="text-area start-text-area" rows={7} value={startDraft} onChange={(event) => {
                      const value = event.target.value;
                      setStartDraft(value);
                      setStartError('');
                      startDraftCache.current.set(activeBot.id, value);
                      setDraftDirty(`start:${activeBot.id}`, value !== (activeBot.startMessage ?? ''));
                    }} placeholder="اكتب رسالة البداية التي تريد أن تظهر للمستخدم عند إرسال /start" />
                    {startError && <p className="field-error"><CircleAlert size={14} />{startError}</p>}
                    <div className="form-actions"><span className="field-hint">يحفظ النص كما أدخلته، ولا يُرسل إلى تيليجرام قبل الضغط على حفظ.</span><div className="form-action-buttons">{activeBot.startMessage && <button type="button" className="text-button danger-text" onClick={askDeleteStart}><Trash2 size={14} /> حذف</button>}<button className="button button-primary" type="submit" disabled={saving}>{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} حفظ</button></div></div>
                  </form>
                </section>
                {activeBot.inline.buttons.length > 0 && activeBot.reply.buttons.length > 0 && (
                  <PreferenceChooser value={activeBot.startKeyboardPreference} onChange={(value) => void changeRootPreference(value)} />
                )}
                <div className="note-card note-card-blue"><span className="note-card-icon"><CircleHelp size={17} /></span><p>بعد حفظ الرسالة، ينعكس النص في المحاكي. لا يرسل البوت أي محتوى افتراضي أو تجريبي.</p></div>
              </>
            ) : section === 'inline' || section === 'reply' ? (
              <>
                <SectionHeading
                  eyebrow={section === 'inline' ? 'لوحة الأزرار' : 'لوحة الكتابة'}
                  title={section === 'inline' ? 'أزرار Inline' : 'أزرار Reply Keyboard'}
                  description={section === 'inline' ? 'أنشئ أزرارًا تظهر أسفل رسائل البوت، وافتح تدفقًا مستقلًا لكل زر.' : 'أنشئ أزرارًا تظهر في لوحة الكتابة، وافتح تدفقًا مستقلًا لكل زر.'}
                  action={<button className="button button-primary" type="button" onClick={() => openCreateRootButton(section)}><Plus size={17} /> إضافة زر {section === 'inline' ? 'Inline' : 'Reply Keyboard'}</button>}
                />
                <section className="editor-panel button-section-panel">
                  <div className="panel-heading-row"><div className="panel-title-with-icon"><span className={`panel-icon ${section === 'inline' ? 'panel-icon-blue' : 'panel-icon-green'}`}>{section === 'inline' ? <Command size={17} /> : <Smartphone size={17} />}</span><div><h2>{section === 'inline' ? 'قائمة أزرار Inline' : 'قائمة Reply Keyboard'}</h2><p>الترتيب في هذه القائمة يطابق ترتيب المحاكي.</p></div></div><span className="count-pill">{activeBot[section].buttons.length} زر</span></div>
                  <MenuSettingsPanel board={activeBot[section]} type={section} onSave={(board) => saveBoardMenuSettings(section, board)} />
                  <ButtonList board={activeBot[section]} onOpen={openButtonFlow} onEdit={openEditButton} onDelete={askDeleteButton} />
                </section>
                <div className="note-card"><span className="note-card-icon"><Grip size={17} /></span><p>غيّر ترتيب الأزرار أو اجمعها في صفوف بالسحب والإفلات داخل محاكي تيليجرام.</p></div>
              </>
            ) : (
              <>
                <SectionHeading eyebrow="اتصال تيليجرام" title="توكن البوت" description="تحقق من التوكن لبدء استقبال التحديثات عبر Telegram Bot API Polling." />
                <section className="editor-panel token-panel">
                  <div className="token-connection-head">
                    <span className={`token-status-icon ${activeBot.connection.state}`}>
                      {activeBot.connection.state === 'connected' ? <CheckCircle2 size={22} /> : activeBot.connection.state === 'connecting' ? <Loader2 size={22} className="spin" /> : activeBot.connection.state === 'error' ? <CircleAlert size={22} /> : <Link2 size={21} />}
                    </span>
                    <div><span className="eyebrow">حالة الاتصال</span><h2>{connectionLabel(activeBot)}</h2><p>{activeBot.connection.username ? `@${activeBot.connection.username}` : 'لم يتم ربط توكن بهذا البوت بعد.'}</p></div>
                    <ConnectionBadge bot={activeBot} />
                  </div>
                  {activeBot.connection.lastError && <div className="inline-alert alert-error"><CircleAlert size={16} />{activeBot.connection.lastError}</div>}
                  {activeBot.connection.state === 'connected' && activeBot.connection.username && (
                    <a className="telegram-account-link" href={`https://t.me/${encodeURIComponent(activeBot.connection.username)}`} target="_blank" rel="noreferrer"><Send size={15} /> فتح البوت في تيليجرام <ArrowUpLeft size={14} /></a>
                  )}
                  <form className="token-form" onSubmit={(event) => void connectBot(event)}>
                    <label className="field-label" htmlFor="telegram-token">{activeBot.connection.state === 'connected' ? 'إدخال توكن جديد' : 'أدخل توكن البوت'}</label>
                    <div className="token-input-wrap">
                      <LockKeyhole size={17} className="token-lock" />
                      <input id="telegram-token" type={tokenVisible ? 'text' : 'password'} className="text-input token-input" value={tokenDraft} onChange={(event) => { setTokenDraft(event.target.value); setTokenError(''); }} placeholder="الصق التوكن الذي أنشأته عبر @BotFather" autoComplete="new-password" dir="ltr" />
                      <button className="token-visibility" type="button" onClick={() => setTokenVisible((visible) => !visible)} aria-label={tokenVisible ? 'إخفاء التوكن' : 'إظهار التوكن'}>{tokenVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                    </div>
                    {tokenError && <p className="field-error"><CircleAlert size={14} />{tokenError}</p>}
                    <p className="token-help">تحتاج إلى بوت أنشأته عبر <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>. لا يُقبل التوكن إلا بعد التحقق منه عبر تيليجرام.</p>
                    {unresolvedPreference && (
                      <div className="inline-alert alert-warning"><TriangleAlert size={16} /><span>اختر لوحة المفاتيح التي ستظهر عند اجتماع النوعين قبل الربط.</span><button type="button" className="text-button" onClick={openTokenPreference}>فتح الاختيار</button></div>
                    )}
                    {!activeBot.startMessage && <div className="inline-alert alert-warning"><TriangleAlert size={16} /><span>لم تحفظ رسالة بداية. سيتم التحقق من الربط، لكن /start لن يرسل ردًا حتى تحفظ رسالة.</span></div>}
                    <button className="button button-primary connect-button" type="submit" disabled={connecting || saving || !tokenDraft.trim() || unresolvedPreference}>
                      {connecting ? <Loader2 size={17} className="spin" /> : activeBot.connection.state === 'connected' ? <RefreshCw size={16} /> : <Link2 size={17} />}
                      {connecting ? 'جارٍ التحقق والربط…' : activeBot.connection.state === 'connected' ? 'التحقق من التوكن الجديد والربط' : 'ربط البوت'}
                    </button>
                  </form>
                  <div className="token-security-note"><ShieldCheck size={16} /><span>لا يُعاد عرض التوكن في الواجهة، ويُحفظ مشفرًا محليًا على الخادم. إذا فشل التوكن الجديد، يبقى الاتصال السابق كما هو.</span></div>
                </section>
                <div className="note-card note-card-green"><span className="note-card-icon"><Activity size={17} /></span><p>كل إعداد محفوظ يُقرأ مباشرة من الخادم عند وصول تحديث من تيليجرام. لا توجد بيانات تجريبية، ولا تظهر حالة اتصال ناجحة قبل التحقق الفعلي.</p></div>
              </>
            )}
          </main>

          <aside className="preview-column">
            <div className="preview-context-header"><div><span className="eyebrow">{flowPath.length ? 'تدفق محدد' : 'بوتك الحالي'}</span><strong>{flowPath.length && currentButton ? currentButton.label : displayBotName(activeBot)}</strong></div><span className="preview-context-mark"><Smartphone size={16} /></span></div>
            <TelegramPreview bot={activeBot} currentButton={currentPreviewButton} onOpenButton={openButtonById} onReorder={(type, buttonId, rowIndex, beforeId, forceNewRow, pageId) => void reorderPreviewButtons(type, buttonId, rowIndex, beforeId, forceNewRow, pageId)} />
            <div className="preview-connect-hint"><span className="preview-connect-dot" /><p>هذه معاينة من الإعدادات المحفوظة لهذا البوت فقط.</p></div>
          </aside>
        </div>
      ) : (
        <div className="loading-screen"><Loader2 size={23} className="spin" /><span>جارٍ فتح مساحة البوت…</span><button type="button" className="text-button" onClick={returnToDashboard}>العودة إلى بوتاتي</button></div>
      )}

      {buttonDialog && (
        <Modal
          title={buttonDialog.mode === 'edit' ? 'تعديل اسم الزر' : buttonDialog.mode === 'create-child' ? 'إضافة زر فرعي' : `إضافة زر ${buttonDialog.type === 'inline' ? 'Inline' : 'Reply Keyboard'}`}
          description={buttonDialog.mode === 'create-child' ? 'اختر نوع الزر الفرعي؛ سيكون له تدفق مستقل.' : buttonDialog.mode === 'edit' ? 'تغيير الاسم لا يحذف الرسائل أو الوسائط أو التدفقات المرتبطة.' : 'أدخل اسم الزر كما تريد أن يظهر في تيليجرام.'}
          onClose={() => setDialog(null)}
        >
          <form onSubmit={(event) => void saveButton(event)} className="modal-form">
            <label className="field-label" htmlFor="button-label">عنوان الزر أو اسمه</label>
            <input id="button-label" className="text-input" autoFocus value={buttonLabelDraft} onChange={(event) => { setButtonLabelDraft(event.target.value); setButtonFormError(''); }} placeholder="اكتب اسم الزر" />
            {buttonDialog.mode === 'create-child' && (
              <div className="nested-type-picker">
                <span className="field-label">نوع الزر</span>
                <div className="nested-type-options">
                  <button type="button" className={`nested-type-option ${newChildType === 'inline' ? 'selected' : ''}`} onClick={() => { setNewChildType('inline'); setButtonFormError(''); }} aria-pressed={newChildType === 'inline'}><Command size={17} /><span><strong>Inline</strong><small>زر أسفل الرسالة</small></span>{newChildType === 'inline' && <CheckCircle2 size={15} />}</button>
                  <button type="button" className={`nested-type-option ${newChildType === 'reply' ? 'selected' : ''}`} onClick={() => { setNewChildType('reply'); setButtonFormError(''); }} aria-pressed={newChildType === 'reply'}><Smartphone size={17} /><span><strong>Reply Keyboard</strong><small>زر في لوحة الكتابة</small></span>{newChildType === 'reply' && <CheckCircle2 size={15} />}</button>
                </div>
              </div>
            )}
            {buttonFormError && <p className="field-error"><CircleAlert size={14} />{buttonFormError}</p>}
            <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setDialog(null)}>إلغاء</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} حفظ</button></div>
          </form>
        </Modal>
      )}

      {confirmDialog && (
        <Modal title={confirmDialog.title} description={confirmDialog.description} onClose={() => { if (!confirming) setDialog(null); }}>
          <div className="confirm-modal-actions"><button className="button button-quiet" type="button" onClick={() => setDialog(null)} disabled={confirming}>لا، إلغاء</button><button className="button button-danger" type="button" disabled={confirming} onClick={async () => { setConfirming(true); try { await confirmDialog.run(); } finally { setConfirming(false); } }}>{confirming ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}{confirming ? 'جارٍ التنفيذ…' : confirmDialog.confirmLabel}</button></div>
        </Modal>
      )}
    </div>
  );
}
