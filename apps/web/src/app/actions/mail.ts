'use server';

import { getRequestContext } from '@cloudflare/next-on-pages';
import {
  getLatestEmails,
  getEmailsByThread,
  getThreadList,
  markAsRead,
  getEmailById,
} from '@q3ik-mail/database';

export async function fetchThreadList(limit = 50) {
  const { env } = getRequestContext();
  return getThreadList(env.DB, limit);
}

export async function fetchLatestEmails(limit = 50) {
  const { env } = getRequestContext();
  return getLatestEmails(env.DB, limit);
}

export async function fetchThread(threadId: string) {
  const { env } = getRequestContext();
  return getEmailsByThread(env.DB, threadId);
}

export async function fetchEmailById(emailId: string) {
  const { env } = getRequestContext();
  return getEmailById(env.DB, emailId);
}

export async function markEmailAsRead(emailId: string) {
  const { env } = getRequestContext();
  return markAsRead(env.DB, emailId);
}
