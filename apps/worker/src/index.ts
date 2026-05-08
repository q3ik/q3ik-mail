import { Resend } from 'resend';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Not Allowed', { status: 405 });
    
    const payload = await request.text(); // Required for signature verification
    const resend = new Resend(env.RESEND_API_KEY);
    
    try {
      // 1. Verify Signature (Agent: use resend.webhooks.verify)
      const event = resend.webhooks.verify({
        payload,
        headers: {
          'svix-id': request.headers.get('svix-id')!,
          'svix-timestamp': request.headers.get('svix-timestamp')!,
          'svix-signature': request.headers.get('svix-signature')!,
        },
        webhookSecret: env.RESEND_WEBHOOK_SECRET
      });

      if (event.type === 'email.received') {
        const emailId = event.data.email_id;
        // 2. Fetch full email content
        const { data: fullEmail } = await resend.emails.get(emailId);
        
        // 3. Threading: Use Message-ID or In-Reply-To
        const threadId = fullEmail.headers?.find(h => h.name === 'In-Reply-To')?.value || emailId;

        await env.DB.prepare(`
          INSERT INTO emails (id, resend_id, thread_id, from_address, subject, body_html, body_text, message_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), emailId, threadId, fullEmail.from, fullEmail.subject, fullEmail.html, fullEmail.text, fullEmail.message_id).run();
      }
      return new Response('Success', { status: 200 });
    } catch (e) {
      return new Response('Unauthorized', { status: 401 });
    }
  }
}
