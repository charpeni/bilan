import { el, svgEl } from './utils.ts';

/** GitHub bot accounts never get a profile link: the payload's list, or the `[bot]` suffix. */
export const isBot = (login: string, bots: ReadonlySet<string>): boolean =>
  bots.has(login) || login.endsWith('[bot]');

export const profileUrl = (login: string): string => `https://github.com/${login}`;

/**
 * A login as the dashboard shows it: a quiet link to the GitHub profile for a
 * person, plain text for a bot. The text is the login either way, so sorting
 * and the golden text never see the anchor.
 */
export function person(login: string, bots: ReadonlySet<string>): Node {
  if (isBot(login, bots)) return document.createTextNode(login);
  return el('a', {
    class: 'quiet',
    href: profileUrl(login),
    target: '_blank',
    rel: 'noopener',
    text: login,
  });
}

/** The same, inside an SVG `<text>` (bar chart labels). */
export function svgPerson(login: string, bots: ReadonlySet<string>): Node {
  if (isBot(login, bots)) return document.createTextNode(login);
  const a = svgEl('a', {
    class: 'quiet',
    href: profileUrl(login),
    target: '_blank',
    rel: 'noopener',
  });
  a.textContent = login;
  return a;
}

export const prUrl = (repo: string, n: number): string => `https://github.com/${repo}/pull/${n}`;

/** A pull request as a quiet link, `text` being whatever the place shows (`#447`, or number and title). */
export function prLink(repo: string, n: number, text: string): HTMLAnchorElement {
  return el('a', { class: 'quiet', href: prUrl(repo, n), target: '_blank', rel: 'noopener', text });
}
