import { EventEmitter } from 'node:events';
import type { ListMessagesOptions, MailEvent, MailProvider, ProviderKind } from './provider';
import type { DraftInput, EmailMessage, EmailSummary, Folder, Page, Thread } from './types';

/** Shared event plumbing for every provider. Concrete providers call
 *  `emitEvent()` from their own connect/idle/webhook/watch logic — this is
 *  the one thing that makes all three transports (IMAP IDLE, Gmail Pub/Sub,
 *  Outlook Graph webhooks) look identical to the rest of the app. */
export abstract class BaseProvider implements MailProvider {
  abstract readonly kind: ProviderKind;

  private emitter = new EventEmitter();
  private healthy = false;

  protected emitEvent(event: MailEvent): void {
    if (event.type === 'connectionState') this.healthy = event.state === 'connected';
    this.emitter.emit('event', event);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  subscribe(onEvent: (event: MailEvent) => void): () => void {
    this.emitter.on('event', onEvent);
    return () => this.emitter.off('event', onEvent);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract listFolders(): Promise<Folder[]>;
  abstract listMessages(options: ListMessagesOptions): Promise<Page<EmailSummary>>;
  abstract getMessage(messageId: string): Promise<EmailMessage>;
  abstract getThread(threadId: string): Promise<Thread>;

  abstract setRead(messageId: string, read: boolean): Promise<void>;
  abstract setFlagged(messageId: string, flagged: boolean): Promise<void>;
  abstract moveToFolder(messageId: string, folderId: string): Promise<void>;
  abstract archive(messageId: string): Promise<void>;
  abstract trash(messageId: string): Promise<void>;

  abstract saveDraft(input: DraftInput): Promise<{ draftId: string }>;
  abstract updateDraft(draftId: string, input: DraftInput): Promise<void>;
  abstract send(input: DraftInput): Promise<{ messageId: string }>;
}
