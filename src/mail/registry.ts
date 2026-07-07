import { EventEmitter } from 'node:events';
import {
  loadProviderCredentials,
  type ProviderConfig,
  type ProviderSecret,
} from '../lib/provider-credentials';
import type { MailEvent, MailProvider } from './provider';
import { ImapProvider } from './providers/imap';

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

/** The one place in the app that ever branches on ProviderKind. Everything
 *  else — routes, and later the AI layer — depends only on
 *  `mailService.getProvider(): MailProvider`. Re-broadcasts the configured
 *  provider's events so subscribers don't need to reach into provider
 *  internals or re-subscribe across a provider swap. */
class MailService extends EventEmitter {
  private provider: MailProvider | null = null;

  async init(dataDir: string): Promise<void> {
    const stored = await loadProviderCredentials(dataDir);
    if (!stored) return;
    const provider = instantiateProvider(stored.config, stored.secret);
    provider.subscribe((event: MailEvent) => this.emit('event', event));
    await provider.connect();
    // Only tear down the previous provider once the new one is confirmed
    // connected — a reconfigure that fails to connect shouldn't leave the
    // app with no provider at all.
    const previous = this.provider;
    this.provider = provider;
    if (previous) await previous.disconnect();
  }

  isConfigured(): boolean {
    return this.provider !== null;
  }

  getProvider(): MailProvider {
    if (!this.provider) throw new Error('No mail provider configured');
    return this.provider;
  }

  onEvent(listener: (event: MailEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const mailService = new MailService();
