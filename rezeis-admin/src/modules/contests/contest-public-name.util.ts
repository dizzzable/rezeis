/**
 * A winner's name as everybody else sees it: enough to tell that a real
 * person won, not enough to find them. «Иван Петров» → «Ив***в», «@neo» →
 * «n***». Counted in code points, so a name that starts with an emoji is cut
 * between characters, not inside one.
 *
 * The display name first, the username when there is none; `null` when there
 * is neither, and the cabinet says «Участник».
 */
export function maskPublicName(name: string | null, username: string | null): string | null {
  const source = (name ?? '').trim() || (username ?? '').trim().replace(/^@+/, '');
  if (source === '') return null;
  const chars = [...source];
  if (chars.length <= 4) return `${chars[0] as string}***`;
  return `${chars.slice(0, 2).join('')}***${chars[chars.length - 1] as string}`;
}
