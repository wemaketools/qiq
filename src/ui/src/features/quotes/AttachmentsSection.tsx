import { useRef, useState } from 'react';
import type { NormalizedError } from '../../api/client';
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  downloadAttachment,
  isAllowedAttachmentFile,
  removeAttachment,
  uploadAttachment,
  type QuoteAttachmentDto,
} from './quotesApi';

interface AttachmentsSectionProps {
  quoteId: number;
  attachments: QuoteAttachmentDto[];
  /** Tenant's `maxAttachmentMb` (spec A-4, T-021), for the size hint text; `null` while unavailable. */
  maxAttachmentMb: number | null;
  /** True once the quote has reached a terminal status (Won/Lost/Expired/Withdrawn, spec FR-48/FR-49). */
  isClosedQuote: boolean;
  /** True when the caller holds `quotes.correct_closed` (T-021's closed-quote correction gate). */
  canCorrectClosed: boolean;
  onUploaded: (attachment: QuoteAttachmentDto) => void;
  onRemoved: (attachmentId: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Quote attachments (spec FR-48, §16, AC-047, T-021, T-029): file input restricted to
 * png/jpg/pdf/doc/docx (client-side pre-check only — the server re-validates extension + declared
 * content type + magic-number bytes, AC-077, and is authoritative), per-tenant size-cap hint, upload
 * progress, download links, and remove buttons that honor the closed-quote correction gate
 * (`quotes.correct_closed`, mirrors `UploadAttachmentCommandHandler`/`RemoveAttachmentCommandHandler`'s
 * identical server-side rule).
 */
function AttachmentsSection({ quoteId, attachments, maxAttachmentMb, isClosedQuote, canCorrectClosed, onUploaded, onRemoved }: AttachmentsSectionProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadDisabled = uploading || (isClosedQuote && !canCorrectClosed);
  const removeDisabled = isClosedQuote && !canCorrectClosed;

  function performUpload(file: File): void {
    setUploadError(null);
    setPendingFile(file);
    setUploading(true);
    setUploadProgress(0);
    uploadAttachment(quoteId, file, (fraction) => setUploadProgress(fraction))
      .then((attachment) => {
        // The signed URL PUT landed AND the server confirmed (size + magic-number, R-8) succeeded.
        setPendingFile(null);
        onUploaded(attachment);
      })
      .catch((err: unknown) => {
        // Any failure — an expired signed URL on the PUT, a 422 signature mismatch at confirm — is
        // surfaced (not swallowed); `pendingFile` is retained so the user can retry the transfer.
        setUploadError((err as NormalizedError).title ?? 'Unable to upload this file.');
      })
      .finally(() => {
        setUploading(false);
        setUploadProgress(null);
      });
  }

  function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (!file) {
      return;
    }

    if (!isAllowedAttachmentFile(file.name)) {
      setUploadError(`"${file.name}" is not an allowed file type. Allowed types: PNG, JPG, PDF, DOC, DOCX.`);
      return;
    }

    performUpload(file);
  }

  function handleRetry(): void {
    if (pendingFile) {
      performUpload(pendingFile);
    }
  }

  function handleDownload(attachment: QuoteAttachmentDto): void {
    downloadAttachment(attachment.id).catch((err: unknown) =>
      setUploadError((err as NormalizedError).title ?? 'Unable to download this file.'),
    );
  }

  function handleRemove(attachment: QuoteAttachmentDto): void {
    setRemovingId(attachment.id);
    removeAttachment(attachment.id)
      .then(() => onRemoved(attachment.id))
      .catch((err: unknown) => setUploadError((err as NormalizedError).title ?? 'Unable to remove this attachment.'))
      .finally(() => setRemovingId(null));
  }

  return (
    <section data-testid="attachments-section">
      <h4 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-3)' }}>
        Attachments
      </h4>

      <div className="qiq-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
        <label htmlFor={`attachment-file-${quoteId}`}>Add attachment</label>
        <input
          id={`attachment-file-${quoteId}`}
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_ATTACHMENT_EXTENSIONS.join(',')}
          disabled={uploadDisabled}
          onChange={handleFileSelected}
        />
      </div>
      <p data-testid="attachment-size-hint" className="qiq-field-hint" style={{ margin: 'var(--qiq-space-2) 0 0' }}>
        Allowed types: PNG, JPG, PDF, DOC, DOCX. {maxAttachmentMb !== null ? `Maximum size: ${maxAttachmentMb} MB.` : ''}
      </p>
      {uploading && (
        <div data-testid="attachment-progress" className="qiq-field-hint">
          <span data-testid="attachment-uploading">Uploading… {Math.round((uploadProgress ?? 0) * 100)}%</span>
          <progress
            aria-label="Upload progress"
            max={100}
            {...(uploadProgress !== null ? { value: Math.round(uploadProgress * 100) } : {})}
            style={{ display: 'block', width: '100%', marginTop: 'var(--qiq-space-1)' }}
          />
        </div>
      )}
      {uploadError && (
        <p role="alert" data-testid="attachment-upload-error" className="qiq-field-error">
          {uploadError}
        </p>
      )}
      {uploadError && pendingFile && !uploading && (
        <button
          type="button"
          className="qiq-btn qiq-btn--sm"
          data-testid="attachment-retry-button"
          onClick={handleRetry}
        >
          Retry upload
        </button>
      )}
      {isClosedQuote && !canCorrectClosed && (
        <p data-testid="attachments-closed-notice" className="qiq-field-hint">
          This quote is closed; attachments cannot be added or removed.
        </p>
      )}

      {attachments.length === 0 ? (
        <p data-testid="attachments-empty" className="qiq-field-hint" style={{ marginTop: 'var(--qiq-space-2)' }}>
          No attachments yet.
        </p>
      ) : (
        <ul data-testid="attachments-list" style={{ listStyle: 'none', margin: 'var(--qiq-space-3) 0 0', padding: 0 }}>
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              data-testid="attachment-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--qiq-space-3)',
                padding: 'var(--qiq-space-2) 0',
                borderBottom: '1px solid var(--qiq-border-subtle)',
              }}
            >
              <span data-testid="attachment-file-name" style={{ fontWeight: 550 }}>
                {attachment.fileName}
              </span>
              <span data-testid="attachment-file-size" style={{ color: 'var(--qiq-text-secondary)', fontSize: '12px', flex: 1 }}>
                ({formatSize(attachment.sizeBytes)})
              </span>
              <button type="button" className="qiq-btn qiq-btn--sm" data-testid="attachment-download-button" onClick={() => handleDownload(attachment)}>
                Download
              </button>
              <button
                type="button"
                className="qiq-btn qiq-btn--sm"
                data-testid="attachment-remove-button"
                disabled={removeDisabled || removingId === attachment.id}
                onClick={() => handleRemove(attachment)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default AttachmentsSection;
