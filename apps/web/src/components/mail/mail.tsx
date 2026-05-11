'use client';

import { useState, useTransition, useRef } from 'react';
import type { Email, EmailSummary } from '@q3ik-mail/database';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { PenSquareIcon } from 'lucide-react';
import { MailList } from './mail-list';
import { MailDisplay } from './mail-display';
import { ComposeDialog, type ComposePayload } from './compose-dialog';
import { fetchThread, markEmailAsRead } from '@/app/actions/mail';

interface MailProps {
  threads: EmailSummary[];
  selectedThread: Email[];
  defaultSelectedId?: string;
}

export function Mail({ threads: initialThreads, selectedThread, defaultSelectedId }: MailProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    defaultSelectedId ?? null
  );
  const [currentThread, setCurrentThread] = useState<Email[]>(selectedThread);
  // Bug #6 fix: lift threads into state so we can optimistically update is_read
  const [threads, setThreads] = useState<EmailSummary[]>(initialThreads);
  const [isPending, startTransition] = useTransition();

  // Bug #3 fix: monotonically-increasing token to guard against out-of-order responses
  const requestTokenRef = useRef(0);

  const [composeOpen, setComposeOpen] = useState(false);
  const [composePayload, setComposePayload] = useState<ComposePayload | undefined>();

  function openCompose(payload?: ComposePayload) {
    setComposePayload(payload);
    setComposeOpen(true);
  }

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

    // Fire-and-forget the DB writes after UI is already updated
    const unreadIds = emails.filter((e) => e.is_read === 0).map((e) => e.id);
    if (unreadIds.length > 0) {
      void Promise.all(unreadIds.map((id) => markEmailAsRead(id)));
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
            <MailList
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectThread={handleSelectThread}
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
