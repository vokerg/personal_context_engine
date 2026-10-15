import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App.js';

describe('web scaffold', () => {
  it('does not expose note content or claim to be signed in', () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain('Private notes are not available');
  });
});
