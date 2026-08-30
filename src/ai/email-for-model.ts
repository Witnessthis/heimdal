import { convert } from 'html-to-text';
import type { EmailMessage } from '../mail/types';
import type { EmailForModel } from './types';

// Prefer the plain-text MIME part when the provider gave us one — already
// clean, no conversion needed. Only fall back to stripping the HTML part
// when there's no text alternative at all. html-to-text excludes
// <script>/<style> content by default (verified directly, not assumed —
// their raw source would otherwise read as if it were message content,
// the same concern web/src/feed/preview.ts's htmlToText() was built to
// guard against on the frontend).
//
// Exported for src/ai/memory-update.ts's buildMemoryEvent, which needs the
// same plain-text extraction to give the memory-update model an actual
// content excerpt to reason about — not just this module's own use.
export function extractPlainBody(body: EmailMessage['body']): string | undefined {
  if (body.text) return body.text;
  if (body.html) return convert(body.html);
  return undefined;
}

/** Converts a real fetched EmailMessage into the metadata classifyEmail()
 *  actually consumes. Provider-agnostic by construction, not by any
 *  special effort here: EmailMessage is already the normalized shape
 *  every MailProvider (today's IMAP, and whatever Gmail/Outlook
 *  providers exist later) is contractually required to produce, so this
 *  function only ever touches fields defined on that generic interface —
 *  never anything provider-specific — and works identically regardless
 *  of which provider the message actually came from.
 *
 *  threadSummary is deliberately never populated — see chat history:
 *  synthesizing prior-thread context is real, separate work nobody's
 *  asked for yet, not something to half-build here. */
export function buildEmailForModel(message: EmailMessage): EmailForModel {
  return {
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    snippet: message.snippet,
    receivedAt: message.receivedAt,
    isRead: message.isRead,
    body: extractPlainBody(message.body),
    folderHint: message.folderId,
  };
}
