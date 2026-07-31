// aiFeedView itself is already owned by feed/dom.ts (shared with
// settings.ts's showView() for the display-toggle) — re-exported here so
// every ai-feed/* module has one place to import both refs from, matching
// the feed/dom.ts / settings' own dom-ref convention.
export { aiFeedView } from '../feed/dom';
export const aiFeedStatus = document.getElementById('ai-feed-status') as HTMLElement;
