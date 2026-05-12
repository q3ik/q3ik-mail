// @vitest-environment happy-dom
// NOTE: This file targets the happy-dom environment. With the environmentMatchGlobs
// rule in vitest.config.ts, the pragma is now redundant for files in this directory
// but is kept as explicit documentation. happy-dom has known differences from jsdom
// (CSS, custom elements) and from the actual Cloudflare Workers runtime.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor, fireEvent } from '@testing-library/react';
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
    onLoadMore,
    isLoadingMore,
    isSearching,
  }: {
    threads: EmailSummary[];
    onSelectThread: (id: string) => void;
    onLoadMore?: () => void;
    isLoadingMore?: boolean;
    isSearching?: boolean;
  }) => (
    <div>
      {isSearching ? <div data-testid="mail-list-searching">Searching…</div> : null}
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
      {onLoadMore ? (
        <button
          type="button"
          data-testid="load-more"
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          Load more
        </button>
      ) : null}
    </div>
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
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('lucide-react', () => ({ PenSquareIcon: () => null }));

// --- helpers ----------------------------------------------------------------

import * as mailActions from '@/app/actions/mail';

const THREAD_ID = 'thread-abc';

const encodeCursor = (createdAt: string, id: string) =>
  btoa(JSON.stringify({ createdAt, id }));

/**
 * Factory for EmailSummary (thread list rows).
 * EmailSummary omits body_html and body_text from the full Email type.
 * references is included (nullable) to stay in sync with the Email interface.
 */
const makeThread = (overrides: Partial<EmailSummary> = {}): EmailSummary => ({
  id: 'email-1',
  thread_id: THREAD_ID,
  resend_id: 'resend-1',
  from_address: 'sender@example.com',
  from_name: 'Sender',
  to_address: 'me@example.com',
  subject: 'Hello',
  message_id: '<msg-1>',
  in_reply_to: null,
  references: null,
  is_read: 0,
  is_sent: 0,
  needs_rethreading: 0,
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

/**
 * Factory for full Email objects (thread detail rows).
 * Email includes body_html and body_text in addition to all EmailSummary fields.
 * references is included (nullable) to stay in sync with the Email interface.
 */
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
  references: null,
  is_read: 0,
  is_sent: 0,
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
    vi.unstubAllGlobals();
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
    act(() => { btn.click(); });

    // The optimistic update fires but markEmailAsRead rejects, so is_read
    // must be reverted to 0. Use waitFor to poll until the revert settles.
    await waitFor(() =>
      expect(screen.getByTestId(`thread-${THREAD_ID}`).getAttribute('data-is-read')).toBe('0')
    );
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

    act(() => { screen.getByTestId(`thread-${THREAD_ID}`).click(); });

    await waitFor(() =>
      expect(screen.getByTestId(`thread-${THREAD_ID}`).getAttribute('data-is-read')).toBe('1')
    );
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

    act(() => { screen.getByTestId(`thread-${THREAD_ID}`).click(); });

    // Wait for fetchThread to have been called (handleSelectThread completed),
    // then assert markEmailAsRead was never invoked.
    await waitFor(() => expect(mailActions.fetchThread).toHaveBeenCalledWith(THREAD_ID));
    expect(mailActions.markEmailAsRead).not.toHaveBeenCalled();
  });

  it('searches via /api/search and replaces the thread list with results', async () => {
    const initialThread = makeThread({ thread_id: 'thread-initial', subject: 'Initial' });
    const searchedThread = makeThread({
      id: 'email-2',
      thread_id: 'thread-search',
      resend_id: 'resend-2',
      subject: 'Found by search',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [searchedThread],
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Mail
        threads={[initialThread]}
        selectedThread={[]}
        defaultSelectedId={undefined}
      />
    );

    const searchInput = screen.getByLabelText('Search emails');
    fireEvent.change(searchInput, { target: { value: 'search' } });
    act(() => { screen.getByRole('button', { name: 'Search' }).click(); });

    await waitFor(() =>
      expect(screen.queryByTestId('thread-thread-search')).not.toBeNull()
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/search?q=search');
    expect(screen.queryByTestId('thread-thread-initial')).toBeNull();
  });

  it('keeps newest search results when an older search resolves later', async () => {
    const initialThread = makeThread({ thread_id: 'thread-initial', subject: 'Initial' });
    const slowSearchThread = makeThread({
      id: 'email-2',
      thread_id: 'thread-slow',
      resend_id: 'resend-2',
      subject: 'Slow result',
    });
    const fastSearchThread = makeThread({
      id: 'email-3',
      thread_id: 'thread-fast',
      resend_id: 'resend-3',
      subject: 'Fast result',
    });

    let resolveSlow: ((value: unknown) => void) | undefined;
    let resolveFast: ((value: unknown) => void) | undefined;
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    const fastPromise = new Promise((resolve) => {
      resolveFast = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(slowPromise)
      .mockReturnValueOnce(fastPromise);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Mail
        threads={[initialThread]}
        selectedThread={[]}
        defaultSelectedId={undefined}
      />
    );

    const searchInput = screen.getByLabelText('Search emails');
    const searchForm = searchInput.closest('form');
    expect(searchForm).not.toBeNull();

    fireEvent.change(searchInput, { target: { value: 'slow' } });
    act(() => { fireEvent.submit(searchForm!); });
    expect(screen.queryByTestId('mail-list-searching')).not.toBeNull();

    fireEvent.change(searchInput, { target: { value: 'fast' } });
    act(() => { fireEvent.submit(searchForm!); });

    resolveFast?.({
      ok: true,
      json: async () => [fastSearchThread],
    });
    await waitFor(() => expect(screen.queryByTestId('thread-thread-fast')).not.toBeNull());

    resolveSlow?.({
      ok: true,
      json: async () => [slowSearchThread],
    });
    await Promise.resolve();

    expect(screen.queryByTestId('thread-thread-fast')).not.toBeNull();
    expect(screen.queryByTestId('thread-thread-slow')).toBeNull();
  });

  it('appends threads from the next cursor page and hides load more when exhausted', async () => {
    const nextThread = makeThread({
      id: 'email-2',
      thread_id: 'thread-def',
      resend_id: 'resend-2',
      subject: 'Later message',
      created_at: '2024-01-02T00:00:00Z',
    });
    const duplicateThread = makeThread({
      id: 'email-1',
      thread_id: THREAD_ID,
      created_at: '2024-01-02T00:00:00Z',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        threads: [duplicateThread, nextThread],
        nextCursor: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Mail
        threads={[
          makeThread({
            created_at: '2024-01-02T00:00:00Z',
          }),
        ]}
        selectedThread={[]}
        defaultSelectedId={undefined}
        initialNextCursor={encodeCursor('2024-01-02T00:00:00Z', 'email-1')}
      />
    );

    screen.getByTestId('load-more').click();

    await waitFor(() =>
      expect(screen.queryByTestId('thread-thread-def')).not.toBeNull()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/emails?cursor=${encodeURIComponent(
        encodeCursor('2024-01-02T00:00:00Z', 'email-1')
      )}`
    );
    expect(screen.getAllByTestId(`thread-${THREAD_ID}`)).toHaveLength(1);
    expect(screen.queryByTestId('load-more')).toBeNull();
  });

  it('keeps one row when load-more payload repeats an existing thread_id', async () => {
    const duplicateThread = makeThread({
      id: 'email-2',
      thread_id: THREAD_ID,
      resend_id: 'resend-2',
      created_at: '2024-01-02T00:00:00Z',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        threads: [duplicateThread],
        nextCursor: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Mail
        threads={[makeThread()]}
        selectedThread={[]}
        defaultSelectedId={undefined}
        initialNextCursor={encodeCursor('2024-01-02T00:00:00Z', 'email-1')}
      />
    );

    screen.getByTestId('load-more').click();

    await waitFor(() => expect(screen.queryByTestId('load-more')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId(`thread-${THREAD_ID}`)).toHaveLength(1);
  });
});
