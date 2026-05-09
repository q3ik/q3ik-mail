'use client';

import { useState, useTransition } from 'react';
import type { Email, EmailSummary } from '@q3ik-mail/database';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { MailList } from './mail-list';
import { MailDisplay } from './mail-display';
import { fetchThread, markEmailAsRead } from '@/app/actions/mail';

interface MailProps {
  threads: EmailSummary[];
  selectedThread: Email[];
  defaultSelectedId?: string;
}

export function Mail({ threads, selectedThread, defaultSelectedId }: MailProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    defaultSelectedId ?? null
  );
  const [currentThread, setCurrentThread] = useState<Email[]>(selectedThread);
  const [isPending, startTransition] = useTransition();

  function handleSelectThread(threadId: string) {
    if (threadId === selectedThreadId) return;

    startTransition(async () => {
      const emails = await fetchThread(threadId);
      setSelectedThreadId(threadId);
      setCurrentThread(emails);

      // Mark all unread emails in the thread as read concurrently
      const unreadIds = emails.filter((e) => e.is_read === 0).map((e) => e.id);
      if (unreadIds.length > 0) {
        await Promise.all(unreadIds.map((id) => markEmailAsRead(id)));
      }
    });
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      <ResizablePanel defaultSize={30} minSize={20}>
        <MailList
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSelectThread={handleSelectThread}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={70} minSize={30}>
        <div className={isPending ? 'opacity-60 transition-opacity' : ''}>
          <MailDisplay thread={currentThread} />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
