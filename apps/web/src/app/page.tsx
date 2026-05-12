export const runtime = 'edge';

import { fetchThreadListPage, fetchThread } from '@/app/actions/mail';
import { Mail } from '@/components/mail/mail';

export default async function InboxPage() {
  const { threads, nextCursor } = await fetchThreadListPage(50);

  const firstThreadId = threads[0]?.thread_id ?? null;
  const initialThread = firstThreadId ? await fetchThread(firstThreadId) : [];

  return (
    <main className="h-screen overflow-hidden">
      <Mail
        threads={threads}
        selectedThread={initialThread}
        defaultSelectedId={firstThreadId ?? undefined}
        initialNextCursor={nextCursor}
      />
    </main>
  );
}
