import { useEffect, useState } from 'react';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import CurrencyInput from '../../components/common/CurrencyInput';
import type { ReferenceItemDto } from '../settings/settingsApi';
import type { CreateQuotePayload } from './quotesApi';

interface NewQuoteModalProps {
  open: boolean;
  leadDateReceived: string;
  defaultProductLineId: number;
  defaultCoverTypeId: number;
  productLineOptions: ReferenceItemDto[] | null;
  coverTypeOptions: ReferenceItemDto[] | null;
  currencySymbol: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (payload: CreateQuotePayload) => void;
  onCancel: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * New Quote (spec FR-46, PRD 7.3, T-029): the system-assigned values — quote ref AND version —
 * are NOT shown here; both are only known once `POST /leads/{id}/quotes` succeeds and are visible
 * on the saved quote (2026-07-22 decision; the old "assigned on save"/"1" placeholder fields were
 * noise). Product line/cover type default from the lead but remain editable, quoted
 * premium is required and must be greater than zero, prepared date defaults today and cannot
 * precede the lead's date received, valid-until is optional at Draft (required only at Send,
 * `SendQuoteDialog`'s own scope), notes, and a single "Save as draft" primary action. Fields lay
 * out two-up in a wide (`size="lg"`) dialog. Client-side validation is UX only —
 * `CreateQuoteValidator`/`CreateQuoteCommandHandler` remain authoritative (spec FR-46).
 */
function NewQuoteModal({
  open,
  leadDateReceived,
  defaultProductLineId,
  defaultCoverTypeId,
  productLineOptions,
  coverTypeOptions,
  currencySymbol,
  busy,
  error,
  onConfirm,
  onCancel,
}: NewQuoteModalProps) {
  const [productLineId, setProductLineId] = useState(String(defaultProductLineId));
  const [coverTypeId, setCoverTypeId] = useState(String(defaultCoverTypeId));
  const [quotedPremium, setQuotedPremium] = useState<number | null>(null);
  const [preparedDate, setPreparedDate] = useState(today());
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [premiumError, setPremiumError] = useState<string | null>(null);
  const [preparedDateError, setPreparedDateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setProductLineId(String(defaultProductLineId));
    setCoverTypeId(String(defaultCoverTypeId));
    setQuotedPremium(null);
    setPreparedDate(today());
    setValidUntil('');
    setNotes('');
    setPremiumError(null);
    setPreparedDateError(null);
  }, [open, defaultProductLineId, defaultCoverTypeId]);

  if (!open) {
    return null;
  }

  const availableCoverTypes = (coverTypeOptions ?? []).filter(
    (coverType) => productLineId !== '' && String(coverType.productLineId) === productLineId,
  );

  function handleConfirm(): void {
    let hasError = false;
    if (quotedPremium === null || quotedPremium <= 0) {
      setPremiumError('Quoted premium must be greater than zero.');
      hasError = true;
    } else {
      setPremiumError(null);
    }
    if (preparedDate < leadDateReceived) {
      setPreparedDateError("Prepared date cannot precede the lead's date received.");
      hasError = true;
    } else {
      setPreparedDateError(null);
    }
    if (hasError) {
      return;
    }

    onConfirm({
      productLineId: productLineId !== '' ? Number(productLineId) : null,
      coverTypeId: coverTypeId !== '' ? Number(coverTypeId) : null,
      quotedPremium: quotedPremium!,
      preparedDate,
      validUntil: validUntil.trim().length > 0 ? validUntil : null,
      notes: notes.trim().length > 0 ? notes.trim() : null,
    });
  }

  return (
    <ConfirmDialog
      testId="new-quote-modal"
      open={open}
      size="lg"
      title="New Quote"
      description="A draft quote will be created for this lead."
      confirmLabel="Save as draft"
      busy={busy}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      {error && (
        <p role="alert" data-testid="workflow-dialog-error">
          {error}
        </p>
      )}

      <div className="qiq-dialog-grid">
        <div>
          <label htmlFor="new-quote-product-line">Product line</label>
          <select
            id="new-quote-product-line"
            name="productLineId"
            value={productLineId}
            disabled={productLineOptions === null}
            onChange={(event) => {
              setProductLineId(event.target.value);
              setCoverTypeId('');
            }}
          >
            <option value="">Select a product line</option>
            {(productLineOptions ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-quote-cover-type">Cover type</label>
          <select
            id="new-quote-cover-type"
            name="coverTypeId"
            value={coverTypeId}
            disabled={productLineId === '' || coverTypeOptions === null}
            onChange={(event) => setCoverTypeId(event.target.value)}
          >
            <option value="">Select a cover type</option>
            {availableCoverTypes.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-quote-prepared-date">Prepared date</label>
          <input
            id="new-quote-prepared-date"
            name="preparedDate"
            type="date"
            value={preparedDate}
            onChange={(event) => {
              setPreparedDate(event.target.value);
              if (preparedDateError) {
                setPreparedDateError(null);
              }
            }}
          />
          {preparedDateError && (
            <p role="alert" data-testid="field-error-prepared-date">
              {preparedDateError}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="new-quote-valid-until">Valid until</label>
          <input id="new-quote-valid-until" name="validUntil" type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
        </div>

        <div>
          <label htmlFor="new-quote-premium">Quoted premium *</label>
          <CurrencyInput
            id="new-quote-premium"
            name="quotedPremium"
            value={quotedPremium}
            currencySymbol={currencySymbol}
            required
            ariaInvalid={!!premiumError}
            onChange={(value) => {
              setQuotedPremium(value);
              if (premiumError) {
                setPremiumError(null);
              }
            }}
          />
          {premiumError && (
            <p role="alert" data-testid="field-error-premium">
              {premiumError}
            </p>
          )}
        </div>

        <div className="qiq-dialog-grid-full">
          <label htmlFor="new-quote-notes">Notes</label>
          <textarea id="new-quote-notes" name="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </div>
      </div>
    </ConfirmDialog>
  );
}

export default NewQuoteModal;
