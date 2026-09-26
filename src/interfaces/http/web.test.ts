import { describe, expect, it } from 'vitest';
import { assetPathFor, isInside, typeFor } from './web.js';

/**
 * The allowlist is the security boundary for the web app, so it gets tested
 * like one. Every case below is an attempt to read a file that is not part of
 * the app; all of them have to fail closed.
 */
describe('web asset allowlist', () => {
  it('maps the app shell and its assets', () => {
    expect(assetPathFor('/app')).toBe('index.html');
    expect(assetPathFor('/app/')).toBe('index.html');
    expect(assetPathFor('/app/index.html')).toBe('index.html');
    expect(assetPathFor('/app/app.js')).toBe('app.js');
    expect(assetPathFor('/app/assets/app.css')).toBe('assets/app.css');
    expect(assetPathFor('/app/lib/money.js')).toBe('lib/money.js');
    expect(assetPathFor('/app/app.js?v=2')).toBe('app.js');
  });

  it('refuses anything that is not on the list', () => {
    for (const url of [
      '/app/../package.json',
      '/app/../../.env',
      '/app/lib/../server.mjs',
      '/app/secret.txt',
      '/app/lib',
      '/appx/app.js',
      '/app/assets/app.css.map',
    ]) {
      expect(assetPathFor(url), url).toBeNull();
    }
  });

  it('keeps traversal attempts inside the web root', () => {
    expect(isInside('/srv/ledgerline/public', 'index.html')).toBe(true);
    expect(isInside('/srv/ledgerline/public', 'assets/app.css')).toBe(true);
    expect(isInside('/srv/ledgerline/public', '../package.json')).toBe(false);
    expect(isInside('/srv/ledgerline/public', '../../.env')).toBe(false);
    expect(isInside('/srv/ledgerline/public', 'assets/../../secrets')).toBe(false);
    expect(isInside('/srv/ledgerline/public', '/etc/passwd')).toBe(false);
    expect(isInside('/srv/ledgerline/public', '../public-evil/x.js')).toBe(false);
  });

  it('labels content types, and never guesses html for a script', () => {
    expect(typeFor('/app')).toBe('text/html; charset=utf-8');
    expect(typeFor('/app/app.js')).toBe('text/javascript; charset=utf-8');
    expect(typeFor('/app/assets/app.css')).toBe('text/css; charset=utf-8');
    expect(typeFor('/app/../package.json')).toBe('application/octet-stream');
  });
});
