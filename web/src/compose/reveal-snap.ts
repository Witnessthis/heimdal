// Pure decision extracted from new-email-reveal.ts's scroll handler so the
// snap-back boundary logic — which has regressed twice — is unit-testable
// without simulating scroll in jsdom. See reveal-snap.test.ts.

/** Whether an in-progress scroll should be clamped back to the hidden/
 *  revealed boundary (`boundary` = hiddenScrollTop()).
 *
 *  Only momentum flings are caught: while a finger is down (`pointerDown`)
 *  the user is deliberately pulling and must never be snapped. Otherwise
 *  this fires exactly on the frame that crosses the boundary from either
 *  side, arresting a fling there instead of letting it sail past into the
 *  list (or all the way to revealed).
 *
 *  The `prevScrollTop` side MUST be a STRICT inequality. Resting exactly at
 *  the boundary (prevScrollTop === boundary — e.g. right after a snap) is
 *  neither above nor below it, so the next scroll event in either direction
 *  is NOT treated as a crossing and the view is free to depart. An
 *  inclusive check (>=/<=) would satisfy both sides at once and slam every
 *  fresh-snap scroll straight back, making it impossible to scroll away. */
export function shouldSnapToBoundary(
  pointerDown: boolean,
  prevScrollTop: number,
  currentScrollTop: number,
  boundary: number,
): boolean {
  if (pointerDown) return false;
  return (
    (prevScrollTop > boundary && currentScrollTop <= boundary) ||
    (prevScrollTop < boundary && currentScrollTop >= boundary)
  );
}
