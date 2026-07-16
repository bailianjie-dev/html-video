function identityPart(value, fallback) {
  const normalized = String(value ?? '').trim();
  return encodeURIComponent(normalized || fallback);
}

export function activeAgentSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session?.id && session.status === 'active');
}

export function chooseAgentSession(sessions, savedSessionId = '') {
  const active = activeAgentSessions(sessions);
  const saved = active.find((session) => session.id === savedSessionId);
  if (saved) return saved;
  return [...active].sort((left, right) => {
    const created = String(left.created_at || '').localeCompare(String(right.created_at || ''));
    return created || String(left.id).localeCompare(String(right.id));
  })[0] ?? null;
}

export function selectedAgentSessionStorageKey(userId, projectId) {
  return `html-video:selected-agent-session:v1:${identityPart(userId, 'anonymous')}:${identityPart(projectId, 'unknown-project')}`;
}

export function agentRunSessionStorageKey(userId, projectId, sessionId) {
  return `html-video:agent-run:v2:${identityPart(userId, 'anonymous')}:${identityPart(projectId, 'unknown-project')}:${identityPart(sessionId, 'unknown-session')}`;
}

export function normalizedAgentViewState(value) {
  const source = value?.view_state ?? value?.viewState ?? value;
  if (!source || typeof source !== 'object') return null;
  const pageCount = Math.max(0, Number(source.pageCount) || 0);
  const activePageIndex = pageCount > 0
    ? Math.max(0, Math.min(pageCount - 1, Number(source.activePageIndex) || 0))
    : 0;
  return {
    activePageIndex,
    pageCount,
    previewRevision: Math.max(0, Number(source.previewRevision) || 0),
    clientRevision: Math.max(0, Number(source.clientRevision) || 0),
  };
}

export function sessionDisplayTitle(session, sessions = []) {
  const explicit = String(session?.title || '').trim();
  if (explicit) return explicit;
  const ordered = [...activeAgentSessions(sessions)].sort((left, right) => {
    const created = String(left.created_at || '').localeCompare(String(right.created_at || ''));
    return created || String(left.id).localeCompare(String(right.id));
  });
  const index = Math.max(0, ordered.findIndex((item) => item.id === session?.id));
  return `Session ${index + 1}`;
}
