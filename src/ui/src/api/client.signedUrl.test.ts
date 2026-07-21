import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { putFileToSignedUrl, navigateToSignedUrl } from './client';

/**
 * The two storage-host primitives of the A-7 signed-URL envelope (T-028): the direct-to-storage PUT
 * (with upload progress) and following a signed download URL. Both must bypass `/api/v1` and must
 * NEVER carry the app bearer token to the storage host.
 */

interface ProgressLike {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  static onSend: ((xhr: FakeXhr) => void) | null = null;

  method = '';
  url = '';
  readonly requestHeaders: Record<string, string> = {};
  body: unknown = undefined;
  status = 0;
  upload: { onprogress: ((event: ProgressLike) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string): void {
    this.requestHeaders[key.toLowerCase()] = value;
  }

  send(body: unknown): void {
    this.body = body;
    FakeXhr.instances.push(this);
    FakeXhr.onSend?.(this);
  }
}

function makeFile(name: string, type: string): File {
  return new File(['some-bytes'], name, { type });
}

describe('putFileToSignedUrl', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    FakeXhr.onSend = null;
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('putFileToSignedUrl_WhenStorageReturns200_ShouldPutTheBytesToTheSignedUrlWithoutAppToken', async () => {
    // Arrange
    const file = makeFile('sample.pdf', 'application/pdf');
    FakeXhr.onSend = (xhr) => {
      xhr.status = 200;
      xhr.onload?.();
    };

    // Act
    await putFileToSignedUrl('https://storage.example.test/upload/sign/key?token=SIGNED', file);

    // Assert
    const xhr = FakeXhr.instances[0];
    expect(xhr?.method).toBe('PUT');
    expect(xhr?.url).toBe('https://storage.example.test/upload/sign/key?token=SIGNED');
    expect(xhr?.requestHeaders['content-type']).toBe('application/pdf');
    // The app bearer token must NEVER be sent to the storage host.
    expect(xhr?.requestHeaders['authorization']).toBeUndefined();
    expect(xhr?.body).toBe(file);
  });

  it('putFileToSignedUrl_WhenUploadProgressFires_ShouldReportFractionComplete', async () => {
    // Arrange
    const file = makeFile('sample.pdf', 'application/pdf');
    const onProgress = vi.fn();
    FakeXhr.onSend = (xhr) => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
      xhr.status = 200;
      xhr.onload?.();
    };

    // Act
    await putFileToSignedUrl('https://storage.example.test/upload?token=x', file, onProgress);

    // Assert
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.25);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1);
  });

  it('putFileToSignedUrl_WhenSignedUrlExpired400_ShouldRejectWithNormalizedError', async () => {
    // Arrange: an expired signed upload URL answers 4xx from the storage host.
    const file = makeFile('sample.pdf', 'application/pdf');
    FakeXhr.onSend = (xhr) => {
      xhr.status = 400;
      xhr.onload?.();
    };

    // Act / Assert
    await expect(
      putFileToSignedUrl('https://storage.example.test/upload?token=expired', file),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('putFileToSignedUrl_WhenNetworkErrors_ShouldReject', async () => {
    // Arrange
    const file = makeFile('sample.pdf', 'application/pdf');
    FakeXhr.onSend = (xhr) => {
      xhr.onerror?.();
    };

    // Act / Assert
    await expect(
      putFileToSignedUrl('https://storage.example.test/upload?token=x', file),
    ).rejects.toMatchObject({ status: 0 });
  });
});

describe('navigateToSignedUrl', () => {
  it('navigateToSignedUrl_WhenCalled_ShouldFollowTheSignedUrlViaAnchorClick', () => {
    // Arrange
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    // Act
    navigateToSignedUrl('https://storage.example.test/object/sign/key?token=DL');

    // Assert
    const anchor = click.mock.instances[0] as HTMLAnchorElement | undefined;
    expect(anchor?.href).toBe('https://storage.example.test/object/sign/key?token=DL');
    click.mockRestore();
  });
});
