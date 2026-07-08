// Some Node versions ship their own native `localStorage` global that
// requires a --localstorage-file flag to actually work — without it,
// property access throws or reads as undefined. That can silently shadow
// jsdom's own implementation under Vitest depending on the Node version
// running the tests, breaking anything that touches localStorage-backed
// code (settings/reading-prefs.ts) for reasons that have nothing to do
// with the code under test. Install a minimal, always-working in-memory
// implementation instead of depending on whichever localStorage the
// current Node/jsdom combination happens to expose.
class MemoryStorage implements Storage {
  #store = new Map<string, string>();

  get length() {
    return this.#store.size;
  }

  clear(): void {
    this.#store.clear();
  }

  getItem(key: string): string | null {
    return this.#store.has(key) ? this.#store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.#store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#store.set(key, String(value));
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});
