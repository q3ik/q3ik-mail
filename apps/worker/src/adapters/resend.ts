import type { InboundMailEnvelope } from '@q3ik-mail/core';
import { parseFrom } from '../utils/parseFrom';

export interface ResendReceivedAttachment {
  id?: string;
  filename?: string;
  content?: string;
  content_type?: string;
  contentType?: string;
  url?: string;
  size?: number;
  content_length?: number;
}

/**
 * Shape of the Resend Receiving API response (resend v4 types omit this endpoint).
 * Field names verified against https://resend.com/docs/api-reference/webhooks/email-received
 * When Resend ships official types, replace this interface with the proper SDK import.
 */
export interface ResendReceivedEmail {
  from?: string;
  // Resend may return a single address string or an array; normalise downstream.
  to?: string | string[];
  subject?: string;
  // `text` is nullable but not guaranteed present on every event (HTML-only senders
  // may omit the key entirely). Treat as optional; normalise to null downstream.
  text?: string | null;
  html?: string | null;
  attachments?: ResendReceivedAttachment[];
  headers?: Array<{ name: string; value: string }>;
}

/**
 * Validates and narrows an unknown Resend receiving-API payload to
 * `ResendReceivedEmail`. Returns `null` plus the name of the offending field
 * when validation fails so callers can emit a diagnostic log entry.
 *
 * Key invariants:
 * - Only `object` payloads are accepted.
 * - `text` is optional (HTML-only emails may omit the key), but when present
 *   it must be `string | null`. Do NOT require its presence — that would cause
 *   a 502 for every HTML-only inbound message.
 * - All other fields are individually optional and type-checked when present.
 * - Inner collection types (headers array) use `Record<string, unknown>` to
 *   preserve exhaustiveness checking as the interface evolves.
 */
export function parseResendReceivedEmail(
  payload: unknown,
): { ok: true; email: ResendReceivedEmail } | { ok: false; field: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, field: '(root)' };
  }

  // Use `unknown` (not `any`) so the compiler enforces explicit narrowing on
  // every property access and exhaustiveness checks remain intact.
  const email = payload as Record<string, unknown>;

  // `text` — optional; when present must be string | null
  if ('text' in email && email.text !== null && typeof email.text !== 'string') {
    return { ok: false, field: 'text' };
  }

  if (email.from !== undefined && typeof email.from !== 'string') {
    return { ok: false, field: 'from' };
  }

  if (
    email.to !== undefined &&
    typeof email.to !== 'string' &&
    !(
      Array.isArray(email.to) &&
      (email.to as unknown[]).every((item) => typeof item === 'string')
    )
  ) {
    return { ok: false, field: 'to' };
  }

  if (email.subject !== undefined && typeof email.subject !== 'string') {
    return { ok: false, field: 'subject' };
  }

  if (email.html !== undefined && email.html !== null && typeof email.html !== 'string') {
    return { ok: false, field: 'html' };
  }

  if (email.headers !== undefined) {
    if (!Array.isArray(email.headers)) {
      return { ok: false, field: 'headers' };
    }
    for (const header of email.headers as unknown[]) {
      if (!header || typeof header !== 'object') {
        return { ok: false, field: 'headers[*]' };
      }
      const h = header as Record<string, unknown>;
      if (typeof h.name !== 'string' || typeof h.value !== 'string') {
        return { ok: false, field: 'headers[*].name/value' };
      }
    }
  }

  if (email.attachments !== undefined) {
    if (!Array.isArray(email.attachments)) {
      return { ok: false, field: 'attachments' };
    }
    for (const attachment of email.attachments as unknown[]) {
      if (!attachment || typeof attachment !== 'object') {
        return { ok: false, field: 'attachments[*]' };
      }
      const a = attachment as Record<string, unknown>;
      if (a.id !== undefined && typeof a.id !== 'string') {
        return { ok: false, field: 'attachments[*].id' };
      }
      if (a.filename !== undefined && typeof a.filename !== 'string') {
        return { ok: false, field: 'attachments[*].filename' };
      }
      if (a.content !== undefined && typeof a.content !== 'string') {
        return { ok: false, field: 'attachments[*].content' };
      }
      if (a.content_type !== undefined && typeof a.content_type !== 'string') {
        return { ok: false, field: 'attachments[*].content_type' };
      }
      if (a.contentType !== undefined && typeof a.contentType !== 'string') {
        return { ok: false, field: 'attachments[*].contentType' };
      }
      if (a.url !== undefined && typeof a.url !== 'string') {
        return { ok: false, field: 'attachments[*].url' };
      }
      if (a.size !== undefined && typeof a.size !== 'number') {
        return { ok: false, field: 'attachments[*].size' };
      }
      if (a.content_length !== undefined && typeof a.content_length !== 'number') {
        return { ok: false, field: 'attachments[*].content_length' };
      }
    }
  }

  return {
    ok: true,
    email: {
      from: typeof email.from === 'string' ? email.from : undefined,
      to:
        typeof email.to === 'string' || Array.isArray(email.to)
          ? (email.to as string | string[])
          : undefined,
      subject: typeof email.subject === 'string' ? email.subject : undefined,
      text:
        typeof email.text === 'string' || email.text === null
          ? (email.text as string | null)
          : undefined,
      html:
        typeof email.html === 'string' || email.html === null
          ? (email.html as string | null)
          : undefined,
      headers: Array.isArray(email.headers)
        ? (email.headers as Array<{ name: string; value: string }>)
        : undefined,
      attachments: Array.isArray(email.attachments)
        ? (email.attachments as ResendReceivedAttachment[])
        : undefined,
    },
  };
}

/**
 * Converts a validated Resend receiving-API payload into the provider-agnostic
 * `InboundMailEnvelope`. This is the single place where Resend-specific field
 * names are mapped to the normalized domain type.
 *
 * @param email - Validated Resend receiving-API payload.
 * @param svixTimestamp - The `svix-timestamp` header value from the webhook
 *   request (Unix epoch seconds as a string). Used as the authoritative
 *   `receivedAt` timestamp so the value is stable across retries and reflects
 *   when Svix accepted the event rather than when the worker happened to
 *   process it. Falls back to `new Date()` if the value is missing or
 *   unparseable (should never happen after signature verification, but
 *   defensive coding is cheap).
 *
 * Call this immediately after `parseResendReceivedEmail` succeeds, then work
 * exclusively with `InboundMailEnvelope` for threading and persistence logic.
 */
export function normalizeResendWebhook(
  email: ResendReceivedEmail,
  svixTimestamp?: string,
): InboundMailEnvelope {
  const headers = email.headers ?? [];

  const messageId = headers.find(
    (h) => h.name.toLowerCase() === 'message-id',
  )?.value ?? null;

  const inReplyTo = headers.find(
    (h) => h.name.toLowerCase() === 'in-reply-to',
  )?.value ?? null;

  const referencesRaw = headers.find(
    (h) => h.name.toLowerCase() === 'references',
  )?.value ?? null;
  // Normalise folded whitespace (CRLF + WSP) into single spaces so downstream
  // consumers receive a clean space-separated Message-ID chain.
  const references = referencesRaw?.replace(/\s+/g, ' ').trim() ?? null;

  const { name: fromName, address: fromAddress } = parseFrom(email.from ?? '');

  const toRaw = email.to;
  const toAddress = Array.isArray(toRaw)
    ? toRaw.join(', ')
    : (typeof toRaw === 'string' ? toRaw : '');

  return {
    messageId,
    inReplyTo,
    references,
    subject: email.subject ?? null,
    fromAddress,
    fromName,
    toAddress: toAddress.trim(),
    bodyText: email.text ?? null,
    bodyHtml: email.html ?? null,
    receivedAt: (() => {
      const epochSeconds = svixTimestamp ? Number(svixTimestamp) : NaN;
      return epochSeconds > 0
        ? new Date(epochSeconds * 1000).toISOString()
        : new Date().toISOString();
    })(),
  };
}
