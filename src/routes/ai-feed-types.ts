// EmailTriage comes from triage-schema.ts specifically, not triage.ts —
// triage.ts also imports the `ai` SDK/./model (Node-only globals, see
// this file's own comment below), and importing from it here would drag
// all of that into any program that resolves this file's types, exactly
// the problem this file exists to avoid.
import type { EmailTriage } from '../ai/triage-schema';
import type { UnsubscribeAction } from '../mail/list-unsubscribe';
import type { EmailAddress } from '../mail/types';

// Split out from ai-feed.ts on purpose: the frontend type-imports
// AiFeedListItem via the @server/* path mapping (see web/tsconfig.json),
// and that's a SEPARATE, isolated tsc program from the backend's — it has
// no reason to ever import '@fastify/cookie' itself, so it never gets
// that package's request.cookies/reply.setCookie type augmentation.
// ai-feed.ts pulls in requireAuth (and therefore that augmentation) to
// wire up its routes; if the frontend type-imported straight from
// ai-feed.ts, resolving AiFeedListItem would drag requireAuth.ts along
// for type-checking too, and it would fail inside the frontend's program
// for lacking that augmentation. Keeping the wire-shape types in their
// own dependency-light file (only pulling in other already-lean
// @server/* modules, same as EmailMessage/UnsubscribeAction already do)
// avoids that entirely.
export interface ConfirmBody {
  senderPreference?: 'show' | 'hide';
  draftReply?: { subject: string; body: string };
  unsubscribe?: boolean;
}

export interface AiFeedListItem {
  triage: EmailTriage;
  from: EmailAddress;
  subject: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  messageId?: string;
  threadId: string;
  unsubscribe: UnsubscribeAction;
}
