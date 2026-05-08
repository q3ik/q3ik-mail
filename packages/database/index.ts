export interface EmailRecord {
  id: string;
  resend_id: string;
  thread_id: string;
  from_address: string;
  subject: string;
  body_html: string;
  created_at: string;
}

// Utility to fetch the latest 50 emails
export const getLatestEmails = async (db: D1Database) => {
  return await db.prepare("SELECT * FROM emails ORDER BY created_at DESC LIMIT 50").all<EmailRecord>();
};
