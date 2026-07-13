import { describe, expect, it } from 'vitest';
import type { ImapProviderConfig } from './index';
import { imapClientOptions } from './index';
import { smtpTransportOptions } from './smtp';

// The MITM plaintext-downgrade defense (RFC 3501/3207/8314): on a
// non-implicit-TLS connection, upgrading to TLS must be MANDATORY, so an
// attacker who strips the STARTTLS capability off the server's greeting
// causes a hard connection failure instead of the password going out in
// cleartext. These pin that mapping — a refactor that flips it to always
// -false (opportunistic STARTTLS) would silently reopen the hole.

const imapConfig = (secure: boolean, port: number): ImapProviderConfig => ({
  kind: 'imap',
  host: 'mail.example.com',
  port,
  secure,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  username: 'user@example.com',
});

describe('IMAP STARTTLS enforcement', () => {
  it('makes STARTTLS mandatory on a plaintext port (secure=false)', () => {
    const opts = imapClientOptions(imapConfig(false, 143), { password: 'pw' });
    expect(opts.secure).toBe(false);
    expect(opts.doSTARTTLS).toBe(true); // fail rather than send plaintext
  });

  it('does not request STARTTLS on an implicit-TLS port (secure=true)', () => {
    const opts = imapClientOptions(imapConfig(true, 993), { password: 'pw' });
    expect(opts.secure).toBe(true);
    expect(opts.doSTARTTLS).toBe(false); // already encrypted end to end
  });
});

describe('SMTP STARTTLS enforcement', () => {
  const smtpConfig = (smtpSecure: boolean, smtpPort: number) => ({
    smtpHost: 'smtp.example.com',
    smtpPort,
    smtpSecure,
    username: 'user@example.com',
    smtpPassword: 'pw',
  });

  it('requires TLS on a submission/plaintext port (smtpSecure=false)', () => {
    const opts = smtpTransportOptions(smtpConfig(false, 587));
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true); // fail rather than send plaintext
  });

  it('does not force requireTLS on an implicit-TLS port (smtpSecure=true)', () => {
    const opts = smtpTransportOptions(smtpConfig(true, 465));
    expect(opts.secure).toBe(true);
    expect(opts.requireTLS).toBe(false); // already encrypted end to end
  });
});
