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
import { PlusIcon, BellIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
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
      {/* ── Top Navigation Bar ── */}
      <div className="flex items-center justify-between border-b border-border bg-background px-6 h-[52px] shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#c084fc] to-[#f472b6] flex items-center justify-center font-mono font-bold text-xs text-white tracking-tight">
              q3
            </div>
            <span className="text-[15px] font-semibold tracking-tight">q3ik mail</span>
          </Link>
          <nav className="flex gap-0.5 ml-2">
            <button className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-secondary text-foreground transition-colors">
              Inbox
            </button>
            <button className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors">
              Sent
            </button>
            <button className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors">
              Drafts
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-[34px] h-[34px] rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors">
            <BellIcon className="w-[17px] h-[17px]" />
          </button>
          <div className="w-[30px] h-[30px] rounded-full bg-gradient-to-br from-[#f472b6] to-[#c084fc] flex items-center justify-center font-semibold text-xs text-white cursor-pointer">
            J
          </div>
        </div>
      </div>

      {/* ── Main Content ── */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={30} minSize={20}>
          <div className="flex flex-col h-full bg-card">
            {/* Panel Header */}
            <div className="flex items-center justify-between p-4">
              <span className="text-lg font-bold tracking-tight">Inbox</span>
              <Button
                size="sm"
                onClick={() => openCompose()}
                className="bg-primary text-primary-foreground glow-primary glow-primary-hover rounded-[10px] font-semibold text-[13px] px-3.5 gap-1.5 transition-all"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                New
              </Button>
            </div>

            {/* Search */}
            <form className="px-4 pb-3.5" onSubmit={handleSearch}>
              <div className="relative">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search conversations…"
                  aria-label="Search emails"
                  className="pl-9 rounded-[10px] bg-background border-border focus-glow transition-all h-9"
                />
                <button
                  type="submit"
                  disabled={isSearching}
                  className="sr-only"
                  aria-label={isSearching ? 'Searching…' : 'Search'}
                >
                  {isSearching ? 'Searching…' : 'Search'}
                </button>
              </div>
            </form>

            {/* Thread List */}
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
        <ResizableHandle className="w-px bg-border hover:bg-primary/20 transition-colors" />
        <ResizablePanel defaultSize={70} minSize={30}>
          <div className={isPending ? 'opacity-60 transition-opacity h-full' : 'h-full'}>
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
