'use client';

import { formatDistanceToNow } from 'date-fns';
import type { EmailSummary } from '@q3ik-mail/database';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface MailListProps {
  threads: EmailSummary[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}

export function MailList({
  threads,
  selectedThreadId,
  onSelectThread,
}: MailListProps) {
  if (threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 p-2">
        {threads.map((thread) => (
          <ThreadRow
            key={thread.thread_id}
            thread={thread}
            isSelected={selectedThreadId === thread.thread_id}
            onSelect={() => onSelectThread(thread.thread_id)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function ThreadRow({
  thread,
  isSelected,
  onSelect,
}: {
  thread: EmailSummary;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isUnread = thread.is_read === 0;
  const senderName = thread.from_name ?? thread.from_address;
  const subject = thread.subject ?? '(no subject)';

  let relativeTime = '';
  try {
    relativeTime = formatDistanceToNow(new Date(thread.created_at), {
      addSuffix: true,
    });
  } catch {
    relativeTime = thread.created_at;
  }

  return (
    <button
      type="button"
      data-testid="mail-list-item"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground',
        isSelected && 'bg-accent text-accent-foreground'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'truncate text-sm',
            isUnread ? 'font-bold' : 'font-medium'
          )}
        >
          {isUnread && (
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-primary align-middle" />
          )}
          {senderName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime}
        </span>
      </div>
      <span
        className={cn(
          'truncate text-sm',
          isUnread ? 'font-semibold' : 'text-muted-foreground'
        )}
      >
        {subject}
      </span>
    </button>
  );
}
