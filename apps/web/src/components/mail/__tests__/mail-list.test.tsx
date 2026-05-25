import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MailList } from '../mail-list';
import type { EmailSummary } from '@q3ik-mail/database';
import { afterEach } from 'vitest';

// Mock ScrollArea to just render its children
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock date-fns
vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '10 minutes ago'),
  isToday: vi.fn(() => false),
  isYesterday: vi.fn(() => false),
  format: vi.fn(() => 'Jan 1'),
}));

const mockThreads: EmailSummary[] = [
  {
    id: '1',
    thread_id: 'thread-1',
    resend_id: 'resend-1',
    from_address: 'alice@example.com',
    from_name: 'Alice',
    to_address: 'me@example.com',
    subject: 'Hello',
    message_id: 'msg-1',
    in_reply_to: null,
    references: null,
    is_read: 1,
    is_sent: 0,
    needs_rethreading: 0,
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    thread_id: 'thread-2',
    resend_id: 'resend-2',
    from_address: 'bob@example.com',
    from_name: null,
    to_address: 'me@example.com',
    subject: 'Meeting',
    message_id: 'msg-2',
    in_reply_to: null,
    references: null,
    is_read: 0,
    is_sent: 0,
    needs_rethreading: 0,
    created_at: '2024-01-01T01:00:00Z',
  },
];

describe('MailList', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders "No messages" when threads are empty', () => {
    render(
      <MailList
        threads={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText('No messages')).toBeDefined();
  });

  it('renders "Searching…" when isSearching is true', () => {
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        isSearching={true}
      />
    );
    expect(screen.getByText('Searching…')).toBeDefined();
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('renders a list of threads', () => {
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('bob@example.com')).toBeDefined(); // Falls back to address when name is null
    expect(screen.getByText('Meeting')).toBeDefined();
  });

  it('calls onSelectThread when a thread is clicked', () => {
    const onSelectThread = vi.fn();
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId={null}
        onSelectThread={onSelectThread}
      />
    );

    fireEvent.click(screen.getByText('Alice'));
    expect(onSelectThread).toHaveBeenCalledWith('thread-1');
  });

  it('highlights the selected thread', () => {
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId="thread-1"
        onSelectThread={vi.fn()}
      />
    );

    const aliceButton = screen.getByText('Alice').closest('button');
    expect(aliceButton?.className).toContain('bg-accent');
  });

  it('shows "Load more" button and calls onLoadMore when clicked', () => {
    const onLoadMore = vi.fn();
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onLoadMore={onLoadMore}
      />
    );

    const loadMoreButton = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(loadMoreButton);
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('shows "Loading…" on load more button when isLoadingMore is true', () => {
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onLoadMore={vi.fn()}
        isLoadingMore={true}
      />
    );

    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Loading…' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders unread state correctly', () => {
    render(
      <MailList
        threads={mockThreads}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />
    );

    // Alice is read (is_read: 1), Bob is unread (is_read: 0)
    const aliceName = screen.getByText('Alice');
    const bobName = screen.getByText('bob@example.com');

    expect(aliceName.className).toContain('font-medium');
    expect(bobName.className).toContain('font-bold');

    const bobSubject = screen.getByText('Meeting');
    expect(bobSubject.className).toContain('font-semibold');
  });
});
