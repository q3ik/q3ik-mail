// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import type { Email, EmailSummary } from '@q3ik-mail/database';
import { Mail } from '../mail';

// --- module mocks -----------------------------------------------------------

vi.mock('@/app/actions/mail', () => ({
  fetchThread: vi.fn(),
  markEmailAsRead: vi.fn(),
}));

// Render children directly so MailList / MailDisplay are exercised through
// our lightweight mock below.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

// Expose `data-is-read` on each row so tests can assert the reverted state
// without coupling to CSS class names.
vi.mock('../mail-list', () => ({
  MailList: ({
    threads,
    onSelectThread,
  }: {
    threads: EmailSummary[];
    onSelectThread: (id: string) => void;
  }) => (
    <ul>
      {threads.map((t) => (
        <li key={t.thread_id}>
          <button
            type="button"
            data-testid={`thread-${t.thread_id}`}
            data-is-read={t.is_read}
            onClick={() => onSelectThread(t.thread_id)}
          >
            {t.subject}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

vi.mock('../mail-display', () => ({
  MailDisplay: () => null,
}));

vi.mock('../compose-dialog', () => ({
  ComposeDialog: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('lucide-react', () => ({ PenSquareIcon: () => null }));

// --- helpers ----------------------------------------------------------------

import * as mailActions from '@/app/actions/mail';

const THREAD_ID = 'thread-abc';

const makeThread = (overrides: Partial<EmailSummary> = {}): EmailSummary => ({
  id: 'email-1',
  thread_id: THREAD_ID,
  resend_id: 'resend-1',
  from_address: 'sender@example.com',
  from_name: 'Sender',
  to_address: 'me@example.com',
  subject: 'Hello',
  body_text: 'Hi there',
  body_html: null,
  message_id: '<msg-1>',
  in_reply_to: null,
  is_read: 0,
  needs_rethreading: 0,
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  thread_id: THREAD_ID,
  resend_id: 'resend-1',
  from_address: 'sender@example.com',
  from_name: 'Sender',
  to_address: 'me@example.com',
  subject: 'Hello',
  body_text: 'Hi there',
  body_html: null,
  message_id: '<msg-1>',
  in_reply_to: null,
  is_read: 0,
  needs_rethreading: 0,
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('Mail — markAsRead error recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('reverts is_read to 0 when markEmailAsRead rejects', async () => {
    const thread = makeThread({ is_read: 0 });
    const email = makeEmail({ is_read: 0 });

    vi.mocked(mailActions.fetchThread).mockResolvedValue([email]);
    vi.mocked(mailActions.markEmailAsRead).mockRejectedValue(new Error('D1 write failed'));

    render(
      <Mail
        threads={[thread]}
        selectedThread={[]}
        defaultSelectedId={undefined}
      />
    );

    // Verify initial unread state
    const btn = screen.getByTestId(`thread-${THREAD_ID}`);
    expect(btn.getAttribute('data-is-read')).toBe('0');

    // Select the thread — triggers the optimistic update then the failing write
    await act(async () => {
      btn.click();
      // Allow microtask queue to drain so the .catch() runs
      await Promise.resolve();
      await Promise.resolve();
    });

    // The optimistic update fires but markEmailAsRead rejects, so is_read
    // must be reverted to 0.
    expect(screen.getByTestId(`thread-${THREAD_ID}`).getAttribute('data-is-read')).toBe('0');
  });

  it('leaves is_read as 1 (read) when markEmailAsRead succeeds', async () => {
    const thread = makeThread({ is_read: 0 });
    const email = makeEmail({ is_read: 0 });

    vi.mocked(mailActions.fetchThread).mockResolvedValue([email]);
    vi.mocked(mailActions.markEmailAsRead).mockResolvedValue(undefined);

    render(
      <Mail
        threads={[thread]}
        selectedThread={[]}
        defaultSelectedId={undefined}
      />
    );

    await act(async () => {
      screen.getByTestId(`thread-${THREAD_ID}`).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId(`thread-${THREAD_ID}`).getAttribute('data-is-read')).toBe('1');
  });

  it('does not call markEmailAsRead when all emails are already read', async () => {
    const thread = makeThread({ is_read: 1 });
    const email = makeEmail({ is_read: 1 });

    vi.mocked(mailActions.fetchThread).mockResolvedValue([email]);

    render(
      <Mail
        threads={[thread]}
        selectedThread={[]}
        defaultSelectedId={undefined}
      />
    );

    await act(async () => {
      screen.getByTestId(`thread-${THREAD_ID}`).click();
      await Promise.resolve();
    });

    expect(mailActions.markEmailAsRead).not.toHaveBeenCalled();
  });
});
