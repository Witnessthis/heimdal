import nodemailer from 'nodemailer';
import type { DraftInput, EmailAddress } from '../../types';

export interface ImapSmtpConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  smtpPassword: string;
}

function toAddressList(addresses: EmailAddress[] | undefined): string[] | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  return addresses.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address));
}

function toMailOptions(input: DraftInput, from: string) {
  return {
    from,
    to: toAddressList(input.to),
    cc: toAddressList(input.cc),
    bcc: toAddressList(input.bcc),
    subject: input.subject,
    text: input.body.text,
    html: input.body.html,
    inReplyTo: input.inReplyTo,
    // Ties the reply into its thread for clients that key off References
    // rather than (or in addition to) In-Reply-To. Only the thread root is
    // known here rather than the full ancestor chain, but that's enough
    // for most clients' threading heuristics.
    references: input.threadId,
  };
}

/** Renders a DraftInput into a raw RFC822 message without sending it over
 *  the network — used to build the payload for IMAP APPEND (saving to the
 *  Drafts folder). */
export async function renderRawMessage(input: DraftInput, from: string): Promise<Buffer> {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transporter.sendMail(toMailOptions(input, from));
  return info.message as Buffer;
}

/** The only function in the IMAP provider that puts a message on the wire. */
export async function sendMail(config: ImapSmtpConfig, input: DraftInput): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    // RFC 3207/8314: on a non-implicit-TLS port, STARTTLS must be
    // mandatory — otherwise a MITM can strip the STARTTLS capability from
    // the EHLO response and nodemailer silently sends the password over
    // plaintext. requireTLS makes it fail the connection instead.
    requireTLS: !config.smtpSecure,
    auth: { user: config.username, pass: config.smtpPassword },
  });
  const info = await transporter.sendMail(toMailOptions(input, config.username));
  return { messageId: info.messageId };
}
