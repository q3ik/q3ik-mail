'use client';

import { useState } from 'react';
import type { Email } from '@q3ik-mail/database';
import { Button } from '@/components/ui/button';

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replyTo?: Email | null;
}

export function ComposeDialog({ open, onOpenChange, replyTo }: ComposeDialogProps) {
  const [to, setTo] = useState(replyTo?.from_address ?? '');
  const [subject, setSubject] = useState(
    replyTo?.subject ? `Re: ${replyTo.subject.replace(/^Re:\s*/i, '')}` : ''
  );
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSend() {
    if (!to || !subject) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          subject,
          content,
          replyToMessageId: replyTo?.message_id ?? undefined,
          references: replyTo?.in_reply_to ?? undefined,
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? 'Failed to send');
      }
      onOpenChange(false);
      setTo('');
      setSubject('');
      setContent('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-lg border bg-background shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50 rounded-t-lg">
          <span className="text-sm font-semibold">
            {replyTo ? 'Reply' : 'New Message'}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close compose"
          >
            ✕
          </button>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-0">
          <div className="flex items-center border-b px-4 py-2 gap-2">
            <label htmlFor="compose-to" className="text-xs text-muted-foreground w-12 shrink-0">
              To
            </label>
            <input
              id="compose-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="flex-1 text-sm bg-transparent outline-none"
            />
          </div>
          <div className="flex items-center border-b px-4 py-2 gap-2">
            <label htmlFor="compose-subject" className="text-xs text-muted-foreground w-12 shrink-0">
              Subject
            </label>
            <input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 text-sm bg-transparent outline-none"
            />
          </div>
          <textarea
            id="compose-body"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder="Write your message here..."
            className="px-4 py-3 text-sm bg-transparent outline-none resize-none"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t">
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2 ml-auto">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Discard
            </Button>
            <Button
              size="sm"
              onClick={handleSend}
              disabled={sending || !to || !subject}
            >
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
