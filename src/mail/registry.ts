import { EventEmitter } from 'node:events';
import { listAccounts } from '../lib/accounts';
import {
  loadProviderCredentials,
  type ProviderConfig,
  type ProviderSecret,
} from '../lib/provider-credentials';
import { qualifyId, splitQualifiedId } from './account-id';
import type { ListMessagesOptions, MailEvent, MailProvider } from './provider';
import { ImapProvider } from './providers/imap';
import type { DraftInput, EmailMessage, EmailSummary, Folder, Page } from './types';

function instantiateProvider(config: ProviderConfig, secret: ProviderSecret): MailProvider {
  switch (config.kind) {
    case 'imap':
      if (!('password' in secret)) throw new Error('Malformed IMAP credentials');
      return new ImapProvider(config, secret);
    case 'gmail':
    case 'outlook':
      throw new Error(`Provider not yet implemented: ${config.kind}`);
  }
}

/** A MailEvent decorated with which account emitted it. `accountId` is a
 *  first-class field rather than something every listener re-derives by
 *  decoding a qualified id, because connectionState carries no message/
 *  folder id of its own to decode it from. `messageId` (when the event
 *  carries one) is itself account-qualified too — see qualifyEvent below —
 *  since it ends up as ai_feed's primary key, which must stay globally
 *  unique now that more than one account can produce one. `folderId` is
 *  deliberately left as the provider's own local id: nothing merges
 *  folders across accounts (the Inbox tab views one account at a time), so
 *  there's no collision to guard against there. */
export type AccountMailEvent = MailEvent & { accountId: string };

function qualifyEvent(accountId: string, event: MailEvent): AccountMailEvent {
  switch (event.type) {
    case 'newMessage':
    case 'messageUpdated':
    case 'messageDeleted':
      return { ...event, accountId, messageId: qualifyId(accountId, event.messageId) };
    case 'connectionState':
      return { ...event, accountId };
  }
}

// `threadId`/`inReplyTo` are deliberately NEVER qualified, unlike `id` —
// they end up verbatim in real outgoing RFC822 headers (References/
// In-Reply-To, see providers/imap/smtp.ts's toMailOptions), and prefixing
// them with our internal accountId would corrupt actual mail sent to real
// recipients. Only `id` (never placed in a header, purely an internal
// lookup key) is qualified.
function qualifySummary<T extends EmailSummary>(accountId: string, summary: T): T {
  return { ...summary, id: qualifyId(accountId, summary.id) };
}

/** Routes calls across every connected mail account. Each account gets its
 *  own MailProvider instance — ImapProvider itself holds only instance-level
 *  state (folderCache, idleConn, ...), so running several concurrently is
 *  already safe; the single-account assumption lived entirely in this
 *  class before this rewrite. Message-scoped operations (getMessage,
 *  setRead, ...) take an account-qualified id and route by decoding it;
 *  account-first operations (listFolders, listMessages, connect/disconnect)
 *  take an explicit accountId since there's no id to derive one from yet. */
class MailService extends EventEmitter {
  private providers = new Map<string, MailProvider>();
  private unsubscribers = new Map<string, () => void>();

  /** Connects every registered account — call once at startup (see
   *  server.ts). A single account failing to connect (bad stored
   *  credentials, unreachable server) is logged and skipped rather than
   *  aborting every other account's connection attempt. */
  async initAll(dataDir: string): Promise<void> {
    const accounts = await listAccounts(dataDir);
    await Promise.all(
      accounts.map((account) =>
        this.connectAccount(dataDir, account.id).catch((err) => {
          console.error(`Failed to connect account ${account.id} (${account.label}):`, err);
        }),
      ),
    );
  }

  async connectAccount(dataDir: string, accountId: string): Promise<void> {
    const stored = await loadProviderCredentials(dataDir, accountId);
    if (!stored) throw new Error(`No credentials stored for account ${accountId}`);
    const provider = instantiateProvider(stored.config, stored.secret);
    const unsubscribe = provider.subscribe((event) => this.emit('event', qualifyEvent(accountId, event)));
    await provider.connect();

    // Only tear down the previous provider (a reconnect, e.g. after
    // updating credentials) once the new one is confirmed connected — a
    // reconfigure that fails to connect shouldn't leave the account with
    // no provider at all.
    const previous = this.providers.get(accountId);
    const previousUnsubscribe = this.unsubscribers.get(accountId);
    this.providers.set(accountId, provider);
    this.unsubscribers.set(accountId, unsubscribe);
    if (previous) {
      previousUnsubscribe?.();
      await previous.disconnect();
    }
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const provider = this.providers.get(accountId);
    if (!provider) return;
    this.unsubscribers.get(accountId)?.();
    this.unsubscribers.delete(accountId);
    this.providers.delete(accountId);
    await provider.disconnect();
  }

  isConfigured(): boolean {
    return this.providers.size > 0;
  }

  isAccountConnected(accountId: string): boolean {
    return this.providers.has(accountId);
  }

  isAccountHealthy(accountId: string): boolean {
    return this.providers.get(accountId)?.isHealthy() ?? false;
  }

  getAccountIds(): string[] {
    return [...this.providers.keys()];
  }

  onEvent(listener: (event: AccountMailEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  private provider(accountId: string): MailProvider {
    const provider = this.providers.get(accountId);
    if (!provider) throw new Error(`No mail provider connected for account ${accountId}`);
    return provider;
  }

  // --- Account-first operations ---

  async listFolders(accountId: string): Promise<Folder[]> {
    return this.provider(accountId).listFolders();
  }

  async listMessages(accountId: string, options: ListMessagesOptions): Promise<Page<EmailSummary>> {
    const page = await this.provider(accountId).listMessages(options);
    return { ...page, items: page.items.map((s) => qualifySummary(accountId, s)) };
  }

  async send(accountId: string, input: DraftInput): Promise<{ messageId: string }> {
    return this.provider(accountId).send(input);
  }

  async saveDraft(accountId: string, input: DraftInput): Promise<{ draftId: string }> {
    const { draftId } = await this.provider(accountId).saveDraft(input);
    return { draftId: qualifyId(accountId, draftId) };
  }

  // --- Message-scoped operations — id already carries its account ---

  /** Groups the given ids by account and dispatches one batched fetch per
   *  account, merging the results back into a single map keyed by the
   *  original qualified id — mirrors what a single-provider call used to
   *  do, just fanned out across however many accounts the ids span. An id
   *  whose account is no longer connected (removed/disconnected since) is
   *  simply absent from the result, same as ImapProvider already treats a
   *  vanished message. */
  async getMessageSummaries(messageIds: string[]): Promise<Map<string, EmailSummary>> {
    const localIdsByAccount = new Map<string, string[]>();
    for (const id of messageIds) {
      const { accountId, localId } = splitQualifiedId(id);
      const localIds = localIdsByAccount.get(accountId);
      if (localIds) localIds.push(localId);
      else localIdsByAccount.set(accountId, [localId]);
    }

    const result = new Map<string, EmailSummary>();
    for (const [accountId, localIds] of localIdsByAccount) {
      const provider = this.providers.get(accountId);
      if (!provider) continue;
      const summaries = await provider.getMessageSummaries(localIds);
      for (const summary of summaries.values()) {
        const qualified = qualifySummary(accountId, summary);
        result.set(qualified.id, qualified);
      }
    }
    return result;
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const { accountId, localId } = splitQualifiedId(messageId);
    const message = await this.provider(accountId).getMessage(localId);
    return qualifySummary(accountId, message);
  }

  async setRead(messageId: string, read: boolean): Promise<void> {
    const { accountId, localId } = splitQualifiedId(messageId);
    await this.provider(accountId).setRead(localId, read);
  }

  async setFlagged(messageId: string, flagged: boolean): Promise<void> {
    const { accountId, localId } = splitQualifiedId(messageId);
    await this.provider(accountId).setFlagged(localId, flagged);
  }

  async moveToFolder(messageId: string, folderId: string): Promise<void> {
    const { accountId, localId } = splitQualifiedId(messageId);
    await this.provider(accountId).moveToFolder(localId, folderId);
  }

  async archive(messageId: string): Promise<void> {
    const { accountId, localId } = splitQualifiedId(messageId);
    await this.provider(accountId).archive(localId);
  }

  async deleteMessage(messageId: string): Promise<void> {
    const { accountId, localId } = splitQualifiedId(messageId);
    await this.provider(accountId).deleteMessage(localId);
  }

  async updateDraft(draftId: string, input: DraftInput): Promise<void> {
    const { accountId, localId } = splitQualifiedId(draftId);
    await this.provider(accountId).updateDraft(localId, input);
  }
}

export const mailService = new MailService();
