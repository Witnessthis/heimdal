import { beforeEach, describe, expect, it } from 'vitest';

// compose.ts reads a large number of #compose-* elements from the DOM at
// module load time (module-level `const composeView = document.getElementById(...)`,
// etc.) — importing it without that markup present would throw on import.
// parseAddressList doesn't touch any of that state, but it lives in the
// same module, so the test document needs the compose view's markup
// before compose.ts can be imported at all.
document.body.innerHTML = `
  <div id="compose-view">
    <div id="compose-to-wrap">
      <div id="compose-to-front">
        <div id="compose-to-field"><input id="compose-to" /></div>
        <div id="compose-to-lock"></div>
      </div>
      <button id="compose-to-discard"></button>
      <button id="compose-to-send"></button>
    </div>
    <span id="compose-to-lock-text"></span>
    <button id="compose-to-edit"></button>
    <div id="compose-to-row"></div>
    <input id="compose-cc" />
    <input id="compose-bcc" />
    <button id="compose-expand-toggle"></button>
    <div id="compose-extra-fields"></div>
    <input id="compose-subject" />
    <textarea id="compose-body"></textarea>
    <p id="compose-error"></p>
  </div>
  <nav id="bottom-nav"></nav>
`;

const { parseAddressList } = await import('./compose');

describe('parseAddressList', () => {
  beforeEach(() => {
    document.body.querySelectorAll('input, textarea').forEach((el) => {
      (el as HTMLInputElement).value = '';
    });
  });

  it('splits comma-separated addresses', () => {
    expect(parseAddressList('a@example.com,b@example.com')).toEqual([
      { address: 'a@example.com' },
      { address: 'b@example.com' },
    ]);
  });

  it('trims whitespace around each address', () => {
    expect(parseAddressList('  a@example.com , b@example.com  ')).toEqual([
      { address: 'a@example.com' },
      { address: 'b@example.com' },
    ]);
  });

  it('drops empty entries from stray/trailing commas', () => {
    expect(parseAddressList('a@example.com,,b@example.com,')).toEqual([
      { address: 'a@example.com' },
      { address: 'b@example.com' },
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
  });

  it('returns a single-entry array for one address with no comma', () => {
    expect(parseAddressList('a@example.com')).toEqual([{ address: 'a@example.com' }]);
  });
});
