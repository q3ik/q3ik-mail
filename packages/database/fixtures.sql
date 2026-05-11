-- Test fixture emails for E2E and local development
INSERT OR IGNORE INTO emails
  (id, resend_id, thread_id, from_address, from_name, to_address, subject,
   body_text, body_html, message_id, in_reply_to, "references",
   needs_rethreading, is_read, is_sent, created_at)
VALUES
  (
    -- fixture-001: root message, starts thread-fixture-001
    'fixture-001',
    'resend-fixture-001',
    'thread-fixture-001',
    'alice@example.com',
    'Alice Example',
    'you@q3ik.com',
    'Welcome to q3ik-mail!',
    'Hello! This is a test email to verify your inbox is working.',
    '<p>Hello! This is a test email to verify your inbox is working.</p>',
    '<fixture-001@example.com>',
    NULL,
    NULL,           -- root message: no References chain yet
    0,
    0,
    0,
    '2026-05-09T10:00:00Z'
  ),
  (
    -- fixture-002: unrelated root message in its own thread
    'fixture-002',
    'resend-fixture-002',
    'thread-fixture-002',
    'bob@example.com',
    'Bob Example',
    'you@q3ik.com',
    'Re: Project Update',
    'Quick update: everything is on track.',
    '<p>Quick update: everything is on track.</p>',
    '<fixture-002@example.com>',
    NULL,
    NULL,           -- root message: no References chain yet
    0,
    1,
    0,
    '2026-05-09T09:00:00Z'
  ),
  (
    -- fixture-003: reply to fixture-001, same thread
    -- references mirrors the RFC 2822 References chain: the root Message-ID
    'fixture-003',
    'resend-fixture-003',
    'thread-fixture-001',
    'alice@example.com',
    'Alice Example',
    'you@q3ik.com',
    'Re: Welcome to q3ik-mail!',
    'Just following up on my previous email.',
    '<p>Just following up on my previous email.</p>',
    '<fixture-003@example.com>',
    '<fixture-001@example.com>',
    '<fixture-001@example.com>',  -- RFC 2822 References: root Message-ID
    0,
    0,
    0,
    '2026-05-09T10:30:00Z'
  );
