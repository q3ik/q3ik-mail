import type { Email } from '@q3ik-mail/database';
import DOMPurify from 'isomorphic-dompurify';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Reply } from 'lucide-react';

interface MailDisplayProps {
  thread: Email[];
  onReply?: () => void;
}

export function MailDisplay({ thread, onReply }: MailDisplayProps) {
  if (thread.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a thread to read
      </div>
    );
  }

  return (
    <div data-testid="mail-display" className="flex flex-col gap-4 p-4 overflow-auto h-full">
      {thread.map((email, index) => (
        <EmailCard
          key={email.id}
          email={email}
          isLast={index === thread.length - 1}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

function EmailCard({
  email,
  isLast,
  onReply,
}: {
  email: Email;
  isLast: boolean;
  onReply?: () => void;
}) {
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
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{date}</span>
          {isLast && onReply && (
            <Button variant="outline" size="sm" onClick={onReply}>
              <Reply className="h-3 w-3 mr-1" />
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
  if (email.body_html) {
    const sanitizedHtml = DOMPurify.sanitize(email.body_html, {
      FORBID_TAGS: ['script', 'style'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
    return (
      <div
        className="prose prose-sm max-w-none"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
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
