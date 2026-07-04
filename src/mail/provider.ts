import type { DraftInput, EmailMessage, EmailSummary, Folder, Page, Thread } from './types';

export type ProviderKind = 'imap' | 'gmail' | 'outlook';

/** Thrown by a provider when caller-supplied input (a message id, page
 *  token, etc.) is malformed — as opposed to a real backend/network
 *  failure. Provider-agnostic so route handlers can catch it without
 *  knowing which provider is behind `MailProvider` and map it to a clean
 *  400 instead of leaking an opaque backend error as a 500. */
export class InvalidRequestError extends Error {}

export type MailEvent =
  | { type: 'newMessage'; folderId: string; messageId: string }
  | { type: 'messageUpdated'; messageId: string }
  | { type: 'messageDeleted'; messageId: string }
  | { type: 'connectionState'; state: 'connected' | 'reconnecting' | 'degraded' };

export interface ListMessagesOptions {
  folderId: string;
  pageToken?: string;
  pageSize?: number;
  query?: string;
}

export interface MailProvider {
  readonly kind: ProviderKind;

  /** Validate stored credentials and establish whatever "connected" means for
   *  this transport (OAuth token check, IMAP login, Graph token acquisition).
   *  Must not throw on transient network errors — those surface as
   *  connectionState events; only throw for "credentials are wrong/revoked". */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): boolean;

  listFolders(): Promise<Folder[]>;
  listMessages(options: ListMessagesOptions): Promise<Page<EmailSummary>>;
  getMessage(messageId: string): Promise<EmailMessage>;
  getThread(threadId: string): Promise<Thread>;

  setRead(messageId: string, read: boolean): Promise<void>;
  setFlagged(messageId: string, flagged: boolean): Promise<void>;
  moveToFolder(messageId: string, folderId: string): Promise<void>;
  archive(messageId: string): Promise<void>;
  /** Soft-delete (moves to Trash/Deleted Items). There is deliberately no
   *  permanentlyDelete() — keeps the one truly irreversible verb out of the
   *  interface entirely. */
  trash(messageId: string): Promise<void>;

  saveDraft(input: DraftInput): Promise<{ draftId: string }>;
  updateDraft(draftId: string, input: DraftInput): Promise<void>;

  /** The only method that puts a message on the wire. Called exclusively from
   *  a user-triggered "quick-send" route handler — never from src/ai/. */
  send(input: DraftInput): Promise<{ messageId: string }>;

  /** Normalizes Pub/Sub push, Graph webhooks, and IMAP IDLE into one event
   *  shape. Returns an unsubscribe function. */
  subscribe(onEvent: (event: MailEvent) => void): () => void;
}
