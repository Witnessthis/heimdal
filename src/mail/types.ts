export interface EmailAddress {
  name?: string;
  address: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmailSummary {
  id: string;
  /** RFC822 Message-ID header of this message itself (angle brackets
   *  stripped), when the provider can supply it — distinct from
   *  `EmailMessage.inReplyTo`/`references`, which describe what *this*
   *  message is replying to, not its own identity. Used to build a correct
   *  `In-Reply-To` header when drafting a reply to this message. */
  messageId?: string;
  threadId: string;
  folderId: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
}

export interface EmailBody {
  text?: string;
  html?: string;
}

export interface EmailMessage extends EmailSummary {
  cc: EmailAddress[];
  bcc: EmailAddress[];
  body: EmailBody;
  attachments: Attachment[];
  inReplyTo?: string;
  references: string[];
}

export interface Thread {
  id: string;
  subject: string;
  messageIds: string[];
  participantAddresses: EmailAddress[];
  lastMessageAt: string;
  isRead: boolean;
}

export interface Folder {
  id: string;
  displayName: string;
  kind: 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam' | 'custom';
  unreadCount?: number;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

export interface DraftInput {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: EmailBody;
  inReplyTo?: string;
  threadId?: string;
}
