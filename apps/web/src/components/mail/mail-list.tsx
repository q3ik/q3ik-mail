'use client';

import { formatDistanceToNow, isToday, isYesterday, format } from 'date-fns';
import type { EmailSummary } from '@q3ik-mail/database';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { getAvatarGradient } from '@/lib/avatars';

interface MailListProps {
  threads: EmailSummary[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  isSearching?: boolean;
}

/** Get initials from sender name or email address. */
function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/** Get a date label for grouping threads. */
function getDateLabel(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'EEEE, MMM d');
  } catch {
    return '';
  }
}

/** Get relative time display. */
function getRelativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isToday(date)) return format(date, 'h:mm a');
    if (isYesterday(date)) return format(date, 'h:mm a');
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return dateStr;
  }
}

export function MailList({
  threads,
  selectedThreadId,
  onSelectThread,
  onLoadMore,
  isLoadingMore = false,
  isSearching = false,
}: MailListProps) {
  if (isSearching) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Searching…
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages
      </div>
    );
  }

  // Group threads by date.
  // currentLabel starts as null so the first thread always creates a group,
  // even if getDateLabel returns '' (invalid date fallback).
  const groups: { label: string; threads: EmailSummary[] }[] = [];
  let currentLabel: string | null = null;
  for (const thread of threads) {
    const label = getDateLabel(thread.created_at);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, threads: [thread] });
    } else {
      groups[groups.length - 1].threads.push(thread);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 px-2.5 pb-2.5">
        {groups.map((group) => (
          <div key={group.label}>
            {group.label && (
              <div className="px-2.5 pt-3 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.06em]">
                {group.label}
              </div>
            )}
            {group.threads.map((thread) => (
              <ThreadRow
                key={thread.thread_id}
                thread={thread}
                isSelected={selectedThreadId === thread.thread_id}
                onSelect={() => onSelectThread(thread.thread_id)}
              />
            ))}
          </div>
        ))}
        {onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="mt-2 rounded-[10px] border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
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
  const relativeTime = getRelativeTime(thread.created_at);
  const gradient = getAvatarGradient(senderName);

  return (
    <button
      type="button"
      data-testid="mail-list-item"
      onClick={onSelect}
      className={cn(
        'flex w-full gap-3 rounded-xl px-3 py-3 text-left transition-all',
        'hover:bg-accent/60',
        isSelected && 'bg-accent text-accent-foreground'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center text-white font-semibold text-[15px] shrink-0',
          gradient
        )}
      >
        {getInitial(senderName)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span
            className={cn(
              'truncate text-sm',
              isUnread ? 'font-bold' : 'font-medium'
            )}
          >
            {isUnread && (
              <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full bg-primary align-middle shadow-[0_0_8px_oklch(0.714_0.203_305_/_40%)]" />
            )}
            {senderName}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground font-mono">
            {relativeTime}
          </span>
        </div>
        <span
          className={cn(
            'truncate text-[13px] block',
            isUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'
          )}
        >
          {subject}
        </span>
      </div>
    </button>
  );
}
