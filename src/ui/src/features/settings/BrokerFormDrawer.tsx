import { useEffect, useState } from 'react';
import type { NormalizedError } from '../../api/client';
import {
  addBrokerContact,
  createBroker,
  disableBroker,
  getBroker,
  removeBrokerContact,
  setPrimaryBrokerContact,
  updateBroker,
  updateBrokerContact,
  type BrokerDetailDto,
  type ReferenceItemDto,
} from './settingsApi';
import ContactsEditor, { type ContactRow } from './ContactsEditor';
import ErrorBanner from '../../components/common/ErrorBanner';
import StatusChip from '../../components/common/StatusChip';
import ConfirmDialog from '../../components/common/ConfirmDialog';

interface BrokerFormPanelProps {
  /** Editing an existing broker when set; creating a new one when `null`. */
  brokerId: number | null;
  brokerTypes: ReferenceItemDto[];
  canManage: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  onDisabled: (message: string) => void;
}

function toContactRow(dto: BrokerDetailDto['contacts'][number]): ContactRow {
  return { key: `existing-${dto.id}`, id: dto.id, name: dto.name, email: dto.email ?? '', phone: dto.phone ?? '', isPrimary: dto.isPrimary };
}

/**
 * Add/Edit broker panel (spec FR-24, AC-023, T-012/T-016): name (required), tier dropdown sourced
 * from the `broker_type` reference list, branch, and the `ContactsEditor` contacts editor. Renders
 * inline in the Settings content area (replacing the brokers list) with the same card + sticky-footer
 * shell as every other form — this replaced an earlier slide-in side drawer that existed nowhere else
 * in the product. The `broker-form-drawer` testid is retained so existing e2e selectors keep working.
 * Since the brokers backend has no bulk-contacts endpoint, saving a broker's contacts diffs the
 * initial vs. current contact rows into the individual add/update/remove/set-primary calls the API
 * actually exposes (T-012).
 */
function BrokerFormPanel({ brokerId, brokerTypes, canManage, onClose, onSaved, onDisabled }: BrokerFormPanelProps) {
  const isEditMode = brokerId !== null;

  const [name, setName] = useState('');
  const [brokerTypeId, setBrokerTypeId] = useState<string>('');
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [initialContacts, setInitialContacts] = useState<ContactRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    if (brokerId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getBroker(brokerId)
      .then((broker) => {
        if (cancelled) {
          return;
        }
        setName(broker.name);
        setBrokerTypeId(broker.brokerTypeId !== null ? String(broker.brokerTypeId) : '');
        setBranch(broker.branch ?? '');
        setStatus(broker.status);
        const rows = broker.contacts.map(toContactRow);
        setInitialContacts(rows);
        setContacts(rows);
      })
      .catch(() => setFormError('Unable to load this broker.'))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brokerId]);

  function validateName(value: string): string | undefined {
    return value.trim().length === 0 ? 'Broker name is required.' : undefined;
  }

  async function persistContacts(id: number): Promise<void> {
    const removed = initialContacts.filter((c) => c.id !== undefined && !contacts.some((cc) => cc.id === c.id));
    for (const contact of removed) {
      await removeBrokerContact(id, contact.id!);
    }

    const idByKey = new Map<string, number>();
    for (const contact of contacts) {
      if (contact.name.trim().length === 0) {
        continue;
      }
      if (contact.id !== undefined) {
        await updateBrokerContact(id, contact.id, {
          name: contact.name,
          email: contact.email || null,
          phone: contact.phone || null,
        });
        idByKey.set(contact.key, contact.id);
      } else {
        const created = await addBrokerContact(id, {
          name: contact.name,
          email: contact.email || null,
          phone: contact.phone || null,
          isPrimary: contact.isPrimary,
        });
        idByKey.set(contact.key, created.id);
      }
    }

    const primaryRow = contacts.find((c) => c.isPrimary);
    if (primaryRow) {
      const primaryId = idByKey.get(primaryRow.key);
      if (primaryId !== undefined) {
        await setPrimaryBrokerContact(id, primaryId);
      }
    }
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
        brokerTypeId: brokerTypeId === '' ? null : Number(brokerTypeId),
        branch: branch.trim() === '' ? null : branch.trim(),
      };

      const broker = isEditMode && brokerId !== null ? await updateBroker(brokerId, payload) : await createBroker(payload);
      await persistContacts(broker.id);

      onSaved(`Broker ${broker.name} saved`);
    } catch (err) {
      setFormError((err as NormalizedError).title ?? 'Unable to save broker.');
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDisable(): Promise<void> {
    if (brokerId === null) {
      return;
    }
    setDisabling(true);
    try {
      await disableBroker(brokerId);
      setConfirmingDisable(false);
      onDisabled(`Broker ${name} disabled`);
    } catch (err) {
      setFormError((err as NormalizedError).title ?? 'Unable to disable broker.');
    } finally {
      setDisabling(false);
    }
  }

  return (
    <div data-testid="broker-form-drawer" className="qiq-page">
      <div className="qiq-page-head" style={{ marginBottom: 0 }}>
        <h2>{isEditMode ? 'Edit broker' : 'New broker'}</h2>
      </div>

      {formError && <ErrorBanner message={formError} />}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="qiq-card" style={{ padding: 0 }}>
          <div style={{ padding: 'var(--qiq-space-5)' }}>
            <div className="qiq-form-grid">
              <div className="qiq-field">
                <label htmlFor="broker-name">Name</label>
                <input
                  id="broker-name"
                  value={name}
                  disabled={!canManage}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameError(validateName(name) ?? null)}
                />
                {nameError && (
                  <p data-testid="field-error" className="qiq-field-error">
                    {nameError}
                  </p>
                )}
              </div>

              <div className="qiq-field">
                <label htmlFor="broker-type">Type</label>
                <select id="broker-type" value={brokerTypeId} disabled={!canManage} onChange={(e) => setBrokerTypeId(e.target.value)}>
                  <option value="">Select a type…</option>
                  {brokerTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="qiq-field">
                <label htmlFor="broker-branch">Branch</label>
                <input id="broker-branch" value={branch} disabled={!canManage} onChange={(e) => setBranch(e.target.value)} />
              </div>

              {isEditMode && (
                <div className="qiq-field">
                  <label>Status</label>
                  <p style={{ margin: 0 }} data-testid="broker-status">
                    <StatusChip label={status === 'active' ? 'Active' : 'Disabled'} category={status === 'active' ? 'won' : 'expired'} />
                  </p>
                </div>
              )}
            </div>

            <h3 className="qiq-form-section-title" style={{ margin: 'var(--qiq-space-5) 0 var(--qiq-space-4)' }}>
              Contacts
            </h3>
            <ContactsEditor contacts={contacts} disabled={!canManage} onChange={setContacts} />
          </div>

          <div className="qiq-sticky-footer">
            <button type="button" className="qiq-btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {canManage && isEditMode && status === 'active' && (
              <button type="button" className="qiq-btn qiq-btn--danger-soft" onClick={() => setConfirmingDisable(true)} disabled={saving}>
                Disable
              </button>
            )}
            {canManage && (
              <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => void handleSave()} disabled={saving}>
                Save
              </button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        testId="disable-broker-dialog"
        open={confirmingDisable}
        title={`Disable broker — ${name}`}
        description="This removes the broker from active pickers on new leads/quotes while preserving it on historical records. This can be reversed by re-enabling later."
        confirmLabel="Confirm"
        danger
        busy={disabling}
        onCancel={() => setConfirmingDisable(false)}
        onConfirm={() => void handleConfirmDisable()}
      />
    </div>
  );
}

export default BrokerFormPanel;
