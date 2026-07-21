import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Drives the real signed-URL envelope orchestration in `quotesApi` (T-028; AC-059, A-7, M-25),
 * mocking only the client layer beneath it. These are behaviour tests, not render tests: they assert
 * the request -> direct PUT -> confirm sequence, that the PUT targets the URL the SERVER returned
 * (never a hardcoded one), and that a confirm-time rejection (the R-8 magic-number check) is
 * surfaced, not swallowed. The load-bearing mutants for this task live in this orchestration.
 */
vi.mock('../../../api/client', () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  putFileToSignedUrl: vi.fn(),
  navigateToSignedUrl: vi.fn(),
}));

import {
  apiPost,
  apiGet,
  putFileToSignedUrl,
  navigateToSignedUrl,
} from '../../../api/client';
import {
  uploadAttachment,
  downloadAttachment,
  type AttachmentUploadEnvelopeDto,
  type AttachmentDownloadEnvelopeDto,
  type QuoteAttachmentDto,
} from '../quotesApi';

const ENVELOPE: AttachmentUploadEnvelopeDto = {
  attachmentId: 42,
  quoteId: 5,
  fileName: 'sample.pdf',
  contentType: 'application/pdf',
  uploadUrl: 'https://storage.example.test/object/upload/sign/quote-attachments/t1/5/42-sample.pdf?token=SIGNED',
  uploadToken: 'SIGNED',
  expiresInSeconds: 7200,
};

const CONFIRMED: QuoteAttachmentDto = {
  id: 42,
  quoteId: 5,
  fileName: 'sample.pdf',
  contentType: 'application/pdf',
  sizeBytes: 4096,
  uploadedAt: '2026-07-20T00:00:00Z',
  uploadedBy: 9,
};

function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('quotesApi attachment envelope orchestration', () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
    vi.mocked(apiGet).mockReset();
    vi.mocked(putFileToSignedUrl).mockReset();
    vi.mocked(navigateToSignedUrl).mockReset();
  });

  describe('uploadAttachment', () => {
    it('uploadAttachment_WhenAllStepsSucceed_ShouldRequestThenPutThenConfirmInOrder', async () => {
      // Arrange
      vi.mocked(apiPost).mockResolvedValueOnce(ENVELOPE).mockResolvedValueOnce(CONFIRMED);
      vi.mocked(putFileToSignedUrl).mockResolvedValue(undefined);
      const file = makeFile('sample.pdf', 'application/pdf', 4096);

      // Act
      const result = await uploadAttachment(5, file);

      // Assert: request-upload envelope
      expect(apiPost).toHaveBeenNthCalledWith(1, '/quotes/5/attachments', {
        fileName: 'sample.pdf',
        contentType: 'application/pdf',
        declaredSizeBytes: 4096,
      });
      // Assert: the PUT targeted the URL the SERVER returned (kills the hardcoded-URL mutant)
      const putCall = vi.mocked(putFileToSignedUrl).mock.calls[0];
      expect(putCall?.[0]).toBe(ENVELOPE.uploadUrl);
      expect(putCall?.[1]).toBeInstanceOf(File);
      // Assert: confirm ran against the server's attachment id
      expect(apiPost).toHaveBeenNthCalledWith(2, '/attachments/42/confirm');
      // Assert: ordering — PUT strictly before confirm
      const putOrder = vi.mocked(putFileToSignedUrl).mock.invocationCallOrder[0] ?? 0;
      const confirmOrder = vi.mocked(apiPost).mock.invocationCallOrder[1] ?? 0;
      expect(putOrder).toBeLessThan(confirmOrder);
      expect(result).toEqual(CONFIRMED);
    });

    it('uploadAttachment_WhenBrowserFileTypeIsMissing_ShouldDeriveContentTypeFromExtension', async () => {
      // Arrange: browsers frequently leave File.type empty for .doc
      vi.mocked(apiPost).mockResolvedValueOnce(ENVELOPE).mockResolvedValueOnce(CONFIRMED);
      vi.mocked(putFileToSignedUrl).mockResolvedValue(undefined);
      const file = makeFile('contract.doc', '', 2048);

      // Act
      await uploadAttachment(5, file);

      // Assert
      expect(apiPost).toHaveBeenNthCalledWith(1, '/quotes/5/attachments', {
        fileName: 'contract.doc',
        contentType: 'application/msword',
        declaredSizeBytes: 2048,
      });
      // The bytes PUT to storage carry the derived type, not the empty browser type.
      const typedFile = vi.mocked(putFileToSignedUrl).mock.calls[0]?.[1] as File;
      expect(typedFile.type).toBe('application/msword');
    });

    it('uploadAttachment_WhenPutFails_ShouldNotConfirmAndShouldReject', async () => {
      // Arrange: the request-upload succeeds, the direct transfer fails (network / expired URL)
      vi.mocked(apiPost).mockResolvedValueOnce(ENVELOPE);
      const transferError = { status: 400, title: 'The file could not be transferred to storage.', fieldErrors: [] };
      vi.mocked(putFileToSignedUrl).mockRejectedValue(transferError);
      const file = makeFile('sample.pdf', 'application/pdf', 4096);

      // Act / Assert
      await expect(uploadAttachment(5, file)).rejects.toBe(transferError);
      // confirm must NOT run when the bytes never landed — only the request-upload POST happened.
      expect(apiPost).toHaveBeenCalledTimes(1);
    });

    it('uploadAttachment_WhenConfirmRejectsWith422_ShouldSurfaceNotSwallow', async () => {
      // Arrange: PUT lands, but the server's magic-number check rejects at confirm (R-8)
      const signatureError = {
        status: 422,
        title: "The file's content does not match its declared content type 'application/pdf'.",
        fieldErrors: [],
      };
      vi.mocked(apiPost).mockResolvedValueOnce(ENVELOPE).mockRejectedValueOnce(signatureError);
      vi.mocked(putFileToSignedUrl).mockResolvedValue(undefined);
      const file = makeFile('sample.pdf', 'application/pdf', 4096);

      // Act / Assert: the rejection must propagate (kills a swallow-the-422 mutant)
      await expect(uploadAttachment(5, file)).rejects.toBe(signatureError);
    });

    it('uploadAttachment_WhenOnProgressProvided_ShouldForwardItToTheTransfer', async () => {
      // Arrange
      vi.mocked(apiPost).mockResolvedValueOnce(ENVELOPE).mockResolvedValueOnce(CONFIRMED);
      vi.mocked(putFileToSignedUrl).mockResolvedValue(undefined);
      const onProgress = vi.fn();
      const file = makeFile('sample.pdf', 'application/pdf', 4096);

      // Act
      await uploadAttachment(5, file, onProgress);

      // Assert
      expect(putFileToSignedUrl).toHaveBeenCalledWith(ENVELOPE.uploadUrl, expect.any(File), onProgress);
    });
  });

  describe('downloadAttachment', () => {
    const DOWNLOAD: AttachmentDownloadEnvelopeDto = {
      attachmentId: 42,
      fileName: 'sample.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
      downloadUrl: 'https://storage.example.test/object/sign/quote-attachments/t1/5/42-sample.pdf?token=DL',
      expiresInSeconds: 300,
    };

    it('downloadAttachment_WhenEnvelopeReturned_ShouldNavigateToTheServerSignedUrl', async () => {
      // Arrange
      vi.mocked(apiGet).mockResolvedValue(DOWNLOAD);

      // Act
      await downloadAttachment(42);

      // Assert
      expect(apiGet).toHaveBeenCalledWith('/attachments/42');
      // Navigation must use the URL the server signed (kills a hardcoded-URL mutant).
      expect(navigateToSignedUrl).toHaveBeenCalledWith(DOWNLOAD.downloadUrl);
    });

    it('downloadAttachment_WhenEnvelopeRequestFails_ShouldRejectAndNotNavigate', async () => {
      // Arrange
      const notFound = { status: 404, title: 'Attachment 42 was not found.', fieldErrors: [] };
      vi.mocked(apiGet).mockRejectedValue(notFound);

      // Act / Assert
      await expect(downloadAttachment(42)).rejects.toBe(notFound);
      expect(navigateToSignedUrl).not.toHaveBeenCalled();
    });
  });
});
