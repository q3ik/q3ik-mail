// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import type { Email } from '@q3ik-mail/database';

// ---------------------------------------------------------------------------
// DOMPurify mock — synchronous stub so tests don't need a real DOM purifier.
// Hook logic (url() stripping) is tested by extracting and calling the
// registered hook function directly.
// ---------------------------------------------------------------------------

const mockSanitize = vi.fn((html: string) => html);
const mockAddHook = vi.fn();

vi.mock('isomorphic-dompurify', () => ({
  default: {
    sanitize: mockSanitize,
    addHook: mockAddHook,
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('lucide-react', () => ({ ReplyIcon: () => null }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  thread_id: 'thread-1',
  resend_id: 'resend-1',
  from_address: 'sender@example.com',
  from_name: 'Sender',
  to_address: 'me@example.com',
  subject: 'Test Subject',
  body_html: '<p style="color:red">Hello <b>world</b></p>',
  body_text: null,
  message_id: '<msg-1>',
  in_reply_to: null,
  references: null,
  is_read: 1,
  is_sent: 0,
  needs_rethreading: 0,
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

async function sanitizeWithAppConfig(MailDisplay: React.ComponentType<{ thread: Email[] }>, html: string) {
  render(<MailDisplay thread={[makeEmail({ body_html: html })]} />);
  await waitFor(() => expect(mockSanitize).toHaveBeenCalled());

  const [, options] = mockSanitize.mock.calls[0] as [string, Record<string, unknown>];
  const { default: realDOMPurify } =
    await vi.importActual<typeof import('isomorphic-dompurify')>('isomorphic-dompurify');

  return {
    options,
    sanitized: realDOMPurify.sanitize(html, options),
  };
}

// ---------------------------------------------------------------------------

describe('MailDisplay — sanitization (C-1 fix)', () => {
  let MailDisplay: React.ComponentType<{ thread: Email[]; onReply?: (payload: unknown) => void }>;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../mail-display');
    MailDisplay = mod.MailDisplay;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders an empty-state message when thread is empty', async () => {
    render(<MailDisplay thread={[]} />);
    expect(screen.getByText('Select a thread to read')).toBeTruthy();
  });

  it('calls DOMPurify.sanitize with FORCE_BODY and USE_PROFILES for an HTML email', async () => {
    const html = '<p style="color:red;font-size:14px">Hello</p>';
    const email = makeEmail({ body_html: html, body_text: null });

    render(<MailDisplay thread={[email]} />);

    await waitFor(() =>
      expect(mockSanitize).toHaveBeenCalledWith(
        html,
        expect.objectContaining({
          USE_PROFILES: { html: true },
          ALLOW_DATA_ATTR: false,
          FORCE_BODY: true,
        }),
      ),
    );
  });

  it('does NOT pass FORBID_ATTR containing "style" (regression for C-1)', async () => {
    const { options, sanitized } = await sanitizeWithAppConfig(
      MailDisplay,
      '<p style="margin:0" onmouseover="alert(1)">Hi</p>',
    );
    const forbidAttr = options['FORBID_ATTR'] as string[] | undefined;

    expect(forbidAttr ?? []).not.toContain('style');
    expect(sanitized).toContain('style="margin:0"');
    expect(sanitized).not.toContain('onmouseover');
  });

  it('strips onclick while preserving safe style rules with the configured sanitize options', async () => {
    const html = '<table><tr><td style="color:red;padding:8px" onclick="alert(1)">Hi</td></tr></table>';
    const { sanitized } = await sanitizeWithAppConfig(MailDisplay, html);

    expect(sanitized).toContain('style="color:red;padding:8px"');
    expect(sanitized).not.toContain('onclick');
  });

  it('strips script tags with the configured sanitize options', async () => {
    const html = '<p>Hello</p><script>alert(1)</script>';
    const { options, sanitized } = await sanitizeWithAppConfig(MailDisplay, html);
    const forbidTags = options['FORBID_TAGS'] as string[] | undefined;
    expect(forbidTags ?? []).toEqual(expect.arrayContaining(['script', 'object', 'embed', 'form']));

    expect(sanitized).toContain('<p>Hello</p>');
    expect(sanitized).not.toContain('<script');
  });

  it('registers the afterSanitizeAttributes hook exactly once across multiple email renders', async () => {
    const email1 = makeEmail({ id: 'e1', body_html: '<p>One</p>' });
    const email2 = makeEmail({ id: 'e2', body_html: '<p>Two</p>' });

    render(<MailDisplay thread={[email1, email2]} />);

    await waitFor(() => expect(mockSanitize).toHaveBeenCalledTimes(2));
    expect(mockAddHook).toHaveBeenCalledTimes(1);
    expect(mockAddHook).toHaveBeenCalledWith('afterSanitizeAttributes', expect.any(Function));
  });

  it('renders sanitized HTML inside an <iframe> with sandbox=""', async () => {
    const sanitizedContent = '<p>Safe content</p>';
    mockSanitize.mockReturnValue(sanitizedContent);

    const email = makeEmail({ body_html: '<p>Raw</p>' });
    render(<MailDisplay thread={[email]} />);

    const iframe = await screen.findByTitle('Email body');
    expect(iframe.tagName.toLowerCase()).toBe('iframe');
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(
      (iframe as HTMLIFrameElement).srcdoc ?? iframe.getAttribute('srcdoc'),
    ).toBe(sanitizedContent);
  });

  it('strips url() from style attributes via the afterSanitizeAttributes hook', async () => {
    render(<MailDisplay thread={[makeEmail()]} />);

    await waitFor(() => expect(mockAddHook).toHaveBeenCalled());
    const hookFn = mockAddHook.mock.calls[0][1] as (node: Element) => void;

    const el = document.createElement('div');
    el.setAttribute(
      'style',
      'background-image: url(https://tracker.example.com/pixel.png); color: red',
    );
    hookFn(el);

    const result = el.getAttribute('style') ?? '';
    expect(result).not.toContain('url(');
    expect(result).toContain('color: red');
  });

  it('preserves style attributes that contain no url() value', async () => {
    render(<MailDisplay thread={[makeEmail()]} />);

    await waitFor(() => expect(mockAddHook).toHaveBeenCalled());
    const hookFn = mockAddHook.mock.calls[0][1] as (node: Element) => void;

    const el = document.createElement('p');
    const originalStyle = 'color: red; font-size: 14px; margin: 0';
    el.setAttribute('style', originalStyle);
    hookFn(el);

    expect(el.getAttribute('style')).toBe(originalStyle);
  });

  it('does not call DOMPurify.sanitize for plain-text-only emails', async () => {
    const email = makeEmail({ body_html: null, body_text: 'Plain text here' });
    render(<MailDisplay thread={[email]} />);

    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(mockSanitize).not.toHaveBeenCalled();
    expect(screen.getByText('Plain text here')).toBeTruthy();
  });

  it('shows loading state while body is being fetched from /api/emails/:id/body', async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    const email = makeEmail({ body_html: null, body_text: null });
    render(<MailDisplay thread={[email]} />);

    expect(screen.getByText('Loading email content...')).toBeTruthy();

    resolveFetch({
      ok: true,
      json: async () => ({ body_html: null, body_text: 'loaded' }),
    });
    await waitFor(() =>
      expect(screen.queryByText('Loading email content...')).toBeNull(),
    );
  });

  it('shows error state when the body fetch returns a non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const email = makeEmail({ body_html: null, body_text: null });
    render(<MailDisplay thread={[email]} />);

    await waitFor(() =>
      expect(screen.getByText('Unable to load email body.')).toBeTruthy(),
    );
  });

  it('shows (no body) when the fetched payload has neither html nor text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body_html: null, body_text: null }),
    }));

    const email = makeEmail({ body_html: null, body_text: null });
    render(<MailDisplay thread={[email]} />);

    await waitFor(() =>
      expect(screen.getByText('(no body)')).toBeTruthy(),
    );
  });
});
