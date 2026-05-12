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

  // Bug #3 fix: monotonically-increasing token for handleSelectThread to guard
  // against out-of-order fetchThread responses. Kept separate from searchTokenRef
  // so that a concurrent thread-selection cannot cancel an in-flight search result
  // (or vice-versa) by incrementing the wrong counter.
  const requestTokenRef = useRef(0);

  // Dedicated token for handleSearch. Isolated from requestTokenRef so that
  // thread-selections and searches never race against each other's counters.
  const searchTokenRef = useRef(0);

  // Stable ref for initialThreads/initialNextCursor so that handleSearch's dep
  // array does not capture the prop snapshot at mount time. This prevents the
  // search-clear path from reverting threads to stale pre-load-more state.
  const initialThreadsRef = useRef(initialThreads);
  const initialNextCursorRef = useRef(initialNextCursor);

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
      setThreads(initialThreadsRef.current);
      setNextCursor(initialNextCursorRef.current);
      return;
    }

    // Race-condition guard: capture a token before the async fetch.
    // If a newer search fires before this one resolves, discard this result
    // without touching isSearching — the newer search owns that state.
    const token = ++searchTokenRef.current;

    setIsSearching(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`);
      if (!response.ok) {
        throw new Error(`Failed to search emails (${response.status})`);
      }

      const payload = (await response.json()) as EmailSummary[];

      // Stale response: a newer search has already been dispatched.
      // Do NOT call setIsSearching(false) here — the active search is still
      // in flight and owns the spinner. Clearing it here would hide the
      // loading indicator prematurely.
      if (token !== searchTokenRef.current) return;

      setThreads(payload);
      setNextCursor(null);
      setIsSearching(false);
    } catch (err) {
      // Only clear the spinner if this is still the active search.
      // A stale error must not cancel the loading state of a newer request.
      if (token === searchTokenRef.current) {
        setIsSearching(false);
      }
      console.error('[mail] search failed:', err);
    }
  }, [searchQuery]);

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
    // that were successfully written; only a batch with >=1 failure triggers a
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
              isSearching={isSearching}
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
