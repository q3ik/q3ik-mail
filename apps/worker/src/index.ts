import { Resend } from 'resend';

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // 1. Verify Webhook (Security)
    // Agent should implement signature verification here using env.RESEND_WEBHOOK_SECRET

    const payload: any = await request.json();
    const resend = new Resend(env.RESEND_API_KEY);

    if (payload.type === 'email.received') {
      const { data } = await resend.emails.get(payload.data.id);

      // 2. Threading Logic: Match In-Reply-To or use the Message-ID
      const threadId = data.headers?.find(h => h.name === 'In-Reply-To')?.value || data.id;

      // 3. Persist to Cloudflare D1
      await env.DB.prepare(`
        INSERT INTO emails (id, resend_id, thread_id, from_address, subject, body_html, body_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        data.id,
        threadId,
        data.from,
        data.subject,
        data.html,
        data.text
      ).run();
    }

    return new Response('OK', { status: 200 });
  },
};
