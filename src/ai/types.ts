import type { EmailAddress } from '../mail/types';

/** Structured representation of an email handed to the model — extracted
 *  metadata, not raw provider objects, so the model never needs to know
 *  which provider the message came from. `body` is populated only when a
 *  draft-reply decision is being requested; classify/prioritize calls never
 *  send the body. */
export interface EmailForModel {
  id: string;
  threadId: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  /** Short synthesized prior-thread context, not raw prior message bodies. */
  threadSummary?: string;
  body?: string;
  folderHint?: string;
}

export type FolderLabel = string;

/** Structurally excludes send/delete — there is no union member that could
 *  represent them, so applyDecision() and any route consuming this type
 *  cannot accidentally wire one up without a human adding a new variant
 *  here first. That's the only enforcement that exists today: no Vercel AI
 *  SDK call site is wired up yet (deferred to a later pass), so there is no
 *  runtime/schema layer mirroring this union. When one is added, its zod
 *  schema should mirror this type exactly so the boundary is enforced both
 *  at compile time and at the SDK's runtime validation layer — until then,
 *  adding a send/delete variant here is a one-line change with no second
 *  safety net catching it. */
export type ModelDecision =
  | { action: 'classify'; emailId: string; labels: FolderLabel[]; confidence: number }
  | { action: 'prioritize'; emailId: string; priority: 'urgent' | 'normal' | 'low'; reason: string }
  | { action: 'move'; emailId: string; targetFolderId: string; reason: string }
  | { action: 'draftReply'; emailId: string; subject: string; body: string; reason: string };
