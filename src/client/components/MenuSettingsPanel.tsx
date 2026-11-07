import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, MoveDownRight, Plus, Save, Trash2 } from 'lucide-react';
import {
  defaultMenuSettings,
  type ButtonBoard,
  type MenuControlAction,
  type MenuPageDefinition,
  type MenuSettings,
  type NavigationAction,
  type PageControlAction,
} from '@shared/types';
import { manualPagesFromBoard } from '@shared/menu';

const pageActions: PageControlAction[] = ['first', 'previous', 'next', 'last'];
const menuActions: MenuControlAction[] = ['back', 'home'];
const actionLabels: Record<NavigationAction, string> = {
  first: 'الأولى',
  previous: 'السابق',
  next: 'التالي',
  last: 'الأخيرة',
  back: 'رجوع',
  home: 'الرئيسية',
};

function normalizeControlRows(settings: MenuSettings): NavigationAction[][] {
  const seen = new Set<NavigationAction>();
  const rows = settings.controlRows.map((row) => row.filter((action) => {
    if (seen.has(action)) return false;
    seen.add(action);
    return true;
  })).filter((row) => row.length > 0);
  const enabled = [
    ...pageActions.filter((action) => settings.pageMode !== 'off' && settings.pageControls[action].enabled),
    ...menuActions.filter((action) => settings.menuControls[action].enabled),
  ];
  for (const action of enabled) if (!seen.has(action)) rows.push([action]);
  return rows;
}

function updateControlRows(settings: MenuSettings, action: NavigationAction, rowIndex: number): MenuSettings {
  const rows = normalizeControlRows(settings).map((row) => row.filter((item) => item !== action));
  while (rows.length <= rowIndex) rows.push([]);
  rows[rowIndex].push(action);
  return { ...settings, controlRows: rows.filter((row) => row.length > 0) };
}

function updatePageSetting(settings: MenuSettings, action: PageControlAction, patch: Partial<MenuSettings['pageControls'][PageControlAction]>): MenuSettings {
  return { ...settings, pageControls: { ...settings.pageControls, [action]: { ...settings.pageControls[action], ...patch } } };
}

function updateMenuSetting(settings: MenuSettings, action: MenuControlAction, patch: Partial<MenuSettings['menuControls'][MenuControlAction]>): MenuSettings {
  return { ...settings, menuControls: { ...settings.menuControls, [action]: { ...settings.menuControls[action], ...patch } } };
}

function boardInManualMode(board: ButtonBoard, settings: MenuSettings): ButtonBoard {
  return { ...board, menuSettings: { ...settings, pageMode: 'manual' } };
}

export function MenuSettingsPanel({
  board,
  type,
  onSave,
}: {
  board: ButtonBoard;
  type: 'inline' | 'reply';
  onSave: (next: ButtonBoard) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<MenuSettings>(() => structuredClone(board.menuSettings ?? defaultMenuSettings()));
  const [saving, setSaving] = useState(false);
  const signature = JSON.stringify(board.menuSettings ?? null);

  useEffect(() => {
    setDraft(structuredClone(board.menuSettings ?? defaultMenuSettings()));
  }, [signature]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(board.menuSettings ?? defaultMenuSettings());
  const pages = draft.pageMode === 'manual' ? manualPagesFromBoard(boardInManualMode(board, draft), draft) : [];
  const controlRows = normalizeControlRows(draft);
  const labelsForType = new Set(board.buttons.map((button) => button.label));
  const enabledControls = [
    ...pageActions.filter((action) => draft.pageMode !== 'off' && draft.pageControls[action].enabled).map((action) => draft.pageControls[action].label),
    ...menuActions.filter((action) => draft.menuControls[action].enabled).map((action) => draft.menuControls[action].label),
  ];
  const replyConflict = type === 'reply' && (
    enabledControls.some((label) => labelsForType.has(label))
    || new Set(enabledControls).size !== enabledControls.length
  );

  const changeMode = (mode: MenuSettings['pageMode']) => {
    setDraft((current) => {
      if (mode !== 'manual') return { ...current, pageMode: mode };
      const next = { ...current, pageMode: 'manual' as const };
      return { ...next, manualPages: manualPagesFromBoard(boardInManualMode(board, next), next) };
    });
  };

  const moveButton = (buttonId: string, destinationId: string) => {
    if (destinationId === 'unassigned') return;
    setDraft((current) => {
      const currentPages = manualPagesFromBoard(boardInManualMode(board, current), current);
      const source = currentPages.find((page) => page.buttonIds.includes(buttonId));
      const destination = currentPages.find((page) => page.id === destinationId);
      if (!source || !destination || source.id === destination.id) return current;
      return {
        ...current,
        manualPages: currentPages.map((page) => {
          if (page.id === source.id) return {
            ...page,
            buttonIds: page.buttonIds.filter((id) => id !== buttonId),
            rows: page.rows.map((row) => row.filter((id) => id !== buttonId)).filter((row) => row.length),
          };
          if (page.id === destination.id) return {
            ...page,
            buttonIds: [...page.buttonIds, buttonId],
            rows: [...page.rows, [buttonId]],
          };
          return page;
        }),
      };
    });
  };

  const movePage = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const nextPages = manualPagesFromBoard(boardInManualMode(board, current), current);
      const target = index + direction;
      if (target < 0 || target >= nextPages.length) return current;
      [nextPages[index], nextPages[target]] = [nextPages[target], nextPages[index]];
      return { ...current, manualPages: nextPages };
    });
  };

  const addPage = () => {
    setDraft((current) => ({
      ...current,
      manualPages: [...manualPagesFromBoard(boardInManualMode(board, current), current), {
        id: `page-${crypto.randomUUID()}`,
        buttonIds: [],
        rows: [],
      }],
    }));
  };

  const removePage = (page: MenuPageDefinition) => {
    if (page.buttonIds.length || pages.length <= 1) return;
    setDraft((current) => ({
      ...current,
      manualPages: manualPagesFromBoard(boardInManualMode(board, current), current).filter((item) => item.id !== page.id),
    }));
  };

  const save = async () => {
    if (!dirty || saving || replyConflict) return;
    setSaving(true);
    try {
      await onSave({ ...board, menuSettings: structuredClone(draft) });
    } finally {
      setSaving(false);
    }
  };

  const renderControl = (action: NavigationAction) => {
    const isPageAction = pageActions.includes(action as PageControlAction);
    const value = isPageAction ? draft.pageControls[action as PageControlAction] : draft.menuControls[action as MenuControlAction];
    const canEdit = isPageAction ? draft.pageMode !== 'off' : true;
    const setter = (patch: { enabled?: boolean; label?: string }) => setDraft((current) => isPageAction
      ? updatePageSetting(current, action as PageControlAction, patch)
      : updateMenuSetting(current, action as MenuControlAction, patch));
    const location = controlRows.findIndex((row) => row.includes(action));
    return (
      <div className={`menu-control-item ${!canEdit ? 'menu-control-disabled' : ''}`} key={action}>
        <label className="menu-control-switch">
          <input type="checkbox" checked={value.enabled} disabled={!canEdit} onChange={(event) => setter({ enabled: event.target.checked })} />
          <span>{actionLabels[action]}</span>
        </label>
        <input className="text-input menu-control-label" value={value.label} maxLength={64} disabled={!canEdit} aria-label={`نص زر ${actionLabels[action]}`} onChange={(event) => setter({ label: event.target.value })} />
        <label className="menu-row-select-label">صف
          <select value={Math.max(0, location)} disabled={!canEdit} onChange={(event) => setDraft((current) => updateControlRows(current, action, Number(event.target.value)))}>
            {Array.from({ length: Math.max(1, controlRows.length + 1) }, (_, index) => <option value={index} key={index}>{index + 1}</option>)}
          </select>
        </label>
      </div>
    );
  };

  return (
    <details className="menu-settings-disclosure">
      <summary><span><strong>الصفحات والتنقل</strong><small>تقسيم القائمة، وأزرار الصفحات والرجوع والرئيسية</small></span><ChevronDown size={16} /></summary>
      <div className="menu-settings-body">
        <div className="menu-mode-row">
          <label className="field-label" htmlFor={`menu-mode-${type}`}>تقسيم القائمة</label>
          <select id={`menu-mode-${type}`} className="text-input menu-mode-select" value={draft.pageMode} onChange={(event) => changeMode(event.target.value as MenuSettings['pageMode'])}>
            <option value="off">بدون صفحات — القائمة الحالية كما هي</option>
            <option value="automatic">تلقائي — عدد أزرار لكل صفحة</option>
            <option value="manual">يدوي — صفحات وتوزيع مخصص</option>
          </select>
        </div>

        {draft.pageMode === 'automatic' && (
          <label className="menu-items-per-page"><span>الأزرار في الصفحة</span><input className="text-input" type="number" min="1" step="1" value={draft.itemsPerPage} onChange={(event) => setDraft((current) => ({ ...current, itemsPerPage: Math.max(1, Number(event.target.value) || 1) }))} /></label>
        )}

        {draft.pageMode === 'manual' && (
          <div className="manual-pages-editor">
            <div className="menu-settings-subheading"><strong>الصفحات اليدوية</strong><span>انقل كل زر إلى الصفحة المناسبة. الصفوف وترتيب الأزرار يُعدّلان من المحاكي.</span></div>
            <div className="manual-pages-list">
              {pages.map((page, index) => (
                <section className="manual-page-card" key={page.id}>
                  <div className="manual-page-title"><strong>صفحة {index + 1}</strong><span>{page.buttonIds.length} زر</span>
                    <button type="button" className="icon-button" disabled={index === 0} aria-label="رفع الصفحة" title="رفع الصفحة" onClick={() => movePage(index, -1)}><ChevronUp size={15} /></button>
                    <button type="button" className="icon-button" disabled={index === pages.length - 1} aria-label="خفض الصفحة" title="خفض الصفحة" onClick={() => movePage(index, 1)}><ChevronDown size={15} /></button>
                    <button type="button" className="icon-button danger-icon" disabled={pages.length <= 1 || page.buttonIds.length > 0} title={page.buttonIds.length ? 'انقل الأزرار أولًا حتى لا تضيع من الصفحة' : 'حذف الصفحة الفارغة'} aria-label={`حذف الصفحة ${index + 1}`} onClick={() => removePage(page)}><Trash2 size={14} /></button>
                  </div>
                  {page.buttonIds.length ? (
                    <div className="manual-page-items">
                      {page.buttonIds.map((id) => {
                        const button = board.buttons.find((item) => item.id === id);
                        if (!button) return null;
                        return <label className="manual-page-item" key={id}><span>{button.label}</span><MoveDownRight size={13} /><select value={page.id} aria-label={`نقل ${button.label} إلى صفحة`} onChange={(event) => moveButton(id, event.target.value)}>{pages.map((option, pageIndex) => <option value={option.id} key={option.id}>صفحة {pageIndex + 1}</option>)}</select></label>;
                      })}
                    </div>
                  ) : <p className="manual-page-empty">صفحة فارغة. يمكن إبقاؤها أو حذفها.</p>}
                </section>
              ))}
            </div>
            <button type="button" className="button button-quiet button-small" onClick={addPage}><Plus size={14} /> إضافة صفحة فارغة</button>
            {!board.buttons.length && <p className="menu-empty-note">لا توجد أزرار بعد؛ يمكنك إعداد الصفحات الآن وستُضاف الأزرار الجديدة إلى آخر صفحة.</p>}
          </div>
        )}

        <div className="menu-settings-subheading"><strong>أزرار التنقل</strong><span>إعدادات الصفحات مستقلة عن الرجوع إلى القائمة السابقة أو الرئيسية.</span></div>
        <div className="menu-control-list">{[...pageActions, ...menuActions].map(renderControl)}</div>
        <label className="menu-controls-position"><span>موضع صفوف التنقل</span><select className="text-input" value={draft.controlsPosition} onChange={(event) => setDraft((current) => ({ ...current, controlsPosition: event.target.value as MenuSettings['controlsPosition'] }))}><option value="before">قبل أزرار القائمة</option><option value="after">بعد أزرار القائمة</option></select></label>

        <section className="menu-indicator-settings">
          <label className="menu-indicator-toggle"><input type="checkbox" checked={draft.pageIndicator.enabled} disabled={draft.pageMode === 'off'} onChange={(event) => setDraft((current) => ({ ...current, pageIndicator: { ...current.pageIndicator, enabled: event.target.checked } }))} /><span><strong>إظهار رقم الصفحة</strong><small>يتحدث تلقائيًا عند انتقال المستخدم</small></span></label>
          <input className="text-input menu-indicator-template" value={draft.pageIndicator.template} maxLength={256} disabled={!draft.pageIndicator.enabled || draft.pageMode === 'off'} aria-label="قالب رقم الصفحة" onChange={(event) => setDraft((current) => ({ ...current, pageIndicator: { ...current.pageIndicator, template: event.target.value } }))} />
          <select className="text-input menu-indicator-position" value={draft.pageIndicator.position} disabled={!draft.pageIndicator.enabled || draft.pageMode === 'off'} onChange={(event) => setDraft((current) => ({ ...current, pageIndicator: { ...current.pageIndicator, position: event.target.value as MenuSettings['pageIndicator']['position'] } }))}><option value="before">قبل النص</option><option value="after">بعد النص</option><option value="separate">رسالة مستقلة</option></select>
          <small className="menu-placeholder-hint">استخدم {'{current}'} للصفحة الحالية و{'{total}'} لعدد الصفحات.</small>
        </section>

        {type === 'inline' ? (
          <label className="menu-render-setting"><span><strong>عند تغيير الصفحة</strong><small>تحديث الرسالة الحالية أو إرسال رسالة جديدة</small></span><select className="text-input" value={draft.renderMode} onChange={(event) => setDraft((current) => ({ ...current, renderMode: event.target.value as MenuSettings['renderMode'] }))}><option value="edit">تحديث الرسالة الحالية</option><option value="send">إرسال رسالة جديدة</option></select></label>
        ) : <div className="menu-telegram-note"><AlertTriangle size={15} /><span>Reply Keyboard لا يدعم تحديث لوحة الرسالة السابقة عبر Telegram؛ الانتقال سيرسل رسالة جديدة، مهما كان الاختيار أعلاه.</span></div>}

        {replyConflict && <div className="menu-telegram-note menu-conflict-note"><AlertTriangle size={15} /><span>يوجد نص زر تنقل مطابق لزر Reply. غيّر أحد النصين لتجنب التباس الإجراء.</span></div>}
        <div className="menu-settings-footer"><span>{dirty ? 'توجد تغييرات غير محفوظة في إعدادات هذه القائمة.' : 'الإعدادات المحفوظة فقط تُستخدم عند اتصال البوت.'}</span><button type="button" className="button button-primary button-small" disabled={!dirty || saving || replyConflict} onClick={() => void save()}>{saving ? 'جارٍ الحفظ…' : <><Save size={14} /> حفظ إعدادات الصفحات</>}</button></div>
      </div>
    </details>
  );
}
