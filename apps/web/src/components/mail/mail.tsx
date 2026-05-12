'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import type { FormEvent } from 'react';
import type { Email, EmailSummary } from '@q3ik-mail/database';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PenSquareIcon } from 'lucide-react';
import { MailList } from './mail-list';
import { MailDisplay } from './mail-display';
import { ComposeDialog, type ComposePayload } from './compose-dialog';
import { fetchThread, markEmailAsRead } from '@/app/actions/mail';

interface MailProps {
  threads: EmailSummary[];
  selectedThread: Email[];
  defaultSelectedId?: string;
  initialNextCursor?: string | null;
}

export function Mail({
  threads: initialThreads,
  selectedThread,
  defaultSelectedId,
  initialNextCursor = null,
}: MailProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    defaultSelectedId ?? null
  );
  const [currentThread, setCurrentThread] = useState<Email[]>(selectedThread);
  // Bug #6 fix: lift threads into state so we can optimistically update is_read
  const [threads, setThreads] = useState<EmailSummary[]>(initialThreads);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Bug #3 fix: monotonically-increasing token to guard against out-of-order responses
  const requestTokenRef = useRef(0);

  const [composeOpen, setComposeOpen] = useState(false);
  const [composePayload, setComposePayload] = useState<ComposePayload | undefined>();

  function openCompose(payload?: ComposePayload) {
    setComposePayload(payload ?? undefined);
    setComposeOpen(true);
  }

  const handleSearch = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      setThreads(initialThreads);
      setNextCursor(initialNextCursor);
      return;
    }

    setIsSearching(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`);
      if (!response.ok) {
        throw new Error(`Failed to search emails (${response.status})`);
      }

      const payload = (await response.json()) as EmailSummary[];
      setThreads(payload);
      setNextCursor(null);
    } catch (err) {
      console.error('[mail] search failed:', err);
    } finally {
      setIsSearching(false);
    }
  }, [initialNextCursor, initialThreads, searchQuery]);

  const handleLoadMore = useCallback(async function handleLoadMore() {
    if (!nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);

    try {
      const response = await fetch(
        `/api/emails?cursor=${encodeURIComponent(nextCursor)}`
      );

      if (!response.ok) {
        throw new Error(`Failed to load more emails (${response.status})`);
      }

      const payload = (await response.json()) as {
        threads: EmailSummary[];
        nextCursor: string | null;
      };

      // Deduplicate by thread_id when appending in case cursor drift or
      // concurrent inbound email causes an existing thread to reappear.
      setThreads((prev) => {
        const seenThreadIds = new Set(prev.map((thread) => thread.thread_id));
        return [
          ...prev,
          ...payload.threads.filter((thread) => !seenThreadIds.has(thread.thread_id)),
        ];
      });
      setNextCursor(payload.nextCursor);
    } catch (err) {
      console.error('[mail] load more failed:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, nextCursor]);

  async function handleSelectThread(threadId: string) {
    if (threadId === selectedThreadId) return;

    // Increment token for this request; capture it in the closure
    const token = ++requestTokenRef.current;

    // Bug #5 fix: run async fetch OUTSIDE startTransition so isPending is
    // reliable from the moment the user clicks until state is committed.
    const emails = await fetchThread(threadId);

    // Bug #3 fix: discard response if a newer selection has already been made
    if (token !== requestTokenRef.current) return;

    // Bug #5 fix: wrap only the synchronous state updates in startTransition
    startTransition(() => {
      setSelectedThreadId(threadId);
      setCurrentThread(emails);

      // Bug #6 fix: optimistically mark the selected thread as read in the list
      setThreads((prev) =>
        prev.map((t) =>
          t.thread_id === threadId ? { ...t, is_read: 1 } : t
        )
      );
    });

    // Persist the DB writes after the UI is already updated.
    // Non-blocking: this .then() callback runs after handleSelectThread returns
    // and the component may have unmounted by the time it executes. Calling
    // setThreads on an unmounted component in React 18+ is a safe no-op.
    // Per-email tracking: allSettled preserves the optimistic update for emails
    // that were successfully written; only a batch with ≥1 failure triggers a
    // thread-level revert (the thread list holds one EmailSummary per thread,
    // so a coarser thread-level revert is the correct granularity here).
    const unreadIds = emails.filter((e) => e.is_read === 0).map((e) => e.id);
    if (unreadIds.length > 0) {
      Promise.allSettled(unreadIds.map((id) => markEmailAsRead(id))).then((results) => {
        const hasFailed = results.some((r) => r.status === 'rejected');
        if (hasFailed) {
          console.error(
            '[mail] markAsRead batch failed, reverting optimistic update',
            unreadIds.filter((_, i) => results[i].status === 'rejected'),
          );
          setThreads((prev) =>
            prev.map((t) =>
              t.thread_id === threadId ? { ...t, is_read: 0 } : t
            )
          );
        }
      });
    }
  }

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={30} minSize={20}>
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between p-3 border-b">
              <span className="text-sm font-semibold">Inbox</span>
              <Button variant="outline" size="sm" onClick={() => openCompose()}>
                <PenSquareIcon className="h-4 w-4 mr-1.5" />
                Compose
              </Button>
            </div>
            <form className="border-b p-3" onSubmit={handleSearch}>
              <div className="flex gap-2">
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search"
                  aria-label="Search emails"
                />
                <Button type="submit" variant="outline" size="sm" disabled={isSearching}>
                  {isSearching ? 'Searching…' : 'Search'}
                </Button>
              </div>
            </form>
            <MailList
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectThread={handleSelectThread}
              onLoadMore={nextCursor ? handleLoadMore : undefined}
              isLoadingMore={isLoadingMore}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={70} minSize={30}>
          <div className={isPending ? 'opacity-60 transition-opacity' : ''}>
            <MailDisplay
              thread={currentThread}
              onReply={(payload) => openCompose(payload)}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <ComposeDialog
        open={composeOpen}
        onOpenChange={(open) => {
          setComposeOpen(open);
          if (!open) setComposePayload(undefined);
        }}
        initial={composePayload}
      />
    </>
  );
}
