import { type FetchMessageObject, ImapFlow, type MessageEnvelopeObject } from 'imapflow';
import { type HeaderLines, type Attachment as MailparserAttachment, simpleParser } from 'mailparser';
import type { ImapSecret, ProviderConfig } from '../../../lib/provider-credentials';
import { BaseProvider } from '../../base-provider';
import { ReconnectingConnection } from '../../lifecycle';
import { parseListUnsubscribe } from '../../list-unsubscribe';
import { InvalidRequestError, type ListMessagesOptions, type ProviderKind } from '../../provider';
import type { DraftInput, EmailAddress, EmailMessage, EmailSummary, Folder, Page, Thread } from '../../types';
import { renderRawMessage, sendMail } from './smtp';

export type ImapProviderConfig = Extract<ProviderConfig, { kind: 'imap' }>;

const PROVIDER_PREFIX = 'imap';
/** IDLE only ever watches one mailbox at a time (an IMAP protocol
 *  limitation) — INBOX covers the "near-real-time new mail" case the
 *  product actually needs; other folders are still fully readable/writable
 *  via the request-driven methods below, they just don't push events. */
const IDLE_FOLDER = 'INBOX';

export function encodeMessageId(folderPath: string, uid: number): string {
  return `${PROVIDER_PREFIX}:${encodeURIComponent(folderPath)}:${uid}`;
}

export function decodeMessageId(messageId: string): { folderPath: string; uid: number } {
  const parts = messageId.split(':');
  if (parts.length !== 3 || parts[0] !== PROVIDER_PREFIX) {
    throw new InvalidRequestError(`Invalid message id: ${messageId}`);
  }
  const uid = Number(parts[2]);
  if (!Number.isInteger(uid) || uid < 1) {
    throw new InvalidRequestError(`Invalid message id: ${messageId}`);
  }
  return { folderPath: decodeURIComponent(parts[1]), uid };
}

function toEmailAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
  return { name: addr?.name || undefined, address: addr?.address ?? '' };
}

function stripAngleBrackets(id: string): string {
  return id.replace(/[<>]/g, '');
}

/** mailparser's structured `parsed.headers` Map deliberately does NOT
 *  expose List-Unsubscribe/List-Unsubscribe-Post as plain strings under
 *  their own name — it groups every "List-*" header under one synthetic
 *  'list' key with its own semantic reinterpretation instead (confirmed:
 *  `headers.get('list-unsubscribe')` is always undefined; the value ends
 *  up at `headers.get('list').unsubscribe`, already re-parsed into
 *  mailparser's own shape, not the original header text).
 *  parseListUnsubscribe needs the exact raw RFC 2369/8058 text, so this
 *  reads from `parsed.headerLines` instead — the one place mailparser
 *  still exposes a header's unprocessed line regardless of any of its own
 *  structured parsing elsewhere. Real senders never repeat List-
 *  Unsubscribe, so the first match is enough. */
export function headerLineValue(headerLines: HeaderLines | undefined, name: string): string | undefined {
  const found = headerLines?.find((h) => h.key === name);
  return found?.line.slice(found.line.indexOf(':') + 1).trim();
}

/** Extracts one named header's raw, unfolded value from a targeted
 *  header-only IMAP fetch (e.g. listMessages'/getMessageSummaries'
 *  `headers: [...]` option — a raw Buffer of just the requested header
 *  lines, not a full message). Line-based rather than a single regex so
 *  folded continuation lines (RFC 5322 — a header wrapped across multiple
 *  lines, each continuation starting with whitespace) are joined
 *  correctly instead of truncating at the first fold. Returns undefined
 *  when the header wasn't present in the fetched block at all — distinct
 *  from headerLineValue in this same file, which reads from mailparser's
 *  HeaderLines on a *full* source fetch instead; this one has no
 *  mailparser involved at all, since a header-only IMAP fetch never
 *  builds one. */
export function extractHeaderValue(headers: Buffer | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'i');
  const lines = headers.toString('utf8').split(/\r\n|\r|\n/);
  let collecting = false;
  let value: string | undefined;
  for (const line of lines) {
    if (prefix.test(line)) {
      collecting = true;
      value = line.replace(prefix, '').trim();
      continue;
    }
    if (collecting && /^[ \t]/.test(line)) {
      value += ` ${line.trim()}`;
      continue;
    }
    if (collecting) break;
  }
  return value;
}

/** Parses the raw `References:` header block into an ordered list of
 *  message-ids, oldest first — the format mail clients use to record a
 *  message's full ancestor chain, not just its immediate parent. */
export function parseReferencesHeader(headers: Buffer | undefined): string[] {
  const value = extractHeaderValue(headers, 'References');
  const ids = value?.match(/<[^>]+>/g) ?? [];
  return ids.map(stripAngleBrackets);
}

/** Thread root id for a message: the oldest ancestor in its References
 *  chain when available (covers 3+-message threads correctly), falling
 *  back to In-Reply-To (immediate parent only) and finally the message's
 *  own id for thread starters. */
export function computeThreadId(
  envelope: MessageEnvelopeObject | undefined,
  headers: Buffer | undefined,
): string {
  const references = parseReferencesHeader(headers);
  if (references.length > 0) return references[0];
  const raw = envelope?.inReplyTo || envelope?.messageId || '';
  return stripAngleBrackets(raw);
}

/** Rewrites `cid:` image references (inline-embedded images like a
 *  signature logo) into base64 data URIs using the bytes already pulled
 *  down for this message — no second round trip, and no route that would
 *  let a caller probe for arbitrary attachment ids. Non-inline attachments
 *  are untouched; unresolvable cids are left as-is (the img just won't
 *  render, same as it wouldn't in any other mail client without the
 *  original context). */
export function resolveInlineImages(html: string, inlineImages: MailparserAttachment[]): string {
  if (!inlineImages.length) return html;
  return html.replace(/\bsrc=(["'])cid:([^"']+)\1/gi, (match, quote, rawCid) => {
    const cid = decodeURIComponent(rawCid);
    const image = inlineImages.find((a) => a.cid === cid);
    if (!image) return match;
    return `src=${quote}data:${image.contentType};base64,${image.content.toString('base64')}${quote}`;
  });
}

export function folderKindFromSpecialUse(specialUse: string | undefined, path: string): Folder['kind'] {
  switch (specialUse) {
    case '\\Inbox':
      return 'inbox';
    case '\\Sent':
      return 'sent';
    case '\\Drafts':
      return 'drafts';
    case '\\Junk':
      return 'spam';
    case '\\Trash':
      return 'trash';
    case '\\Archive':
      return 'archive';
  }
  const lower = path.toLowerCase();
  if (lower === 'inbox') return 'inbox';
  if (/sent/.test(lower)) return 'sent';
  if (/draft/.test(lower)) return 'drafts';
  if (/(junk|spam)/.test(lower)) return 'spam';
  if (/(trash|deleted)/.test(lower)) return 'trash';
  if (/archive/.test(lower)) return 'archive';
  return 'custom';
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** listMessages' pageSize comes straight from an authenticated request's
 *  query string (routes/mail.ts does `Number(pageSize)`), so it can arrive
 *  as undefined, NaN, 0, negative, or absurdly large. Clamp it: anything
 *  invalid falls back to the default, and the hard cap bounds how large a
 *  single IMAP fetch an authenticated client can force — a big sequence
 *  range blows a batch's fetch time from ~1s to 10-25s, i.e. an
 *  authenticated self-DoS without this. Pure + exported for testing. */
export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(requested, MAX_PAGE_SIZE);
}

/** ImapFlow connection options, isolated so the STARTTLS-enforcement
 *  invariant is unit-testable without a live server (see
 *  tls-enforcement.test.ts). The security-critical line is `doSTARTTLS`:
 *  when not already on an implicit-TLS port (secure=false), STARTTLS must
 *  be mandatory, not opportunistic — otherwise a MITM can strip the
 *  STARTTLS capability from the server's response and the password goes
 *  out in the clear with no error. doSTARTTLS: true makes imapflow fail
 *  the connection instead of silently downgrading (secure: true +
 *  doSTARTTLS: true is invalid, hence the negation — already-implicit-TLS
 *  connections don't need it). */
export function imapClientOptions(config: ImapProviderConfig, secret: ImapSecret) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    doSTARTTLS: !config.secure,
    auth: { user: config.username, pass: secret.password },
    disableAutoIdle: true,
    logger: false as const,
  };
}

export class ImapProvider extends BaseProvider {
  readonly kind: ProviderKind = 'imap';

  private folderCache = new Map<string, Folder>();
  private idleConn: ReconnectingConnection;
  private idleClient: ImapFlow | null = null;

  constructor(
    private config: ImapProviderConfig,
    private secret: ImapSecret,
  ) {
    super();
    this.idleConn = new ReconnectingConnection({
      connect: () => this.runIdleSession(),
      backoff: { initialMs: 2000, maxMs: 60_000 },
      onStateChange: (state) => this.emitEvent({ type: 'connectionState', state }),
    });
  }

  private newClient(): ImapFlow {
    const client = new ImapFlow(imapClientOptions(this.config, this.secret));
    // ImapFlow emits 'error' on the underlying socket for things like a
    // timeout (closeAfter() has already torn the connection down by the
    // time it does) — Node throws and crashes the *entire process* if an
    // EventEmitter's 'error' event has no listener. The in-flight
    // operation on this client still fails on its own (idle()'s loop sees
    // `client.usable` go false and exits, withClient()'s caller sees a
    // rejected promise), which is what actually drives reconnect/error
    // handling — this listener exists purely to stop a transient network
    // hiccup from taking down the whole server.
    client.on('error', (err) => {
      console.error('IMAP client error:', err instanceof Error ? err.message : err);
    });
    return client;
  }

  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.newClient();
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async connect(): Promise<void> {
    // Validate credentials with a short-lived connection before trusting them
    // and before starting the persistent IDLE session.
    await this.withClient(async () => {});
    this.emitEvent({ type: 'connectionState', state: 'connected' });
    this.idleConn.start();
  }

  async disconnect(): Promise<void> {
    // Order matters: stop() first so ReconnectingConnection's loop sees
    // `stopped` and doesn't schedule a retry once close() below makes the
    // in-flight idle() reject.
    this.idleConn.stop();
    this.idleClient?.close();
    this.idleClient = null;
  }

  private async runIdleSession(): Promise<void> {
    const client = this.newClient();
    this.idleClient = client;
    await client.connect();
    this.emitEvent({ type: 'connectionState', state: 'connected' });
    const lock = await client.getMailboxLock(IDLE_FOLDER);
    try {
      client.on('exists', (data) => {
        // 'exists' fires on any mailbox-size change, including decreases
        // (e.g. a bulk server-side expunge) — only a genuine increase means
        // a new message arrived.
        if (data.count > data.prevCount) {
          void this.emitNewestMessageEvent(client, data.path);
        }
      });
      client.on('expunge', (data) => {
        if (data.uid !== undefined) {
          this.emitEvent({ type: 'messageDeleted', messageId: encodeMessageId(IDLE_FOLDER, data.uid) });
        }
      });
      client.on('flags', (data) => {
        if (data.uid !== undefined) {
          this.emitEvent({ type: 'messageUpdated', messageId: encodeMessageId(IDLE_FOLDER, data.uid) });
        }
      });
      while (client.usable) {
        await client.idle();
      }
    } finally {
      lock.release();
      await client.logout().catch(() => client.close());
      if (this.idleClient === client) this.idleClient = null;
    }
  }

  private async emitNewestMessageEvent(client: ImapFlow, path: string): Promise<void> {
    const mailbox = client.mailbox;
    if (!mailbox) return;
    const msg = await client.fetchOne(String(mailbox.exists), { uid: true });
    if (msg) {
      this.emitEvent({ type: 'newMessage', folderId: path, messageId: encodeMessageId(path, msg.uid) });
    }
  }

  /** Builds a list-view summary from envelope/flag data only — no body
   *  fetch at all, not even a bounded preview. The list view no longer
   *  shows a snippet (see the frontend's buildCard()), so there's nothing
   *  for a body fetch to buy here; skipping it entirely is what keeps
   *  batch loading fast regardless of how many messages (or how large
   *  their attachments) are in a page. `snippet`/`hasAttachments` are
   *  consequently unavailable without a body fetch — left as
   *  empty/false, which is fine since neither is read anywhere in the UI
   *  today. Full content (and real hasAttachments) is only ever fetched
   *  on demand, via getMessage(), once a card is actually expanded.
   *  `unsubscribe` is the one exception: List-Unsubscribe/-Post are two
   *  specific named headers a targeted `headers: [...]` fetch can request
   *  cheaply (see callers), unlike arbitrary body content, so this is
   *  available here too rather than only on the full fetch. */
  private toSummary(folderId: string, msg: FetchMessageObject): EmailSummary {
    const envelope = msg.envelope;
    const flags = msg.flags ?? new Set<string>();
    const unsubscribe = parseListUnsubscribe(
      extractHeaderValue(msg.headers, 'List-Unsubscribe'),
      extractHeaderValue(msg.headers, 'List-Unsubscribe-Post'),
    );

    return {
      id: encodeMessageId(folderId, msg.uid),
      messageId: envelope?.messageId ? stripAngleBrackets(envelope.messageId) : undefined,
      threadId: computeThreadId(envelope, msg.headers),
      folderId,
      from: toEmailAddress(envelope?.from?.[0]),
      to: (envelope?.to ?? []).map(toEmailAddress),
      subject: envelope?.subject ?? '(no subject)',
      snippet: '',
      receivedAt: (envelope?.date ?? new Date()).toISOString(),
      isRead: flags.has('\\Seen'),
      isFlagged: flags.has('\\Flagged'),
      hasAttachments: false,
      unsubscribe,
    };
  }

  async listFolders(): Promise<Folder[]> {
    return this.withClient(async (client) => {
      const list = await client.list();
      const folders: Folder[] = list.map((m) => ({
        id: m.path,
        displayName: m.name,
        kind: folderKindFromSpecialUse(m.specialUse, m.path),
      }));
      this.folderCache = new Map(folders.map((f) => [f.id, f]));
      return folders;
    });
  }

  private async findFolderByKind(kind: Folder['kind']): Promise<Folder | undefined> {
    if (this.folderCache.size === 0) await this.listFolders();
    return [...this.folderCache.values()].find((f) => f.kind === kind);
  }

  /** IMAP has no native paging cursor. This pages by sequence-number range
   *  within the currently-locked mailbox, newest first — pageToken encodes
   *  the upper sequence bound of the next page. Sequence numbers can shift
   *  if messages are expunged between page fetches; acceptable for a
   *  single-user mailbox browsed interactively. */
  async listMessages(options: ListMessagesOptions): Promise<Page<EmailSummary>> {
    const pageSize = clampPageSize(options.pageSize);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(options.folderId);
      try {
        const mailbox = client.mailbox;
        if (!mailbox) return { items: [] };
        let upperBound = mailbox.exists;
        if (options.pageToken !== undefined) {
          upperBound = Number(options.pageToken);
          if (!Number.isInteger(upperBound) || upperBound < 1) {
            throw new InvalidRequestError(`Invalid pageToken: ${options.pageToken}`);
          }
        }
        if (upperBound < 1) return { items: [] };
        const lowerBound = Math.max(1, upperBound - pageSize + 1);

        const items: EmailSummary[] = [];
        // No `source` fetch at all — envelope/flags/references are enough
        // for everything the list view shows (sender, time, subject,
        // read/flagged state), and skipping the body entirely is what
        // keeps batch loading fast regardless of message size or
        // attachments (a multi-MB attachment used to single-handedly blow
        // up a batch's fetch time from ~1s to 10-25s even with a bounded
        // preview fetch — see the conversation that led here). The two
        // List-Unsubscribe headers are requested alongside references —
        // named headers cost nothing like a body fetch does regardless of
        // message size, so toSummary can populate `unsubscribe` for free.
        // Full content is fetched separately, on demand, only when a card
        // is actually expanded.
        for await (const msg of client.fetch(`${lowerBound}:${upperBound}`, {
          uid: true,
          envelope: true,
          flags: true,
          headers: ['references', 'list-unsubscribe', 'list-unsubscribe-post'],
        })) {
          items.push(await this.toSummary(options.folderId, msg));
        }
        items.reverse();

        const nextPageToken = lowerBound > 1 ? String(lowerBound - 1) : undefined;
        return { items, nextPageToken };
      } finally {
        lock.release();
      }
    });
  }

  /** Batched counterpart to toSummary()/listMessages() for a scattered set
   *  of specific ids rather than a contiguous range — one connection (one
   *  withClient() call) covers every id regardless of folder or how many
   *  there are, instead of a caller looping getMessage() once per id (see
   *  MailProvider's own doc comment on why this exists). Grouped by
   *  folder since a UID set is only meaningful within one mailbox at a
   *  time; in practice every AI Feed id is INBOX (IDLE only ever watches
   *  one folder), so this almost always means exactly one group. One
   *  folder failing (e.g. it was since deleted) doesn't take down the
   *  others — each group is caught independently, same resilience
   *  buildFeedList's old per-item try/catch had, just moved down a
   *  layer. */
  async getMessageSummaries(messageIds: string[]): Promise<Map<string, EmailSummary>> {
    const uidsByFolder = new Map<string, number[]>();
    for (const id of messageIds) {
      const { folderPath, uid } = decodeMessageId(id);
      const uids = uidsByFolder.get(folderPath);
      if (uids) uids.push(uid);
      else uidsByFolder.set(folderPath, [uid]);
    }

    const summaries = new Map<string, EmailSummary>();
    if (uidsByFolder.size === 0) return summaries;

    await this.withClient(async (client) => {
      for (const [folderPath, uids] of uidsByFolder) {
        try {
          const lock = await client.getMailboxLock(folderPath);
          try {
            for await (const msg of client.fetch(
              uids,
              {
                envelope: true,
                flags: true,
                headers: ['references', 'list-unsubscribe', 'list-unsubscribe-post'],
              },
              { uid: true },
            )) {
              const summary = this.toSummary(folderPath, msg);
              summaries.set(summary.id, summary);
            }
          } finally {
            lock.release();
          }
        } catch (err) {
          console.error(`Failed to fetch message summaries from ${folderPath}:`, err);
        }
      }
    });
    return summaries;
  }

  /** Builds a normalized, full-content EmailMessage from a raw fetch
   *  result. Used by getMessage() — the on-demand, full-content fetch for
   *  a single expanded card; the list view uses toSummary() instead,
   *  which works off a bounded preview fetch and never pulls attachment
   *  content. */
  private async toEmailMessage(folderPath: string, msg: FetchMessageObject): Promise<EmailMessage> {
    const parsed = msg.source ? await simpleParser(msg.source) : undefined;
    const envelope = msg.envelope;
    const flags = msg.flags ?? new Set<string>();
    const references = (
      Array.isArray(parsed?.references) ? parsed.references : parsed?.references ? [parsed.references] : []
    ).map(stripAngleBrackets);
    const threadId =
      references[0] ??
      (parsed?.inReplyTo ? stripAngleBrackets(parsed.inReplyTo) : undefined) ??
      (envelope?.messageId ? stripAngleBrackets(envelope.messageId) : '');

    // `related` attachments are inline-embedded (e.g. a signature logo
    // referenced via cid: in the HTML body) rather than something a user
    // would want to see offered for download — keep those out of the
    // downloadable attachments list and hasAttachments, and use them only
    // to resolve the cid: references in the body itself.
    const inlineImages = (parsed?.attachments ?? []).filter((a) => a.related);
    const downloadableAttachments = (parsed?.attachments ?? []).filter((a) => !a.related);
    const unsubscribe = parseListUnsubscribe(
      headerLineValue(parsed?.headerLines, 'list-unsubscribe'),
      headerLineValue(parsed?.headerLines, 'list-unsubscribe-post'),
    );

    return {
      id: encodeMessageId(folderPath, msg.uid),
      messageId: envelope?.messageId ? stripAngleBrackets(envelope.messageId) : undefined,
      threadId,
      folderId: folderPath,
      from: toEmailAddress(envelope?.from?.[0]),
      to: (envelope?.to ?? []).map(toEmailAddress),
      cc: (envelope?.cc ?? []).map(toEmailAddress),
      bcc: (envelope?.bcc ?? []).map(toEmailAddress),
      subject: envelope?.subject ?? '(no subject)',
      snippet: (parsed?.text ?? '').slice(0, 200),
      receivedAt: (envelope?.date ?? new Date()).toISOString(),
      isRead: flags.has('\\Seen'),
      isFlagged: flags.has('\\Flagged'),
      hasAttachments: downloadableAttachments.length > 0,
      body: {
        text: parsed?.text,
        html: typeof parsed?.html === 'string' ? resolveInlineImages(parsed.html, inlineImages) : undefined,
      },
      attachments: downloadableAttachments.map((a, i) => ({
        id: a.cid ?? String(i),
        filename: a.filename ?? `attachment-${i}`,
        mimeType: a.contentType,
        sizeBytes: a.size,
      })),
      inReplyTo: parsed?.inReplyTo,
      references,
      unsubscribe,
    };
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const { folderPath, uid } = decodeMessageId(messageId);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { envelope: true, flags: true, source: true },
          { uid: true },
        );
        if (!msg) throw new Error(`Message not found: ${messageId}`);
        return this.toEmailMessage(folderPath, msg);
      } finally {
        lock.release();
      }
    });
  }

  /** No portable cross-folder threading over generic IMAP without a
   *  server-side SEARCH/THREAD extension. This v1 implementation scans
   *  INBOX only and groups client-side by the same root-id heuristic used
   *  in toSummary (References-chain root, falling back to In-Reply-To) —
   *  O(n) per call, acceptable for a personal mailbox. Revisit if/when a
   *  persisted message index exists. */
  async getThread(threadId: string): Promise<Thread> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(IDLE_FOLDER);
      try {
        const matches: EmailSummary[] = [];
        for await (const msg of client.fetch('1:*', {
          uid: true,
          envelope: true,
          flags: true,
          headers: ['references'],
        })) {
          const summary = await this.toSummary(IDLE_FOLDER, msg);
          if (summary.threadId === threadId || summary.messageId === threadId) {
            matches.push(summary);
          }
        }
        matches.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

        const participants = new Map<string, EmailAddress>();
        for (const m of matches) participants.set(m.from.address, m.from);

        return {
          id: threadId,
          subject: matches[0]?.subject ?? '',
          messageIds: matches.map((m) => m.id),
          participantAddresses: [...participants.values()],
          lastMessageAt: matches[matches.length - 1]?.receivedAt ?? new Date().toISOString(),
          isRead: matches.every((m) => m.isRead),
        };
      } finally {
        lock.release();
      }
    });
  }

  async setRead(messageId: string, read: boolean): Promise<void> {
    const { folderPath, uid } = decodeMessageId(messageId);
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        if (read) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    });
    this.emitEvent({ type: 'messageUpdated', messageId });
  }

  async setFlagged(messageId: string, flagged: boolean): Promise<void> {
    const { folderPath, uid } = decodeMessageId(messageId);
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        if (flagged) await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
        else await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
      } finally {
        lock.release();
      }
    });
    this.emitEvent({ type: 'messageUpdated', messageId });
  }

  async moveToFolder(messageId: string, folderId: string): Promise<void> {
    const { folderPath, uid } = decodeMessageId(messageId);
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        await client.messageMove(String(uid), folderId, { uid: true });
      } finally {
        lock.release();
      }
    });
    // The old composite id (folder+uid) is no longer valid — signal removal
    // from its previous location. The new location surfaces on next list.
    this.emitEvent({ type: 'messageDeleted', messageId });
  }

  async archive(messageId: string): Promise<void> {
    const folder = await this.findFolderByKind('archive');
    if (!folder) throw new Error('No archive folder found on this account');
    await this.moveToFolder(messageId, folder.id);
  }

  /** A real, permanent delete — sets \Deleted and expunges the message
   *  from its current mailbox, via imapflow's messageDelete(). Deliberately
   *  NOT a move to a Trash folder: that would depend on one existing and
   *  being correctly identified (special-use flag or name heuristic, see
   *  folderKindFromSpecialUse), which not every account has — see chat
   *  history for the decision to require nothing about the account's
   *  folder structure instead. Whether this is actually recoverable
   *  afterwards is entirely up to the server (some auto-back up expunged
   *  mail on their own); this app makes no promise either way. */
  async deleteMessage(messageId: string): Promise<void> {
    const { folderPath, uid } = decodeMessageId(messageId);
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        await client.messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
    });
    this.emitEvent({ type: 'messageDeleted', messageId });
  }

  async saveDraft(input: DraftInput): Promise<{ draftId: string }> {
    const folder = await this.findFolderByKind('drafts');
    if (!folder) throw new Error('No drafts folder found on this account');
    const raw = await renderRawMessage(input, this.config.username);
    return this.withClient(async (client) => {
      const result = await client.append(folder.id, raw, ['\\Draft']);
      if (!result || result.uid === undefined) throw new Error('Failed to save draft');
      return { draftId: encodeMessageId(folder.id, result.uid) };
    });
  }

  async updateDraft(draftId: string, input: DraftInput): Promise<void> {
    const { folderPath, uid } = decodeMessageId(draftId);
    const raw = await renderRawMessage(input, this.config.username);
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        await client.messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
      await client.append(folderPath, raw, ['\\Draft']);
    });
  }

  async send(input: DraftInput): Promise<{ messageId: string }> {
    const smtpPassword = this.secret.smtpPassword ?? this.secret.password;
    return sendMail(
      {
        smtpHost: this.config.smtpHost,
        smtpPort: this.config.smtpPort,
        smtpSecure: this.config.smtpSecure,
        username: this.config.username,
        smtpPassword,
      },
      input,
    );
  }
}
