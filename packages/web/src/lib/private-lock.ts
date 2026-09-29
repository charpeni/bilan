/** What the lock icon on a private repository says when hovered or focused. */
export const PRIVATE_LOCK_COPY =
  'Private repository. Only people who can see it on GitHub can open this dashboard; bilan checks their access with their own GitHub token each time. Nothing here is public.';

export const PRIVATE_LOCK_LABEL = 'Private repository';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a tooltip of `tip` size goes for an icon at `anchor`: centred under
 * it, `gap` below, kept `margin` px inside the viewport on both sides; above
 * the icon when there is no room below.
 */
export function tooltipPosition(
  anchor: Box,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8,
): { left: number; top: number } {
  const centre = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(margin, viewport.width - margin - tip.width);
  const left = Math.min(maxLeft, Math.max(margin, centre - tip.width / 2));
  const below = anchor.bottom + gap;
  const top =
    below + tip.height <= viewport.height - margin
      ? below
      : Math.max(margin, anchor.top - gap - tip.height);
  return { left: Math.round(left), top: Math.round(top) };
}
