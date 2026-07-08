// Shared DOM references for the feed/nav shell — a single query per
// element rather than every module that needs one re-querying the DOM.
export const feed = document.getElementById('feed') as HTMLElement;
export const feedStatus = document.getElementById('feed-status') as HTMLElement;
export const settingsView = document.getElementById('settings-view') as HTMLElement;
export const nav = document.getElementById('bottom-nav') as HTMLElement;
export const navInbox = document.getElementById('nav-inbox') as HTMLElement;
export const navSettings = document.getElementById('nav-settings') as HTMLElement;
