import { expect, test } from '@playwright/test';
import { AgentMailClient } from '@q3ik-mail/testing';
import type { AgentMailMessage } from '@q3ik-mail/testing';

const agentmailApiKey = process.env.AGENTMAIL_API_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const inboundAddress = process.env.E2E_INBOUND_ADDRESS ?? 'mail@q3ik.com';
const inboundFromAddress = process.env.E2E_INBOUND_FROM ?? 'mail@q3ik.com';
const timeoutMs = Number.parseInt(process.env.AGENTMAIL_TIMEOUT_MS ?? '30000', 10);
const isPullRequestEvent = process.env.GITHUB_EVENT_NAME === 'pull_request';

test.skip(!agentmailApiKey, 'AGENTMAIL_API_KEY is not configured; skipping agentmail E2E tests');
test.skip(isPullRequestEvent, 'agentmail E2E tests are disabled for pull_request events');

function getHeader(message: AgentMailMessage, name: string): string | undefined {
  const lowerName = name.toLowerCase();

  const headerSources = [
    message.headers,
    message.parsed_headers,
    message.raw_headers,
  ];

  for (const source of headerSources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() === lowerName && typeof value === 'string') return value;
    }
  }

  return undefined;
}

test.describe('agentmail delivery', () => {
  let client: AgentMailClient;
  let mailbox: { id: string; email: string } | null = null;

  test.beforeAll(async () => {
    client = new AgentMailClient(agentmailApiKey!);
    mailbox = await client.createMailbox();
  });

  test.afterAll(async () => {
    if (!mailbox) return;
    await client.deleteMailbox(mailbox.id);
  });

  test('Scenario A: inbound routing persists email data', async ({ request }) => {
    test.skip(
      !resendApiKey,
      'RESEND_API_KEY is required for inbound routing E2E'
    );

    const uniqueSubject = `AgentMail inbound ${Date.now()}`;
    const senderAddress = inboundFromAddress;

    const resendResponse = await request.post('https://api.resend.com/emails', {
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        from: senderAddress,
        to: [inboundAddress],
        subject: uniqueSubject,
        text: 'Inbound routing scenario message',
      },
    });
    expect(resendResponse.ok()).toBeTruthy();

    await expect
      .poll(
        async () => {
          const response = await request.get('/api/emails?limit=100');
          if (!response.ok()) return null;
          const payload = (await response.json()) as { threads?: Array<Record<string, unknown>> };
          return payload.threads?.find((row) => row.subject === uniqueSubject) ?? null;
        },
        { timeout: timeoutMs, intervals: [2_000] }
      )
      .toMatchObject({ from_address: senderAddress, subject: uniqueSubject });

    const verificationResponse = await request.get('/api/emails?limit=100');
    expect(verificationResponse.ok()).toBeTruthy();
    const verificationPayload = (await verificationResponse.json()) as {
      threads?: Array<Record<string, unknown>>;
    };
    const persistedRow = verificationPayload.threads?.find((row) => row.subject === uniqueSubject)!;
    expect(persistedRow).toBeTruthy();

    expect(typeof persistedRow.thread_id).toBe('string');
    if (typeof persistedRow.message_id === 'string' && persistedRow.message_id.length > 0) {
      expect(persistedRow.thread_id).toBe(persistedRow.message_id);
    }
  });

  test('Scenario B: outbound loopback preserves reply headers', async ({ request }) => {
    test.skip(!resendApiKey, 'RESEND_API_KEY is required for outbound loopback E2E');

    const outboundSubject = `AgentMail loopback ${Date.now()}`;
    const response = await request.post('/api/send', {
      data: {
        to: mailbox!.email,
        subject: outboundSubject,
        content: 'Outbound loopback test body',
        replyToId: '<reply-parent@q3ik.com>',
        references: '<thread-root@q3ik.com>',
      },
    });

    expect(response.ok()).toBeTruthy();

    const message = await client.waitForEmail(mailbox!.id, {
      timeoutMs,
      filter: (candidate) => candidate.subject === outboundSubject,
    });
    expect(message.subject).toBe(outboundSubject);
    expect(getHeader(message, 'In-Reply-To')).toBe('<reply-parent@q3ik.com>');
    expect(getHeader(message, 'References')).toContain('<thread-root@q3ik.com>');
    expect(getHeader(message, 'References')).toContain('<reply-parent@q3ik.com>');

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
