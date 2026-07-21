import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import {
  createReferenceItem,
  disableReferenceItem,
  listReferenceItems,
  reorderReferenceItems,
  updateReferenceItem,
  REFERENCE_LIST_TYPES,
  REFERENCE_LIST_TYPE_LABELS,
  type ReferenceItemDto,
  type ReferenceListType,
} from './settingsApi';
import ErrorBanner from '../../components/common/ErrorBanner';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import StatusChip from '../../components/common/StatusChip';
import Icon from '../../components/common/Icon';
import { useToast } from '../../components/common/Toast';

const INTERMEDIATE_CATEGORIES = ['open', 'quoted'];
const DEFAULT_INTERMEDIATE_CATEGORY = 'open';
const STATUS_LIST_TYPES: ReferenceListType[] = ['lead_status', 'quote_status'];

interface DrawerState {
  open: boolean;
  item: ReferenceItemDto | null;
}

/**
 * Reference data tab (spec §11.2, FR-19..FR-21, AC-018, T-008/T-016): a left list-type selector for
 * all eleven tenant reference lists, and a right table of that list's values with add/edit/disable/
 * reorder. Guarded-status affordances mirror the T-008 backend rules as UX only (server remains
 * authoritative, CLAUDE.md security stance):
 *  - a `reporting-category-cell` column on `lead_status`/`quote_status`, read-only whenever the row
 *    is canonical (`canonicalKey !== null`, matching `UpdateItemCommandHandler`'s
 *    `CanonicalFieldsImmutable` rule);
 *  - the Disable action is hidden entirely for `isTerminal` rows (matches
 *    `DisableItemCommandHandler`'s `TERMINAL_STATUS_CANNOT_BE_DISABLED` rule);
 *  - a new/edited non-canonical lead/quote status's reporting-category picker is restricted to
 *    `open`/`quoted` (matches `ReportingCategory.IntermediateAllowed`, both `CreateItemCommandHandler`
 *    and `UpdateItemCommandHandler`);
 *  - `cover_type` rows require a `product_line` selection (matches the `ProductLineRequired` rule);
 *  - `request_channel` rows carry a broker-channel toggle.
 */
function ReferenceDataTab() {
  const navigate = useNavigate();
  const { listType: listTypeParam } = useParams<{ listType?: string }>();
  const { showSuccess, showError } = useToast();
  const canManage = useAppSelector(selectHasPermission(PermissionCodes.ReferenceDataManage));

  const selectedListType: ReferenceListType = (REFERENCE_LIST_TYPES as readonly string[]).includes(listTypeParam ?? '')
    ? (listTypeParam as ReferenceListType)
    : 'request_channel';

  const [items, setItems] = useState<ReferenceItemDto[]>([]);
  const [productLines, setProductLines] = useState<ReferenceItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, item: null });
  const [disableTarget, setDisableTarget] = useState<ReferenceItemDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const loaders: Promise<unknown>[] = [
      listReferenceItems(selectedListType, true).then(setItems),
    ];
    if (selectedListType === 'cover_type') {
      loaders.push(listReferenceItems('product_line').then(setProductLines));
    }
    Promise.all(loaders)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load reference data.'))
      .finally(() => setLoading(false));
  }, [selectedListType]);

  useEffect(() => {
    load();
  }, [load]);

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.displayOrder - b.displayOrder), [items]);

  // `POST .../reorder` requires *exactly* the current active-item id set (ReorderItemsCommandHandler:
  // "no disabled ids: disabled rows never resurface in a picker or a reorderable Settings UI list").
  // Reordering therefore only ever operates on the active-only subsequence — a disabled row's
  // position among active rows is meaningless, and including its id in the payload would make the
  // set mismatch the backend's active-only set and fail with REFERENCE_DATA_REORDER_SET_MISMATCH.
  const activeSortedItems = useMemo(() => sortedItems.filter((item) => item.isActive), [sortedItems]);

  function productLineName(productLineId: number | null): string {
    if (productLineId === null) {
      return '—';
    }
    return productLines.find((p) => p.id === productLineId)?.name ?? '—';
  }

  async function move(activeIndex: number, direction: -1 | 1): Promise<void> {
    const targetIndex = activeIndex + direction;
    if (targetIndex < 0 || targetIndex >= activeSortedItems.length) {
      return;
    }
    const current = activeSortedItems[activeIndex];
    const target = activeSortedItems[targetIndex];
    if (!current || !target) {
      return;
    }
    const reordered = [...activeSortedItems];
    reordered[activeIndex] = target;
    reordered[targetIndex] = current;
    setBusy(true);
    try {
      await reorderReferenceItems(selectedListType, reordered.map((item) => item.id));
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to reorder.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisableConfirm(): Promise<void> {
    if (!disableTarget) {
      return;
    }
    setBusy(true);
    try {
      await disableReferenceItem(selectedListType, disableTarget.id);
      showSuccess(`${disableTarget.name} disabled`);
      setDisableTarget(null);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to disable this value.');
    } finally {
      setBusy(false);
    }
  }

  const showReportingCategory = STATUS_LIST_TYPES.includes(selectedListType);
  const showProductLine = selectedListType === 'cover_type';
  const showBrokerChannel = selectedListType === 'request_channel';

  return (
    <div data-testid="reference-data-tab" style={{ display: 'flex', gap: 'var(--qiq-space-5)' }}>
      <nav data-testid="reference-list-type-nav" aria-label="Reference list types" style={{ minWidth: '180px' }}>
        <ul className="qiq-vtabs">
          {REFERENCE_LIST_TYPES.map((listType) => (
            <li key={listType}>
              <a
                href={`/settings/reference-data/${listType}`}
                aria-current={listType === selectedListType ? 'page' : undefined}
                className={listType === selectedListType ? 'qiq-vtab--active' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/settings/reference-data/${listType}`);
                }}
              >
                {REFERENCE_LIST_TYPE_LABELS[listType]}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="qiq-page-head">
          <h2>{REFERENCE_LIST_TYPE_LABELS[selectedListType]}</h2>
          {canManage && (
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => setDrawer({ open: true, item: null })}>
              + Add value
            </button>
          )}
        </div>

        {error && <ErrorBanner message={error} onRetry={load} />}

        {!error && loading && <SkeletonTable rows={5} columns={4} />}

        {!error && !loading && sortedItems.length === 0 && <EmptyState message="No values configured for this list yet." />}

        {!error && !loading && sortedItems.length > 0 && (
          <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="reference-items-table">
            <thead>
              <tr>
                <th>Name</th>
                {showReportingCategory && <th>Reporting category</th>}
                {showProductLine && <th>Product line</th>}
                {showBrokerChannel && <th>Broker channel</th>}
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item) => {
                const activeIndex = activeSortedItems.findIndex((active) => active.id === item.id);
                return (
                  <tr key={item.id} aria-label={item.name}>
                    <td>{item.name}</td>
                    {showReportingCategory && (
                      <td data-testid="reporting-category-cell">{item.reportingCategory ?? '—'}</td>
                    )}
                    {showProductLine && <td>{productLineName(item.productLineId)}</td>}
                    {showBrokerChannel && <td>{item.isBrokerChannel ? 'Yes' : 'No'}</td>}
                    <td>
                      <StatusChip label={item.isActive ? 'Active' : 'Disabled'} category={item.isActive ? 'won' : 'expired'} />
                    </td>
                    <td>
                      {canManage && (
                        <div className="qiq-row-actions">
                          {item.isActive && (
                            <>
                              <button
                                type="button"
                                className="qiq-btn qiq-btn--sm"
                                data-testid="reorder-up"
                                aria-label={`Move ${item.name} up`}
                                disabled={busy || activeIndex === 0}
                                onClick={() => void move(activeIndex, -1)}
                              >
                                <Icon name="chevron-up" size={14} />
                              </button>
                              <button
                                type="button"
                                className="qiq-btn qiq-btn--sm"
                                data-testid="reorder-down"
                                aria-label={`Move ${item.name} down`}
                                disabled={busy || activeIndex === activeSortedItems.length - 1}
                                onClick={() => void move(activeIndex, 1)}
                              >
                                <Icon name="chevron-down" size={14} />
                              </button>
                            </>
                          )}
                          <button type="button" className="qiq-btn qiq-btn--sm" onClick={() => setDrawer({ open: true, item })}>
                            Edit
                          </button>
                          {item.isActive && !item.isTerminal && (
                            <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={() => setDisableTarget(item)}>
                              Disable
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {drawer.open && (
        <ReferenceItemDialog
          listType={selectedListType}
          item={drawer.item}
          productLines={productLines}
          onClose={() => setDrawer({ open: false, item: null })}
          onSaved={() => {
            setDrawer({ open: false, item: null });
            load();
          }}
        />
      )}

      <ConfirmDialog
        testId="disable-reference-item-dialog"
        open={disableTarget !== null}
        title={`Disable value — ${disableTarget?.name ?? ''}`}
        description="This removes the value from active pickers going forward while preserving it on historical records."
        confirmLabel="Confirm"
        danger
        busy={busy}
        onConfirm={() => void handleDisableConfirm()}
        onCancel={() => setDisableTarget(null)}
      />
    </div>
  );
}

interface ReferenceItemDialogProps {
  listType: ReferenceListType;
  item: ReferenceItemDto | null;
  productLines: ReferenceItemDto[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Add/edit dialog for a single reference value (spec §11.2, FR-19/FR-20, T-008/T-016). Uses the
 * standard centered `.qiq-dialog` anatomy — the slide-in side drawer this replaced existed nowhere
 * else in the product (the brokers form dropped its own drawer for the same reason). The
 * `reference-item-drawer` testid is retained so existing e2e selectors keep working.
 */
function ReferenceItemDialog({ listType, item, productLines, onClose, onSaved }: ReferenceItemDialogProps) {
  const { showSuccess, showError } = useToast();
  const isEditMode = item !== null;
  const isCanonical = item?.canonicalKey != null;

  const [name, setName] = useState(item?.name ?? '');
  const [isBrokerChannel, setIsBrokerChannel] = useState(item?.isBrokerChannel ?? false);
  const [productLineId, setProductLineId] = useState<string>(item?.productLineId !== null && item?.productLineId !== undefined ? String(item.productLineId) : '');
  const [reportingCategory, setReportingCategory] = useState<string>(item?.reportingCategory ?? DEFAULT_INTERMEDIATE_CATEGORY);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const showBrokerChannelField = listType === 'request_channel';
  const showProductLineField = listType === 'cover_type';
  const showReportingCategoryField = STATUS_LIST_TYPES.includes(listType);

  function validateName(value: string): string | undefined {
    return value.trim().length === 0 ? 'Name is required.' : undefined;
  }

  async function handleSave(): Promise<void> {
    setFormError(null);
    const error = validateName(name);
    setNameError(error ?? null);
    if (error) {
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        isBrokerChannel: showBrokerChannelField ? isBrokerChannel : undefined,
        productLineId: showProductLineField ? (productLineId === '' ? null : Number(productLineId)) : undefined,
        reportingCategory: showReportingCategoryField ? (isCanonical ? item!.reportingCategory : reportingCategory) : undefined,
      };

      if (isEditMode && item) {
        await updateReferenceItem(listType, item.id, payload);
        showSuccess(`${payload.name} updated`);
      } else {
        await createReferenceItem(listType, payload);
        showSuccess(`${payload.name} created`);
      }
      onSaved();
    } catch (err) {
      const message = (err as NormalizedError).title ?? 'Unable to save this value.';
      setFormError(message);
      showError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="qiq-scrim" role="presentation" data-testid="reference-item-drawer-overlay">
      <div className="qiq-dialog" data-testid="reference-item-drawer" role="dialog" aria-modal="true" aria-labelledby="ref-item-dialog-title">
        <div className="qiq-dialog-header">
          <h2 id="ref-item-dialog-title">{isEditMode ? 'Edit value' : 'Add value'}</h2>
        </div>

        <div className="qiq-dialog-body">
          {formError && <ErrorBanner message={formError} />}

          <div className="qiq-field">
            <label htmlFor="ref-item-name">Name</label>
            <input
              id="ref-item-name"
              value={name}
              aria-invalid={nameError ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNameError(validateName(name) ?? null)}
            />
            {nameError && <p data-testid="field-error" className="qiq-field-error">{nameError}</p>}
          </div>

          {showBrokerChannelField && (
            <label htmlFor="ref-item-broker-channel">
              <input
                id="ref-item-broker-channel"
                data-testid="broker-channel-toggle"
                type="checkbox"
                checked={isBrokerChannel}
                onChange={(e) => setIsBrokerChannel(e.target.checked)}
              />
              {' '}Broker channel
            </label>
          )}

          {showProductLineField && (
            <div className="qiq-field" style={{ marginTop: 'var(--qiq-space-4)' }}>
              <label htmlFor="ref-item-product-line">Product line</label>
              <select id="ref-item-product-line" value={productLineId} onChange={(e) => setProductLineId(e.target.value)}>
                <option value="">Select a product line…</option>
                {productLines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showReportingCategoryField && (
            <div className="qiq-field" style={{ marginTop: 'var(--qiq-space-4)' }}>
              <label htmlFor="ref-item-reporting-category">Reporting category</label>
              <select
                id="ref-item-reporting-category"
                data-testid="reporting-category-select"
                value={isCanonical ? (item!.reportingCategory ?? '') : reportingCategory}
                disabled={isCanonical}
                onChange={(e) => setReportingCategory(e.target.value)}
              >
                {isCanonical
                  ? item?.reportingCategory && <option value={item.reportingCategory}>{item.reportingCategory}</option>
                  : INTERMEDIATE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
              </select>
            </div>
          )}
        </div>

        <div className="qiq-dialog-footer">
          <button type="button" className="qiq-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => void handleSave()} disabled={saving}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default ReferenceDataTab;
