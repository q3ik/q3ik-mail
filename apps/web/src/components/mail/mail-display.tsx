'use client';

import { useEffect, useState } from 'react';
import type { Email } from '@q3ik-mail/database';
import { ReplyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ComposePayload } from '@/components/mail/compose-dialog';

const sanitizeOptions = {
  USE_PROFILES: { html: true },
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
};

let DOMPurifyPromise: Promise<typeof import('isomorphic-dompurify')> | undefined;

function loadDomPurify() {
  DOMPurifyPromise ??= import('isomorphic-dompurify');
  return DOMPurifyPromise;
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
  // A valid reply requires a real RFC 2822 Message-ID in In-Reply-To.
  // email.id is an internal UUID — not a valid Message-ID — so when
  // message_id is null we disable the button rather than silently sending
  // a malformed header that breaks threading in external mail clients.
  const canReply = Boolean(email.message_id);

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
            <span
              tabIndex={canReply ? undefined : 0}
              title={!canReply ? 'Cannot reply — this email has no Message-ID' : undefined}
            >
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={!canReply}
                aria-disabled={!canReply}
                onClick={() =>
                  canReply &&
                  onReply({
                    to: email.from_address,
                    subject: email.subject?.startsWith('Re: ')
                      ? email.subject
                      : `Re: ${email.subject ?? ''}`,
                    replyToId: email.message_id!,
                    references: email.references ?? undefined,
                  })
                }
              >
                <ReplyIcon className="h-4 w-4 mr-1" />
                Reply
              </Button>
            </span>
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
  const [body, setBody] = useState<{ body_html: string | null; body_text: string | null }>({
    body_html: email.body_html,
    body_text: email.body_text,
  });
  const [isBodyLoading, setIsBodyLoading] = useState(false);
  const [sanitizedHtml, setSanitizedHtml] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setIsBodyLoading(true);

    void fetch(`/api/emails/${encodeURIComponent(email.id)}/body`, {
      method: 'GET',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to fetch email body (${response.status})`);
        }
        const payload = (await response.json()) as {
          body_html: string | null;
          body_text: string | null;
        };
        setBody({
          body_html: payload.body_html ?? null,
          body_text: payload.body_text ?? null,
        });
      })
      .catch(() => {
        setBody({
          body_html: email.body_html,
          body_text: email.body_text,
        });
      })
      .finally(() => {
        setIsBodyLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [email.id, email.body_html, email.body_text]);

  useEffect(() => {
    let cancelled = false;

    const bodyHtml = body.body_html;
    if (bodyHtml) {
      void loadDomPurify()
        .then(({ default: DOMPurify }) => {
          if (!cancelled) {
            setSanitizedHtml(DOMPurify.sanitize(bodyHtml, sanitizeOptions));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSanitizedHtml(null);
          }
        });
    } else {
      setSanitizedHtml(null);
    }

    return () => {
      cancelled = true;
    };
  }, [body.body_html]);

  if (body.body_html) {
    if (sanitizedHtml) {
      return (
        <iframe
          title="Email body"
          srcDoc={sanitizedHtml}
          sandbox=""
          className="w-full h-[70vh] min-h-[16rem] border-0"
        />
      );
    }

    if (isBodyLoading) {
      return (
        <p aria-live="polite" className="text-sm text-muted-foreground italic">
          Loading email content...
        </p>
      );
    }

    return (
      <p className="text-sm text-muted-foreground italic">(no body)</p>
    );
  }

  if (body.body_text) {
    return (
      <pre className="whitespace-pre-wrap text-sm text-foreground font-sans break-words">
        {body.body_text}
      </pre>
    );
  }

  return (
    <p className="text-sm text-muted-foreground italic">(no body)</p>
  );
}
