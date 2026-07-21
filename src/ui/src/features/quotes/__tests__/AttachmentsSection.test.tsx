import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AttachmentsSection from '../AttachmentsSection';
import { uploadAttachment, downloadAttachment, removeAttachment, type QuoteAttachmentDto } from '../quotesApi';

vi.mock('../quotesApi', async () => {
  const actual = await vi.importActual<typeof import('../quotesApi')>('../quotesApi');
  return {
    ...actual,
    uploadAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
    removeAttachment: vi.fn(),
  };
});

function makeFile(name: string, type: string): File {
  return new File(['dummy content'], name, { type });
}

const ATTACHMENT: QuoteAttachmentDto = {
  id: 1,
  quoteId: 5,
  fileName: 'sample.pdf',
  contentType: 'application/pdf',
  sizeBytes: 51200,
  uploadedAt: '2026-07-01T00:00:00Z',
  uploadedBy: 9,
};

function renderSection(overrides: Partial<React.ComponentProps<typeof AttachmentsSection>> = {}) {
  const props: React.ComponentProps<typeof AttachmentsSection> = {
    quoteId: 5,
    attachments: [],
    maxAttachmentMb: 10,
    isClosedQuote: false,
    canCorrectClosed: false,
    onUploaded: vi.fn(),
    onRemoved: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AttachmentsSection {...props} />) };
}

describe('AttachmentsSection', () => {
  beforeEach(() => {
    vi.mocked(uploadAttachment).mockReset();
    vi.mocked(downloadAttachment).mockReset();
    vi.mocked(removeAttachment).mockReset();
  });

  it('render_WhenNoAttachments_ShouldShowEmptyStateAndSizeHint', () => {
    renderSection();
    expect(screen.getByTestId('attachments-empty')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-size-hint')).toHaveTextContent('Maximum size: 10 MB.');
  });

  it('change_WhenDisallowedFileTypeSelected_ShouldShowInlineRejectionAndNotUpload', () => {
    // The client-side pre-check message is UX-only and must be UNCHANGED from the prior flow.
    renderSection();
    const file = makeFile('malware.exe', 'application/octet-stream');

    fireEvent.change(screen.getByLabelText('Add attachment'), { target: { files: [file] } });

    expect(screen.getByTestId('attachment-upload-error')).toHaveTextContent('is not an allowed file type');
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('change_WhenAllowedFileSelected_ShouldRunEnvelopeUploadAndCallOnUploaded', async () => {
    const onUploaded = vi.fn();
    vi.mocked(uploadAttachment).mockResolvedValue(ATTACHMENT);
    renderSection({ onUploaded });
    const file = makeFile('sample.pdf', 'application/pdf');

    fireEvent.change(screen.getByLabelText('Add attachment'), { target: { files: [file] } });

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(ATTACHMENT));
    expect(uploadAttachment).toHaveBeenCalledWith(5, file, expect.any(Function));
  });

  it('change_WhileTransferring_ShouldRenderUploadProgress', async () => {
    // Hold the upload open so the in-flight progress state is observable.
    let resolveUpload: (value: QuoteAttachmentDto) => void = () => undefined;
    const pending = new Promise<QuoteAttachmentDto>((resolve) => {
      resolveUpload = resolve;
    });
    vi.mocked(uploadAttachment).mockImplementation(async (_quoteId, _file, onProgress) => {
      onProgress?.(0.42);
      return pending;
    });
    renderSection();
    const file = makeFile('sample.pdf', 'application/pdf');

    fireEvent.change(screen.getByLabelText('Add attachment'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('attachment-progress')).toHaveTextContent('42%'));
    resolveUpload(ATTACHMENT);
    await waitFor(() => expect(screen.queryByTestId('attachment-progress')).not.toBeInTheDocument());
  });

  it('change_WhenUploadFails_ShouldSurfaceServerMessageAndOfferRetry', async () => {
    // A confirm-time 422 (magic-number mismatch) or an expired-URL PUT failure must be visible,
    // not swallowed, and must offer a retry affordance.
    vi.mocked(uploadAttachment).mockRejectedValueOnce({
      status: 422,
      title: "The file's content does not match its declared content type 'application/pdf'.",
      fieldErrors: [],
    });
    renderSection();
    const file = makeFile('sample.pdf', 'application/pdf');

    fireEvent.change(screen.getByLabelText('Add attachment'), { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByTestId('attachment-upload-error')).toHaveTextContent('does not match its declared content type'),
    );
    expect(screen.getByTestId('attachment-retry-button')).toBeInTheDocument();
  });

  it('click_WhenRetryClicked_ShouldReAttemptTheUploadWithTheSameFile', async () => {
    const onUploaded = vi.fn();
    vi.mocked(uploadAttachment)
      .mockRejectedValueOnce({ status: 400, title: 'The file could not be transferred to storage.', fieldErrors: [] })
      .mockResolvedValueOnce(ATTACHMENT);
    renderSection({ onUploaded });
    const file = makeFile('sample.pdf', 'application/pdf');

    fireEvent.change(screen.getByLabelText('Add attachment'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('attachment-retry-button')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('attachment-retry-button'));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(ATTACHMENT));
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(vi.mocked(uploadAttachment).mock.calls[1]?.[1]).toBe(file);
  });

  it('render_WhenAttachmentsExist_ShouldListEachWithDownloadAndRemove', () => {
    renderSection({ attachments: [ATTACHMENT] });
    expect(screen.getByTestId('attachment-row')).toHaveTextContent('sample.pdf');
    expect(screen.getByTestId('attachment-download-button')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-remove-button')).toBeEnabled();
  });

  it('click_WhenDownloadClicked_ShouldRequestTheSignedDownloadEnvelope', async () => {
    vi.mocked(downloadAttachment).mockResolvedValue(undefined);
    renderSection({ attachments: [ATTACHMENT] });

    fireEvent.click(screen.getByTestId('attachment-download-button'));

    await waitFor(() => expect(downloadAttachment).toHaveBeenCalledWith(1));
  });

  it('click_WhenDownloadFails_ShouldShowAnError', async () => {
    vi.mocked(downloadAttachment).mockRejectedValue({ status: 404, title: 'Attachment 1 was not found.', fieldErrors: [] });
    renderSection({ attachments: [ATTACHMENT] });

    fireEvent.click(screen.getByTestId('attachment-download-button'));

    await waitFor(() => expect(screen.getByTestId('attachment-upload-error')).toHaveTextContent('was not found'));
  });

  it('click_WhenRemoveClicked_ShouldCallRemoveAttachmentAndOnRemoved', async () => {
    const onRemoved = vi.fn();
    vi.mocked(removeAttachment).mockResolvedValue(undefined);
    renderSection({ attachments: [ATTACHMENT], onRemoved });

    fireEvent.click(screen.getByTestId('attachment-remove-button'));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(1));
  });

  it('render_WhenClosedQuoteWithoutCorrectionPermission_ShouldDisableUploadAndRemove', () => {
    renderSection({ attachments: [ATTACHMENT], isClosedQuote: true, canCorrectClosed: false });
    expect(screen.getByLabelText('Add attachment')).toBeDisabled();
    expect(screen.getByTestId('attachment-remove-button')).toBeDisabled();
    expect(screen.getByTestId('attachments-closed-notice')).toBeInTheDocument();
  });

  it('render_WhenClosedQuoteWithCorrectionPermission_ShouldAllowUploadAndRemove', () => {
    renderSection({ attachments: [ATTACHMENT], isClosedQuote: true, canCorrectClosed: true });
    expect(screen.getByLabelText('Add attachment')).toBeEnabled();
    expect(screen.getByTestId('attachment-remove-button')).toBeEnabled();
  });
});
