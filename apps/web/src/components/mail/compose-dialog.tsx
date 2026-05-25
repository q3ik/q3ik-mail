'use client';

import { useState, useTransition } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

export interface ComposePayload {
  to?: string;
  subject?: string;
  replyToId?: string;   // RFC 2822 Message-ID of the email being replied to (used in In-Reply-To header)
  references?: string;  // RFC 2822 References header value from the replied-to email (echoed verbatim to build the chain)
}

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ComposePayload;
}

export function ComposeDialog({ open, onOpenChange, initial }: ComposeDialogProps) {
  const [to, setTo] = useState(initial?.to ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Reset form fields whenever the dialog opens with new initial values
  // (important when switching between compose and reply)
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setTo(initial?.to ?? '');
      setSubject(initial?.subject ?? '');
      setContent('');
      setError(null);
    }
    onOpenChange(next);
  };

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to,
            subject,
            content,
            replyToId: initial?.replyToId,
            references: initial?.references,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError((data as { error?: string }).error ?? 'Failed to send email');
          return;
        }

        onOpenChange(false);
      } catch {
        setError('Network error — please try again');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px] rounded-[14px]">
        <DialogHeader>
          <DialogTitle>
            {initial?.replyToId ? 'Reply' : 'New Message'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="compose-to">To</Label>
            <Input
              id="compose-to"
              type="email"
              placeholder="recipient@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              disabled={isPending}
              className="rounded-[10px] focus-glow"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input
              id="compose-subject"
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              disabled={isPending}
              className="rounded-[10px] focus-glow"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="compose-content">Message</Label>
            <Textarea
              id="compose-content"
              placeholder="Write your message…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              disabled={isPending}
              className="rounded-[10px] focus-glow min-h-[120px]"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
              className="rounded-[10px]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending}
              className="rounded-[10px] glow-primary glow-primary-hover transition-all"
            >
              {isPending ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
