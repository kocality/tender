import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

// #/trust and the home hero: plain words first, the technical wording folded, and every source file it names is a link
// once the build knows the repository URL (VITE_REPO_URL).

const REPO = 'https://github.com/kocality/tender';
/** The text a visitor reads without opening anything: a closed fold drops out, an open one stays (innermost first). */
function unfold(html: string): string {
  const inner = /<details([^>]*)>((?:(?!<details)[\s\S])*?)<\/details>/;
  for (let m = inner.exec(html); m; m = inner.exec(html)) html = html.replace(m[0], /\bopen\b/.test(m[1]!) ? `<div>${m[2]}</div>` : '');
  return html;
}
const visible = (html: string) =>
  unfold(html)
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return { Trust: (await import('../pages/Trust')).Trust, Rich: (await import('../components/Rich')).Rich, HomeView: (await import('../pages/Home')).HomeView };
}
afterEach(() => vi.unstubAllEnvs());

describe('#/trust', () => {
  test('the never-opened limit reads plainly; its technical wording sits in a closed fold inside it', async () => {
    const { Trust } = await load({});
    const html = renderToString(<Trust />);
    const shown = visible(html);
    expect(shown).toContain('Bids in a sale that never opened are not deleted.');
    expect(shown).toContain('its sealed bids are not erased');
    expect(shown).not.toContain('so the MPC threshold still covers them');
    expect(html).toContain('so the MPC threshold still covers them');
  });

  test('with VITE_REPO_URL, docs/protocol.md and JUDGES.md are links into the repository', async () => {
    const { Trust } = await load({ VITE_REPO_URL: REPO });
    const html = renderToString(<Trust />);
    expect(html).toContain(`href="${REPO}/blob/main/docs/protocol.md"`);
    expect(html).toContain(`href="${REPO}/blob/main/JUDGES.md"`);
  });

  test('without it, the same names stay plain text and nothing links to a repository', async () => {
    const { Trust } = await load({ VITE_REPO_URL: '' });
    const html = renderToString(<Trust />);
    expect(html).toContain('docs/protocol.md');
    expect(html).not.toContain('github.com');
  });
});

describe('Rich links the source files a copy string names', () => {
  test('`docs/protocol.md`, `README.md` and `JUDGES.md` become links when the repository URL is known; commands stay code', async () => {
    const { Rich } = await load({ VITE_REPO_URL: REPO });
    const html = renderToString(<Rich text="See `docs/protocol.md`, `README.md` and `JUDGES.md`; run `pnpm verify`." />);
    expect(html).toContain(`<a href="${REPO}/blob/main/docs/protocol.md" target="_blank" rel="noreferrer"><code>docs/protocol.md</code></a>`);
    expect(html).toContain(`href="${REPO}/blob/main/README.md"`);
    expect(html).toContain(`href="${REPO}/blob/main/JUDGES.md"`);
    expect(html).toContain('<code>pnpm verify</code>');
    expect(html).not.toContain('blob/main/pnpm');
  });
});

describe('the home hero', () => {
  test('the caveat under the steps links to the full wording with a one-click "why"', async () => {
    const { HomeView } = await load({});
    const html = renderToString(<HomeView data={null} error={null} loading nowNs={0n} />);
    const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('id="how"'));
    expect(visible(hero)).toContain('Your price stays sealed until the sale opens.');
    expect(hero).toMatch(/<a href="#\/trust">Why these two/);
  });
});
