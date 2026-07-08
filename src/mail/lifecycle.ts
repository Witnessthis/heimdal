/** For anything with an expiry that needs periodic re-issuance: Gmail
 *  Pub/Sub watch() (~7d) and Graph webhook subscriptions (~3d). Not used by
 *  the IMAP provider (which has no lease concept) — kept here so future
 *  Gmail/Outlook providers share one renewal implementation. */
export class RenewableLease {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private opts: {
      renew: () => Promise<{ expiresAt: Date }>;
      renewMarginMs: number;
      onError: (err: unknown) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.renewAndSchedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async renewAndSchedule(): Promise<void> {
    if (this.stopped) return;
    try {
      const { expiresAt } = await this.opts.renew();
      if (this.stopped) return;
      const delay = Math.max(0, expiresAt.getTime() - Date.now() - this.opts.renewMarginMs);
      this.timer = setTimeout(() => void this.renewAndSchedule(), delay);
    } catch (err) {
      this.opts.onError(err);
    }
  }
}

export type ConnectionState = 'connected' | 'reconnecting' | 'degraded';

/** For a persistent stateful connection that can drop: IMAP's IDLE socket.
 *  `connect` owns one full session — it should establish the connection,
 *  report success itself (the wrapper has no way to know when login
 *  actually succeeds), and then block for as long as the session stays
 *  alive (e.g. via IMAP's own idle() loop), resolving/throwing once it
 *  ends so the wrapper can retry with backoff. */
export class ReconnectingConnection {
  private stopped = false;
  private attempt = 0;

  constructor(
    private opts: {
      connect: () => Promise<void>;
      backoff: { initialMs: number; maxMs: number };
      onStateChange: (state: Extract<ConnectionState, 'reconnecting' | 'degraded'>) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.attempt > 0) this.opts.onStateChange('reconnecting');
      try {
        await this.opts.connect();
        this.attempt = 0;
      } catch {
        this.attempt += 1;
        this.opts.onStateChange('degraded');
      }
      if (this.stopped) return;
      const delay = Math.min(this.opts.backoff.initialMs * 2 ** this.attempt, this.opts.backoff.maxMs);
      await sleep(delay);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
