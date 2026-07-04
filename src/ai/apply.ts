import { mailService } from '../mail/registry';
import type { ModelDecision } from './types';

export interface ApplyResult {
  applied: boolean;
  requiresConfirmation: boolean;
}

/** Turns a ModelDecision into MailProvider calls. This is the only place in
 *  the codebase that decides what a model output is allowed to do — and
 *  because ModelDecision has no send/delete variant, there is nothing here
 *  that could call provider.send() or provider.trash(). Those are reachable
 *  only from user-triggered routes (src/routes/mail.ts): a "quick-send"
 *  request the user issues after reviewing a draft this function created,
 *  or an explicit trash request. The app, not the model, owns those. */
export async function applyDecision(decision: ModelDecision): Promise<ApplyResult> {
  const provider = mailService.getProvider();

  switch (decision.action) {
    case 'classify':
    case 'prioritize':
      // Local annotation only — no persisted classification/priority store
      // exists yet (out of scope for this pass), and no provider call is
      // needed for either since neither maps to an IMAP/Gmail/Graph
      // operation. Placeholder contract until that store exists.
      return { applied: true, requiresConfirmation: false };

    case 'move':
      await provider.moveToFolder(decision.emailId, decision.targetFolderId);
      return { applied: true, requiresConfirmation: false };

    case 'draftReply': {
      const original = await provider.getMessage(decision.emailId);
      await provider.saveDraft({
        to: [original.from],
        subject: decision.subject,
        body: { text: decision.body },
        // The real RFC822 Message-ID of the message being replied to —
        // decision.emailId is our internal composite id (e.g.
        // "imap:INBOX:42") and must never end up in an email header.
        inReplyTo: original.messageId,
        threadId: original.threadId,
      });
      // Saved as an inert draft the user can review/edit/quick-send later —
      // never sent automatically.
      return { applied: true, requiresConfirmation: true };
    }
  }
}
