import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebPushError extends Error {
  statusCode: number;
  constructor(statusCode: number) {
    super(`mock WebPushError ${statusCode}`);
    this.statusCode = statusCode;
  }
}

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
const webPushMock = { sendNotification, setVapidDetails, WebPushError: MockWebPushError };
// Covers both `import webpush from 'web-push'` (needs .default under
// Vitest's ESM-first module handling) and a plain named-import shape,
// since which one actually applies depends on transform details this
// test shouldn't need to know about.
vi.mock('web-push', () => ({ default: webPushMock, ...webPushMock }));

vi.mock('./push-keys', () => ({ getVapidKeys: vi.fn() }));
vi.mock('./push-subscriptions', () => ({
  getAllSubscriptions: vi.fn(),
  removeSubscription: vi.fn(),
}));

const { getVapidKeys } = await import('./push-keys');
const { getAllSubscriptions, removeSubscription } = await import('./push-subscriptions');
const { sendFeedNotification, vapidSubject } = await import('./send-push');

const DATA_DIR = '/data';
const notification = { title: 'Subject line', body: 'A short preview', emailId: 'imap:INBOX:1', count: 3 };
const subA = { endpoint: 'https://push.example/a', keys: { p256dh: 'p256dh-a', auth: 'auth-a' } };
const subB = { endpoint: 'https://push.example/b', keys: { p256dh: 'p256dh-b', auth: 'auth-b' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVapidKeys).mockResolvedValue({ publicKey: 'pub', privateKey: 'priv' });
});
afterEach(() => {
  delete process.env.DOMAIN;
});

describe('vapidSubject', () => {
  it('uses https://<DOMAIN> when DOMAIN is set — see the BadJwtToken regression this fixed', () => {
    process.env.DOMAIN = 'witnessthis.eu';
    expect(vapidSubject()).toBe('https://witnessthis.eu');
  });

  it('falls back to a placeholder when DOMAIN is unset (dev — push never actually fires here)', () => {
    expect(vapidSubject()).toBe('mailto:heimdal@localhost');
  });
});

describe('sendFeedNotification', () => {
  it('does nothing when there are no subscriptions — never even reads the VAPID keys', async () => {
    vi.mocked(getAllSubscriptions).mockResolvedValue([]);
    await sendFeedNotification(DATA_DIR, notification);

    expect(getVapidKeys).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sets the VAPID identity from the real keys and DOMAIN, then sends to every subscription', async () => {
    process.env.DOMAIN = 'witnessthis.eu';
    vi.mocked(getAllSubscriptions).mockResolvedValue([subA, subB]);
    sendNotification.mockResolvedValue(undefined);

    await sendFeedNotification(DATA_DIR, notification);

    expect(setVapidDetails).toHaveBeenCalledWith('https://witnessthis.eu', 'pub', 'priv');
    expect(sendNotification).toHaveBeenCalledWith(subA, JSON.stringify(notification));
    expect(sendNotification).toHaveBeenCalledWith(subB, JSON.stringify(notification));
  });

  it('prunes a subscription that 404s/410s, without stopping delivery to the others', async () => {
    vi.mocked(getAllSubscriptions).mockResolvedValue([subA, subB]);
    sendNotification.mockImplementation(async (target: typeof subA) => {
      if (target.endpoint === subA.endpoint) throw new MockWebPushError(410);
    });

    await sendFeedNotification(DATA_DIR, notification);

    expect(removeSubscription).toHaveBeenCalledWith(DATA_DIR, subA.endpoint);
    expect(removeSubscription).not.toHaveBeenCalledWith(DATA_DIR, subB.endpoint);
    expect(sendNotification).toHaveBeenCalledWith(subB, JSON.stringify(notification));
  });

  it('logs and swallows a non-404/410 failure (e.g. BadJwtToken) without pruning or throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getAllSubscriptions).mockResolvedValue([subA]);
    sendNotification.mockRejectedValue(new MockWebPushError(403));

    await expect(sendFeedNotification(DATA_DIR, notification)).resolves.toBeUndefined();

    expect(removeSubscription).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
