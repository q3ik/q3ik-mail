import { useEffect, useState } from 'react';
import type { Email } from '@q3ik-mail/database';
import { ReplyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ComposePayload } from '@/components/mail/compose-dialog';

const sanitizeOptions = {
  USE_PROFILES: { html: true },
  FORBID_ATTR: ['style'],
};

let domPurifyPromise: Promise<typeof import('isomorphic-dompurify')> | undefined;

function loadDomPurify() {
  domPurifyPromise ??= import('isomorphic-dompurify');
  return domPurifyPromise;
}

interface MailDisplayProps {
  thread: Email[];
  onReply?: (payload: ComposePayload) => void;
}

export function MailDisplay({ thread, onReply }: MailDisplayProps) {
  if (thread.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a thread to read
      </div>
    );
  }

  const lastEmailId = thread[thread.length - 1].id;

  return (
    <div data-testid="mail-display" className="flex flex-col gap-4 p-4 overflow-auto h-full">
      {thread.map((email) => (
        <EmailCard
          key={email.id}
          email={email}
          onReply={email.id === lastEmailId ? onReply : undefined}
        />
      ))}
    </div>
  );
}

function EmailCard({ email, onReply }: { email: Email; onReply?: (payload: ComposePayload) => void }) {
  const senderName = email.from_name ?? email.from_address;
  const date = new Date(email.created_at).toLocaleString();

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-4 shadow-sm',
        email.is_read === 0 && 'border-primary/30'
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span className={cn('text-sm font-medium', email.is_read === 0 && 'font-bold')}>
            {senderName}
          </span>
          <span className="text-xs text-muted-foreground">{email.from_address}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{date}</span>
          {onReply && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() =>
                onReply({
                  to: email.from_address,
                  subject: email.subject?.startsWith('Re: ')
                    ? email.subject
                    : `Re: ${email.subject ?? ''}`,
                  replyToId: email.id,
                  references: email.thread_id,
                })
              }
            >
              <ReplyIcon className="h-4 w-4 mr-1" />
              Reply
            </Button>
          )}
        </div>
      </div>

      {email.subject && (
        <h2 className="mb-3 text-base font-semibold">{email.subject}</h2>
      )}

      <EmailBody email={email} />
    </div>
  );
}

function EmailBody({ email }: { email: Email }) {
  const [sanitizedHtml, setSanitizedHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (email.body_html) {
      void loadDomPurify().then(({ default: DOMPurify }) => {
        if (!cancelled) {
          setSanitizedHtml(DOMPurify.sanitize(email.body_html!, sanitizeOptions));
        }
      });
    } else {
      setSanitizedHtml(null);
    }

    return () => {
      cancelled = true;
    };
  }, [email.body_html]);

  if (email.body_html) {
    if (sanitizedHtml) {
      return (
        <div
          className="prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      );
    }

    return (
      <p aria-live="polite" className="text-sm text-muted-foreground italic">
        (loading message)
      </p>
    );
  }

  if (email.body_text) {
    return (
      <pre className="whitespace-pre-wrap text-sm text-foreground font-sans break-words">
        {email.body_text}
      </pre>
    );
  }

  return (
    <p className="text-sm text-muted-foreground italic">(no body)</p>
  );
}
