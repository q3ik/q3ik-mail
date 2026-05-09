import type { Email } from '@q3ik-mail/database';
import { cn } from '@/lib/utils';

interface MailDisplayProps {
  thread: Email[];
}

export function MailDisplay({ thread }: MailDisplayProps) {
  if (thread.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a thread to read
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto h-full">
      {thread.map((email) => (
        <EmailCard key={email.id} email={email} />
      ))}
    </div>
  );
}

function EmailCard({ email }: { email: Email }) {
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
        <span className="shrink-0 text-xs text-muted-foreground">{date}</span>
      </div>

      {email.subject && (
        <h2 className="mb-3 text-base font-semibold">{email.subject}</h2>
      )}

      <EmailBody email={email} />
    </div>
  );
}

function EmailBody({ email }: { email: Email }) {
  // Render plain text body as a fallback.
  // TODO: Attempt isomorphic-dompurify for sanitized HTML rendering once
  // Cloudflare Workers DOM shim compatibility is confirmed.
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
