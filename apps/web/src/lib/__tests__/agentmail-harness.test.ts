import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { AgentMailClient } from '@q3ik-mail/testing';

describe('AgentMailClient listMessages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns mailbox messages on success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'message-1', subject: 'Hello' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const client = new AgentMailClient('test-key', { baseUrl: 'https://api.agentmail.to/v0' });

    const messages = await client.listMessages('mailbox-123');

    expect(messages).toEqual([{ id: 'message-1', subject: 'Hello' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.agentmail.to/v0/inboxes/mailbox-123/messages',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      })
    );
  });

  it('throws when the agentmail API returns a non-success status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('server error', { status: 500 }));
    const client = new AgentMailClient('test-key', { baseUrl: 'https://api.agentmail.to/v0' });

    await expect(client.listMessages('mailbox-123')).rejects.toThrow(
      'AgentMail API error 500 on /inboxes/mailbox-123/messages'
    );
  });

  it('redacts API key from JSON and inspect output', () => {
    const client = new AgentMailClient('test-key', { baseUrl: 'https://api.agentmail.to/v0' });

    expect(JSON.stringify(client)).toBe('{"type":"AgentMailClient"}');
    expect(inspect(client)).toBe('AgentMailClient [key redacted]');
  });
});
