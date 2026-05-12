export interface AgentMailMailbox {
  id: string;
  email: string;
}

export interface AgentMailMessage {
  id: string;
  subject?: string;
  headers?: Record<string, string>;
  parsed_headers?: Record<string, string>;
  raw_headers?: Record<string, string>;
  [key: string]: unknown;
}

interface AgentMailMessagesResponse {
  messages: AgentMailMessage[];
}

export class AgentMailClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    options?: { baseUrl?: string }
  ) {
    this.baseUrl = options?.baseUrl ?? 'https://api.agentmail.to/v1';
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`AgentMail API request failed (${res.status}): ${errorBody}`);
    }

    return res.json() as Promise<T>;
  }

  async createMailbox(): Promise<AgentMailMailbox> {
    return this.request<AgentMailMailbox>('/mailboxes', { method: 'POST' });
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/mailboxes/${mailboxId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok && res.status !== 404) {
      const errorBody = await res.text();
      throw new Error(`AgentMail mailbox cleanup failed (${res.status}): ${errorBody}`);
    }
  }

  async waitForEmail(mailboxId: string, timeoutMs = 30_000): Promise<AgentMailMessage> {
    const start = Date.now();
    const pollIntervalMs = 2_000;

    while (true) {
      if (Date.now() - start >= timeoutMs) break;
      const data = await this.request<AgentMailMessagesResponse>(`/mailboxes/${mailboxId}/messages`);
      if (data.messages.length > 0) return data.messages[0];
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('Timed out waiting for email');
  }
}
