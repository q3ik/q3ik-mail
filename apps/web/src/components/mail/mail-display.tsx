'use client';

import { useEffect, useRef, useState } from 'react';
import type { Email } from '@q3ik-mail/database';
import { ReplyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { captureMessage } from '@/lib/sentry';
import type { ComposePayload } from '@/components/mail/compose-dialog';

// ---------------------------------------------------------------------------
// DOMPurify configuration
//
// Prior to this fix, `FORBID_ATTR: ['style']` stripped all inline CSS from
// incoming HTML emails, collapsing multi-column layouts and removing all
// visual formatting. Inline CSS is the primary (often only) styling mechanism
// for HTML email, since external stylesheets are blocked by email clients.
//
// The email body is rendered inside <iframe sandbox=""> (no flags), which:
//   - Blocks script execution (no JS runs inside the frame)
//   - Blocks same-origin access (frame cannot read parent DOM/cookies)
//   - Blocks form submission and top-level navigation
//
// Given that containment, the residual CSS threat is:
//   - url() in style attributes → CSS-based tracker exfiltration
//     (background-image: url(https://tracker.example.com/pixel))
//
// This is addressed by the afterSanitizeAttributes hook below, which strips
// url() values from any style attribute while preserving all other CSS.
// The parent-page CSP (img-src 'self' data: cid:) provides an additional
// layer of defence against tracker pixels escaping the parent context.
// ---------------------------------------------------------------------------

/** DOMPurify config — style attribute is intentionally NOT forbidden. */
const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  ALLOW_DATA_ATTR: false,
  FORCE_BODY: true,
  FORBID_TAGS: ['script', 'object', 'embed', 'form'],
};

/**
 * Matches any CSS url(...) value in a style attribute.
 *
 * NOTE: Do NOT use .test() with this regex — it uses the /g flag, which means
 * lastIndex persists between calls on the same regex instance. On alternating
 * invocations .test() would return false even when a url() is present,
 * allowing tracker pixels through. Always use .replace() instead (which
 * resets lastIndex on every call).
 */
const CSS_URL_RE = /url\s*\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)/gi;

let DOMPurifyPromise: Promise<typeof import('isomorphic-dompurify')> | undefined;
let hooksInstalled = false;

function loadDomPurify() {
  DOMPurifyPromise ??= import('isomorphic-dompurify').then((mod) => {
    if (!hooksInstalled) {
      hooksInstalled = true;
      // Strip url() from style attributes to block CSS-based tracker pixels.
      // All other inline styles (colors, spacing, fonts, layout) are kept.
      mod.default.addHook('afterSanitizeAttributes', (node) => {
        const el = node as Element;
        const style = el.getAttribute?.('style');
        if (style) {
          const cleaned = style.replace(CSS_URL_RE, '');
          if (cleaned !== style) {
            el.setAttribute('style', cleaned);
          }
        }
      });
    }
    return mod;
  });
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
    body_html: null,
    body_text: null,
  });
  const [isBodyLoading, setIsBodyLoading] = useState(false);
  const [bodyLoadError, setBodyLoadError] = useState(false);
  const [sanitizedHtml, setSanitizedHtml] = useState<string | null>(null);
  // Track the email id that produced the current sanitizedHtml so stale
  // content is never shown when navigating rapidly between emails.
  const sanitizedForId = useRef<string | null>(null);

  // Dependency is [email.id] only — see original comment for rationale.
  useEffect(() => {
    const controller = new AbortController();
    const shouldFetchFromApi = email.body_html === null && email.body_text === null;

    if (!shouldFetchFromApi) {
      setBody({
        body_html: email.body_html,
        body_text: email.body_text,
      });
      setIsBodyLoading(false);
      setBodyLoadError(false);
      return () => {
        controller.abort();
      };
    }

    setIsBodyLoading(true);
    setBodyLoadError(false);
    setBody({
      body_html: null,
      body_text: null,
    });

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
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        console.error('[mail-display] failed to fetch email body:', err);
        void captureMessage('[mail-display] email body loading error', {
          level: 'warning',
          tags: { category: 'loading-error', surface: 'mail-display', email_id: email.id },
        });
        setBodyLoadError(true);
      })
      .finally(() => {
        setIsBodyLoading(false);
      });

    return () => {
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id]);

  useEffect(() => {
    let cancelled = false;
    const bodyHtml = body.body_html;

    if (!bodyHtml) {
      setSanitizedHtml(null);
      sanitizedForId.current = null;
      return;
    }

    void loadDomPurify()
      .then(({ default: DOMPurify }) => {
        if (!cancelled) {
          sanitizedForId.current = email.id;
          setSanitizedHtml(DOMPurify.sanitize(bodyHtml, SANITIZE_OPTIONS));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSanitizedHtml(null);
          sanitizedForId.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [body.body_html, email.id]);

  if (isBodyLoading && (sanitizedForId.current !== email.id) && !body.body_text) {
    return (
      <p aria-live="polite" className="text-sm text-muted-foreground italic">
        Loading email content...
      </p>
    );
  }

  if (sanitizedHtml && sanitizedForId.current === email.id) {
    return (
      // sandbox="" (no flags) blocks: scripts, same-origin access, forms,
      // plugins, top-level navigation, and pointer-lock inside the frame.
      // The email body only needs to render HTML+CSS — no flags needed.
      <iframe
        title="Email body"
        srcDoc={sanitizedHtml}
        sandbox=""
        className="w-full h-[70vh] min-h-[16rem] border-0"
      />
    );
  }

  if (body.body_text) {
    return (
      <pre className="whitespace-pre-wrap text-sm text-foreground font-sans break-words">
        {body.body_text}
      </pre>
    );
  }

  if (bodyLoadError) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Unable to load email body.
      </p>
    );
  }

  if (body.body_html) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Unable to render email body.
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground italic">(no body)</p>
  );
}
