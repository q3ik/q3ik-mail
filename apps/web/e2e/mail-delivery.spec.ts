import { expect, test } from '@playwright/test';
import { AgentMailClient } from '@q3ik-mail/testing';
import type { AgentMailMessage } from '@q3ik-mail/testing';

const agentmailApiKey = process.env.AGENTMAIL_API_KEY;
// Issue 3 fix: RESEND_API_KEY is no longer read in this file. Scenario A
// sends via the app's own /api/trigger-inbound endpoint so the key is
// never present in Playwright's browser-context request traces or reports.
const inboundAddress = process.env.E2E_INBOUND_ADDRESS ?? 'mail@q3ik.com';
// Issue 4 fix: E2E_INBOUND_FROM is required — no default that equals
// inboundAddress. Scenario A skips explicitly when the var is absent.
const inboundFromAddress = process.env.E2E_INBOUND_FROM;
const timeoutMs = Number.parseInt(process.env.AGENTMAIL_TIMEOUT_MS ?? '30000', 10);
const e2eTestSecret = process.env.E2E_TEST_SECRET;

function getHeader(message: AgentMailMessage, name: string): string | undefined {
  const lowerName = name.toLowerCase();

  const headerSources = [
    message.headers,
    message.parsed_headers,
  ];

  for (const source of headerSources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() === lowerName && typeof value === 'string') return value;
    }
  }

  if (typeof message.raw_headers === 'string') {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rawHeaderMatch = message.raw_headers.match(new RegExp(`^${escapedName}:\\s*(.+)$`, 'im'));
    if (rawHeaderMatch?.[1]) return rawHeaderMatch[1].trim();
  }

  return undefined;
}

test.describe('agentmail delivery', () => {
  let client: AgentMailClient;
  let mailbox: { id: string; email: string } | null = null;

  test.beforeAll(async () => {
    test.skip(!agentmailApiKey, 'AGENTMAIL_API_KEY is not configured; skipping agentmail E2E tests');
    client = new AgentMailClient(agentmailApiKey!);
    mailbox = await client.createMailbox();
    if (!mailbox) throw new Error('AgentMail createMailbox() returned null — cannot proceed with suite');
  });

  test.afterAll(async () => {
    if (!mailbox) return;
    await client.deleteMailbox(mailbox.id);
  });

  test('Scenario A: inbound routing persists email data', async ({ request }) => {
    // Issue 4 fix: require E2E_INBOUND_FROM; self-send to production inbox
    // is no longer possible via the default value.
    test.skip(
      !inboundFromAddress,
      'E2E_INBOUND_FROM is required for inbound routing E2E — set it to a Resend sandbox sender'
    );

    const uniqueSubject = `AgentMail inbound ${Date.now()}`;
    const senderAddress = inboundFromAddress!;

    // Issue 3 fix: route the send through the app's own internal endpoint
    // instead of calling api.resend.com directly. This keeps the Resend API
    // key out of Playwright's browser-context traces and HTML reports.
    const triggerResponse = await request.post('/api/trigger-inbound', {
      headers: {
        TEST_SECRET: e2eTestSecret ?? '',
      },
      data: {
        from: senderAddress,
        to: inboundAddress,
        subject: uniqueSubject,
        text: 'Inbound routing scenario message',
      },
    });
    expect(triggerResponse.ok()).toBeTruthy();

    // Issue 5 fix: capture the matched row directly from the poll closure
    // and eliminate the redundant second GET + the non-null ! assertion.
    let persistedRow: Record<string, unknown> | null = null;

    await expect
      .poll(
        async () => {
          const response = await request.get('/api/emails?limit=100');
          if (!response.ok()) return null;
          const payload = (await response.json()) as { threads?: Array<Record<string, unknown>> };
          persistedRow = payload.threads?.find((row) => row.subject === uniqueSubject) ?? null;
          return persistedRow;
        },
        { timeout: timeoutMs, intervals: [2_000] }
      )
      .toMatchObject({ from_address: senderAddress, subject: uniqueSubject });

    expect(persistedRow).not.toBeNull();
    // persistedRow is guaranteed non-null here: expect.poll only resolves
    // when the closure returned a truthy value, which set persistedRow.
    expect(typeof (persistedRow as Record<string, unknown>).thread_id).toBe('string');
    const row = persistedRow as Record<string, unknown>;
    if (typeof row.message_id === 'string' && row.message_id.length > 0) {
      expect(row.thread_id).toBe(row.message_id);
    }
  });

  test('Scenario B: outbound loopback preserves reply headers', async ({ request }) => {
    const outboundSubject = `AgentMail loopback ${Date.now()}`;
    if (!mailbox) throw new Error('Mailbox not initialized');
    const response = await request.post('/api/send', {
      data: {
        to: mailbox.email,
        subject: outboundSubject,
        content: 'Outbound loopback test body',
        replyToId: '<reply-parent@q3ik.com>',
        references: '<thread-root@q3ik.com>',
      },
    });

    expect(response.ok()).toBeTruthy();

    const message = await client.waitForEmail(mailbox.id, {
      timeoutMs,
      filter: (candidate) => candidate.subject === outboundSubject,
    });
    expect(message.subject).toBe(outboundSubject);
    expect(getHeader(message, 'In-Reply-To')).toBe('<reply-parent@q3ik.com>');
    expect(getHeader(message, 'References')).toContain('<thread-root@q3ik.com>');
    expect(getHeader(message, 'References')).toContain('<reply-parent@q3ik.com>');

    // Sent-email persistence is best-effort and asynchronous in /api/send,
    // so poll /api/emails until the inserted row becomes visible.
    await expect
      .poll(
        async () => {
          const sentResponse = await request.get('/api/emails?limit=100');
          if (!sentResponse.ok()) return null;
          const payload = (await sentResponse.json()) as { threads?: Array<Record<string, unknown>> };
          return payload.threads?.find((row) => row.subject === outboundSubject) ?? null;
        },
        { timeout: timeoutMs, intervals: [2_000] }
      )
      .toMatchObject({
        subject: outboundSubject,
        in_reply_to: '<reply-parent@q3ik.com>',
      });
  });
});
