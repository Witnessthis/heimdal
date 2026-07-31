import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';

const FILE_NAME = 'push-vapid.json';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Self-generated and persisted on first use, the same pattern
 *  credentials.ts uses for the password hash — no manual VAPID setup
 *  step, matching this app's self-managed-secret philosophy. Every
 *  caller gets the same pair back once generated, so subscriptions
 *  created against an earlier key never silently stop validating. */
export async function getVapidKeys(dataDir: string): Promise<VapidKeys> {
  try {
    const raw = await readFile(join(dataDir, FILE_NAME), 'utf-8');
    return JSON.parse(raw) as VapidKeys;
  } catch {
    const keys = webpush.generateVAPIDKeys();
    await mkdir(dataDir, { recursive: true });
    try {
      // 'wx': fail instead of overwriting if the file now exists — two
      // concurrent first-ever calls (e.g. a subscribe request racing the
      // classification pipeline's first send) would otherwise each
      // generate a different pair and the second write would silently
      // strand whichever subscription was already made against the first.
      await writeFile(join(dataDir, FILE_NAME), JSON.stringify(keys, null, 2), { mode: 0o600, flag: 'wx' });
      return keys;
    } catch {
      // Lost that race — read back the pair the other caller wrote.
      const raw = await readFile(join(dataDir, FILE_NAME), 'utf-8');
      return JSON.parse(raw) as VapidKeys;
    }
  }
}
