/**
 * Normalized inbound mail envelope.
 *
 * All provider-specific fields are mapped to this common shape before any
 * threading or persistence logic runs. This decouples the ingestion pipeline
 * from a specific inbound email provider (e.g. Resend) and makes threading
 * logic independently testable with pure functions.
 */
export interface InboundMailEnvelope {
  /** RFC 2822 Message-ID header value, or null if absent. */
  messageId: string | null;
  /** RFC 2822 In-Reply-To header value, or null if absent. */
  inReplyTo: string | null;
  /** RFC 2822 References header (space-separated Message-ID chain), or null if absent. */
  references: string | null;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  /** Recipient address(es), comma-separated when multiple. */
  toAddress: string;
  bodyText: string | null;
  bodyHtml: string | null;
  /** ISO 8601 timestamp of when the message was received. */
  receivedAt: string;
}
