/** RFC 2369 / RFC 8058 List-Unsubscribe parsing — deterministic, no model
 *  involved. Distinct from EmailTriage's unsubscribeCandidate
 *  (src/ai/triage.ts), which is the model's read on whether an email's
 *  *content* looks promotional; this is only about whether the email
 *  supplies a working, standards-based unsubscribe mechanism, and which
 *  kind. A promotional-looking email can have no List-Unsubscribe header
 *  at all (type: 'none'), and a non-promotional one can still carry one —
 *  most mailing-list software adds it unconditionally, regardless of
 *  content. Provider-agnostic on purpose: it only ever takes the raw
 *  header text, so a future Gmail/Outlook provider reuses it exactly as
 *  the IMAP one does, same as buildEmailForModel. */
export type UnsubscribeAction =
  | { type: 'none' }
  | { type: 'oneClick'; url: string }
  | { type: 'link'; url: string }
  | { type: 'mailto'; address: string; subject?: string; body?: string };

const ONE_CLICK_POST_VALUE = 'list-unsubscribe=one-click';

/** headerValue/postHeaderValue are the raw List-Unsubscribe /
 *  List-Unsubscribe-Post header values exactly as the transport gave
 *  them — this is where the actual RFC parsing happens, so a provider
 *  only ever needs to hand over whatever raw header text it already has. */
export function parseListUnsubscribe(
  headerValue: string | undefined,
  postHeaderValue: string | undefined,
): UnsubscribeAction {
  if (!headerValue) return { type: 'none' };

  const uris = extractUris(headerValue);
  const webUrl = uris.find((uri) => /^https?:\/\//i.test(uri));
  const mailtoUri = uris.find((uri) => /^mailto:/i.test(uri));

  // RFC 8058: one-click requires both an https:// link AND the sender's
  // explicit List-Unsubscribe-Post confirmation that it accepts a bare
  // POST with no further interaction — an https link with no Post header
  // may still render its own confirmation page, so it's only ever a
  // "link", never "oneClick".
  if (webUrl?.startsWith('https://') && isOneClickPost(postHeaderValue)) {
    return { type: 'oneClick', url: webUrl };
  }
  if (webUrl) return { type: 'link', url: webUrl };

  if (mailtoUri) {
    const [rawAddress, query] = mailtoUri.slice('mailto:'.length).split('?');
    const address = rawAddress.trim();
    if (address) return { type: 'mailto', address, ...(query ? parseMailtoQuery(query) : {}) };
  }

  return { type: 'none' };
}

function isOneClickPost(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === ONE_CLICK_POST_VALUE;
}

/** Some senders' automated unsubscribe processing depends on the actual
 *  subject/body their mailto URI specifies (e.g. a fixed subject line
 *  their system parses) — dropping these would silently send a blank
 *  email an automated handler might not recognize. Decoded by hand
 *  rather than via URLSearchParams: RFC 6068 query components are plain
 *  percent-encoded text, and unlike application/x-www-form-urlencoded a
 *  literal '+' is not supposed to mean space, which URLSearchParams
 *  would otherwise silently get wrong for a subject/body containing one. */
function parseMailtoQuery(query: string): { subject?: string; body?: string } {
  const result: { subject?: string; body?: string } = {};
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    const key = safeDecode(rawKey)?.toLowerCase();
    if (key !== 'subject' && key !== 'body') continue;
    const value = safeDecode(rawValue);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** The header value is a comma-separated list of URIs, each wrapped in
 *  angle brackets per RFC 2369 (e.g. "<mailto:a@b.com>, <https://...>").
 *  Some real-world senders omit the brackets entirely on a single-URI
 *  header — falls back to treating the whole trimmed value as one URI
 *  rather than discarding a header that's merely slightly malformed. */
function extractUris(headerValue: string): string[] {
  const bracketed = [...headerValue.matchAll(/<([^>]*)>/g)].map((m) => m[1].trim());
  if (bracketed.length > 0) return bracketed;
  const whole = headerValue.trim();
  return whole ? [whole] : [];
}
