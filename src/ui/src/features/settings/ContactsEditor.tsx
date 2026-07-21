export interface ContactRow {
  /** Stable client-side key (a real contact id once persisted, or a synthetic `new-N` key before save). */
  key: string;
  id?: number;
  name: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

interface ContactsEditorProps {
  contacts: ContactRow[];
  disabled?: boolean;
  onChange: (contacts: ContactRow[]) => void;
}

/**
 * Broker contacts editor (spec FR-24, AC-023, T-012/T-016): rows of name/email/phone with a primary
 * radio group enforcing exactly one primary contact in the UX (mirrors, but never replaces, the
 * backend's exactly-one-primary-contact invariant — `BrokerFormDrawer` translates the row marked
 * primary here into the real `set-primary` API call on save).
 */
function ContactsEditor({ contacts, disabled, onChange }: ContactsEditorProps) {
  function addContact(): void {
    onChange([
      ...contacts,
      { key: `new-${Date.now()}-${Math.random()}`, name: '', email: '', phone: '', isPrimary: contacts.length === 0 },
    ]);
  }

  function updateContact(key: string, patch: Partial<ContactRow>): void {
    onChange(contacts.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeContact(key: string): void {
    const remaining = contacts.filter((c) => c.key !== key);
    const removedWasPrimary = contacts.find((c) => c.key === key)?.isPrimary ?? false;
    const first = remaining[0];
    if (removedWasPrimary && first && !remaining.some((c) => c.isPrimary)) {
      remaining[0] = { ...first, isPrimary: true };
    }
    onChange(remaining);
  }

  function setPrimary(key: string): void {
    onChange(contacts.map((c) => ({ ...c, isPrimary: c.key === key })));
  }

  const fieldLabelStyle = { fontSize: '12px', fontWeight: 600, color: 'var(--qiq-text-secondary)' } as const;

  return (
    <div data-testid="contacts-editor">
      {contacts.map((contact, index) => (
        <div
          key={contact.key}
          data-testid="contact-row"
          style={{ display: 'flex', gap: 'var(--qiq-space-3)', marginBottom: 'var(--qiq-space-3)', alignItems: 'flex-end' }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 2, minWidth: 0 }}>
            <span style={fieldLabelStyle}>Name</span>
            <input
              value={contact.name}
              disabled={disabled}
              onChange={(e) => updateContact(contact.key, { name: e.target.value })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 2, minWidth: 0 }}>
            <span style={fieldLabelStyle}>Email</span>
            <input
              type="email"
              value={contact.email}
              disabled={disabled}
              onChange={(e) => updateContact(contact.key, { email: e.target.value })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 2, minWidth: 0 }}>
            <span style={fieldLabelStyle}>Phone</span>
            <input
              value={contact.phone}
              disabled={disabled}
              onChange={(e) => updateContact(contact.key, { phone: e.target.value })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'center', paddingBottom: '9px' }}>
            <span style={fieldLabelStyle}>Primary</span>
            <input
              data-testid="primary-contact-radio"
              type="radio"
              name="primary-contact"
              aria-label={`Primary contact ${index + 1}`}
              checked={contact.isPrimary}
              disabled={disabled}
              onChange={() => setPrimary(contact.key)}
            />
          </label>
          {!disabled && (
            <button type="button" className="qiq-btn qiq-btn--sm" style={{ marginBottom: '2px' }} onClick={() => removeContact(contact.key)}>
              Remove contact
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button type="button" className="qiq-btn qiq-btn--sm" onClick={addContact}>
          + Add contact
        </button>
      )}
    </div>
  );
}

export default ContactsEditor;
