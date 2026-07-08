import type { EmailMessage, EmailSummary } from '@server/mail/types';

// Remembers each card's original EmailSummary/EmailMessage so
// ensureFullBodyLoaded() can check for an already-complete `.body` (see
// toSummary() on the backend) without threading an extra parameter
// through every call site. A WeakMap rather than a data attribute since
// the value is a real object, not a string, and it should disappear on
// its own once a card is removed from the feed.
export const cardData = new WeakMap<HTMLElement, EmailSummary | EmailMessage>();
