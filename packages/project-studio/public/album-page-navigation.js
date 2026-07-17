export function createAlbumPageNavigationLock(target, now = Date.now(), durationMs = 1000) {
  return {
    target: Math.max(0, Number(target) || 0),
    until: now + Math.max(250, Number(durationMs) || 1000),
  };
}

export function albumPageNavigationTarget(lock, now = Date.now()) {
  if (!lock || now > lock.until) return null;
  return Math.max(0, Number(lock.target) || 0);
}

export function decidePreviewAlbumPageSync(lock, observedPageIndex, now = Date.now()) {
  const target = albumPageNavigationTarget(lock, now);
  if (target === null) return { accept: true, nextLock: null };
  if (Number(observedPageIndex) !== target) return { accept: false, nextLock: lock };
  return { accept: true, nextLock: null };
}
