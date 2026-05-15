import { afterEach, describe, expect, it, vi } from 'vitest';

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
const withScopeMock = vi.fn((cb: (scope: unknown) => void) => {
  cb({
    setLevel: vi.fn(),
    setTags: vi.fn(),
    setExtras: vi.fn(),
  });
});

vi.mock('@sentry/nextjs', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
  withScope: withScopeMock,
}));

describe('captureException', () => {
  afterEach(() => {
    captureExceptionMock.mockReset();
  });

  it('delegates to @sentry/nextjs', async () => {
    const { captureException } = await import('../sentry');
    const error = new Error('test');

    captureException(error);

    expect(captureExceptionMock).toHaveBeenCalledWith(error);
  });

  it('does not throw when the underlying SDK call fails', async () => {
    captureExceptionMock.mockImplementation(() => {
      throw new Error('SDK failure');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { captureException } = await import('../sentry');

    // Should not throw
    expect(() => captureException(new Error('original'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('captureMessage', () => {
  afterEach(() => {
    captureMessageMock.mockReset();
    withScopeMock.mockClear();
  });

  it('sends a plain message', async () => {
    const { captureMessage } = await import('../sentry');

    captureMessage('hello');

    expect(captureMessageMock).toHaveBeenCalledWith('hello');
  });

  it('uses withScope when context is provided', async () => {
    const { captureMessage } = await import('../sentry');

    captureMessage('tagged', {
      level: 'warning',
      tags: { foo: 'bar' },
      extra: { detail: 42 },
    });

    expect(withScopeMock).toHaveBeenCalled();
    expect(captureMessageMock).toHaveBeenCalledWith('tagged');
  });
});
