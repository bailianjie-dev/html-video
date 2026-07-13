// html-video studio v0.4 — chat-driven HTML + template gallery + text-node editor

import { t, getLocale, setLocale, AVAILABLE_LOCALES } from './i18n.js';

// Re-render whole UI on language change.
document.addEventListener('hv-locale-change', () => {
  document.documentElement.lang = getLocale();
  if (typeof renderToolbar === 'function') renderToolbar();
  if (typeof renderMain === 'function') renderMain();
  if (typeof renderSidebar === 'function') renderSidebar();
});
document.documentElement.lang = getLocale();

// Background-music style presets. Clicking a chip fills the prompt textarea
// with a tuned English MiniMax prompt (the model follows English best); the
// label is localized via i18n (soundtrack.preset_<key>). Still editable after.
const MUSIC_PRESETS = [
  { key: 'energetic', prompt: 'energetic upbeat electronic, driving beat, punchy synths, modern and confident' },
  { key: 'calm',      prompt: 'calm ambient pad, soft piano, slow and soothing, gentle and warm' },
  { key: 'tech',      prompt: 'sleek tech corporate, pulsing synth arpeggio, clean minimal beat, futuristic' },
  { key: 'narrative', prompt: 'cinematic storytelling score, emotional strings, building piano, reflective' },
  { key: 'minimal',   prompt: 'minimal lo-fi, sparse beat, mellow keys, understated background bed' },
  { key: 'epic',      prompt: 'epic orchestral, powerful drums, soaring brass, dramatic and inspiring' },
];

// Narration voices — MiniMax built-in voice_ids, all verified usable.
// `key` maps to a localized label (soundtrack.voice_<key>).
const NARRATION_VOICES = [
  { key: 'male_warm',     voiceId: 'male-qn-qingse' },
  { key: 'male_pro',      voiceId: 'male-qn-jingying' },
  { key: 'male_deep',     voiceId: 'audiobook_male_1' },
  { key: 'female_anchor', voiceId: 'presenter_female' },
  { key: 'female_mature', voiceId: 'female-yujie' },
  { key: 'female_sweet',  voiceId: 'female-shaonv' },
];

const API = {
  me: () => fetch('/api/auth/me').then(r => r.json()),
  login: async b => {
    const response = await fetch('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    return { ok: response.ok, status: response.status, data: await response.json() };
  },
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(r => r.json()),
  projects: () => fetch('/api/projects').then(r => r.json()),
  createProject: b => fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()),
  getProject: id => fetch(`/api/projects/${id}`).then(r => r.json()),
  patchProject: (id, b) => fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()),
  deleteProject: id => fetch(`/api/projects/${id}`, { method: 'DELETE' }).then(r => r.json()),
  templates: () => fetch('/api/templates').then(r => r.json()),
  agents: () => fetch('/api/agents').then(r => r.json()),
  setTemplate: (id, tid) => fetch(`/api/projects/${id}/template`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template_id: tid }) }).then(r => r.json()),
  setAgent: (id, aid, model) => fetch(`/api/projects/${id}/agent`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: aid, ...(model !== undefined && { agent_model: model }) }) }).then(r => r.json()),
  exportMp4: id => fetch(`/api/projects/${id}/export`, { method: 'POST' }).then(r => r.json()),
  getMessages: id => fetch(`/api/projects/${id}/messages`).then(r => r.json()),
  getAssets: id => fetch(`/api/projects/${id}/assets`).then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
  rawHtml: id => fetch(`/api/projects/${id}/raw-html`).then(r => r.ok ? r.text() : null),
  putRawHtml: (id, html) => fetch(`/api/projects/${id}/raw-html`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html }) }).then(r => r.json()),
  contentGraph: id => fetch(`/api/projects/${id}/content-graph`).then(r => r.ok ? r.json() : null),
  unenhanceFrame: (id, nodeId) => fetch(`/api/projects/${id}/frames/${encodeURIComponent(nodeId)}/unenhance`, { method: 'POST' }).then(r => r.json()),
  testAgent: id => fetch(`/api/agents/${encodeURIComponent(id)}/test`, { method: 'POST' }).then(r => r.json()),
  rescanAgents: () => fetch('/api/agents?force=1').then(r => r.json()),
};

const state = {
  currentUser: null,
  projects: [],
  templates: [],
  agents: [],
  activePage: 'create',
  selectedId: null,
  selected: null,
  messages: [],
  projectAssets: [],
  projectAssetsLoading: false,
  projectAssetsError: '',
  composing: false,
  textFields: [],          // [{key, original, current}]
  textSaveTimer: null,
  pendingAttachments: [],  // [{file, dataUrl?, name, kind, size}] before send
  // v0.8: multi-frame timeline state
  activeFrameId: null,     // graphNodeId currently shown in iframe
  iterateFocusFrameId: null, // graphNodeId iterations should target only (null = whole video)
  exporting: false,        // export run in progress
  exportProgress: null,    // { pct, stage } during a streamed export
  lastGraph: null,         // last fetched ContentGraph (for download)
  generationMeta: null,    // create-page selections shown on the generation page
  generationComposerOpen: false,
  previewZoom: 1.15,
  albumPageCount: 0,
  activeAlbumPage: 0,
  // Phase C: per-frame native Remotion enhancement
  frameKinds: {},          // { [graphNodeId]: 'entity'|'data'|'text' } for the selected project
  enhancing: null,         // { nodeId, pct, stage } while a single-frame enhance render is in flight
};

const ROUTES = {
  create: '/',
  album: '/image-album',
  history: '/album-history',
  studioPrefix: '/album-studio',
};

function routeWithCurrentSearch(path) {
  const params = new URLSearchParams(window.location.search);
  params.delete('studioProject');
  params.delete('generationJob');
  const search = params.toString();
  return `${path}${search ? `?${search}` : ''}`;
}

function routeProjectIdFromPath(pathname = window.location.pathname) {
  const match = pathname.match(/^\/album-studio\/([^/?#]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

function routeProjectIdFromSearch(search = window.location.search) {
  return new URLSearchParams(search).get('studioProject') || '';
}

function routeGenerationJobIdFromSearch(search = window.location.search) {
  return new URLSearchParams(search).get('generationJob') || '';
}

function routePageFromPath(pathname = window.location.pathname) {
  if (pathname === ROUTES.history) return 'history';
  if (pathname === ROUTES.album) return 'album';
  if (pathname === '/' || pathname === '/index.html') return 'create';
  return '';
}

function projectStudioPath(projectId) {
  return `${ROUTES.studioPrefix}/${encodeURIComponent(projectId)}`;
}

function projectStudioBootstrapUrl(projectId, extraParams = {}) {
  const params = new URLSearchParams(window.location.search);
  params.set('studioProject', projectId);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  const search = params.toString();
  return `/${search ? `?${search}` : ''}`;
}

function openProjectStudioPlaceholder() {
  const opened = window.open('about:blank', '_blank');
  if (!opened) {
    toast('浏览器拦截了新页面，请允许弹窗后重试。', 'warn');
    return null;
  }
  try {
    opened.document.write('<!doctype html><title>正在打开项目</title><body style="font-family:system-ui,sans-serif;padding:24px;color:#0f172a">正在打开项目预览...</body>');
    opened.document.close();
  } catch {}
  return opened;
}

function focusOpenedPage(opened) {
  if (!opened) return;
  try {
    opened.opener = null;
    opened.focus?.();
  } catch {}
}

function navigateProjectStudioPage(projectId, extraParams = {}, opened = null) {
  const url = projectStudioBootstrapUrl(projectId, extraParams);
  if (opened && !opened.closed) {
    opened.location.href = url;
    focusOpenedPage(opened);
    return true;
  }
  const newWindow = window.open(url, '_blank');
  if (newWindow) {
    focusOpenedPage(newWindow);
    return true;
  }
  toast('浏览器拦截了新页面，请允许弹窗后重试。', 'warn');
  return false;
}

function openProjectStudioPage(projectId) {
  navigateProjectStudioPage(projectId);
}

function updateBrowserRoute(path, { replace = false } = {}) {
  const nextUrl = routeWithCurrentSearch(path);
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (currentUrl === nextUrl) return;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', nextUrl);
}

function updateProjectStudioRoute(projectId, options = {}) {
  updateBrowserRoute(projectStudioPath(projectId), options);
}

function updatePageRoute(page, options = {}) {
  const path = ROUTES[page] || ROUTES.create;
  updateBrowserRoute(path, options);
}

const PENDING_GENERATION_DB = 'hv-studio-pending-generation';
const PENDING_GENERATION_STORE = 'jobs';
const LOCAL_GENERATION_META_KEY = 'hv.studio.projectGenerationMeta';

function openPendingGenerationDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PENDING_GENERATION_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PENDING_GENERATION_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('open indexedDB failed'));
  });
}

async function savePendingGenerationJob(job) {
  const db = await openPendingGenerationDb();
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const row = { ...job, id, createdAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_GENERATION_STORE, 'readwrite');
    tx.objectStore(PENDING_GENERATION_STORE).put(row);
    tx.oncomplete = () => {
      db.close();
      resolve(id);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('save pending generation failed'));
    };
  });
}

async function takePendingGenerationJob(id) {
  if (!id) return null;
  const db = await openPendingGenerationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_GENERATION_STORE, 'readwrite');
    const store = tx.objectStore(PENDING_GENERATION_STORE);
    const get = store.get(id);
    let row = null;
    get.onsuccess = () => {
      row = get.result || null;
      if (row) store.delete(id);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(row);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('read pending generation failed'));
    };
  });
}

function serializePendingAttachments() {
  return state.pendingAttachments.map((a) => ({
    file: a.file,
    name: a.name,
    kind: a.kind,
    size: a.size,
    dataUrl: a.dataUrl || '',
  }));
}

function restorePendingAttachments(attachments = []) {
  return attachments
    .filter((a) => a?.file)
    .map((a) => ({
      file: a.file,
      name: a.name || a.file.name,
      kind: a.kind || attachmentKind(a.file),
      size: a.size || a.file.size,
      dataUrl: a.dataUrl || '',
    }));
}

function readLocalGenerationMetaMap() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_GENERATION_META_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveLocalGenerationMeta(projectId, meta) {
  if (!projectId || !meta) return;
  try {
    const map = readLocalGenerationMetaMap();
    map[projectId] = meta;
    localStorage.setItem(LOCAL_GENERATION_META_KEY, JSON.stringify(map));
  } catch {}
}

// ============== boot ==============
async function init() {
  wireAuthForm();
  try {
    const result = await API.me();
    if (result?.user?.authenticated) {
      await enterStudio(result.user);
      return;
    }
  } catch (error) {
    console.warn('auth check failed:', error);
  }
  showLogin();
}

let studioInitialized = false;

function clearSessionState() {
  state.selectedId = null;
  state.selected = null;
  state.messages = [];
  state.projectAssets = [];
  state.projectAssetsLoading = false;
  state.projectAssetsError = '';
  state.projects = [];
  state.activePage = 'create';
  state.pendingAttachments = [];
  state.composing = false;
  state.exporting = false;
  state.exportProgress = null;
  state.lastGraph = null;
  state.generationMeta = null;
  state.generationComposerOpen = false;
  state.albumPageCount = 0;
  state.activeAlbumPage = 0;
  state.activeFrameId = null;
  state.iterateFocusFrameId = null;
  state.frameKinds = {};
  state.enhancing = null;
  state.textFields = [];
  if (state.textSaveTimer) {
    clearTimeout(state.textSaveTimer);
    state.textSaveTimer = null;
  }
}

async function enterStudio(user) {
  const previousUserId = state.currentUser?.user_id ?? null;
  const userChanged = previousUserId !== null && previousUserId !== user.user_id;
  state.currentUser = user;
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('studio-app').hidden = false;
  if (studioInitialized) {
    if (userChanged) clearSessionState();
    await refreshProjects();
    renderToolbar();
    renderMain();
    return;
  }
  studioInitialized = true;
  await initStudio();
}

async function initStudio() {
  // Kick off agent detection in the background — `which` + `<bin> --version`
  // can take ~400ms+ cold and there's no point holding the whole UI for it.
  // Composer renders disabled-but-visible; we re-render it once agents land.
  const agentsPromise = refreshAgents().then(() => {
    renderToolbar();
    if (state.selected) renderComposer();
  });
  await Promise.all([refreshTemplates(), refreshProjects()]);
  renderToolbar();
  wireToolbar();
  wireModals();
  // Don't block — but surface failures in the console.
  agentsPromise.catch((e) => console.warn('agent detection failed:', e));

  if (!(await applyRouteFromLocation({ replace: true }))) {
    renderMain();
  }
}

async function applyRouteFromLocation(options = {}) {
  const routedProjectId = routeProjectIdFromPath() || routeProjectIdFromSearch();
  if (routedProjectId) {
    const generationJobId = routeGenerationJobIdFromSearch();
    let generationJob = null;
    if (generationJobId) {
      try {
        generationJob = await takePendingGenerationJob(generationJobId);
        if (generationJob?.generationMeta) state.generationMeta = generationJob.generationMeta;
      } catch (error) {
        console.warn('pending generation job load failed:', error);
      }
    }
    await selectProject(routedProjectId, { page: 'workspace', updateUrl: false });
    if (options.replace) updateProjectStudioRoute(routedProjectId, { replace: true });
    if (generationJob) {
      await runPendingGenerationJob(generationJob);
    }
    return true;
  }
  const routedPage = routePageFromPath();
  if (routedPage) {
    state.activePage = routedPage;
    renderToolbar();
    renderMain();
    return true;
  }
  return false;
}

window.addEventListener('popstate', () => {
  if (!state.currentUser?.authenticated) return;
  applyRouteFromLocation().then((handled) => {
    if (handled) return;
    state.activePage = 'create';
    renderToolbar();
    renderMain();
  });
});

function wireAuthForm() {
  const form = document.getElementById('auth-form');
  if (!form || form.dataset.wired === '1') return;
  form.dataset.wired = '1';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const usernameInput = document.getElementById('auth-username');
    const passwordInput = document.getElementById('auth-password');
    const submit = document.getElementById('auth-submit');
    const error = document.getElementById('auth-error');
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      const result = await API.login({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
      });
      if (!result.ok || !result.data?.user?.authenticated) {
        error.textContent = result.status === 503
          ? '临时登录尚未配置，请先创建 .html-video/auth.toml'
          : '用户名或密码错误';
        passwordInput.select();
        return;
      }
      passwordInput.value = '';
      await enterStudio(result.data.user);
    } catch {
      error.textContent = '无法连接到服务，请稍后重试';
    } finally {
      submit.disabled = false;
      submit.textContent = '登录';
    }
  });
}

function showLogin() {
  state.currentUser = null;
  document.getElementById('studio-app').hidden = true;
  document.getElementById('auth-screen').hidden = false;
  const usernameInput = document.getElementById('auth-username');
  const passwordInput = document.getElementById('auth-password');
  if (usernameInput) usernameInput.value = '';
  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.focus();
  }
}

async function logout() {
  try {
    await API.logout();
  } catch (error) {
    console.warn('logout failed:', error);
  }
  clearSessionState();
  state.currentUser = null;
  showLogin();
}

function defaultProjectName(seed) {
  const n = (state.projects?.length ?? 0) + (seed ?? 0) + 1;
  return `Untitled ${String(n).padStart(2, '0')}`;
}

/**
 * Format a percent value for inline progress UI.
 *  - integer pcts stay integer ("56" → "56")
 *  - fractional pcts truncate to 1 decimal place ("98.333…" → "98.3")
 * Avoids the JS-default "98.33333333334%" tail when sources publish
 * (frame_index + sub_pct/100) / total style fractions.
 */
function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

async function createDefaultProject() {
  state.activePage = 'workspace';
  const r = await API.createProject({ name: defaultProjectName(0) });
  if (!r?.project) {
    toast(t('modal.new.failed'), 'error');
    return;
  }
  await refreshProjects();
  await selectProject(r.project.id);
}

// ============== Export MP4 (streamed) ==============
async function startExportStream() {
  if (!state.selected) return;
  const projectId = state.selected.id;
  state.exporting = true;
  state.exportProgress = { pct: 0, stage: 'starting' };
  renderToolbar();
  updateGenerationControls();
  state.messages.push({ role: 'preview-event', content: t('export.starting'), ts: Date.now() });
  renderChatLog();

  let res;
  try {
    res = await fetch(`/api/projects/${projectId}/export`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (e) {
    state.exporting = false;
    state.exportProgress = null;
    toast(t('export.failed_short', { message: (e?.message ?? e) }), 'error');
    renderToolbar();
    updateGenerationControls();
    return;
  }
  if (!res.ok || !res.body) {
    state.exporting = false;
    state.exportProgress = null;
    const err = await res.text().catch(() => '');
    toast(t('export.failed_short', { message: err.slice(0, 200) }), 'error');
    renderToolbar();
    updateGenerationControls();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const line of events) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'export_progress') {
          state.exportProgress = { pct: ev.pct, stage: ev.stage };
          renderToolbar();
          updateGenerationControls();
        } else if (ev.type === 'export_done') {
          state.exporting = false;
          state.exportProgress = null;
          if (ev.project) state.selected = ev.project;
          const seconds = ev.elapsed_ms ? `${(ev.elapsed_ms / 1000).toFixed(1)}s` : '';
          state.messages.push({
            role: 'preview-event',
            content: seconds ? t('export.done_seconds', { seconds }) : t('export.done_no_seconds'),
            ts: Date.now(),
          });
          state.messages.push({
            role: 'export-done',
            content: ev.output_path,
            ts: Date.now(),
          });
          renderChatLog();
          renderToolbar();
          updateGenerationControls();
          refreshProjects();
        } else if (ev.type === 'export_failed') {
          state.exporting = false;
          state.exportProgress = null;
          state.messages.push({
            role: 'system',
            content: t('export.failed', { message: ev.message }),
            ts: Date.now(),
          });
          renderChatLog();
          renderToolbar();
          updateGenerationControls();
        }
      }
    }
  } catch (e) {
    state.exporting = false;
    state.exportProgress = null;
    toast(t('export.stream_interrupted', { message: (e?.message ?? e) }), 'error');
    renderToolbar();
    updateGenerationControls();
  }
}

// ============== Per-frame native enhancement (streamed) ==============
// Render ONE data frame with the native Remotion template and stream progress,
// mirroring startExportStream. On done, swap that frame's thumbnail + centre
// preview to the rendered <video>. User-initiated only (the toggle's click).
async function startEnhanceStream(nodeId, nativeTemplateId = 'frame-data-rollup') {
  if (!state.selected || state.enhancing) return;
  const projectId = state.selected.id;
  state.enhancing = { nodeId, pct: 0, stage: 'starting' };
  renderFramesStrip();

  let res;
  try {
    res = await fetch(`/api/projects/${projectId}/frames/${encodeURIComponent(nodeId)}/enhance`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ nativeTemplateId }),
    });
  } catch (e) {
    state.enhancing = null;
    toast(t('enhance.failed', { message: (e?.message ?? e) }), 'error');
    renderFramesStrip();
    return;
  }
  if (!res.ok || !res.body) {
    state.enhancing = null;
    const err = await res.text().catch(() => '');
    toast(t('enhance.failed', { message: err.slice(0, 200) }), 'error');
    renderFramesStrip();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const line of events) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'enhance_progress') {
          if (state.enhancing) { state.enhancing.pct = ev.pct; state.enhancing.stage = ev.stage; }
          renderFramesStrip();
        } else if (ev.type === 'enhance_done') {
          state.enhancing = null;
          if (ev.project) state.selected = ev.project; // bumped updatedAt → fresh <video> URL
          state.messages.push({ role: 'preview-event', content: t('enhance.done'), ts: Date.now() });
          renderChatLog();
          renderFramesStrip();
          renderPreview();
          refreshProjects();
        } else if (ev.type === 'enhance_failed') {
          state.enhancing = null;
          toast(t('enhance.failed', { message: ev.message }), 'error');
          renderFramesStrip();
        }
      }
    }
  } catch (e) {
    state.enhancing = null;
    toast(t('enhance.failed', { message: (e?.message ?? e) }), 'error');
    renderFramesStrip();
  }
}

async function unenhanceFrameAction(nodeId) {
  if (!state.selected || state.enhancing) return;
  try {
    const r = await API.unenhanceFrame(state.selected.id, nodeId);
    if (r?.project) state.selected = r.project;
    renderFramesStrip();
    renderPreview();
    refreshProjects();
  } catch (e) {
    toast(t('enhance.failed', { message: (e?.message ?? e) }), 'error');
  }
}

/**
 * Detect "I want to export this to MP4" intent in a chat message.
 * Hits both Chinese + English without leaning on the agent.
 */
function isExportIntent(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 40) return false;        // long messages are content / iterate requests
  if (/https?:\/\//i.test(t)) return false; // a link is ALWAYS source material to build from, never "export"
  // "生成/做一个视频" is the most common way to ask to CREATE a video — it must
  // NOT count as export. Only match explicit export/render verbs that target an
  // already-produced result: 导出 / 出片 / 渲染 / export / render / encode / 输出mp4.
  return /^\s*(?:export|render|encode|导出(?:视频|为?\s?mp4)?|出片|渲染|输出\s?mp4|存为\s?mp4)\s*$/i.test(t)
    || /(?:^|\s)(?:导出|出片|渲染成?|export|render|encode)(?:$|\s|视频|为?\s?mp4|成\s?mp4)/i.test(t);
}

async function revealExportedFile() {
  if (!state.selected) return;
  try {
    const r = await fetch(`/api/projects/${state.selected.id}/reveal`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `${r.status}`);
  } catch (e) {
    toast(t('export.reveal_failed', { message: (e?.message ?? e) }), 'error');
  }
}
async function refreshTemplates() {
  const r = await API.templates();
  state.templates = r.templates ?? [];
}
async function refreshAgents() {
  try { state.agents = (await API.agents()).agents ?? []; }
  catch { state.agents = []; }
}
async function refreshProjects() {
  state.projects = (await API.projects()).projects ?? [];
  renderSidebar();
  if (state.activePage === 'history') renderProjectHistory();
}

async function selectProject(id, options = {}) {
  state.activePage = options.page || 'workspace';
  state.selectedId = id;
  if (options.updateUrl !== false) {
    updateProjectStudioRoute(id, { replace: !!options.replaceUrl });
  }
  state.selected = (await API.getProject(id)).project;
  state.projectAssets = [];
  state.projectAssetsError = '';
  state.projectAssetsLoading = true;
  state.activeFrameId = null;  // reset frame selection on project switch
  state.iterateFocusFrameId = null;
  state.albumPageCount = 0;
  state.activeAlbumPage = 0;
  state.enhancing = null;
  // Phase C: map graph node id → kind so the strip can show the "⚡ Enhance"
  // toggle only on data frames. One fetch per project switch.
  state.frameKinds = {};
  try {
    const cg = await API.contentGraph(id);
    if (cg?.graph?.nodes) for (const n of cg.graph.nodes) state.frameKinds[n.id] = n.kind;
  } catch { /* no graph (single-frame project) — no toggles, fine */ }
  // A generation running for the PREVIOUS project keeps going on the backend
  // (its result persists); just release the composer so this project is usable.
  // The in-flight SSE loop self-stops once it sees selectedId changed.
  state.composing = false;
  try { state.messages = (await API.getMessages(id)).messages ?? []; }
  catch { state.messages = []; }
  // Export history is persisted on the project — surface the latest export so
  // its "MP4 ready" card survives a session/project switch (it was previously
  // only an in-memory chat message and vanished on switch).
  const exports = state.selected?.exports ?? [];
  if (exports.length && exports[exports.length - 1]?.path) {
    state.messages.push({ role: 'export-done', content: exports[exports.length - 1].path, ts: Date.now() });
  } else if (state.selected?.lastOutputMp4Path) {
    state.messages.push({ role: 'export-done', content: state.selected.lastOutputMp4Path, ts: Date.now() });
  }
  // If a generation is still running on the backend for this project, surface a
  // live "still generating" line (the in-memory progress lines were lost on the
  // switch; the result will appear in messages once it finishes — reload to see).
  try {
    const g = await fetch(`/api/projects/${id}/generating`).then((r) => r.json());
    if (g?.generating && id === state.selectedId) {
      state.messages.push({ role: 'preview-event', content: t('chat.still_generating'), ts: Date.now() });
    }
  } catch { /* non-fatal */ }
  renderSidebar();
  renderToolbar();   // <-- bug fix: toolbar buttons (template / agent / export) must
                     //     be re-enabled after a project is selected
  renderMain();
  await refreshProjectAssets(id);
  await refreshTextFields();
}

const NAV_ITEMS = [
  { id: 'create', label: '新建相册', desc: 'Agent 规划结构与文案', icon: 'plus' },
  { id: 'album', label: '图片转相册', desc: '照片按顺序一键成片', icon: 'image' },
  { id: 'history', label: '历史项目', desc: '管理已生成项目', icon: 'history' },
];

function navIcon(name) {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const paths = {
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 15 3-3 2 2 3-4 2 5"/><circle cx="8" cy="9" r="1.4"/>',
    album: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v6l4 2"/>',
    templates: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1Z"/>',
    attach: '<path d="m21.4 11.6-8.5 8.5a5.2 5.2 0 0 1-7.4-7.4l9.1-9.1a3.5 3.5 0 0 1 5 5l-9.1 9.1a1.8 1.8 0 0 1-2.5-2.5l8.5-8.5"/>',
  };
  return `<svg ${common}>${paths[name] ?? paths.edit}</svg>`;
}

function renderFeatureNav() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  const user = state.currentUser ?? {};
  const displayName = user.display_name || user.user_id || '用户';
  const avatarText = Array.from(displayName)[0]?.toUpperCase() || 'U';
  nav.innerHTML = `
    <div class="app-nav-brand">
      <div class="brand-mark">H</div>
      <div>
        <div class="brand-name">AI相册助手</div>
        <div class="brand-sub">html-video · v0.7</div>
      </div>
    </div>
    <div class="app-nav-section">
      <div class="app-nav-label">功能菜单</div>
      ${NAV_ITEMS.map((item) => `
        <button type="button" class="app-nav-item ${state.activePage === item.id ? 'active' : ''}" data-page="${item.id}">
          ${navIcon(item.icon)}
          <span><span class="nav-title">${esc(item.label)}</span><span class="nav-desc">${esc(item.desc)}</span></span>
        </button>
      `).join('')}
    </div>
    <div class="app-nav-foot">
      <div class="app-nav-user">
        <div class="avatar">${esc(avatarText)}</div>
        <div class="app-nav-user-copy">
          <div class="app-nav-user-name" title="${esc(displayName)}">${esc(displayName)}</div>
          <div class="brand-sub">${state.projects.length} 个项目</div>
        </div>
        <button type="button" class="app-nav-logout" id="btn-logout" title="退出登录" aria-label="退出登录">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  nav.querySelectorAll('[data-page]').forEach((btn) => {
    btn.onclick = () => setActivePage(btn.dataset.page);
  });
  const logoutButton = nav.querySelector('#btn-logout');
  if (logoutButton) logoutButton.onclick = logout;
}

function setActivePage(page) {
  state.activePage = page || 'create';
  if (state.activePage === 'workspace' && !state.selectedId && state.projects[0]?.id) {
    selectProject(state.projects[0].id, { page: 'workspace' });
    return;
  }
  if (state.activePage !== 'workspace' && state.activePage !== 'generating') {
    updatePageRoute(state.activePage);
  }
  renderMain();
  renderToolbar();
}

async function createAlbumProject() {
  state.activePage = 'workspace';
  const r = await API.createProject({ name: '电子相册' });
  if (!r?.project) {
    toast(t('modal.new.failed'), 'error');
    return;
  }
  await refreshProjects();
  let project = r.project;
  try {
    const applied = await API.setTemplate(project.id, 'album-scroll-story');
    project = applied.project ?? project;
  } catch (e) {
    toast(`电子相册模板应用失败：${e?.message ?? e}`, 'error');
  }
  await selectProject(project.id);
}

const CREATE_TOPIC_EXAMPLES = [
  '公司介绍电子相册：封面、公司简介、核心业务、团队优势、联系方式',
  '产品发布相册：痛点、方案、亮点、使用场景、购买方式',
  '案例展示相册：客户背景、挑战、解决方案、成果数据、客户评价',
  '活动回顾相册：开场、现场瞬间、嘉宾观点、精彩数据、结束致谢',
];

const ALBUM_AUDIENCE_GROUPS = [
  {
    label: '常用受众',
    options: [
      { label: '潜在客户', value: '潜在客户：重点讲清企业实力、产品/服务价值、可信背书和合作入口，适合获客型宣传相册。' },
      { label: '企业客户', value: '企业客户：语气专业可信，突出解决方案、交付能力、案例成果和长期服务能力。' },
      { label: '合作伙伴', value: '合作伙伴：突出资源互补、合作模式、市场机会和共同成长价值。' },
      { label: '招商加盟商', value: '招商加盟商：突出品牌势能、盈利模型、扶持政策、样板案例和加盟流程。' },
      { label: '展会观众', value: '展会观众：开头抓眼球，快速说明公司是谁、亮点是什么、为什么值得进一步交流。' },
    ],
  },
  {
    label: '更多受众',
    options: [
      { label: '销售线索', value: '销售线索：围绕痛点、方案、优势、案例和行动引导组织内容，利于后续转化。' },
      { label: '投资人', value: '投资人：突出商业模式、增长数据、团队能力、行业空间和里程碑。' },
      { label: '渠道代理', value: '渠道代理：突出市场空间、产品卖点、合作政策、渠道支持和收益预期。' },
      { label: '招投标评审', value: '招投标评审：表达严谨，突出资质、项目经验、交付流程、团队配置和风险控制。' },
      { label: '政府/园区/协会', value: '政府、园区或行业协会：表达稳健正式，突出企业资质、产业价值、社会贡献和合规经营。' },
      { label: '招聘候选人', value: '招聘候选人：突出企业愿景、团队氛围、成长机会和岗位吸引力。' },
    ],
  },
];

const ALBUM_SCENE_GROUPS = [
  {
    label: '常用场景',
    options: [
      { label: '公司介绍', value: '公司介绍：用于企业对外宣传，建议包含封面、公司简介、核心业务、优势背书、案例/成果、联系方式。' },
      { label: '品牌宣传', value: '品牌宣传：突出品牌定位、理念、差异化价值、视觉记忆点和行动引导。' },
      { label: '产品介绍', value: '产品介绍：围绕痛点、产品能力、核心卖点、使用场景、案例成果和购买/咨询方式组织。' },
      { label: '解决方案', value: '解决方案：面向行业或客户问题，呈现需求洞察、方案架构、实施流程和预期价值。' },
      { label: '案例展示', value: '案例展示：按客户背景、挑战、方案、执行过程、结果数据和客户评价展开。' },
      { label: '活动回顾', value: '活动回顾：按开场、现场亮点、嘉宾观点、互动瞬间、数据成果和感谢收束组织。' },
    ],
  },
  {
    label: '更多场景',
    options: [
      { label: '展会招商', value: '展会招商：适合展台屏幕或扫码浏览，开头吸引注意，快速呈现品牌、产品、政策和联系方式。' },
      { label: '客户拜访', value: '客户拜访：适合销售随身展示，内容简洁有说服力，突出客户关心的价值、案例和合作方式。' },
      { label: '服务流程', value: '服务流程：讲清咨询、定制、交付、验收、售后等环节，增强信任和转化。' },
      { label: '发布会预告', value: '发布会预告：制造期待感，突出主题、时间、亮点、嘉宾或新品信息，并引导报名/预约。' },
      { label: '荣誉资质', value: '荣誉资质：集中展示证书、奖项、专利、认证、媒体报道和客户认可。' },
      { label: '团队风采', value: '团队风采：展示核心团队、专业背景、协作方式、办公环境和服务精神。' },
      { label: '年度总结', value: '年度总结：呈现年度数据、关键项目、团队成果、重要客户、荣誉和下一年规划。' },
    ],
  },
];

const ALBUM_STYLE_GROUPS = [
  {
    label: '通用与商务',
    options: [
      { label: '清爽留白', value: '清爽留白：浅色背景、充足留白、细线分隔、轻量卡片，适合正式介绍和可读性优先的电子相册。' },
      { label: '浅中性渐变', value: '浅中性渐变：浅灰蓝或淡紫渐变背景，层次柔和，适合通用展示、课程、活动和公司介绍。' },
      { label: '商务灰', value: '商务灰：冷静灰白底、规整网格、深色正文和克制强调色，适合报告、方案、项目汇报类相册。' },
      { label: '暖色商务', value: '暖色商务：米白、暖金、浅咖色调，稳重亲和，适合品牌故事、团队介绍和客户展示。' },
      { label: '杂志感', value: '杂志感：大标题、图文错落、留白与封面式排版，适合作品集、人物、品牌和活动回顾。' },
    ],
  },
  {
    label: '科技与产品',
    options: [
      { label: '科技深蓝', value: '科技深蓝：深蓝或蓝黑背景、蓝紫光效、玻璃拟态卡片、高对比标题，适合科技公司、产品发布和数据展示。' },
      { label: '深色渐变', value: '深色渐变：深色背景叠加蓝紫/青绿渐变光，视觉冲击更强，适合发布会、预告片和高端产品相册。' },
      { label: '数据大屏', value: '数据大屏：深色仪表盘、数字高亮、模块化信息卡，适合业绩、业务数据、年度总结和运营展示。' },
      { label: '极简黑白', value: '极简黑白：黑白灰主调、强字体层级、少量强调色，适合高级感品牌、建筑、设计和作品展示。' },
    ],
  },
  {
    label: '自然与纪念',
    options: [
      { label: '自然绿', value: '自然绿：深绿、薄荷绿或森林绿配色，柔和渐变与自然纹理，适合户外、健康、环保和生活方式相册。' },
      { label: '温暖纪实', value: '温暖纪实：暖光、胶片颗粒、真实照片优先，适合年会、毕业、家庭、旅行和纪念类电子相册。' },
      { label: '胶片复古', value: '胶片复古：复古色调、轻颗粒、拍立得/相纸边框，适合个人回忆、旅行记录和老照片整理。' },
      { label: '旅行明信片', value: '旅行明信片：明亮色彩、地图/票据/邮戳元素、轻松排版，适合旅行、城市漫游和活动路线相册。' },
      { label: '婚礼浪漫', value: '婚礼浪漫：柔粉、奶白、香槟金、花艺与细腻衬线标题，适合婚礼、情侣和重要仪式相册。' },
    ],
  },
  {
    label: '个人与创意',
    options: [
      { label: '个人作品集', value: '个人作品集：干净背景、作品大图、标签化信息和强个人署名，适合设计师、摄影师、学生和求职展示。' },
      { label: '插画手账', value: '插画手账：手绘贴纸、纸张纹理、轻松排版，适合亲子、校园、课程和生活记录。' },
      { label: '国潮雅致', value: '国潮雅致：宣纸质感、墨色、朱砂或青绿点缀，现代留白结合东方元素，适合文化、非遗和中式品牌相册。' },
      { label: '自定义风格', value: '自定义风格：优先采用用户在主题和素材说明里写出的个人偏好、参考图片或品牌要求；如果没有额外说明，再选择最适合内容的视觉方向。' },
    ],
  },
];

const GENERATION_STYLE_PRESETS = [
  {
    label: '科技深蓝',
    desc: '深蓝背景、蓝紫光效、高对比标题，适合科技公司、产品发布、数据展示。',
    swatch: 'linear-gradient(135deg, #08111f, #174ea6 58%, #23b7ff)',
    prompt: '请把当前电子相册重套为“科技深蓝”风格：深蓝或蓝黑背景，蓝紫光效，高对比标题，适合科技公司、产品发布和数据展示；保留现有内容重点、页数和行动引导。',
  },
  {
    label: '清爽商务',
    desc: '浅色背景、留白充足、信息清楚，适合公司介绍、解决方案和客户拜访。',
    swatch: 'linear-gradient(135deg, #ffffff, #e9f2ff 52%, #9db9e8)',
    prompt: '请把当前电子相册重套为“清爽商务”风格：浅色背景，充足留白，规整图文层级，整体专业可信；保留现有内容重点、页数和行动引导。',
  },
  {
    label: '暖色品牌',
    desc: '暖白、浅金、柔和卡片，适合品牌故事、团队风采和客户案例。',
    swatch: 'linear-gradient(135deg, #fff8ec, #ffd69d 58%, #c9893f)',
    prompt: '请把当前电子相册重套为“暖色品牌”风格：暖白、浅金、柔和卡片和亲和视觉，适合品牌故事、团队风采和客户案例；保留现有内容重点、页数和行动引导。',
  },
  {
    label: '杂志感',
    desc: '大标题、封面式排版、图文错落，适合品牌宣传、活动回顾和作品展示。',
    swatch: 'linear-gradient(135deg, #f7f3ea, #111827 54%, #d6b36a)',
    prompt: '请把当前电子相册重套为“杂志感”风格：大标题、封面式排版、图文错落、留白明确，适合品牌宣传和活动回顾；保留现有内容重点、页数和行动引导。',
  },
  {
    label: '数据大屏',
    desc: '深色模块、数字突出、指标卡片，适合业绩成果、年度总结和运营数据。',
    swatch: 'linear-gradient(135deg, #06141f, #0f766e 48%, #67e8f9)',
    prompt: '请把当前电子相册重套为“数据大屏”风格：深色模块化界面，数字和指标突出，适合业绩成果、年度总结和运营数据展示；保留现有内容重点、页数和行动引导。',
  },
  {
    label: '极简黑白',
    desc: '黑白灰主调、强字体层级、少量强调色，适合高端品牌和设计感展示。',
    swatch: 'linear-gradient(135deg, #f8fafc, #111827 62%, #64748b)',
    prompt: '请把当前电子相册重套为“极简黑白”风格：黑白灰主调，强字体层级，少量强调色，整体高级克制；保留现有内容重点、页数和行动引导。',
  },
];

const GENERATION_PAGE_PRESETS = [
  { label: '3 页', desc: '精简版，适合快速介绍和移动端轻量传播。' },
  { label: '5 页', desc: '标准版，适合公司介绍、产品宣传和客户拜访。' },
  { label: '8 页', desc: '完整版，适合信息较多的企业宣传和案例展示。' },
  { label: '10 页', desc: '详细版，适合招商、解决方案、年度成果等长内容。' },
];

function renderGroupedOptions(groups, defaultLabel = '') {
  return groups.map((group) => `
    <optgroup label="${esc(group.label)}">
      ${group.options.map((option) => `<option value="${esc(option.value)}"${option.label === defaultLabel ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}
    </optgroup>
  `).join('');
}

function renderAlbumAudienceOptions(defaultLabel = '潜在客户') {
  return renderGroupedOptions(ALBUM_AUDIENCE_GROUPS, defaultLabel);
}

function renderAlbumSceneOptions(defaultLabel = '公司介绍') {
  return renderGroupedOptions(ALBUM_SCENE_GROUPS, defaultLabel);
}

function renderAlbumStyleOptions(defaultLabel = '科技深蓝') {
  return renderGroupedOptions(ALBUM_STYLE_GROUPS, defaultLabel);
}

function makeAlbumProjectName(raw) {
  const first = String(raw || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '电子相册';
  return first.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 18) || '电子相册';
}

function projectUserStatus(project) {
  if (!project) return '';
  if (state.selectedId === project.id && state.exporting) return '正在导出';
  if (state.selectedId === project.id && state.composing) return '正在生成';
  if (hasProjectPreview(project)) return '已生成，可预览和调整';
  if (project.status === 'rendered' || project.status === 'previewed') return '生成中断，可重新生成';
  if (project.status === 'draft') return '准备生成';
  return '需要重新生成';
}

function hasProjectPreview(project) {
  return !!(
    project?.lastPreviewHtmlPath
    || project?.last_preview_html_path
    || (project?.frames?.length ?? 0) > 0
  );
}

function selectedOptionText(id) {
  const el = document.getElementById(id);
  return el?.selectedOptions?.[0]?.textContent?.trim() || el?.value || '';
}

function buildCreateGenerationMeta(raw) {
  const title = makeAlbumProjectName(raw);
  return {
    title,
    status: 'draft',
    kind: '电子相册',
    pages: selectedOptionText('create-pages') || '5 页',
    audience: selectedOptionText('create-audience') || '潜在客户',
    scene: selectedOptionText('create-scene') || '公司介绍',
    tone: selectedOptionText('create-tone') || '温柔',
    ratio: selectedOptionText('create-ratio') || '9:16 竖屏',
    style: selectedOptionText('create-style') || '科技深蓝',
    materialUse: selectedOptionText('create-material-use') || '没有素材也可生成',
    cta: selectedOptionText('create-cta') || '联系咨询',
  };
}

function buildImageAlbumGenerationMeta() {
  const title = document.getElementById('image-album-title')?.value.trim() || '图片电子相册';
  return {
    title: makeAlbumProjectName(title),
    status: 'draft',
    kind: '电子相册',
    pages: `${state.pendingAttachments.length || 0} 页`,
    audience: '潜在客户',
    scene: '图片宣传相册',
    tone: '温柔',
    ratio: selectedOptionText('image-album-ratio') || '9:16 竖屏',
    style: selectedOptionText('image-album-style') || '温暖纪实',
    materialUse: '图片为主文字为辅',
    cta: '联系咨询',
  };
}

function buildAlbumPromptFromCreatePage() {
  const pick = (id) => document.getElementById(id)?.value || '';
  const raw = document.getElementById('create-topic-input')?.value.trim() || '';
  const wantsThinking = document.getElementById('btn-create-thinking')?.classList.contains('active');
  const attachmentNote = state.pendingAttachments.length
    ? `\n已上传 ${state.pendingAttachments.length} 个素材，请按照“素材使用方式”处理这些素材。`
    : '';
  return `帮我生成一个电子相册。

主题和素材说明：
${raw}

生成要求：
1. 内容类型：电子相册。
2. 页数：${pick('create-pages')}。
3. 受众：${pick('create-audience')}。
4. 场景：${pick('create-scene')}。
5. 语气：${pick('create-tone')}。
6. 比例：${pick('create-ratio')}。
7. 风格：${pick('create-style')}。
8. 素材使用方式：${pick('create-material-use')}。
9. 行动引导：${pick('create-cta')}。
10. 这些页数、受众、场景、语气、比例、风格、素材使用方式、行动引导都已由用户在输入前确认，不要再追问“想做哪种内容”或重复确认配置。
11. 必须是手机端下滑翻页、PC 端点击下一页查看下一页的交互式 HTML 电子相册。
12. 页面文案要服务于企业宣传相册，适合直接对外展示：表达可信、重点清晰、避免夸张空话；最后一页必须按“行动引导”生成明确 CTA。
13. ${wantsThinking ? '请先梳理内容结构，再生成最终 HTML。' : '直接生成最终 HTML。'}${attachmentNote}`;
}

function renderLandingAttachments() {
  const el = document.getElementById('create-attachment-state');
  if (!el) return;
  if (!state.pendingAttachments.length) {
    el.textContent = '可选，未上传参考图';
    return;
  }
  const names = state.pendingAttachments.map((a) => a.name).slice(0, 2).join('、');
  el.textContent = `${state.pendingAttachments.length} 张参考图：${names}${state.pendingAttachments.length > 2 ? ' 等' : ''}`;
}

function renderImageAlbumAttachments() {
  const list = document.getElementById('image-album-list');
  const count = document.getElementById('image-album-count');
  if (count) count.textContent = `${state.pendingAttachments.length} 张图片`;
  if (!list) return;
  if (!state.pendingAttachments.length) {
    list.innerHTML = `
      <div class="image-upload-empty">
        <strong>先上传图片</strong>
        <span>可拖拽或选择多张，按上传顺序一图一页生成。</span>
      </div>
    `;
    return;
  }
  list.innerHTML = state.pendingAttachments.map((a, i) => `
    <div class="image-upload-item">
      <div class="image-upload-thumb">
        ${a.dataUrl ? `<img src="${a.dataUrl}" alt="" />` : navIcon('image')}
      </div>
      <div class="image-upload-meta">
        <b>第 ${i + 1} 页</b>
        <span title="${esc(a.name)}">${esc(a.name)}</span>
      </div>
      <button type="button" data-remove-image="${i}" title="移除">×</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-remove-image]').forEach((btn) => {
    btn.onclick = () => {
      removeAttachment(Number(btn.dataset.removeImage));
      renderImageAlbumAttachments();
    };
  });
}

function buildImageAlbumPrompt() {
  const note = document.getElementById('image-album-note')?.value.trim() || '请根据图片内容组织简洁文案。';
  const title = document.getElementById('image-album-title')?.value.trim() || '图片电子相册';
  const style = document.getElementById('image-album-style')?.value || '清爽留白';
  const ratio = document.getElementById('image-album-ratio')?.value || '9:16 竖屏';
  const names = state.pendingAttachments.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
  return `请根据我上传的图片生成一个电子相册。

相册标题：${title}
补充说明：${note}

图片顺序：
${names}

生成要求：
1. 内容类型：电子相册。
2. 已确认这是图片转电子相册，不要再追问“想做哪种内容”或重复确认配置。
3. 必须严格按照上传图片顺序生成页面，第 1 张图片对应第 1 页，第 2 张图片对应第 2 页，以此类推。
4. 每一页以对应图片为主体，搭配一句简短标题和一段不超过 40 字的说明。
5. 风格：${style}。
6. 比例：${ratio}。
7. 生成可独立运行的交互式 HTML 电子相册。
8. 手机端下滑翻页，PC 端点击下一页或使用键盘翻页。
9. 不要编造图片中看不出的具体事实；不确定的内容用中性表达。`;
}

async function runPendingGenerationJob(job) {
  if (!job || job.projectId !== state.selectedId) return;
  if (job.generationMeta) state.generationMeta = job.generationMeta;
  state.pendingAttachments = restorePendingAttachments(job.attachments);
  renderAttachments();
  renderLandingAttachments();
  renderImageAlbumAttachments();
  const input = document.getElementById('composer-input');
  if (!input) return;
  input.value = job.prompt || '';
  if (input.value.trim() || state.pendingAttachments.length) {
    await sendMessage();
  }
}

async function startImageAlbumFromUploadPage() {
  if (!state.pendingAttachments.length) {
    toast('请先上传至少一张图片。', 'error');
    return;
  }
  const invalid = state.pendingAttachments.find((a) => a.kind !== 'image');
  if (invalid) {
    toast('图片转相册只支持图片文件，请移除非图片素材。', 'error');
    return;
  }
  const targetWindow = openProjectStudioPlaceholder();
  if (!targetWindow) return;
  const btn = document.getElementById('btn-image-album-send');
  if (btn) btn.disabled = true;
  try {
    const generationMeta = buildImageAlbumGenerationMeta();
    state.generationMeta = generationMeta;
    const title = document.getElementById('image-album-title')?.value.trim() || '图片电子相册';
    const r = await API.createProject({ name: makeAlbumProjectName(title) });
    if (!r?.project) throw new Error('project create failed');
    await refreshProjects();
    try {
      await API.setTemplate(r.project.id, 'album-scroll-story');
    } catch (e) {
      toast(`电子相册模板应用失败：${e?.message ?? e}`, 'error');
    }
    saveLocalGenerationMeta(r.project.id, generationMeta);
    await API.patchProject(r.project.id, { preferences: { generationMeta } }).catch((e) => {
      console.warn('save generation meta failed:', e);
    });
    const prompt = buildImageAlbumPrompt();
    const generationJob = await savePendingGenerationJob({
      projectId: r.project.id,
      prompt,
      generationMeta,
      attachments: serializePendingAttachments(),
    });
    navigateProjectStudioPage(r.project.id, { generationJob }, targetWindow);
    state.pendingAttachments = [];
    renderImageAlbumAttachments();
    toast('已在新页面开始生成相册。', 'success');
  } catch (e) {
    try { targetWindow.close(); } catch {}
    toast(`图片转相册失败：${e?.message ?? e}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function startAlbumFromCreatePage() {
  const raw = document.getElementById('create-topic-input')?.value.trim() || '';
  if (!raw && !state.pendingAttachments.length) {
    toast('请输入相册主题，或先上传素材。', 'error');
    return;
  }
  const targetWindow = openProjectStudioPlaceholder();
  if (!targetWindow) return;
  const btn = document.getElementById('btn-create-send');
  if (btn) btn.disabled = true;
  try {
    const generationMeta = buildCreateGenerationMeta(raw);
    state.generationMeta = generationMeta;
    const r = await API.createProject({ name: makeAlbumProjectName(raw) });
    if (!r?.project) throw new Error('project create failed');
    await refreshProjects();
    try {
      await API.setTemplate(r.project.id, 'album-scroll-story');
    } catch (e) {
      toast(`电子相册模板应用失败：${e?.message ?? e}`, 'error');
    }
    saveLocalGenerationMeta(r.project.id, generationMeta);
    await API.patchProject(r.project.id, { preferences: { generationMeta } }).catch((e) => {
      console.warn('save generation meta failed:', e);
    });
    const prompt = buildAlbumPromptFromCreatePage();
    const generationJob = await savePendingGenerationJob({
      projectId: r.project.id,
      prompt,
      generationMeta,
      attachments: serializePendingAttachments(),
    });
    navigateProjectStudioPage(r.project.id, { generationJob }, targetWindow);
    state.pendingAttachments = [];
    renderLandingAttachments();
    toast('已在新页面开始生成相册。', 'success');
  } catch (e) {
    try { targetWindow.close(); } catch {}
    toast(`创建电子相册失败：${e?.message ?? e}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderCreatePage() {
  return `
    <main class="create-page">
      <section class="create-hero">
        <h2>基于Agent<span>电子相册工具</span></h2>
        <p>输入主题，Agent 帮你规划结构与文案；无需图片也能生成完整相册</p>
      </section>

      <section class="generator-panel">
        <div class="generator-tabs">
          <div class="generator-mode-label">${navIcon('edit')}<span>主题与生成要求</span></div>
        </div>

        <div class="generator-controls">
          <label><span>页数</span><select id="create-pages"><option>5 页</option><option>3 页</option><option>8 页</option><option>10 页</option></select></label>
          <label><span>受众</span><select id="create-audience">${renderAlbumAudienceOptions('潜在客户')}</select></label>
          <label><span>场景</span><select id="create-scene">${renderAlbumSceneOptions('公司介绍')}</select></label>
          <label><span>语气</span><select id="create-tone"><option>温柔</option><option>专业</option><option>活泼</option><option>克制</option></select></label>
          <label><span>比例</span><select id="create-ratio"><option>9:16 竖屏</option><option>16:9 横屏</option><option>1:1 方形</option></select></label>
          <label><span>风格</span><select id="create-style">${renderAlbumStyleOptions('科技深蓝')}</select></label>
          <label><span>素材使用方式</span><select id="create-material-use">
            <option value="没有素材也可生成：即使用户没有上传素材，也要基于主题生成完整电子相册，可使用排版、色块、图标、数据卡片和合理占位，不要要求用户补充素材。">没有素材也可生成</option>
            <option value="优先使用上传素材：如果用户上传了图片、Logo、截图或资料，应优先围绕这些素材组织页面；不足的部分再用文字、图形或合理占位补足。">优先使用上传素材</option>
            <option value="图片为主文字为辅：页面以图片、产品图、场景图或上传素材为主要视觉，文字保持短句说明和标题，不要堆叠长段落。">图片为主文字为辅</option>
            <option value="文字为主图片点缀：页面以清晰文案、数据、卖点和结构化信息为主，图片只作为品牌氛围、图标或局部点缀。">文字为主图片点缀</option>
          </select></label>
          <label><span>行动引导</span><select id="create-cta">
            <option value="联系咨询：最后一页突出联系方式、咨询按钮或电话/微信入口，引导客户直接联系。">联系咨询</option>
            <option value="扫码添加：最后一页预留二维码区域，文案引导扫码添加客服、企业微信或公众号。">扫码添加</option>
            <option value="预约演示：最后一页突出预约演示、体验产品或安排顾问讲解的行动按钮。">预约演示</option>
            <option value="了解产品：最后一页引导查看产品详情、核心功能、解决方案或产品手册。">了解产品</option>
            <option value="报名活动：最后一页突出活动报名、席位预约、参会时间和报名入口。">报名活动</option>
            <option value="下载资料：最后一页引导下载白皮书、产品资料、报价单、案例集或宣传册。">下载资料</option>
          </select></label>
        </div>
        <p class="generator-help">以文字主题为主，Agent 自动规划页面结构；上传参考图可选。下方选项调整页数、受众、场景、语气、比例、视觉风格和最后一页 CTA。</p>

        <p class="prompt-guide">可以写公司介绍、产品亮点、客户案例、联系方式；也可以直接粘贴公司简介。</p>
        <div class="prompt-field">
          <textarea id="create-topic-input" rows="8" placeholder="请输入电子相册主题，例如：大米科技有限公司公司介绍，包含封面、公司简介、核心业务、团队优势、联系方式。"></textarea>
          <div class="prompt-bottom">
            <div class="prompt-tools">
              <button type="button" class="tool-btn" id="btn-create-attach" title="可选，上传 Logo、产品图等作为参考">${navIcon('image')}<span>补充参考图（可选）</span></button>
              <input type="file" id="create-file-input" multiple hidden />
              <span class="attachment-state" id="create-attachment-state">可选，未上传参考图</span>
            </div>
            <div class="prompt-actions">
              <button type="button" class="mini-action" id="btn-create-thinking" title="先梳理结构再生成，适合资料多、要求高的相册。">${navIcon('settings')}<span>深度思考</span></button>
              <button type="button" class="send-orb" id="btn-create-send" title="生成电子相册">${navIcon('plus')}<span>生成相册</span></button>
            </div>
          </div>
        </div>

        <div class="topic-row">
          <span>常用宣传主题：</span>
          ${CREATE_TOPIC_EXAMPLES.map((x) => `<button type="button" data-topic="${esc(x)}">${esc(x.split('：')[0])}</button>`).join('')}
        </div>
        <p class="create-note">创建后会自动进入项目编辑页，可继续修改文字、预览交互并导出 HTML 或 MP4。</p>
      </section>
    </main>
  `;
}

function wireCreatePage() {
  document.querySelectorAll('[data-topic]').forEach((btn) => {
    btn.onclick = () => {
      const input = document.getElementById('create-topic-input');
      if (input) {
        input.value = btn.dataset.topic || '';
        input.focus();
      }
    };
  });
  const attachBtn = document.getElementById('btn-create-attach');
  const fileInput = document.getElementById('create-file-input');
  if (attachBtn && fileInput) {
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      addAttachments([...e.target.files]);
      renderLandingAttachments();
    };
  }
  const thinkingBtn = document.getElementById('btn-create-thinking');
  if (thinkingBtn) {
    thinkingBtn.onclick = () => {
      thinkingBtn.classList.toggle('active');
      toast(thinkingBtn.classList.contains('active') ? '已加入深度思考要求。' : '已取消深度思考要求。');
    };
  }
  const sendBtn = document.getElementById('btn-create-send');
  if (sendBtn) sendBtn.onclick = startAlbumFromCreatePage;
  renderLandingAttachments();
}

function renderAlbumPage() {
  return `
    <main class="feature-page">
      <div class="feature-page-inner">
        <section class="feature-hero">
          <div class="kicker">Photo To Album</div>
          <h2>图片转相册</h2>
          <p>已有照片？按顺序一键成片。每张图一页，适合年会、旅行、毕业等纪念相册。</p>
        </section>

        <section class="image-album-flow">
          <div class="image-album-main">
            <div class="upload-drop" id="image-album-drop">
              <input type="file" id="image-album-input" accept="image/*" multiple hidden />
              <div class="upload-icon">${navIcon('image')}</div>
              <h3>拖拽或选择相册图片</h3>
              <p>支持拖拽或选择多张图片；生成时严格按上传顺序，一图一页。</p>
              <button type="button" class="feature-btn primary" id="btn-image-album-pick">选择图片</button>
            </div>

            <div class="image-upload-list" id="image-album-list"></div>
          </div>

          <aside class="image-album-side">
            <div class="side-panel">
              <div class="feature-panel-head compact">
                <div>
                  <h3>相册设置</h3>
                  <p id="image-album-count">0 张图片</p>
                </div>
              </div>

              <label class="stack-field">
                <span>相册标题</span>
                <input id="image-album-title" value="图片电子相册" />
              </label>

              <label class="stack-field">
                <span>补充说明</span>
                <textarea id="image-album-note" rows="5" placeholder="例如：这是公司年会现场照片，整体风格温暖、有纪念感。"></textarea>
              </label>

              <div class="side-grid">
                <label class="stack-field">
                  <span>比例</span>
                  <select id="image-album-ratio">
                  <option>9:16 竖屏</option>
                  <option>16:9 横屏</option>
                  <option>1:1 方形</option>
                  </select>
                </label>
                <label class="stack-field">
                  <span>风格</span>
                  <select id="image-album-style">
                    ${renderAlbumStyleOptions('温暖纪实')}
                  </select>
                </label>
              </div>

              <div class="feature-actions">
                <button type="button" class="feature-btn primary wide" id="btn-image-album-send">按图片顺序生成</button>
                <button type="button" class="feature-btn wide" id="btn-image-album-clear">清空图片</button>
              </div>
            </div>

            <div class="side-panel muted">
              <div>
                <h3>生成规则</h3>
                <p>一图一页，图片为页面主体；Agent 补充短标题和说明。无需填写宣传主题，有照片即可开始。生成后可预览、改字和导出。</p>
              </div>
            </div>
        </section>
      </div>
    </main>
  `;
}

function wireAlbumPage() {
  const input = document.getElementById('image-album-input');
  const pick = document.getElementById('btn-image-album-pick');
  const drop = document.getElementById('image-album-drop');
  if (pick && input) pick.onclick = () => input.click();
  if (input) {
    input.onchange = (e) => {
      addAttachments([...e.target.files].filter((f) => (f.type || '').startsWith('image/')));
      renderImageAlbumAttachments();
    };
  }
  if (drop) {
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add('dragging');
    };
    drop.ondragleave = () => drop.classList.remove('dragging');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('dragging');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => (f.type || '').startsWith('image/'));
      if (files.length) {
        addAttachments(files);
        renderImageAlbumAttachments();
      }
    };
  }
  const clearBtn = document.getElementById('btn-image-album-clear');
  if (clearBtn) {
    clearBtn.onclick = () => {
      state.pendingAttachments = [];
      renderImageAlbumAttachments();
    };
  }
  const sendBtn = document.getElementById('btn-image-album-send');
  if (sendBtn) sendBtn.onclick = startImageAlbumFromUploadPage;
  renderImageAlbumAttachments();
}

function renderGenerationPage() {
  const meta = state.generationMeta || {
    title: state.selected?.name || '电子相册',
    status: 'draft',
    kind: '电子相册',
    pages: '5 页',
    audience: '潜在客户',
    scene: '公司介绍',
    tone: '温柔',
    ratio: '9:16 竖屏',
    style: '科技深蓝',
    materialUse: '没有素材也可生成',
    cta: '联系咨询',
  };
  const summaryRows = [
    ['页数', meta.pages || '5 页'],
    ['受众', meta.audience || '潜在客户'],
    ['场景', meta.scene || '公司介绍'],
    ['语气', meta.tone || '温柔'],
    ['比例', meta.ratio || '9:16 竖屏'],
    ['风格', meta.style || '科技深蓝'],
    ['素材', meta.materialUse || '没有素材也可生成'],
    ['行动引导', meta.cta || '联系咨询'],
  ];
  const hasPreview = hasProjectPreview(state.selected);
  const needsRegenerate = !!state.selected && !hasPreview && !state.composing;
  const progressText = state.composing
    ? '整理内容 → 规划页面 → 生成文案 → 生成预览'
    : hasPreview
      ? '已生成，可预览和调整'
      : '尚未生成预览，请重新生成';
  const footerText = state.composing
    ? `${meta.title || '电子相册'} · 正在生成`
    : hasPreview
      ? `${meta.title || '电子相册'} · 已生成，可预览和调整`
      : `${meta.title || '电子相册'} · 需要重新生成`;
  const canExportHtml = !!state.selected?.lastPreviewHtmlPath;
  const canExportMp4 = !!state.selected && hasPreview && !state.exporting;
  const previewEmptyHtml = needsRegenerate ? `
            <div class="generation-loading generation-recover">
              <h2>这个项目还没有生成成功</h2>
              <p>可能是在生成过程中刷新、关闭页面或重启服务，导致预览 HTML 没有写入。</p>
              <span>可以点击“重新生成”，系统会沿用当前页数、受众、场景、比例和风格重新生成相册。</span>
              <div class="generation-tip">
                <b>建议操作</b>
                <span>直接点右上角“重新生成”；如果想保留原需求，也可以在右侧输入补充要求后发送。</span>
              </div>
              <button type="button" class="generation-btn primary" id="btn-recover-regenerate">重新生成</button>
            </div>` : `
            <div class="generation-loading">
              <div class="generation-spinner"></div>
              <h2>正在为你生成「${esc(meta.title || '电子相册')}」</h2>
              <p>${esc(meta.pages || '5 页')} · 完成后可调整内容并导出 HTML 或 MP4</p>
              <span>实时进度请查看右侧 AI助手</span>
              <div class="generation-skeletons" aria-hidden="true">
                <div class="generation-skeleton-card"></div>
                <div class="generation-skeleton-card active"></div>
                <div class="generation-skeleton-card"></div>
              </div>
              <div class="generation-tip">
                <b>宣传相册生成中</b>
                <span>AI助手会根据你选择的受众、场景和风格自动组织页面结构。</span>
              </div>
            </div>`;
  return `
    <main class="generation-page">
      <header class="generation-topbar">
        <div class="generation-title-block">
          <h1>${esc(meta.title || '电子相册')}</h1>
          <p>需求摘要</p>
          <div class="generation-summary">
            ${summaryRows.map(([label, value]) => `<span><b>${esc(label)}</b>${esc(value)}</span>`).join('')}
          </div>
        </div>
        <div class="generation-actions">
          <button type="button" class="generation-btn" id="btn-generation-copy">调整文案</button>
          <button type="button" class="generation-btn" id="btn-generation-style">换风格</button>
          <button type="button" class="generation-btn" id="btn-generation-pages">改页数</button>
          <button type="button" class="generation-btn" id="btn-generation-image">替换图片</button>
          <button type="button" class="generation-btn" id="btn-generation-cta">调整结尾 CTA</button>
          <button type="button" class="generation-btn" id="btn-generation-regenerate">重新生成</button>
          <div class="generation-export-actions">
            <button type="button" class="generation-btn primary" id="btn-generation-export-html"${canExportHtml ? '' : ' disabled'}>导出电子相册</button>
            <button type="button" class="generation-btn primary" id="btn-generation-export-mp4"${canExportMp4 ? '' : ' disabled'}>${state.exporting ? '导出中...' : '导出视频'}</button>
          </div>
        </div>
      </header>

      <section class="generation-workbench">
        <aside class="generation-page-rail">
          <div class="frames-strip" id="frames-strip"></div>
        </aside>

        <div class="generation-main">
          <div class="preview-toolbar" aria-label="预览工具">
            <div class="preview-zoom-controls" aria-label="预览缩放">
              <button type="button" id="btn-preview-zoom-out" title="缩小预览">−</button>
              <input type="range" id="preview-zoom-range" min="70" max="180" step="5" value="${Math.round(getPreviewZoom() * 100)}" aria-label="预览缩放比例" />
              <button type="button" id="btn-preview-zoom-in" title="放大预览">+</button>
              <span id="preview-zoom-value">${Math.round(getPreviewZoom() * 100)}%</span>
              <button type="button" class="fit" id="btn-preview-zoom-fit" title="恢复为适合屏幕">适合</button>
            </div>
          </div>
          <div class="generation-preview-shell" id="preview-stage">
${previewEmptyHtml}
          </div>
          <div class="right-footer generation-footer">
            <span class="status" id="footer-status">${esc(footerText)}</span>
            <span class="grow"></span>
            <button class="reload-btn" id="btn-reload">刷新预览</button>
          </div>
          <div class="export-format-help">
            <span><b>HTML</b> 适合网页分享 / 嵌入官网</span>
            <span><b>MP4</b> 适合视频号、朋友圈、展会屏幕播放</span>
          </div>
        </div>

        <aside class="generation-assistant">
          <div class="generation-assistant-head">
            <div>
              <h2>AI助手</h2>
              <p>${state.composing ? '正在生成相册...' : '用户提示与生成过程'}</p>
            </div>
          </div>
          <div class="generation-progress">
            <span>执行进度</span>
            <b>${esc(progressText)}</b>
          </div>
          <div class="chat-log generation-chat-log" id="chat-log"></div>
        </aside>

        <aside class="text-pane generation-text-pane">
          <div class="text-pane-head">
            <h2>${t('text_pane.title')}</h2>
            <span class="save-state" id="text-save-state">${t('text_pane.save_state.idle')}</span>
            <button class="textfields-toggle" id="btn-textfields-toggle" title="${t('text_pane.collapse')}">&lsaquo;</button>
          </div>
          <div class="text-fields" id="text-fields"></div>
          <div class="generation-side-composer ${state.generationComposerOpen ? 'open' : ''}">
            <button type="button" class="composer-disclosure" id="btn-generation-composer-toggle">还有其它修改要求？</button>
            <div class="generation-composer-shell composer-shell" id="composer-shell">
              <div class="attachments" id="attachments"></div>
              <textarea id="composer-input" rows="3" placeholder="点击上方按钮快速调整，也可以直接输入具体修改要求..."></textarea>
              <div class="actions">
                <button class="icon-btn attach-btn" id="btn-attach" title="${t('composer.attach')}" aria-label="${t('composer.attach')}">${navIcon('attach')}</button>
                <input type="file" id="file-input" multiple style="display:none" />
                <span class="hint">可上传参考图或补充资料</span>
                <button class="send-btn" id="btn-send" disabled>发送调整</button>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  `;
}

function wireGenerationPage() {
  const copyBtn = document.getElementById('btn-generation-copy');
  if (copyBtn) copyBtn.onclick = () => sendGenerationQuickAdjust('请优化这本电子相册的文案：标题更有吸引力，正文更简洁有说服力，CTA 更明确；保持当前页数、比例和整体结构。');
  const styleBtn = document.getElementById('btn-generation-style');
  if (styleBtn) styleBtn.onclick = () => state.selected ? openGenerationStyleModal() : null;
  const pagesBtn = document.getElementById('btn-generation-pages');
  if (pagesBtn) pagesBtn.onclick = () => state.selected ? openGenerationPagesModal() : null;
  const imageBtn = document.getElementById('btn-generation-image');
  if (imageBtn) {
    imageBtn.onclick = () => {
      openGenerationComposer('请替换或补充这本电子相册中的图片素材：优先使用我新上传的图片，保持当前内容结构和风格。');
      document.getElementById('file-input')?.click();
    };
  }
  const ctaBtn = document.getElementById('btn-generation-cta');
  if (ctaBtn) ctaBtn.onclick = () => openGenerationComposer('请调整最后一页的行动引导 CTA：让联系方式、咨询入口或扫码添加更明确，文案更适合企业客户转化。');
  const regenerateBtn = document.getElementById('btn-generation-regenerate');
  if (regenerateBtn) regenerateBtn.onclick = () => sendGenerationQuickAdjust('请基于当前需求重新生成一版电子相册，保留用户已选择的受众、场景、语气、比例、风格、素材使用方式和行动引导，但重新组织页面结构与表达。');
  const recoverRegenerateBtn = document.getElementById('btn-recover-regenerate');
  if (recoverRegenerateBtn) recoverRegenerateBtn.onclick = () => sendGenerationQuickAdjust('请基于当前需求重新生成这本电子相册，保留用户已选择的页数、受众、场景、语气、比例、风格、素材使用方式和行动引导。');
  wirePreviewZoomControls();
  const composerToggle = document.getElementById('btn-generation-composer-toggle');
  if (composerToggle) composerToggle.onclick = () => toggleGenerationComposer();
  const exportHtmlBtn = document.getElementById('btn-generation-export-html');
  if (exportHtmlBtn) {
    exportHtmlBtn.onclick = () => {
      if (!state.selected || !state.selected.lastPreviewHtmlPath) return;
      window.location.href = `/api/projects/${state.selected.id}/export-html`;
    };
  }
  const exportMp4Btn = document.getElementById('btn-generation-export-mp4');
  if (exportMp4Btn) {
    exportMp4Btn.onclick = () => {
      if (!state.selected || state.exporting) return;
      startExportStream();
    };
  }
  updateGenerationControls();
}

async function sendGenerationQuickAdjust(text) {
  if (!state.selected || state.composing) return;
  openGenerationComposer(text);
  await sendMessage();
}

function openGenerationComposer(text = '') {
  state.generationComposerOpen = true;
  const panel = document.querySelector('.generation-side-composer');
  if (panel) panel.classList.add('open');
  const input = document.getElementById('composer-input');
  if (input) {
    if (text) input.value = text;
    input.focus();
  }
}

function toggleGenerationComposer() {
  state.generationComposerOpen = !state.generationComposerOpen;
  const panel = document.querySelector('.generation-side-composer');
  if (panel) panel.classList.toggle('open', state.generationComposerOpen);
  if (state.generationComposerOpen) document.getElementById('composer-input')?.focus();
}

function getPreviewZoom() {
  const zoom = Number(state.previewZoom);
  return Number.isFinite(zoom) ? Math.max(0.7, Math.min(1.8, zoom)) : 1.15;
}

function setPreviewZoom(zoom, { render = true } = {}) {
  state.previewZoom = Math.round(Math.max(0.7, Math.min(1.8, Number(zoom) || 1)) * 100) / 100;
  updatePreviewZoomControls();
  if (render) renderPreview();
}

function updatePreviewZoomControls() {
  const pct = Math.round(getPreviewZoom() * 100);
  const range = document.getElementById('preview-zoom-range');
  const value = document.getElementById('preview-zoom-value');
  if (range) range.value = String(pct);
  if (value) value.textContent = `${pct}%`;
}

function wirePreviewZoomControls() {
  updatePreviewZoomControls();
  const outBtn = document.getElementById('btn-preview-zoom-out');
  const inBtn = document.getElementById('btn-preview-zoom-in');
  const fitBtn = document.getElementById('btn-preview-zoom-fit');
  const range = document.getElementById('preview-zoom-range');
  if (outBtn) outBtn.onclick = () => setPreviewZoom(getPreviewZoom() - 0.1);
  if (inBtn) inBtn.onclick = () => setPreviewZoom(getPreviewZoom() + 0.1);
  if (fitBtn) fitBtn.onclick = () => setPreviewZoom(1);
  if (range) range.oninput = (e) => setPreviewZoom(Number(e.target.value) / 100);
}

function openGenerationStyleModal() {
  const modal = document.getElementById('generation-style-modal');
  const grid = document.getElementById('generation-style-grid');
  if (!modal || !grid) return;
  grid.innerHTML = GENERATION_STYLE_PRESETS.map((preset, index) => `
    <button type="button" class="generation-style-card" data-style-index="${index}">
      <span class="generation-style-swatch" style="background:${esc(preset.swatch)}"></span>
      <b>${esc(preset.label)}</b>
      <em>${esc(preset.desc)}</em>
    </button>
  `).join('');
  grid.querySelectorAll('[data-style-index]').forEach((btn) => {
    btn.onclick = async () => {
      const preset = GENERATION_STYLE_PRESETS[Number(btn.dataset.styleIndex)];
      closeGenerationStyleModal();
      if (preset) await sendGenerationQuickAdjust(preset.prompt);
    };
  });
  modal.classList.add('show');
}

function closeGenerationStyleModal() {
  document.getElementById('generation-style-modal')?.classList.remove('show');
}

function openGenerationPagesModal() {
  const modal = document.getElementById('generation-pages-modal');
  const grid = document.getElementById('generation-pages-grid');
  const customInput = document.getElementById('generation-pages-custom');
  if (!modal || !grid || !customInput) return;
  grid.innerHTML = GENERATION_PAGE_PRESETS.map((preset) => `
    <button type="button" class="generation-page-card" data-page-value="${esc(preset.label)}">
      <b>${esc(preset.label)}</b>
      <span>${esc(preset.desc)}</span>
    </button>
  `).join('');
  grid.querySelectorAll('[data-page-value]').forEach((btn) => {
    btn.onclick = async () => {
      closeGenerationPagesModal();
      await sendGenerationPageAdjust(btn.dataset.pageValue || '5 页');
    };
  });
  customInput.value = '';
  modal.classList.add('show');
  customInput.focus();
}

function closeGenerationPagesModal() {
  document.getElementById('generation-pages-modal')?.classList.remove('show');
}

async function sendGenerationPageAdjust(pageLabel) {
  await sendGenerationQuickAdjust(`请把这本电子相册调整为 ${pageLabel}。请重新规划页面结构，让每一页信息清晰、节奏适合企业宣传，并保留当前受众、场景、语气、比例、风格、素材使用方式和行动引导。`);
}

function updateGenerationControls() {
  ['btn-generation-copy', 'btn-generation-pages', 'btn-generation-image', 'btn-generation-cta', 'btn-generation-regenerate'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !state.selected || !!state.composing;
  });
  const styleBtn = document.getElementById('btn-generation-style');
  if (styleBtn) styleBtn.disabled = !state.selected || !!state.composing;
  const htmlBtn = document.getElementById('btn-generation-export-html');
  if (htmlBtn) htmlBtn.disabled = !state.selected?.lastPreviewHtmlPath;
  const mp4Btn = document.getElementById('btn-generation-export-mp4');
  if (mp4Btn) {
    const canExport = !!(state.selected && hasProjectPreview(state.selected));
    mp4Btn.disabled = !canExport || !!state.exporting;
    mp4Btn.textContent = state.exporting ? '导出中...' : '导出视频';
  }
  const progress = document.querySelector('.generation-progress b');
  if (progress) {
    progress.textContent = state.composing
      ? '整理内容 → 规划页面 → 生成文案 → 生成预览'
      : hasProjectPreview(state.selected)
        ? '已生成，可预览和调整'
        : '尚未生成预览，请重新生成';
  }
}

function renderProjectHistoryPage() {
  return `
    <main class="feature-page">
      <div class="feature-page-inner">
        <section class="feature-panel history-shell">
          <div class="history-toolbar">
            <div class="history-title">
              <h3>历史项目</h3>
              <p>浏览已创建的电子相册，点击卡片继续预览和编辑。</p>
            </div>
            <div class="history-toolbar-actions">
              <div class="history-count">共 ${state.projects.length} 个项目</div>
              <button class="feature-btn primary" id="btn-history-new">新建项目</button>
            </div>
          </div>
          <div class="history-recent" id="history-recent"></div>
          <div class="history-grid" id="history-list"></div>
        </section>
      </div>
    </main>
  `;
}

function projectPageCount(project) {
  const frames = Array.isArray(project?.frames) ? project.frames.length : 0;
  if (frames > 0) return frames;
  const pages = Number(project?.preferences?.pages ?? project?.pageCount ?? project?.page_count);
  return Number.isFinite(pages) && pages > 0 ? pages : null;
}

function projectAspectLabel(project) {
  const res = project?.preferences?.resolution;
  const w = Number(res?.width);
  const h = Number(res?.height);
  if (w > 0 && h > 0) {
    if (Math.abs(w / h - 16 / 9) < 0.03) return '16:9';
    if (Math.abs(w / h - 9 / 16) < 0.03) return '9:16';
    if (Math.abs(w / h - 1) < 0.03) return '1:1';
    return `${w}:${h}`;
  }
  return '16:9';
}

function projectGenerationMeta(project) {
  return project?.preferences?.generationMeta || readLocalGenerationMetaMap()[project?.id] || {};
}

function projectPageLabel(project) {
  const meta = projectGenerationMeta(project);
  const count = projectPageCount(project);
  const raw = meta.pages || (count ? `${count} 页` : '');
  const match = String(raw || '').match(/\d+/);
  if (match && Number(match[0]) > 0) return `${Number(match[0])} 页`;
  return '5 页';
}

function normalizeRatioLabel(value) {
  const raw = String(value || '').trim();
  const ratio = raw.match(/(\d+)\s*:\s*(\d+)/);
  if (ratio) return `${ratio[1]}:${ratio[2]}`;
  if (/方形|square/i.test(raw)) return '1:1';
  if (/竖屏|portrait/i.test(raw)) return '9:16';
  if (/横屏|landscape/i.test(raw)) return '16:9';
  return '';
}

function projectRatioLabel(project) {
  const meta = projectGenerationMeta(project);
  return normalizeRatioLabel(meta.ratio) || projectAspectLabel(project);
}

function projectHistoryPreviewSrc(project) {
  if (!project?.id) return '';
  const updated = project.updatedAt ?? project.updated_at ?? Date.now();
  const ver = updated ? new Date(updated).getTime() : Date.now();
  const frames = Array.isArray(project.frames) ? [...project.frames].sort((a, b) => a.order - b.order) : [];
  if (frames[0]?.graphNodeId) {
    return `/preview/${project.id}/frame/${encodeURIComponent(frames[0].graphNodeId)}?thumb=1&v=${ver}`;
  }
  if (hasProjectPreview(project)) {
    return `/preview/${project.id}?thumb=1&albumPage=1&v=${ver}`;
  }
  return '';
}

function renderProjectHistoryCover(project, className = 'history-cover') {
  const status = projectUserStatus(project);
  const pageLabel = projectPageLabel(project);
  const src = projectHistoryPreviewSrc(project);
  const res = project?.preferences?.resolution ?? { width: 1920, height: 1080 };
  const nativeW = Number(res.width) || 1920;
  const nativeH = Number(res.height) || 1080;
  const baseW = className.includes('recent') ? 300 : 360;
  const scale = Math.max(0.08, baseW / nativeW);
  return `
      <div class="${className} ${src ? 'has-preview' : ''}">
        ${src ? `<div class="history-cover-preview">
          <iframe sandbox="allow-scripts allow-same-origin"
            src="${src}"
            tabindex="-1"
            loading="lazy"
            style="--history-cover-w:${nativeW}px;--history-cover-h:${nativeH}px;--history-cover-scale:${scale}"></iframe>
        </div>` : `
        <div class="history-cover-lines" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>`}
        <span class="history-badge status">${esc(status.includes('已生成') ? '已生成' : '草稿')}</span>
        <span class="history-badge pages">${esc(pageLabel)}</span>
      </div>`;
}

function renderProjectHistoryInfo(project, { compact = false } = {}) {
  const meta = projectGenerationMeta(project);
  const audience = meta.audience || '潜在客户';
  const scene = meta.scene || '企业宣传';
  const style = meta.style || meta.tone || '可预览';
  const tone = meta.tone || '';
  const pageLabel = projectPageLabel(project);
  const ratioLabel = projectRatioLabel(project);
  const chips = compact
    ? [audience, scene, style]
    : [`受众 ${audience}`, `场景 ${scene}`, `风格 ${style}`];
  return {
    subtitle: style,
    detail: tone ? `受众：${audience}  场景：${scene}  语气：${tone}` : `受众：${audience}  场景：${scene}`,
    pageLabel,
    ratioLabel,
    chips,
  };
}

function projectSortTime(project) {
  const raw = project?.updatedAt ?? project?.updated_at ?? project?.createdAt ?? project?.created_at;
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function formatProjectTime(project) {
  const raw = project?.updatedAt ?? project?.updated_at ?? project?.createdAt ?? project?.created_at;
  if (!raw) return '刚刚';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function renderProjectHistory() {
  const list = document.getElementById('history-list');
  const recent = document.getElementById('history-recent');
  if (!list) return;
  if (!state.projects.length) {
    if (recent) recent.innerHTML = '';
    list.innerHTML = `<div class="empty-list">还没有项目，先从“新建相册”开始生成一个。</div>`;
    return;
  }
  const projects = [...state.projects].sort((a, b) => projectSortTime(b) - projectSortTime(a));
  const latest = projects[0];
  if (recent && latest) {
    const status = projectUserStatus(latest);
    const updated = formatProjectTime(latest);
    const info = renderProjectHistoryInfo(latest, { compact: true });
    recent.innerHTML = `
      <div class="history-recent-label">最近编辑</div>
      <article class="history-recent-card" data-open-project="${esc(latest.id)}" tabindex="0" role="button">
        ${renderProjectHistoryCover(latest, 'history-recent-cover')}
        <div class="history-recent-body">
          <h4 title="${esc(latest.name)}">${esc(latest.name)}</h4>
          <p>电子相册 · ${esc(status)}</p>
          <div class="history-tags">
            ${info.chips.map((chip) => `<span>${esc(chip)}</span>`).join('')}
          </div>
        </div>
        <div class="history-recent-meta">
          <span>${esc(info.ratioLabel)}</span>
          <span>${esc(updated)}</span>
        </div>
      </article>
    `;
  }
  list.innerHTML = projects.map((p) => {
    const status = projectUserStatus(p);
    const updated = formatProjectTime(p);
    const info = renderProjectHistoryInfo(p);
    return `
    <article class="history-card" data-open-project="${esc(p.id)}" tabindex="0" role="button">
      ${renderProjectHistoryCover(p)}
      <div class="history-card-body">
        <h4 title="${esc(p.name)}">${esc(p.name)}</h4>
        <div class="kind">${esc(info.subtitle)}</div>
        <div class="history-detail-line">${esc(info.detail)}</div>
        <div class="history-tags">
          ${info.chips.map((chip) => `<span>${esc(chip)}</span>`).join('')}
        </div>
        <div class="history-meta-row">
          <span>${esc(info.ratioLabel)}</span>
          <span>${esc(updated)}</span>
        </div>
      </div>
      <div class="history-card-actions">
        <button class="history-delete-btn" data-delete-project="${esc(p.id)}">删除项目</button>
      </div>
    </article>`;
  }).join('');
  document.querySelectorAll('.history-card[data-open-project], .history-recent-card[data-open-project]').forEach((card) => {
    card.onclick = (event) => {
      if (event.target.closest('[data-delete-project]')) return;
      openProjectStudioPage(card.dataset.openProject);
    };
    card.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('[data-delete-project]')) return;
      event.preventDefault();
      openProjectStudioPage(card.dataset.openProject);
    };
  });
  list.querySelectorAll('[data-delete-project]').forEach((btn) => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      const project = state.projects.find((p) => p.id === btn.dataset.deleteProject);
      if (!project) return;
      if (!confirm(`删除“${project.name}”？此操作不可撤销。`)) return;
      await API.deleteProject(project.id);
      await refreshProjects();
      renderProjectHistory();
    };
  });
}

async function refreshProjectAssets(projectId = state.selectedId) {
  if (!projectId) return;
  state.projectAssetsLoading = true;
  state.projectAssetsError = '';
  renderProjectAssetsPanel();
  try {
    const result = await API.getAssets(projectId);
    if (state.selectedId !== projectId) return;
    state.projectAssets = result.assets ?? [];
  } catch (error) {
    if (state.selectedId !== projectId) return;
    state.projectAssets = [];
    state.projectAssetsError = error?.message ?? String(error);
  } finally {
    if (state.selectedId === projectId) {
      state.projectAssetsLoading = false;
      renderProjectAssetsPanel();
    }
  }
}

function assetDisplayName(asset) {
  return asset.file_name || asset.filename || asset.name || asset.id || '未命名素材';
}

function assetDisplayType(asset) {
  return asset.asset_type || asset.kind || asset.mime_type || 'asset';
}

function assetPreviewUrl(asset) {
  if (state.selectedId && asset.id) {
    return `/api/projects/${encodeURIComponent(state.selectedId)}/assets/${encodeURIComponent(asset.id)}/content`;
  }
  const direct = asset.url || asset.path;
  if (!direct) return '';
  if (/^https?:\/\//i.test(direct)) return direct;
  return `/asset?path=${encodeURIComponent(direct)}`;
}

function formatAssetSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderProjectAssetsPanel() {
  const list = document.getElementById('project-assets-list');
  const count = document.getElementById('project-assets-count');
  if (!list) return;
  const assets = (state.projectAssets ?? []).filter((asset) => asset.status !== 'deleted');
  if (count) count.textContent = state.projectAssetsLoading ? '加载中' : `${assets.length} 个素材`;
  if (state.projectAssetsLoading && !assets.length) {
    list.innerHTML = `<div class="project-assets-empty">正在读取已上传素材…</div>`;
    return;
  }
  if (state.projectAssetsError) {
    list.innerHTML = `<div class="project-assets-empty error">素材读取失败：${esc(state.projectAssetsError)}</div>`;
    return;
  }
  if (!assets.length) {
    list.innerHTML = `<div class="project-assets-empty">暂无已上传素材。通过聊天框或“图片转相册”上传后会显示在这里。</div>`;
    return;
  }
  list.innerHTML = assets.map((asset) => {
    const name = assetDisplayName(asset);
    const type = assetDisplayType(asset);
    const size = formatAssetSize(asset.file_size_bytes ?? asset.size);
    const url = assetPreviewUrl(asset);
    const isImage = type === 'image' || String(asset.mime_type ?? '').startsWith('image/');
    const key = asset.oss_key || asset.path || '';
    const thumb = isImage && url
      ? `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'), { textContent: '图片' }))" />`
      : `<span>${esc(type)}</span>`;
    return `
      <div class="project-asset-card">
        <div class="project-asset-thumb">${thumb}</div>
        <div class="project-asset-info">
          <b title="${esc(name)}">${esc(name)}</b>
          <span>${esc(type)}${size ? ` · ${esc(size)}` : ''} · ${esc(asset.status ?? 'available')}</span>
          ${key ? `<small title="${esc(key)}">${esc(key)}</small>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderTemplatesPage() {
  return `
    <main class="feature-page">
      <div class="feature-page-inner">
        <section class="feature-hero">
          <div class="kicker">Template Library</div>
          <h2>模板库</h2>
          <p>先浏览模板效果，再决定是否应用到当前项目。</p>
        </section>
        <section class="feature-panel">
          <div class="feature-panel-head">
            <div>
              <h3>可用模板</h3>
              <p>${state.templates.length} 个模板</p>
            </div>
            <button class="feature-btn primary" id="btn-template-new">新建项目</button>
          </div>
          <div class="gallery feature-template-grid" id="feature-template-grid"></div>
        </section>
      </div>
    </main>
  `;
}

function renderSettingsPage() {
  return `
    <main class="feature-page">
      <div class="feature-page-inner">
        <section class="feature-hero">
          <div class="kicker">Settings</div>
          <h2>系统设置</h2>
          <p>集中配置 Agent、模型、语言和音频生成能力。</p>
        </section>
        <section class="feature-panel">
          <div class="feature-panel-head">
            <div>
              <h3>配置入口</h3>
              <p>保留原设置面板，减少改动风险。</p>
            </div>
          </div>
          <div class="quick-grid">
            <div class="quick-card"><h4>AI助手</h4><p>配置用于生成电子相册的 AI 助手后端。</p></div>
            <div class="quick-card"><h4>音频</h4><p>配置背景音乐和旁白所需的 MiniMax API 信息。</p></div>
            <div class="quick-card"><h4>语言</h4><p>切换 Studio 界面语言。</p></div>
          </div>
          <div class="feature-actions" style="margin-top:18px">
            <button class="feature-btn primary" id="btn-open-settings-page">打开设置面板</button>
          </div>
        </section>
      </div>
    </main>
  `;
}

// ============== sidebar ==============
function renderSidebar() {
  const list = document.getElementById('project-list');
  if (!list) return;
  if (!state.projects.length) {
    list.innerHTML = `<div class="empty-list">${t('sidebar.empty_list')}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const p of state.projects) {
    const div = document.createElement('div');
    div.className = 'project-row' + (p.id === state.selectedId ? ' active' : '');
    div.innerHTML = `
      <div class="name">${esc(p.name)}</div>
      <div class="meta">电子相册 · ${esc(projectUserStatus(p))}</div>
      <button class="row-menu-btn" title="More" data-pid="${esc(p.id)}">⋯</button>
    `;
    div.onclick = (e) => {
      // Ignore clicks that started inside the menu button.
      if (e.target.closest('.row-menu-btn') || e.target.closest('.row-menu')) return;
      selectProject(p.id);
    };
    list.appendChild(div);
  }
  list.querySelectorAll('.row-menu-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openProjectMenu(btn);
    };
  });
}

function openProjectMenu(anchor) {
  // Close any existing menu.
  document.querySelectorAll('.row-menu').forEach((m) => m.remove());
  const pid = anchor.dataset.pid;
  const proj = state.projects.find((p) => p.id === pid);
  if (!proj) return;
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  menu.innerHTML = `
    <button data-act="rename">${t('sidebar.menu.rename')}</button>
    <button data-act="delete">${t('sidebar.menu.delete')}</button>
  `;
  // Position below the button.
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${r.right - 140}px`;
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').onclick = async () => {
    menu.remove();
    const next = prompt(t('sidebar.rename_prompt'), proj.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === proj.name) return;
    await API.patchProject(proj.id, { name: trimmed });
    await refreshProjects();
    if (state.selectedId === proj.id) {
      state.selected = (await API.getProject(proj.id)).project;
      renderToolbar();
      renderFooter();
    }
  };
  menu.querySelector('[data-act="delete"]').onclick = async () => {
    menu.remove();
    if (!confirm(t('sidebar.delete_confirm', { name: proj.name }))) return;
    await API.deleteProject(proj.id);
    await refreshProjects();
    if (state.selectedId === proj.id) {
      state.selectedId = null;
      state.selected = null;
      state.messages = [];
      // Pick the next available project, or build a fresh default.
      if (state.projects.length > 0) {
        await selectProject(state.projects[0].id);
      } else {
        const r = await API.createProject({ name: defaultProjectName(0) });
        await refreshProjects();
        if (r?.project) await selectProject(r.project.id);
      }
    }
  };
  // Close on outside click / Escape.
  const close = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('keydown', escClose);
  };
  const escClose = (e) => {
    if (e.key === 'Escape') {
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escClose);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escClose);
  }, 0);
}

// ============== toolbar ==============
function renderToolbar() {
  const p = state.selected;
  const nameInput = document.getElementById('proj-name');
  const pickBtn = document.getElementById('btn-pick-template');
  const exportBtn = document.getElementById('btn-export');
  const exportHtmlBtn = document.getElementById('btn-export-html');

  nameInput.disabled = !p;
  nameInput.placeholder = p ? '' : t('app.no_project');
  nameInput.value = p?.name ?? '';

  pickBtn.disabled = !p;
  if (p && p.templateId) {
    const tpl = state.templates.find(x => x.id === p.templateId);
    pickBtn.classList.remove('empty');
    pickBtn.querySelector('.label').textContent = tpl ? tpl.name : p.templateId;
  } else {
    pickBtn.classList.add('empty');
    pickBtn.querySelector('.label').textContent = t('toolbar.template_pick');
  }

  // Frames-mode projects don't need a template to export — they have
  // frames[] directly. Single-frame projects still need a template until
  // the v0.x stub is gone.
  exportBtn.disabled = !p || !hasProjectPreview(p) || !!state.exporting;
  if (state.exporting) {
    exportBtn.textContent = state.exportProgress
      ? t('export.button_running', {
          pct: formatPct(state.exportProgress.pct),
          stage: state.exportProgress.stage,
        })
      : t('export.starting');
  } else {
    exportBtn.textContent = t('toolbar.export_mp4');
  }
  if (exportHtmlBtn) {
    exportHtmlBtn.disabled = !p || !p.lastPreviewHtmlPath;
    exportHtmlBtn.textContent = t('toolbar.export_html');
    exportHtmlBtn.title = p?.lastPreviewHtmlPath
      ? t('toolbar.export_html_title_ready')
      : t('toolbar.export_html_title_disabled');
  }
  renderAgentPill();

  // Re-wire on every render so handlers always match the current DOM.
  wireToolbar();
}

/** Fill the top-bar Agent pill: current agent's logo + name + connection dot. */
function renderAgentPill() {
  const pill = document.getElementById('btn-agent');
  if (!pill) return;
  const p = state.selected;
  pill.disabled = true;
  const dot = document.getElementById('agent-dot');
  const logo = document.getElementById('agent-pill-logo');
  const label = document.getElementById('agent-pill-label');
  if (!p) {
    label.textContent = t('toolbar.agent_none');
    logo.innerHTML = '';
    dot.className = 'agent-dot';
    return;
  }
  const currentId = 'pi-agent';
  const a = state.agents.find((x) => x.id === currentId);
  const available = a?.available ?? false;
  label.textContent = a?.name ?? currentId;
  logo.innerHTML = AGENT_LOGOS[currentId] ? `<img src="${esc(AGENT_LOGOS[currentId])}" alt="" />` : '';
  dot.className = 'agent-dot ' + (available ? 'ok' : 'missing');
  pill.title = available ? t('toolbar.agent_ready') : t('settings.agent.unavailable');
  renderModelSwitch(currentId);
}

/** Model picker — only for AMR (the one agent with a model catalog). Lazily
 *  fetches the live list, fills the dropdown, and persists the choice to the
 *  project so generation drives session/set_model with it. */
async function renderModelSwitch(currentAgentId) {
  const wrap = document.getElementById('model-switch');
  const sel = document.getElementById('model-select');
  if (!wrap || !sel) return;
  void currentAgentId;
  wrap.hidden = true;
  sel.innerHTML = '';
  sel.onchange = null;
}

/** Open/refresh the top-bar agent dropdown. */
function renderAgentMenu() {
  const menu = document.getElementById('agent-menu');
  if (!menu || !state.selected) return;
  const currentId = 'pi-agent';
  menu.innerHTML = state.agents.map((a) => {
    const cur = a.id === currentId ? ' current' : '';
    const logo = AGENT_LOGOS[a.id] ? `<img src="${esc(AGENT_LOGOS[a.id])}" alt="" />` : '';
    // AMR is "found but needs login": it can be made available by signing in,
    // unlike a genuinely missing CLI. Offer a login button instead of just
    // greying it out + the misleading "Not installed".
    const needsLogin = !a.available && a.id === 'amr' && !!a.hint;
    // Star the recommended agent (AMR) to draw the eye.
    const star = a.id === 'amr' ? `<span class="mi-star" title="${esc(t('agent.recommended'))}">★</span>` : '';
    const inner = `<span class="mi-dot ${a.available ? 'ok' : ''}"></span>
      <span class="mi-logo">${logo}</span>
      <span class="mi-name">${esc(a.name)}</span>${star}`;
    // AMR-needs-login: render the row as a DIV (not a button) so a real, separate
    // Sign-in <button> can live beside it — nesting a button inside a button is
    // invalid HTML and the outer one eats the inner one's clicks.
    if (needsLogin) {
      return `<div class="agent-menu-item is-unselectable" title="${esc(a.hint ?? '')}">
        ${inner}
        <button type="button" class="mi-login" data-login-agent="${esc(a.id)}">${esc(t('agent.sign_in'))}</button>
      </div>`;
    }
    const tag = a.available ? '' : `<span class="mi-tag">${esc(t('settings.agent.unavailable'))}</span>`;
    const unsel = a.available ? '' : ' is-unselectable';
    return `<button type="button" class="agent-menu-item${cur}${unsel}" data-agent-id="${esc(a.id)}" data-selectable="${a.available ? '1' : '0'}" title="${esc(a.hint ?? '')}">
      ${inner}${tag}
    </button>`;
  }).join('');
  menu.querySelectorAll('.agent-menu-item').forEach((item) => {
    item.onclick = async (e) => {
      // Login button inside the item: don't treat as agent-select.
      if (e.target.closest('.mi-login')) return;
      const aid = item.dataset.agentId;
      if (!state.selected || item.dataset.selectable !== '1') return;
      try {
        await API.setAgent(state.selected.id, aid);
        state.selected = (await API.getProject(state.selected.id)).project;
        toast(`✓ ${aid}`, 'success');
      } catch (e) {
        toast(`${e?.message ?? e}`, 'error');
      }
      closeAgentMenu();
      renderToolbar();
    };
  });
  // AMR "Sign in" → spawn `vela login` server-side (opens the browser), then
  // re-detect so the agent flips to available.
  menu.querySelectorAll('.mi-login').forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.busy === '1') return;
      const label = btn.textContent;
      btn.textContent = t('agent.signing_in');
      btn.dataset.busy = '1';
      btn.classList.add('busy');
      try {
        const res = await fetch(`/api/agents/${btn.dataset.loginAgent}/login`, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.ok) {
          toast(t('agent.signed_in'), 'success');
          state.agents = (await fetch('/api/agents?force=1').then((r) => r.json())).agents ?? state.agents;
          renderAgentMenu();
          renderToolbar();
        } else {
          toast(data.error || t('agent.sign_in_failed'), 'error');
          btn.textContent = label; delete btn.dataset.busy; btn.classList.remove('busy');
        }
      } catch (err) {
        toast(`${err?.message ?? err}`, 'error');
        btn.textContent = label; delete btn.dataset.busy; btn.classList.remove('busy');
      }
    };
  });
}

function closeAgentMenu() {
  const menu = document.getElementById('agent-menu');
  if (menu) menu.hidden = true;
  document.removeEventListener('click', _agentMenuOutside, true);
}
function _agentMenuOutside(e) {
  const sw = document.getElementById('agent-switch');
  if (sw && !sw.contains(e.target)) closeAgentMenu();
}

// Wire toolbar elements — re-bind on every renderToolbar() so any DOM
// reuse / re-render can't strand stale event handlers. (Joey reported
// template + agent picks not responding in v0.6.2.)
function wireToolbar() {
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) settingsBtn.onclick = openSettingsModal;
  const pickBtn = document.getElementById('btn-pick-template');
  if (pickBtn) {
    pickBtn.onclick = (e) => {
      e.preventDefault();
      if (!state.selected) {
        toast(t('composer.placeholder.no_project'), 'error');
        return;
      }
      openGallery();
    };
  }
  // Top-bar agent switcher: pill toggles a dropdown to view status + switch.
  const agentBtn = document.getElementById('btn-agent');
  if (agentBtn) {
    agentBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selected) { toast(t('composer.placeholder.no_project'), 'error'); return; }
      const menu = document.getElementById('agent-menu');
      if (!menu) return;
      if (menu.hidden) {
        renderAgentMenu();
        menu.hidden = false;
        // close on outside click (capture so it fires before re-open)
        setTimeout(() => document.addEventListener('click', _agentMenuOutside, true), 0);
      } else {
        closeAgentMenu();
      }
    };
  }
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
    exportBtn.onclick = () => {
      if (!state.selected) return;
      if (state.exporting) return;
      startExportStream();
    };
  }
  const exportHtmlBtn = document.getElementById('btn-export-html');
  if (exportHtmlBtn) {
    exportHtmlBtn.onclick = () => {
      if (!state.selected || !state.selected.lastPreviewHtmlPath) return;
      window.location.href = `/api/projects/${state.selected.id}/export-html`;
    };
  }
  const nameInput = document.getElementById('proj-name');
  if (nameInput) {
    nameInput.onblur = () => {
      if (state.selected) nameInput.value = state.selected.name;
    };
  }
  const sidebarToggle = document.getElementById('btn-sidebar-toggle');
  if (sidebarToggle) {
    sidebarToggle.onclick = () => {
      document.body.classList.toggle('sidebar-collapsed');
    };
  }
}

// ============== main: 4-column body ==============
function renderMain() {
  const body = document.getElementById('body');
  renderFeatureNav();
  const navPage = state.activePage || 'create';
  const page = navPage === 'workspace' ? 'generating' : navPage;
  document.body.dataset.page = page;
  body.className = page === 'generating'
      ? 'body generation-body'
      : 'body feature-body';
  if (page === 'create') {
    body.innerHTML = renderCreatePage();
    wireCreatePage();
    return;
  }
  if (page === 'album') {
    body.innerHTML = renderAlbumPage();
    wireAlbumPage();
    return;
  }
  if (page === 'generating') {
    body.innerHTML = renderGenerationPage();
    wireGenerationPage();
    if (state.selected) {
      renderChatLog();
      renderComposer();
      renderFooter();
      renderFramesStrip();
      renderTextFields();
      refreshTextFields();
      if (state.selected.lastPreviewHtmlPath || (state.selected.frames?.length ?? 0) > 0) {
        renderPreview();
      }
      const textToggle = document.getElementById('btn-textfields-toggle');
      if (textToggle) textToggle.onclick = () => document.body.classList.toggle('textfields-collapsed');
      const sendBtn = document.getElementById('btn-send');
      if (sendBtn) sendBtn.onclick = sendMessage;
      const composerInput = document.getElementById('composer-input');
      if (composerInput) {
        composerInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            sendMessage();
          }
        });
      }
      const attachBtn = document.getElementById('btn-attach');
      const fileInput = document.getElementById('file-input');
      if (attachBtn && fileInput) attachBtn.onclick = () => fileInput.click();
      if (fileInput) fileInput.onchange = (e) => addAttachments([...e.target.files]);
      const reloadBtn = document.getElementById('btn-reload');
      if (reloadBtn) reloadBtn.onclick = renderPreview;
    }
    return;
  }
  if (page === 'history') {
    body.innerHTML = renderProjectHistoryPage();
    renderProjectHistory();
    const newBtn = document.getElementById('btn-history-new');
    if (newBtn) newBtn.onclick = createDefaultProject;
    return;
  }
  if (page === 'templates') {
    body.innerHTML = renderTemplatesPage();
    const grid = document.getElementById('feature-template-grid');
    if (grid) renderTemplateGrid(grid);
    const newBtn = document.getElementById('btn-template-new');
    if (newBtn) newBtn.onclick = createDefaultProject;
    return;
  }
  if (page === 'settings') {
    body.innerHTML = renderSettingsPage();
    const openBtn = document.getElementById('btn-open-settings-page');
    if (openBtn) openBtn.onclick = openSettingsModal;
    return;
  }
  body.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar-head">
        <h2>${t('sidebar.projects')}</h2>
        <button class="new-project" id="btn-new">${t('sidebar.new')}</button>
        <button class="sidebar-toggle" id="btn-sidebar-toggle" title="${t('sidebar.collapse')}">‹</button>
      </div>
      <div class="project-list" id="project-list"></div>
    </aside>

    ${state.selected
      ? `
        <section class="chat-pane">
          <div class="chat-log" id="chat-log"></div>
          <div class="composer">
            <div class="composer-shell" id="composer-shell">
              <div class="attachments" id="attachments"></div>
              <textarea id="composer-input" placeholder="..." rows="2"></textarea>
              <div class="actions">
                <button class="icon-btn" id="btn-attach" title="${t('composer.attach')}">📎</button>
                <input type="file" id="file-input" multiple style="display:none" />
                <span class="hint">${t('composer.hint')}</span>
                <button class="send-btn" id="btn-send" disabled>${t('composer.send')}</button>
              </div>
            </div>
          </div>
        </section>

        <section class="right-pane">
          <div class="preview-stage" id="preview-stage">
            <div class="preview-placeholder"><div><div class="ico">🎞️</div>${t('preview.placeholder.pick_template')}</div></div>
          </div>
          <div class="frames-strip" id="frames-strip"></div>
          <div class="right-footer">
            <span class="status" id="footer-status">${t('app.no_project')}</span>
            <span class="grow"></span>
            <button class="reload-btn" id="btn-reload">${t('preview.reload')}</button>
          </div>
        </section>

        <aside class="text-pane">
          <div class="text-pane-head">
            <h2>${t('text_pane.title')}</h2>
            <span class="save-state" id="text-save-state">${t('text_pane.save_state.idle')}</span>
            <button class="textfields-toggle" id="btn-textfields-toggle" title="${t('text_pane.collapse')}">&lsaquo;</button>
          </div>
          <div class="text-fields" id="text-fields"></div>
        </aside>

        <div class="graph-modal" id="graph-modal">
          <div class="panel">
            <header>
              <h3>Content graph</h3>
              <span class="grow"></span>
              <button class="download-btn" id="graph-download">⬇ Download JSON</button>
              <button class="close-btn" id="graph-close">✕</button>
            </header>
            <pre id="graph-json"></pre>
          </div>
        </div>
      `
      : `<div class="empty-state"><div><div class="ico">🎬</div>
          <h2>${t('app.empty_pick_create')}</h2>
          <p>${t('app.empty_subtitle')}</p></div></div>`}
  `;
  // Re-attach sidebar handlers (renderMain rebuilt the DOM)
  renderSidebar();
  document.getElementById('btn-new').onclick = createDefaultProject;
  const togBtn = document.getElementById('btn-sidebar-toggle');
  if (togBtn) togBtn.onclick = () => document.body.classList.toggle('sidebar-collapsed');
  const textToggle = document.getElementById('btn-textfields-toggle');
  if (textToggle) textToggle.onclick = () => document.body.classList.toggle('textfields-collapsed');
  if (state.selected) {
    renderChatLog();
    renderComposer();
    renderPreview();
    renderFooter();
    renderTextFields();
    refreshTextFields();
    document.getElementById('btn-send').onclick = sendMessage;
    document.getElementById('composer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendMessage();
      }
    });
    document.getElementById('btn-attach').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = (e) => addAttachments([...e.target.files]);
    wireDragAndPaste();
    document.getElementById('btn-reload').onclick = reloadPreview;
  }
}

/**
 * Soundtrack panel: generate MiniMax music + narration, stream SSE progress,
 * preview the resulting MP3s. The generated tracks are stored on the project's
 * soundtrack and mixed in automatically at export time.
 */
function wireSoundtrackPanel() {
  const panel = document.getElementById('soundtrack-panel');
  if (!panel) return;
  const musicPrompt = document.getElementById('st-music-prompt');
  const narrationText = document.getElementById('st-narration-text');
  const musicVol = document.getElementById('st-music-vol');
  const narrationVol = document.getElementById('st-narration-vol');
  const musicVolVal = document.getElementById('st-music-vol-val');
  const narrationVolVal = document.getElementById('st-narration-vol-val');
  const genMusicBtn = document.getElementById('btn-st-gen-music');
  const genNarrationBtn = document.getElementById('btn-st-gen-narration');
  const clearBtn = document.getElementById('btn-st-clear');
  const musicStatusEl = document.getElementById('st-music-status');
  const narrationStatusEl = document.getElementById('st-narration-status');
  const previewEl = document.getElementById('st-preview');
  const draftFrameBtn = document.getElementById('btn-st-draft-frame');
  const draftAllBtn = document.getElementById('btn-st-draft-all');
  const whichEl = document.getElementById('st-narration-which');

  // Music style presets: click fills the prompt textarea (editable after).
  document.querySelectorAll('#st-music-presets .st-preset').forEach((btn) => {
    btn.onclick = () => {
      musicPrompt.value = btn.dataset.prompt || '';
      document.querySelectorAll('#st-music-presets .st-preset').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // ---- Per-frame narration model ----------------------------------------
  // narrationByFrame: { [graphNodeId]: text }. The textarea always shows the
  // line for the CURRENTLY SELECTED frame (state.activeFrameId); editing it
  // writes back to that frame. Switching frames in the strip swaps the text.
  const sortedFrames = [...(state.selected?.frames ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const hasFrames = sortedFrames.length > 0;
  // Seed from saved soundtrack; migrate a legacy single narrationText onto frame 1.
  state._narrationByFrame = { ...(state.selected?.soundtrack?.narrationByFrame ?? {}) };
  if (!Object.keys(state._narrationByFrame).length && state.selected?.soundtrack?.narrationText && sortedFrames[0]) {
    state._narrationByFrame[sortedFrames[0].graphNodeId] = state.selected.soundtrack.narrationText;
  }
  const frameLabel = (fid) => {
    const i = sortedFrames.findIndex((f) => f.graphNodeId === fid);
    return i >= 0 ? `${t('soundtrack.frame_word')} ${i + 1}/${sortedFrames.length}` : '';
  };
  // Read frames LIVE from state (not the wire-time snapshot) so button state is
  // always correct no matter what changed it (generate / regen / switch / clear).
  const liveFrames = () => [...(state.selected?.frames ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const currentFrameId = () => state.activeFrameId ?? liveFrames()[0]?.graphNodeId ?? null;
  const syncNarrationField = () => {
    const frames = liveFrames();
    const has = frames.length > 0;
    const fid = currentFrameId();
    if (whichEl) {
      const i = frames.findIndex((f) => f.graphNodeId === fid);
      // Spell out which frame the script + "✨ draft this frame" act on, so it's
      // obvious the per-frame buttons follow the selected frame (issues #5):
      // users couldn't tell "draft this frame" only touched the active one.
      whichEl.textContent = has && i >= 0
        ? (frames.length > 1
            ? t('soundtrack.editing_frame', { n: i + 1, total: frames.length })
            : '')
        : '';
    }
    // Only overwrite the textarea when it isn't the user's in-progress edit.
    if (document.activeElement !== narrationText) {
      narrationText.value = (fid && state._narrationByFrame[fid]) || '';
    }
    const dis = !has || !fid;
    if (draftFrameBtn) { draftFrameBtn.disabled = dis; draftFrameBtn.title = dis ? t('soundtrack.draft_need_frames') : ''; }
    if (draftAllBtn) { draftAllBtn.disabled = !has; draftAllBtn.title = has ? '' : t('soundtrack.draft_need_frames'); }
    const fitBtn = document.getElementById('btn-st-fit');
    if (fitBtn) {
      const anyNarr = Object.values(state._narrationByFrame || {}).some((v) => (v || '').trim());
      fitBtn.disabled = !has || !anyNarr;
    }
  };
  // Persist edits back to the active frame as the user types.
  narrationText.oninput = () => {
    const fid = currentFrameId();
    if (fid) state._narrationByFrame[fid] = narrationText.value;
  };
  // Expose so ANY state change (frame switch, generation finished, regen, etc.)
  // can re-evaluate button enablement + the shown line without re-rendering the
  // whole panel. Called from renderPreview() — the convergence point all those
  // paths already hit — so buttons can never get stuck stale.
  window.__hvSyncNarration = syncNarrationField;
  syncNarrationField();

  async function draftNarration(frameId /* null = all */) {
    if (!state.selected) return;
    const btn = frameId ? draftFrameBtn : draftAllBtn;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = t('soundtrack.drafting'); }
    try {
      const res = await fetch(`/api/projects/${state.selected.id}/draft-narration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(frameId && { frameId }),
        }),
      });
      const data = await res.json();
      if (res.ok && data.narrationByFrame) {
        // Merge (single-frame draft only returns that frame; global returns all).
        Object.assign(state._narrationByFrame, data.narrationByFrame);
        syncNarrationField();
      } else {
        if (narrationStatusEl) narrationStatusEl.textContent = t('soundtrack.draft_failed', { message: data.error || `HTTP ${res.status}` });
      }
    } catch (e) {
      if (narrationStatusEl) narrationStatusEl.textContent = t('soundtrack.draft_failed', { message: (e?.message ?? e) });
    } finally {
      if (btn) { btn.textContent = label; }
      syncNarrationField();
    }
  }
  if (draftFrameBtn) draftFrameBtn.onclick = () => draftNarration(currentFrameId());
  if (draftAllBtn) draftAllBtn.onclick = () => draftNarration(null);

  // "Fit to narration": re-pace each frame's duration by its narration length.
  const fitBtn = document.getElementById('btn-st-fit');
  if (fitBtn) {
    const anyNarration = () => Object.values(state._narrationByFrame || {}).some((v) => (v || '').trim());
    fitBtn.disabled = !hasFrames || !anyNarration();
    fitBtn.onclick = async () => {
      if (!state.selected || !anyNarration()) return;
      const label = fitBtn.textContent;
      fitBtn.disabled = true; fitBtn.textContent = t('soundtrack.fitting');
      try {
        const res = await fetch(`/api/projects/${state.selected.id}/fit-durations`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ narrationByFrame: state._narrationByFrame }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          toast(t('soundtrack.fitted', { sec: data.totalSec }), 'success');
          // Refresh frames so the strip + preview reflect the new per-frame durations.
          if (typeof renderPreview === 'function') renderPreview();
          if (typeof renderFramesStrip === 'function') renderFramesStrip();
        } else {
          toast(data.error || t('soundtrack.fit_failed'), 'error');
        }
      } catch (e) {
        toast(`${e?.message ?? e}`, 'error');
      } finally {
        fitBtn.textContent = label; fitBtn.disabled = !anyNarration();
      }
    };
  }

  // Restore previously generated soundtrack (music prompt + audio previews).
  const st = state.selected?.soundtrack;
  if (st) {
    if (st.musicPrompt) musicPrompt.value = st.musicPrompt;
    if (typeof st.musicVolumeDb === 'number') musicVol.value = String(st.musicVolumeDb);
    if (typeof st.narrationVolumeDb === 'number') narrationVol.value = String(st.narrationVolumeDb);
    renderSoundtrackPreview(st);
  }
  musicVolVal.textContent = `${musicVol.value} dB`;
  narrationVolVal.textContent = `${narrationVol.value} dB`;
  musicVol.oninput = () => { musicVolVal.textContent = `${musicVol.value} dB`; };
  narrationVol.oninput = () => { narrationVolVal.textContent = `${narrationVol.value} dB`; };

  clearBtn.onclick = async () => {
    if (!state.selected) return;
    await fetch(`/api/projects/${state.selected.id}/soundtrack`, { method: 'DELETE' });
    musicPrompt.value = '';
    narrationText.value = '';
    previewEl.innerHTML = '';
    if (musicStatusEl) musicStatusEl.textContent = '';
    if (narrationStatusEl) narrationStatusEl.textContent = '';
    if (state.selected) delete state.selected.soundtrack;
  };

  // Music and narration generate INDEPENDENTLY. `kind` decides which part of
  // the generate-audio payload we send + which button/status to drive.
  async function runGenerate(kind /* 'music' | 'narration' */) {
    if (!state.selected) return;
    const btn = kind === 'music' ? genMusicBtn : genNarrationBtn;
    const statusEl = kind === 'music' ? musicStatusEl : narrationStatusEl;
    const payload = {};
    if (kind === 'music') {
      const mp = musicPrompt.value.trim();
      if (!mp) { if (statusEl) statusEl.textContent = t('soundtrack.empty_music'); return; }
      payload.music = { prompt: mp, instrumental: true, volumeDb: Number(musicVol.value) };
    } else {
      // Stitch every frame's line in order into one narration track.
      const stitched = sortedFrames
        .map((f) => (state._narrationByFrame[f.graphNodeId] || '').trim())
        .filter((s) => s.length > 0).join('\n');
      const nt = stitched || narrationText.value.trim();
      if (!nt) { if (statusEl) statusEl.textContent = t('soundtrack.empty_narration'); return; }
      const voiceSel = document.getElementById('st-narration-voice');
      payload.narration = { text: nt, volumeDb: Number(narrationVol.value), byFrame: state._narrationByFrame, ...(voiceSel?.value && { voiceId: voiceSel.value }) };
    }

    const label = btn?.textContent;
    if (btn) btn.disabled = true;
    clearBtn.disabled = true;
    if (statusEl) statusEl.textContent = t('soundtrack.starting');

    let res;
    try {
      res = await fetch(`/api/projects/${state.selected.id}/generate-audio`, {
        method: 'POST',
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (statusEl) statusEl.textContent = t('soundtrack.failed', { message: (e?.message ?? e) });
      if (btn) btn.disabled = false; clearBtn.disabled = false; return;
    }
    if (!res.ok || !res.body) {
      if (statusEl) statusEl.textContent = t('soundtrack.failed', { message: `HTTP ${res.status}` });
      if (btn) btn.disabled = false; clearBtn.disabled = false; return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const line of events) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'audio_progress' && statusEl) {
            statusEl.textContent = ev.stage === 'music' ? t('soundtrack.progress_music') : t('soundtrack.progress_narration');
          } else if (ev.type === 'audio_done') {
            if (statusEl) statusEl.textContent = t('soundtrack.done');
            if (ev.project) state.selected = ev.project;
            renderSoundtrackPreview(ev.soundtrack);
          } else if (ev.type === 'audio_failed' && statusEl) {
            statusEl.textContent = t('soundtrack.failed', { message: ev.message });
          }
        }
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = t('soundtrack.failed', { message: (e?.message ?? e) });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      clearBtn.disabled = false;
    }
  }
  if (genMusicBtn) genMusicBtn.onclick = () => runGenerate('music');
  if (genNarrationBtn) genNarrationBtn.onclick = () => runGenerate('narration');
}

function renderSoundtrackPreview(soundtrack) {
  const previewEl = document.getElementById('st-preview');
  if (!previewEl || !soundtrack || !state.selected) return;
  const assets = state.selected.assets || [];
  const srcFor = (id) => {
    const a = assets.find((x) => x.id === id);
    return a?.path ? `/asset?path=${encodeURIComponent(a.path)}` : null;
  };
  const blocks = [];
  const musicSrc = soundtrack.musicAssetId && srcFor(soundtrack.musicAssetId);
  const narrSrc = soundtrack.narrationAssetId && srcFor(soundtrack.narrationAssetId);
  if (musicSrc) blocks.push(`<div class="st-track"><span>${t('soundtrack.music_ready')}</span><audio controls src="${musicSrc}"></audio></div>`);
  if (narrSrc) blocks.push(`<div class="st-track"><span>${t('soundtrack.narration_ready')}</span><audio controls src="${narrSrc}"></audio></div>`);
  previewEl.innerHTML = blocks.join('');
}

// ============== composer attachments ==============
function attachmentKind(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/json' || t === 'text/csv' || /\.(csv|tsv|json)$/i.test(file.name)) return 'data';
  if (t.startsWith('text/')) return 'text';
  return 'reference-link';
}
function iconForKind(k) {
  return { image: '🖼', video: '🎬', audio: '🎵', data: '📊', text: '📝' }[k] ?? '📎';
}

function addAttachments(files) {
  for (const f of files) {
    const kind = attachmentKind(f);
    const att = { file: f, name: f.name, kind, size: f.size };
    state.pendingAttachments.push(att);
    if (kind === 'image') {
      const r = new FileReader();
      r.onload = (e) => {
        att.dataUrl = e.target.result;
        renderAttachments();
        renderImageAlbumAttachments();
        renderLandingAttachments();
      };
      r.readAsDataURL(f);
    }
  }
  renderAttachments();
  renderImageAlbumAttachments();
  renderLandingAttachments();
}

function removeAttachment(i) {
  state.pendingAttachments.splice(i, 1);
  renderAttachments();
}

function renderAttachments() {
  const wrap = document.getElementById('attachments');
  if (!wrap) return;
  wrap.innerHTML = state.pendingAttachments.map((a, i) => {
    const thumb = a.dataUrl ? `<img src="${a.dataUrl}" alt="" />` : `<span class="ico">${iconForKind(a.kind)}</span>`;
    return `<span class="att-chip">
      ${thumb}
      <span class="name" title="${esc(a.name)}">${esc(a.name)}</span>
      <button data-i="${i}" title="Remove">×</button>
    </span>`;
  }).join('');
  wrap.querySelectorAll('button[data-i]').forEach(btn => {
    btn.onclick = () => removeAttachment(Number(btn.dataset.i));
  });
}

function wireDragAndPaste() {
  const shell = document.getElementById('composer-shell');
  const ta = document.getElementById('composer-input');
  if (!shell) return;
  shell.addEventListener('dragover', (e) => {
    e.preventDefault();
    shell.classList.add('dragging');
  });
  shell.addEventListener('dragleave', () => shell.classList.remove('dragging'));
  shell.addEventListener('drop', (e) => {
    e.preventDefault();
    shell.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) addAttachments([...e.dataTransfer.files]);
  });
  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addAttachments(files);
    }
  });
}

function renderComposer() {
  const p = state.selected;
  const ta = document.getElementById('composer-input');
  const sendBtn = document.getElementById('btn-send');
  if (!ta) return;
  const availableAgents = state.agents.filter(a => a.available);
  const agentsKnown = state.agents.length > 0;
  const canType = !!p && !state.composing;
  const canSend = !!(p && availableAgents.length > 0 && !state.composing);
  ta.disabled = !canType;
  sendBtn.disabled = !canSend;

  // Focus chip: when a frame is pinned for single-frame iterate, show it
  // above the textarea so the user knows their next message will only
  // rewrite that frame. Click to clear.
  const shell = document.getElementById('composer-shell');
  if (shell) {
    let chip = shell.querySelector('.focus-chip');
    const focus = state.iterateFocusFrameId;
    if (focus) {
      const order = (p?.frames ?? []).find((f) => f.graphNodeId === focus)?.order ?? 0;
      const orderStr = String(order + 1).padStart(2, '0');
      const html = `🎯 ${t('composer.focus_chip', { order: orderStr, fid: '' })}<span class="fid">${esc(focus)}</span><button title="${t('composer.focus_clear')}" type="button">✕</button>`;
      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'focus-chip';
        // Insert above attachments (or as first child).
        shell.insertBefore(chip, shell.firstChild);
      }
      chip.innerHTML = html;
      chip.querySelector('button').onclick = (e) => {
        e.stopPropagation();
        state.iterateFocusFrameId = null;
        renderComposer();
        renderFramesStrip();
      };
    } else if (chip) {
      chip.remove();
    }
  }

  ta.placeholder = !p ? t('composer.placeholder.no_project')
    : !agentsKnown ? t('composer.placeholder.detecting_agents')
    : availableAgents.length === 0 ? t('composer.placeholder.no_agent')
    : state.iterateFocusFrameId ? t('composer.placeholder.focus')
    : !p.templateId ? t('composer.placeholder.no_template')
    : t('composer.placeholder.with_template');
}

function renderFooter() {
  const p = state.selected;
  const fs = document.getElementById('footer-status');
  if (!fs) return;
  if (p) {
    fs.innerHTML = `<b>${esc(p.name)}</b> · ${esc(projectUserStatus(p))}`;
  } else {
    fs.textContent = '未选择项目';
  }
}

// ============== chat log ==============
function renderChatLog() {
  const log = document.getElementById('chat-log');
  if (!log) return;
  if (!state.messages.length) {
    log.innerHTML = `<div class="chat-empty"><div><div class="ico">💬</div>
      <div style="font-weight:500;margin-bottom:6px;">${t('chat.empty.title')}</div>
      ${t('chat.empty.body')}
      <div class="examples">
        <b>"Warm-grain magazine outro: Open Design — design that evolves itself"</b>
        <b>"Cyberpunk glitch title saying SYSTEM ONLINE, neon cyan/magenta"</b>
        <b>"Swiss-grid data card: Templates 231, Skills 15, Systems 150, Craft 11"</b>
      </div>
    </div></div>`;
    return;
  }
  log.innerHTML = state.messages.map((m, i) => renderMessage(m, i)).join('');
  log.querySelectorAll('button.opt[data-opt-msg]').forEach((btn) => {
    btn.onclick = () => {
      const msgIdx = Number(btn.dataset.optMsg);
      const optI = Number(btn.dataset.optI);
      const m = state.messages[msgIdx];
      if (!m || m.pickedOption) return;
      const { options } = parseHvOptions(m.content ?? '');
      if (!options) return;
      const picked = options.options[optI];
      const label = picked?.label ?? '';
      m.pickedOption = label;
      // Fire as a new user turn
      pickAndSend(label);
    };
  });
  // Inline freeform input on each hv-options card
  log.querySelectorAll('textarea[data-freeform-msg]').forEach((ta) => {
    const msgIdx = Number(ta.dataset.freeformMsg);
    const sendBtn = log.querySelector(`button.freeform-send[data-freeform-msg="${msgIdx}"]`);
    const submit = () => {
      const text = ta.value.trim();
      if (!text) return;
      const m = state.messages[msgIdx];
      if (!m || m.pickedOption) return;
      m.pickedOption = text;  // mark answered so options collapse
      pickAndSend(text);
    };
    const autoResize = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';
    };
    ta.addEventListener('input', () => {
      if (sendBtn) sendBtn.disabled = ta.value.trim().length === 0;
      autoResize();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    if (sendBtn) sendBtn.onclick = submit;
  });
  // hv-form: collect field values + optional file attachments, submit as
  // [hv-form:submit]\n<json>. Files go through the existing pendingAttachments
  // path so the server multipart handler treats them like normal uploads.
  // Segmented buttons: click writes to the hidden input + flips .selected.
  // Update the live "total = per_frame × frames" readout for a form card.
  const updateFormTotal = (msgIdx) => {
    const totalEl = document.getElementById(`form-total-${msgIdx}`);
    if (!totalEl) return;
    const card = totalEl.closest('.form-card');
    const val = (key) => {
      const h = card?.querySelector(`.form-seg[data-form-key="${CSS.escape(key)}"] input[type="hidden"]`);
      return Number(h?.value || 0);
    };
    const pf = val('per_frame'), fc = val('frame_count');
    totalEl.textContent = pf > 0 && fc > 0 ? `${t('soundtrack.total_word') || 'Total'} ≈ ${pf * fc}s` : '';
  };
  log.querySelectorAll('.form-seg-btn[data-form-msg]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const seg = btn.closest('.form-seg');
      if (!seg) return;
      seg.querySelectorAll('.form-seg-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      const hidden = seg.querySelector('input[type="hidden"]');
      if (hidden) hidden.value = btn.dataset.val ?? '';
      updateFormTotal(Number(btn.dataset.formMsg));
    };
  });
  // Initial paint of any total readouts present.
  log.querySelectorAll('[id^="form-total-"]').forEach((el) => updateFormTotal(Number(el.id.replace('form-total-', ''))));
  log.querySelectorAll('button.form-submit[data-form-msg]').forEach((btn) => {
    btn.onclick = async () => {
      const msgIdx = Number(btn.dataset.formMsg);
      const m = state.messages[msgIdx];
      if (!m || m.formSubmitted) return;
      const card = btn.closest('.form-card');
      if (!card) return;
      const collected = {};
      let missing = null;
      // Only grab inputs / textareas / selects — buttons share the data-form-key
      // attribute but their .value is empty, would clobber the real one.
      card.querySelectorAll(
        'input[data-form-key], textarea[data-form-key], select[data-form-key]',
      ).forEach((el) => {
        const key = el.dataset.formKey;
        const val = (el.value || '').trim();
        if (!val && card.querySelector(`label .req`) &&
            card.querySelector(`[data-form-key="${CSS.escape(key)}"]`).closest('.form-field')
              ?.querySelector('label .req')) {
          // Required field that's empty
          missing = key;
        }
        collected[key] = val;
      });
      if (missing) {
        toast(`${t('text_pane.save_state.error')}: ${missing}`, 'warn');
        return;
      }
      m.formSubmitted = collected;
      // Files: read from the existing form-att-<msgIdx> tray and route them
      // through state.pendingAttachments so sendMessage's multipart path picks
      // them up.
      const submitText = `[hv-form:submit]\n${JSON.stringify(collected, null, 2)}`;
      const ta = document.getElementById('composer-input');
      if (ta) ta.value = submitText;
      await sendMessage();
    };
  });
  // hv-form attach button — same flow as composer's 📎 button, scoped to the card.
  log.querySelectorAll('button.form-attach-btn[data-form-msg]').forEach((btn) => {
    btn.onclick = () => {
      const msgIdx = Number(btn.dataset.formMsg);
      const fi = document.getElementById(`form-file-${msgIdx}`);
      if (fi) fi.click();
    };
  });
  log.querySelectorAll('input[type="file"][id^="form-file-"]').forEach((fi) => {
    fi.onchange = (e) => addAttachments([...e.target.files]);
  });
  // hv-confirm: generate / edit buttons
  log.querySelectorAll('[data-confirm-msg]').forEach((btn) => {
    btn.onclick = async () => {
      const msgIdx = Number(btn.dataset.confirmMsg);
      const action = btn.dataset.action;
      const m = state.messages[msgIdx];
      if (!m) return;
      // In-flight guard only — don't permanently mark resolved here. Whether
      // the card stays locked is recomputed from history each render
      // (renderMessage inspects whether the click actually produced output).
      if (m.confirmInFlight) return;
      m.confirmInFlight = true;
      try {
        const ta = document.getElementById('composer-input');
        if (ta) ta.value = action === 'generate' ? '[hv-confirm:generate]' : '[hv-confirm:edit]';
        await sendMessage();
      } finally {
        m.confirmInFlight = false;
      }
    };
  });
  log.querySelectorAll('[data-export-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.exportAction;
      const card = btn.closest('.export-done');
      const path = card?.querySelector('.export-path code')?.textContent ?? '';
      if (action === 'reveal') {
        await revealExportedFile();
      } else if (action === 'copy' && path) {
        try {
          await navigator.clipboard.writeText(path);
          toast(t('export.copied'), 'success');
        } catch (e) {
          toast(t('export.copy_failed', { message: (e?.message ?? e) }), 'error');
        }
      }
    });
  });
  log.scrollTop = log.scrollHeight;
}

async function pickAndSend(label) {
  // Stuff the textarea with the chosen label and send it as a normal turn
  const ta = document.getElementById('composer-input');
  if (ta) ta.value = label;
  renderChatLog(); // shows the picked highlight on the previous message
  await sendMessage();
}

function parseCreatePromptSummary(content) {
  const text = String(content || '');
  if (!/生成要求\s*[:：]/.test(text)) return null;
  if (!/(主题和素材说明|相册标题|图片顺序)\s*[:：]/.test(text)) return null;
  const pickLine = (label) => {
    const re = new RegExp(`${label}\\s*[:：]\\s*([^\\n。]+)`);
    return re.exec(text)?.[1]?.trim() || '';
  };
  const title =
    /主题和素材说明\s*[:：]\s*([\s\S]*?)\n\s*生成要求\s*[:：]/.exec(text)?.[1]?.trim()
    || pickLine('相册标题')
    || state.selected?.name
    || '电子相册';
  const rows = [
    pickLine('(?:内容类型|类型)'),
    pickLine('页数\\/帧数') || pickLine('页数') || pickLine('帧数'),
    pickLine('受众'),
    pickLine('场景'),
    pickLine('语气'),
    pickLine('(?:比例|画面尺寸|尺寸)'),
    pickLine('风格'),
    pickLine('素材使用方式'),
    pickLine('行动引导'),
  ].filter(Boolean);
  return { title: title.replace(/\s+/g, ' ').slice(0, 140), rows };
}

function normalizePersistedStatusMessage(m) {
  const raw = String(m?.content || '').trim();
  if (!raw) return null;

  if (m?.messageType === 'system_event') {
    if (/^⚠️/.test(raw)) return { role: 'system', content: raw };
    return { role: 'preview-event', content: raw.replace(/^✓\s*/, '') };
  }

  // Backward compatibility for old messages that were persisted as assistant
  // prose before status events had their own messageType.
  if (/^✓\s*updated the HTML preview$/i.test(raw)) {
    return { role: 'preview-event', content: '预览已刷新' };
  }
  if (/^✓\s*HTML preview updated$/i.test(raw)) {
    return { role: 'preview-event', content: '预览已刷新' };
  }
  const frameMatch = /^✓\s*frame\s+(.+?)\s+updated$/i.exec(raw);
  if (frameMatch) {
    return { role: 'preview-event', content: `已更新选中页面 ${frameMatch[1]}` };
  }
  const storyboardMatch = /^✓\s*(\d+)-frame storyboard (?:generated|regenerated|restyled)\b/i.exec(raw);
  if (storyboardMatch) {
    return { role: 'preview-event', content: `已生成 ${storyboardMatch[1]} 页预览` };
  }
  if (/^⚠️\s*The agent returned an empty reply/i.test(raw)) {
    return {
      role: 'system',
      content: '⚠️ AI 助手本轮没有返回有效内容。请补充品牌、主题或 1-2 个关键细节后重试。',
    };
  }
  return null;
}

function isGenerationSuccessMessage(m) {
  const status = normalizePersistedStatusMessage(m);
  if (status?.role === 'preview-event') return true;
  const raw = String(m?.content || '').trim();
  return /```json#content-graph|故事板规划完成|storyboard (generated|regenerated|restyled)|^✓\s*(?:已生成\s*\d+\s*页预览|预览已更新|updated the HTML preview|HTML preview updated)/i.test(raw);
}

function renderMessage(m, idx) {
  if (m.role === 'user') {
    const userContent = (m.content ?? '').trim();
    if (
      document.getElementById('chat-log')?.classList.contains('generation-chat-log') &&
      /^\[(?:hv-confirm|hv-form):/.test(userContent)
    ) {
      return '';
    }
    // User-side form-submission marker carries hidden JSON the user can't read;
    // show a friendlier label instead of a wall of "topic=foo\nheadline=bar…".
    const formMatch = /^\[hv-form:submit\]\n([\s\S]*)$/.exec(m.content ?? '');
    if (formMatch) {
      return `<div class="msg user">${t('chat.summary.form_submitted')}</div>`;
    }
    if ((m.content ?? '').trim() === '[hv-confirm:generate]') {
      return `<div class="msg user">${t('chat.summary.confirm_generate')}</div>`;
    }
    if ((m.content ?? '').trim() === '[hv-confirm:edit]') {
      return `<div class="msg user">${t('chat.summary.confirm_edit')}</div>`;
    }
    const promptSummary = parseCreatePromptSummary(m.content);
    if (promptSummary) {
      return `<div class="msg user prompt-summary">
        <b>已提交生成需求</b>
        <span>${esc(promptSummary.title)}</span>
        <div class="prompt-summary-tags">${promptSummary.rows.map((row) => `<em>${esc(row)}</em>`).join('')}</div>
      </div>`;
    }
    return `<div class="msg user">${esc(m.content)}</div>`;
  }
  if (m.role === 'system') return `<div class="msg system">${esc(m.content)}</div>`;
  if (m.role === 'preview-event') return `<div class="msg preview-event">${esc(m.content)}</div>`;
  if (m.role === 'thinking') return `<div class="msg thinking">${esc(m.content || t('chat.thinking'))}</div>`;
  if (m.role === 'export-done') {
    const path = m.content || '';
    const fname = path.split('/').pop() || 'output.mp4';
    return `<div class="msg export-done">
      <div class="export-title">${t('export.title')}</div>
      <div class="export-fname">${esc(fname)}</div>
      <div class="export-actions">
        <button class="btn-reveal" data-export-action="reveal">${t('export.reveal')}</button>
      </div>
    </div>`;
  }
  // assistant: try each card protocol in turn
  const raw = m.content ?? '';
  const statusMessage = normalizePersistedStatusMessage(m);
  if (statusMessage) {
    const cls = statusMessage.role === 'system' ? 'system' : 'preview-event';
    return `<div class="msg ${cls}">${esc(statusMessage.content)}</div>`;
  }
  const parsedOptions = parseHvOptions(raw);
  if (
    parsedOptions.options?.meta?.phase === 'type' &&
    state.messages.slice(0, idx).some(isGenerationSuccessMessage)
  ) {
    return '';
  }
  const formP = parseHvForm(raw);
  if (formP.form) {
    // Resolve "submitted" from history: any user turn after this card with
    // [hv-form:submit] marker counts as the answer.
    let submitted = m.formSubmitted;
    if (!submitted) {
      const nextUser = state.messages.slice(idx + 1).find((x) => x.role === 'user');
      if (nextUser) {
        const fm = /^\[hv-form:submit\]\n([\s\S]*)$/.exec(nextUser.content ?? '');
        if (fm && fm[1]) {
          try { submitted = JSON.parse(fm[1]); } catch { submitted = null; }
        }
      }
    }
    const formHtml = renderFormCard(formP.form, submitted, idx);
    return `<div class="msg assistant">
      <div class="role">AI助手</div>
      <div class="body">${md(sanitizeAssistantProse(formP.prose))}${formHtml}</div>
    </div>`;
  }
  const confirmP = parseHvConfirm(raw);
  if (confirmP.confirm) {
    // Only lock the card when the click actually led somewhere:
    //   - "✏️ 改一下" → next assistant turn re-emitted hv-form (the edit landed)
    //   - "✓ 开始生成" → next assistant turn produced real output
    //                   (preview-event / ✓ HTML preview / storyboard summary)
    // If the click triggered an empty reply or generate failed, treat the
    // card as live so the user can press the button again.
    let resolved = m.confirmResolved;
    if (!resolved) {
      const after = state.messages.slice(idx + 1);
      const nextUser = after.find((x) => x.role === 'user');
      if (nextUser) {
        const t = (nextUser.content ?? '').trim();
        if (t === '[hv-confirm:generate]') {
          // Did anything productive happen between this user click and the
          // next user turn?
          const userIdx = after.indexOf(nextUser);
          const between = after.slice(userIdx + 1);
          const sawSuccess = between.some((x) => {
            if (x.role === 'preview-event') return true;
            if (x.role === 'assistant') {
              const c = (x.content ?? '').trim();
              if (!c) return false;
              if (/^⚠️/.test(c)) return false;
              if (/^✓\s/.test(c)) return true;
              if (/storyboard generated|HTML preview updated/i.test(c)) return true;
            }
            return false;
          });
          if (sawSuccess) resolved = '✓ 开始生成';
        } else if (t === '[hv-confirm:edit]') {
          resolved = '✏️ 改一下';
        }
      }
    }
    const confirmHtml = renderConfirmCard(confirmP.confirm, resolved, idx);
    return `<div class="msg assistant">
      <div class="role">AI助手</div>
      <div class="body">${md(sanitizeAssistantProse(confirmP.prose))}${confirmHtml}</div>
    </div>`;
  }
  // Default: hv-options + prose
  const { prose, options } = parsedOptions;
  // m.pickedOption is in-memory only — wiped on reload. Recover it from
  // history: any user turn AFTER this card is implicitly the answer.
  let picked = m.pickedOption;
  if (options && !picked) {
    const nextUser = state.messages.slice(idx + 1).find((x) => x.role === 'user');
    if (nextUser) picked = nextUser.content;
  }
  const optionsHtml = options ? renderOptionCard(options, picked, idx) : '';
  return `<div class="msg assistant">
    <div class="role">AI助手</div>
    <div class="body">${md(sanitizeAssistantProse(prose))}${optionsHtml}</div>
  </div>`;
}

/**
 * Strip HTML / content-graph code blocks from assistant text before render.
 * Streaming text comes in raw — without this the user sees a wall of CSS /
 * JSX / HTML scrolling past. We replace each block with a one-line collapsed
 * marker so they know something is being generated, but don't have to read
 * 600 lines of style declarations.
 *
 * Acts on render only; the underlying message content is untouched, so the
 * server's persisted "✓ frame X updated" summary still wins on reload.
 */
function sanitizeAssistantProse(text) {
  if (!text) return text;
  let out = text;
  const genHtml = t('chat.placeholder.gen_html');
  const planGraph = t('chat.placeholder.plan_graph');
  // ```html ... ``` (full block) — closed
  out = out.replace(/```html(?:#[\w-]+)?\s*\n[\s\S]*?```/gi, `\n${genHtml}\n`);
  // ```html ... (still open, mid-stream) — clip everything after the fence
  out = out.replace(/```html(?:#[\w-]+)?\s*\n[\s\S]*$/i, `\n${genHtml}`);
  // ```json#content-graph ...```
  out = out.replace(/```json#content-graph\s*\n[\s\S]*?```/gi, `\n${planGraph}\n`);
  out = out.replace(/```json#content-graph\s*\n[\s\S]*$/i, `\n${planGraph}`);
  // ```hv-form / ```hv-confirm / ```hv-options blocks are parsed by their
  // own renderers above; if we got here they slipped past — collapse them.
  out = out.replace(/```hv-(?:form|confirm|options)\s*\n[\s\S]*?```/gi, '');
  return out;
}

// === Markdown rendering ===
// Uses `marked` from CDN for proper headings/lists/bold/links/code,
// then DOMPurify to sanitize, so user prompts can't inject script tags
// even if the agent echos them back.
function md(text) {
  if (!text) return '';
  let html;
  if (typeof window.marked !== 'undefined') {
    try {
      html = window.marked.parse(String(text), { breaks: true, gfm: true });
    } catch {
      html = esc(text);
    }
  } else {
    // Fallback: render bare with line breaks if CDN failed to load
    html = esc(text).replace(/\n/g, '<br>');
  }
  if (typeof window.DOMPurify !== 'undefined') {
    return window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'hr', 'span'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    });
  }
  return html;
}

// === hv-options block parsing ===
// Splits assistant text into prose + an optional ```hv-options``` block.
function parseHvOptions(text) {
  const m = /```hv-options\s*\n([\s\S]*?)```/i.exec(text);
  if (!m) return { prose: text, options: null };
  const prose = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let parsed;
  try { parsed = JSON.parse(m[1].trim()); }
  catch { return { prose: text, options: null }; }
  if (!parsed || !Array.isArray(parsed.options) || !parsed.question) {
    return { prose: text, options: null };
  }
  return { prose, options: parsed };
}

// === hv-form block parsing ===
// Multi-field input card. Schema:
//   ```hv-form
//   {
//     "title": "讲一下你想做的视频…",
//     "fields": [
//       { "key": "topic",     "label": "主题 / who-what",   "kind": "text",     "required": true },
//       { "key": "headline",  "label": "Headline",          "kind": "text",     "required": true },
//       { "key": "data",      "label": "关键数字 / 数据",   "kind": "textarea" },
//       { "key": "aspect",    "label": "尺寸",              "kind": "select",   "options": ["16:9","9:16","1:1","4:5"], "default": "16:9" },
//       { "key": "duration",  "label": "时长(秒)",          "kind": "select",   "options": ["3","5","10","15","30"], "default": "5" },
//       { "key": "frame_count","label": "帧数 / 画面数",    "kind": "text",     "default": "1" },
//       { "key": "style",     "label": "风格描述",          "kind": "textarea" }
//     ],
//     "allow_attachments": true
//   }
function parseHvForm(text) {
  const m = /```hv-form\s*\n([\s\S]*?)```/i.exec(text);
  if (!m) return { prose: text, form: null };
  const prose = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let parsed;
  try { parsed = JSON.parse(m[1].trim()); }
  catch { return { prose: text, form: null }; }
  if (!parsed || !Array.isArray(parsed.fields) || parsed.fields.length === 0) {
    return { prose: text, form: null };
  }
  return { prose, form: parsed };
}

// === hv-confirm block parsing ===
//   ```hv-confirm
//   {
//     "title": "按这些信息开始生成？",
//     "summary": [{ "label": "主题", "value": "nexu-io" }, ...],
//     "actions": ["generate","edit"]   // optional, defaults to both
//   }
function parseHvConfirm(text) {
  const m = /```hv-confirm\s*\n([\s\S]*?)```/i.exec(text);
  if (!m) return { prose: text, confirm: null };
  const prose = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let parsed;
  try { parsed = JSON.parse(m[1].trim()); }
  catch { return { prose: text, confirm: null }; }
  if (!parsed || !Array.isArray(parsed.summary)) {
    return { prose: text, confirm: null };
  }
  return { prose, confirm: parsed };
}

// === hv-form render ===
function renderFormCard(form, submitted, msgIdx) {
  const title = form.title || 'Tell me a bit more…';
  const fields = form.fields || [];
  const allowAttachments = form.allow_attachments !== false;
  const fieldsHtml = fields.map((f, i) => {
    const key = f.key || `field_${i}`;
    const label = f.label || key;
    const ph = f.placeholder || '';
    const required = f.required ? '<span class="req">*</span>' : '';
    const def = (submitted && submitted[key] !== undefined ? submitted[key] : (f.default ?? ''));
    const dis = submitted ? 'disabled' : '';
    let control;
    if (f.kind === 'textarea') {
      control = `<textarea data-form-msg="${msgIdx}" data-form-key="${esc(key)}" rows="2" placeholder="${esc(ph)}" ${dis}>${esc(def)}</textarea>`;
    } else if (f.kind === 'select') {
      const opts = (f.options || []).map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const lbl = typeof o === 'string' ? o : (o.label || o.value);
        const sel = String(v) === String(def) ? 'selected' : '';
        return `<option value="${esc(v)}" ${sel}>${esc(lbl)}</option>`;
      }).join('');
      control = `<select data-form-msg="${msgIdx}" data-form-key="${esc(key)}" ${dis}>${opts}</select>`;
    } else if (f.kind === 'buttons') {
      // Segmented control: a hidden input carries the value, visible buttons
      // toggle. Wired up in renderChatLog.
      const optsHtml = (f.options || []).map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const lbl = typeof o === 'string' ? o : (o.label || o.value);
        const sel = String(v) === String(def) ? 'selected' : '';
        return `<button type="button" class="form-seg-btn ${sel}" data-form-msg="${msgIdx}" data-form-key="${esc(key)}" data-val="${esc(v)}" ${dis}>${esc(lbl)}</button>`;
      }).join('');
      control = `<div class="form-seg" data-form-key="${esc(key)}">
        <input type="hidden" data-form-msg="${msgIdx}" data-form-key="${esc(key)}" value="${esc(def)}" />
        ${optsHtml}
      </div>`;
    } else {
      control = `<input type="text" data-form-msg="${msgIdx}" data-form-key="${esc(key)}" placeholder="${esc(ph)}" value="${esc(def)}" ${dis} />`;
    }
    const hintHtml = f.hint ? `<span class="form-hint">${esc(f.hint)}</span>` : '';
    return `<div class="form-field">
      <label>${esc(label)}${required}${hintHtml}</label>
      ${control}
    </div>`;
  }).join('');
  // Live total-duration readout when the form paces by per-frame × frames.
  const hasPerFrame = fields.some((f) => f.key === 'per_frame') && fields.some((f) => f.key === 'frame_count');
  const totalHtml = hasPerFrame && !submitted
    ? `<div class="form-total" id="form-total-${msgIdx}"></div>`
    : '';
  const dropHtml = allowAttachments && !submitted ? `
    <div class="form-attachments" data-form-msg="${msgIdx}">
      <div class="form-drop-hint">📎 拖拽 / 粘贴 / 选择文件作为素材（logo、截图、数据 CSV…可选）</div>
      <div class="form-attachment-list" id="form-att-${msgIdx}"></div>
      <input type="file" id="form-file-${msgIdx}" multiple style="display:none" />
      <button type="button" class="form-attach-btn" data-form-msg="${msgIdx}">+ 添加文件</button>
    </div>` : '';
  const actionsHtml = submitted ? '' : `
    <div class="form-actions">
      <button class="form-submit" data-form-msg="${msgIdx}">提交 ↵</button>
    </div>`;
  return `<div class="form-card${submitted ? ' submitted' : ''}">
    <div class="form-title">${esc(title)}</div>
    <div class="form-fields">${fieldsHtml}</div>
    ${totalHtml}
    ${dropHtml}
    ${actionsHtml}
  </div>`;
}

// === hv-confirm render ===
function renderConfirmCard(confirm, resolved, msgIdx) {
  const title = confirm.title || 'Looks right?';
  const summary = confirm.summary || [];
  const actions = confirm.actions || ['generate', 'edit'];
  const summaryHtml = summary.map((s) => {
    const label = s.label || s.key || '';
    const value = s.value !== undefined ? String(s.value) : '';
    return `<div class="confirm-row">
      <div class="confirm-label">${esc(label)}</div>
      <div class="confirm-value">${esc(value) || '<span class="muted">—</span>'}</div>
    </div>`;
  }).join('');
  const actionsHtml = resolved ? '' : `
    <div class="confirm-actions">
      ${actions.includes('generate') ? `<button class="confirm-go" data-confirm-msg="${msgIdx}" data-action="generate">✓ 开始生成</button>` : ''}
      ${actions.includes('edit') ? `<button class="confirm-edit" data-confirm-msg="${msgIdx}" data-action="edit">✏️ 修改</button>` : ''}
    </div>`;
  return `<div class="confirm-card${resolved ? ' resolved' : ''}">
    <div class="confirm-title">${esc(title)}</div>
    <div class="confirm-summary">${summaryHtml}</div>
    ${actionsHtml}
    ${resolved ? `<div class="confirm-resolved-mark">${esc(resolved)}</div>` : ''}
  </div>`;
}

function renderOptionCard(opts, picked, msgIdx) {
  const allowFreeform = opts.allow_freeform !== false;
  const optsHtml = (opts.options || []).map((o, i) => {
    const label = o.label ?? String(o);
    const hint = o.hint ?? '';
    const isPicked = picked === label;
    const cls = 'opt' + (isPicked ? ' picked' : '');
    // Once the user has picked anything on this card, ALL buttons lock —
    // including the picked one, so the same option can't fire twice.
    const disabled = picked ? 'disabled' : '';
    return `<button class="${cls}" data-opt-msg="${msgIdx}" data-opt-i="${i}" ${disabled}>
      <span class="label">${esc(label)}</span>
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    </button>`;
  }).join('');
  // Inline freeform input — saves a trip to the bottom composer when the
  // user just wants to type a custom answer to this card's question.
  const freeformHtml = allowFreeform && !picked ? `
    <div class="freeform-input">
      <textarea data-freeform-msg="${msgIdx}" rows="1"
        placeholder="…or type your own answer"></textarea>
      <button class="freeform-send" data-freeform-msg="${msgIdx}" disabled>↵ Send</button>
    </div>` : '';
  return `<div class="opt-card">
    <div class="question">${esc(opts.question)}</div>
    <div class="opts">${optsHtml}</div>
    ${freeformHtml}
  </div>`;
}

// ============== preview ==============
function renderPreview() {
  const stage = document.getElementById('preview-stage');
  if (!stage) return;
  const p = state.selected;
  if (!p) {
    stage.innerHTML = `<div class="preview-placeholder"><div><div class="ico">🎞️</div>${t('preview.placeholder.pick_project')}</div></div>`;
    renderFramesStrip();
    return;
  }
  // No template + no prior preview → show "send a chat first" placeholder
  if (!hasProjectPreview(p)) {
    stage.innerHTML = `<div class="preview-placeholder"><div><div class="ico">🎞️</div>这个项目还没有生成成功，请点击“重新生成”。</div></div>`;
    renderFramesStrip();
    return;
  }
  // v0.8: if multi-frame, default-iframe shows the active frame (first by default).
  const frames = Array.isArray(p.frames) ? p.frames : [];
  const sortedFrames = [...frames].sort((a, b) => a.order - b.order);
  if (sortedFrames.length > 0 && !state.activeFrameId) {
    state.activeFrameId = sortedFrames[0].graphNodeId;
  }
  if (sortedFrames.length > 0 && state.activeFrameId
      && !sortedFrames.find((f) => f.graphNodeId === state.activeFrameId)) {
    state.activeFrameId = sortedFrames[0].graphNodeId;
  }
  const iframeSrc = sortedFrames.length > 0 && state.activeFrameId
    ? `/preview/${p.id}/frame/${encodeURIComponent(state.activeFrameId)}?t=${Date.now()}`
    : `/preview/${p.id}?t=${Date.now()}`;
  const stamp = sortedFrames.length > 0 && state.activeFrameId
    ? state.activeFrameId
    : (p.templateId || '');
  // Respect the project's chosen resolution so the preview box matches the real
  // export aspect (4:5 / 9:16 / 1:1), not a hardcoded 16:9. The iframe renders
  // at the design's native pixel size and is scaled to fit (scale set on resize).
  const res = p.preferences?.resolution ?? { width: 1920, height: 1080 };
  const vw = res.width || 1920, vh = res.height || 1080;
  const previewZoom = stage.classList.contains('generation-preview-shell') ? getPreviewZoom() : 1;
  const zoomStyle = `--preview-user-zoom:${previewZoom};`;
  // Constrain the preview frame along the *long* axis so the whole frame stays
  // contained in the (bounded-height) stage. The base CSS only limits width
  // (width:100%; max-width:1280px) which is right for landscape, but for a
  // portrait frame (vh>vw) that lets it grow ~2275px tall and overflow — you'd
  // only see the top slice. For portrait, limit height instead and let width
  // follow the aspect-ratio. Square stays width-bound.
  const sizeStyle = vh > vw
    ? `${zoomStyle}width:auto;max-width:none;height:min(${Math.round(78 * previewZoom)}vh, ${Math.round(820 * previewZoom)}px);max-height:none`
    : `${zoomStyle}width:${Math.round(100 * previewZoom)}%;max-width:${Math.round(1280 * previewZoom)}px`;
  // A native (enhanced) frame has no HTML — play its rendered preview MP4 and
  // hide the data-hv-text edit affordance (there's no HTML text to edit).
  const activeFrame = sortedFrames.find((f) => f.graphNodeId === state.activeFrameId);
  const activeEnhanced = activeFrame?.engine === 'remotion';
  if (activeEnhanced) {
    const videoSrc = `/preview/${p.id}/frame/${encodeURIComponent(state.activeFrameId)}.mp4?t=${Date.now()}`;
    stage.innerHTML = `<div class="preview-frame" style="aspect-ratio:${vw}/${vh};${sizeStyle}">
      <video id="preview-iframe" src="${videoSrc}" autoplay muted loop controls playsinline style="width:${vw}px;height:${vh}px"></video>
      ${stamp ? `<div class="stamp">${esc(stamp)} · ⚡</div>` : ''}
    </div>`;
    attachPreviewScaler();
    renderFramesStrip();
    return;
  }
  // sandbox grants same-origin so Studio can inspect album pages and text fields.
  // allow-scripts keeps the page's own animations running; forms / popups /
  // top-navigation stay blocked.
  stage.innerHTML = `<div class="preview-frame" style="aspect-ratio:${vw}/${vh};${sizeStyle}">
    <iframe id="preview-iframe" sandbox="allow-scripts allow-same-origin" src="${iframeSrc}" style="width:${vw}px;height:${vh}px"></iframe>
    ${stamp ? `<div class="stamp">${esc(stamp)}</div>` : ''}
  </div>`;
  attachPreviewScaler();
  const iframe = document.getElementById('preview-iframe');
  if (iframe) {
    iframe.addEventListener('load', () => syncAlbumPagesFromPreview(iframe), { once: true });
  }
  renderFramesStrip();
  // Convergence point for every frame/preview change → keep soundtrack buttons
  // (draft / fit) and the per-frame narration line in sync, regardless of which
  // path triggered the change.
  if (typeof window.__hvSyncNarration === 'function') window.__hvSyncNarration();
}

function getAlbumPagesFromIframe(iframe) {
  try {
    const doc = iframe?.contentDocument;
    if (!doc) return [];
    return Array.from(doc.querySelectorAll('[data-page]'));
  } catch {
    return [];
  }
}

function syncAlbumPagesFromPreview(iframe) {
  const p = state.selected;
  const hasFrames = Array.isArray(p?.frames) && p.frames.length > 0;
  if (!p || hasFrames) return;
  const pages = getAlbumPagesFromIframe(iframe);
  const nextCount = pages.length;
  if (nextCount !== state.albumPageCount) {
    state.albumPageCount = nextCount;
    state.activeAlbumPage = Math.min(state.activeAlbumPage, Math.max(0, nextCount - 1));
    renderFramesStrip();
  }
  scrollPreviewToAlbumPage(state.activeAlbumPage, 'auto');
  wireAlbumPageScrollSync(iframe);
}

function wireAlbumPageScrollSync(iframe) {
  try {
    const doc = iframe?.contentDocument;
    const album = doc?.getElementById('album') || doc?.scrollingElement;
    const pages = getAlbumPagesFromIframe(iframe);
    if (!album || pages.length === 0 || album.dataset.hvStudioPageSync === '1') return;
    album.dataset.hvStudioPageSync = '1';
    let ticking = false;
    const update = () => {
      ticking = false;
      const albumRect = album.getBoundingClientRect();
      let bestIndex = 0;
      let bestDistance = Infinity;
      pages.forEach((page, index) => {
        const distance = Math.abs(page.getBoundingClientRect().top - albumRect.top);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      if (bestIndex !== state.activeAlbumPage) {
        state.activeAlbumPage = bestIndex;
        updateAlbumPageTabActive();
      }
    };
    album.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
  } catch {}
}

function scrollPreviewToAlbumPage(index, behavior = 'smooth') {
  const iframe = document.getElementById('preview-iframe');
  const pages = getAlbumPagesFromIframe(iframe);
  if (!pages.length) return;
  const safeIndex = Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
  state.activeAlbumPage = safeIndex;
  updateAlbumPageTabActive();
  pages[safeIndex].scrollIntoView({ behavior, block: 'start' });
}

function scrollAlbumThumbToPage(iframe, index) {
  const pages = getAlbumPagesFromIframe(iframe);
  if (!pages.length) return;
  const safeIndex = Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
  pages[safeIndex].scrollIntoView({ behavior: 'auto', block: 'start' });
}

function updateAlbumPageTabActive() {
  document.querySelectorAll('button.album-page-tab').forEach((btn) => {
    const pageIndex = Number(btn.dataset.albumPage) || 0;
    btn.classList.toggle('active', pageIndex === state.activeAlbumPage);
  });
}

// Keep --preview-scale on .preview-frame in sync with its rendered width
// so the 1920×1080 iframe shrinks proportionally rather than getting
// cropped by a smaller viewport.
let _previewResizeObserver = null;
function attachPreviewScaler() {
  const frame = document.querySelector('.preview-frame');
  if (!frame) return;
  const apply = () => {
    const w = frame.clientWidth;
    if (!w) return;
    // Scale by the inner element's native design width (not a hardcoded 1920)
    // so non-16:9 aspects (1080-wide) shrink correctly too. A native (enhanced)
    // frame uses a <video> instead of an <iframe> — scale it the same way, else
    // the 1920×1080 MP4 overflows and the frame gets cropped.
    const inner = frame.querySelector('iframe, video');
    const nativeW = inner ? (parseFloat(inner.style.width) || 1920) : 1920;
    frame.style.setProperty('--preview-scale', (w / nativeW).toFixed(4));
  };
  apply();
  if (_previewResizeObserver) _previewResizeObserver.disconnect();
  _previewResizeObserver = new ResizeObserver(apply);
  _previewResizeObserver.observe(frame);
}

function reloadPreview() {
  const iframe = document.getElementById('preview-iframe');
  if (!iframe || !state.selected) return;
  const p = state.selected;
  const frames = Array.isArray(p.frames) ? p.frames : [];
  if (frames.length > 0 && state.activeFrameId) {
    iframe.src = `/preview/${p.id}/frame/${encodeURIComponent(state.activeFrameId)}?t=${Date.now()}`;
  } else {
    iframe.src = `/preview/${p.id}?t=${Date.now()}`;
  }
}

// ============== v0.8: frames timeline + graph modal ==============
function renderFramesStrip() {
  const strip = document.getElementById('frames-strip');
  if (!strip) return;
  const p = state.selected;
  const frames = p && Array.isArray(p.frames) ? [...p.frames].sort((a, b) => a.order - b.order) : [];
  if (frames.length === 0) {
    renderAlbumPagesStrip(strip, p);
    return;
  }
  strip.classList.add('has-frames');
  // Each chip = label + mini iframe of the frame's actual HTML, transform-
  // scaled so the 1920×1080 page fits in a ~180×100 thumb. sandbox blocks
  // navigation; allow-scripts so any opening animation runs.
  // Bust cache when frame content changes (re-renders point to a new
  // versioned URL via `?v=<timestamp>` derived from project.updatedAt).
  const ver = p.updatedAt ? new Date(p.updatedAt).getTime() : Date.now();
  const tabs = frames.map((f) => {
    const isActive = f.graphNodeId === state.activeFrameId;
    const isFocus = f.graphNodeId === state.iterateFocusFrameId;
    const cls = ['frame-tab', isActive && 'active', isFocus && 'focus']
      .filter(Boolean).join(' ');
    // A native (enhanced) frame has no HTML — play its rendered preview MP4.
    const enhanced = f.engine === 'remotion';
    const thumbInner = enhanced
      ? `<video src="/preview/${p.id}/frame/${encodeURIComponent(f.graphNodeId)}.mp4?v=${ver}" autoplay muted loop playsinline tabindex="-1"></video>`
      : `<iframe sandbox="allow-scripts" src="/preview/${p.id}/frame/${encodeURIComponent(f.graphNodeId)}?thumb=1&v=${ver}" tabindex="-1" loading="lazy"></iframe>`;
    // The "⚡ Enhance" control shows only on data frames (kind==='data'). It's an
    // overlay badge ON the thumbnail (top area) so it's obvious + always visible.
    const isData = state.frameKinds[f.graphNodeId] === 'data';
    const busy = state.enhancing && state.enhancing.nodeId === f.graphNodeId;
    let enhanceCtl = '';
    if (isData) {
      if (busy) {
        enhanceCtl = `<span class="frame-enhance busy" data-fid="${esc(f.graphNodeId)}">${t('frames.enhancing', { pct: state.enhancing.pct ?? 0 })}</span>`;
      } else if (enhanced) {
        enhanceCtl = `<span class="frame-enhance on" data-fid="${esc(f.graphNodeId)}" data-act="unenhance" title="${esc(t('frames.enhanced_revert'))}">${t('frames.enhanced_revert')}</span>`;
      } else {
        enhanceCtl = `<span class="frame-enhance" data-fid="${esc(f.graphNodeId)}" data-act="enhance" title="${esc(t('frames.enhance_hint'))}">${t('frames.enhance')}</span>`;
      }
    }
    return `<button class="${cls}${isData ? ' is-data' : ''}" data-fid="${esc(f.graphNodeId)}">
      <div class="frame-thumb">
        ${thumbInner}
        ${enhanceCtl}
        ${isFocus ? '<div class="focus-mark" title="正在编辑此帧">✎</div>' : ''}
      </div>
      <div class="frame-tab-label">
        <span class="order">${String(f.order + 1).padStart(2, '0')}</span>
        <span class="fid">${esc(f.graphNodeId)}</span>
      </div>
    </button>`;
  }).join('');
  strip.innerHTML = `<span class="label">${t('frames.label')}</span>${tabs}
    <button class="frame-graph-btn" id="btn-show-graph">${t('frames.view_graph')}</button>`;
  // Single-click: switch which frame is shown in the centre preview.
  // Double-click: pin this frame as the iteration target so subsequent
  // chat messages only rewrite this frame. Click another / dbl-click the
  // same one to clear.
  strip.querySelectorAll('button.frame-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fid = btn.dataset.fid;
      state.activeFrameId = fid;
      // First click also pins focus so the user doesn't have to dbl-click —
      // but only when nothing else is focused, or they're switching to a new
      // frame. Clicking the already-focused frame again clears focus.
      if (state.iterateFocusFrameId === fid) {
        state.iterateFocusFrameId = null;
      } else {
        state.iterateFocusFrameId = fid;
      }
      renderPreview();
      renderComposer();
      // Refresh the right-pane Frame text editor to point at the newly
      // active frame's data-hv-text values.
      refreshTextFields();
      // Soundtrack narration is per-frame — point the textarea at this frame.
      if (typeof window.__hvSyncNarration === 'function') window.__hvSyncNarration();
    });
  });
  // Per-frame enhance / revert toggle (data frames only). stopPropagation so
  // clicking it doesn't also fire the parent tab's frame-switch handler.
  strip.querySelectorAll('.frame-enhance').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.enhancing) return; // single in-flight; ignore double-clicks
      const fid = el.dataset.fid;
      if (el.dataset.act === 'unenhance') unenhanceFrameAction(fid);
      else if (el.dataset.act === 'enhance') startEnhanceStream(fid);
    });
  });
  const gbtn = document.getElementById('btn-show-graph');
  if (gbtn) gbtn.addEventListener('click', openGraphModal);
}

function renderAlbumPagesStrip(strip, p) {
  const count = Number(state.albumPageCount) || 0;
  if (!p || count <= 0) {
    strip.classList.remove('has-frames');
    strip.innerHTML = '';
    return;
  }
  strip.classList.add('has-frames');
  const ver = p.updatedAt ? new Date(p.updatedAt).getTime() : Date.now();
  const res = p.preferences?.resolution ?? { width: 1920, height: 1080 };
  const nativeW = res.width || 1920;
  const nativeH = res.height || 1080;
  const thumbW = 210;
  const thumbH = 132;
  const thumbScale = thumbW / nativeW;
  const overflowY = Math.max(0, nativeH * thumbScale - thumbH);
  const thumbOffsetY = -Math.round(overflowY * 0.42);
  const thumbStyle = `--thumb-native-w:${nativeW}px;--thumb-native-h:${nativeH}px;--thumb-scale:${thumbScale};--thumb-offset-y:${thumbOffsetY}px`;
  const tabs = Array.from({ length: count }, (_, index) => {
    const isActive = index === state.activeAlbumPage;
    const cls = ['frame-tab', 'album-page-tab', isActive && 'active'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-album-page="${index}">
      <div class="frame-thumb">
        <iframe sandbox="allow-scripts allow-same-origin"
          src="/preview/${p.id}?thumb=1&albumPage=${index + 1}&v=${ver}"
          data-album-thumb="${index}" tabindex="-1" loading="lazy" style="${thumbStyle}"></iframe>
      </div>
      <div class="frame-tab-label">
        <span class="order">${String(index + 1).padStart(2, '0')}</span>
        <span class="fid">第 ${index + 1} 页</span>
      </div>
    </button>`;
  }).join('');
  strip.innerHTML = `<span class="label">相册页</span>${tabs}`;
  strip.querySelectorAll('button.album-page-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pageIndex = Number(btn.dataset.albumPage) || 0;
      state.activeAlbumPage = pageIndex;
      updateAlbumPageTabActive();
      scrollPreviewToAlbumPage(pageIndex);
    });
  });
  strip.querySelectorAll('iframe[data-album-thumb]').forEach((iframe) => {
    iframe.addEventListener('load', () => {
      scrollAlbumThumbToPage(iframe, Number(iframe.dataset.albumThumb) || 0);
    }, { once: true });
  });
}

async function openGraphModal() {
  if (!state.selected) return;
  const modal = document.getElementById('graph-modal');
  const pre = document.getElementById('graph-json');
  if (!modal || !pre) return;
  try {
    const r = await fetch(`/api/projects/${state.selected.id}/content-graph`);
    if (!r.ok) {
      pre.textContent = '(no graph for this project)';
    } else {
      const { graph } = await r.json();
      pre.textContent = JSON.stringify(graph, null, 2);
      state.lastGraph = graph;
    }
  } catch (e) {
    pre.textContent = `error loading graph: ${e.message}`;
  }
  modal.classList.add('open');
  const close = document.getElementById('graph-close');
  const dl = document.getElementById('graph-download');
  if (close) close.onclick = () => modal.classList.remove('open');
  if (dl) dl.onclick = () => {
    if (!state.lastGraph) return;
    const blob = new Blob([JSON.stringify(state.lastGraph, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `content-graph-${state.selected.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('open');
  }, { once: true });
}

// ============== text fields (data-hv-text editor) ==============
/**
 * Source the HTML the right-side editor reads. For multi-frame projects
 * we follow `state.activeFrameId` so clicking a frame in the strip swaps
 * the editor over to that frame; otherwise fall back to the whole-project
 * preview HTML.
 */
async function fetchActiveFrameHtml() {
  if (!state.selected) return null;
  const fid = state.activeFrameId;
  const url = fid
    ? `/api/projects/${state.selected.id}/frames/${encodeURIComponent(fid)}/raw-html`
    : `/api/projects/${state.selected.id}/raw-html`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function refreshTextFields() {
  if (!state.selected) {
    state.textFields = [];
    renderTextFields();
    return;
  }
  // We used to gate this on a templateId, but frames-mode projects are
  // template-free and still have hv-text fields worth showing.
  const html = await fetchActiveFrameHtml();
  if (!html) {
    state.textFields = [];
    renderTextFields();
    return;
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('[data-hv-text]');
  const seen = new Set();
  const fields = [];
  for (const el of nodes) {
    const key = el.getAttribute('data-hv-text');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const text = el.textContent ?? '';
    fields.push({ key, original: text, current: text });
  }
  state.textFields = fields;
  renderTextFields();
}

function renderTextFields() {
  const wrap = document.getElementById('text-fields');
  if (!wrap) return;
  if (!state.selected) {
    wrap.innerHTML = `<div class="text-empty">${t('text_pane.no_project')}</div>`;
    return;
  }
  if (state.textFields.length === 0) {
    const hasFrames = (state.selected.frames?.length ?? 0) > 0;
    const hint = hasFrames ? t('text_pane.empty_with_frames') : t('text_pane.empty_no_frames');
    wrap.innerHTML = `<div class="text-empty">${hint}</div>`;
    return;
  }
  // Always render as textarea — agent decides text length, no hard cap.
  wrap.innerHTML = state.textFields.map((f, i) => {
    const labelKey = humanizeKey(f.key);
    return `<div class="text-field">
      <div class="key">${esc(labelKey)}<span class="badge">${esc(f.key)}</span></div>
      <textarea data-i="${i}" rows="1" placeholder="(empty)">${esc(f.current)}</textarea>
    </div>`;
  }).join('');
  wrap.querySelectorAll('textarea[data-i]').forEach((el) => {
    autoResize(el);
    el.addEventListener('input', (e) => {
      const i = Number(e.target.dataset.i);
      state.textFields[i].current = e.target.value;
      autoResize(el);
      scheduleTextSave();
    });
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px';
}

const TEXT_FIELD_LABELS_ZH = {
  company_tagline: '公司标语',
  brand_name: '品牌名称',
  brand_mark: '品牌标识',
  cover_eyebrow: '封面眉标题',
  cover_title: '封面标题',
  cover_subtitle: '封面副标题',
  cover_caption: '封面说明',
  cover_meta_left: '封面左侧提示',
  cover_meta_right: '封面右侧提示',
  about_eyebrow: '关于我们眉标题',
  about_title: '关于我们标题',
  about_desc: '关于我们介绍',
  stat_year: '成立年份',
  stat_year_label: '成立年份标签',
  stat_clients: '客户数量',
  stat_clients_label: '客户数量标签',
  stat_projects: '项目数量',
  stat_projects_label: '项目数量标签',
  stat_users: '用户数量',
  stat_users_label: '用户数量标签',
  cta_title: '行动引导标题',
  cta_desc: '行动引导说明',
  cta_button: '行动按钮',
  scroll_hint: '滚动提示',
  contact_title: '联系标题',
  contact_desc: '联系说明',
  contact_phone: '联系电话',
  contact_email: '联系邮箱',
  contact_wechat: '联系微信',
  headline: '主标题',
  subheadline: '副标题',
  tagline: '标语',
  title: '标题',
  subtitle: '副标题',
  caption: '说明文字',
  description: '描述',
  eyebrow: '眉标题',
  body: '正文',
  section_label_1: '第 1 组标签',
  section_label_2: '第 2 组标签',
  section_label_3: '第 3 组标签',
  strength_title: '实力标题',
  strength_desc: '实力介绍',
  metric_1_num: '数据 1 数值',
  metric_1_label: '数据 1 标签',
  metric_2_num: '数据 2 数值',
  metric_2_label: '数据 2 标签',
  metric_3_num: '数据 3 数值',
  metric_3_label: '数据 3 标签',
};

const TEXT_FIELD_TOKEN_LABELS_ZH = {
  about: '关于我们',
  audience: '受众',
  body: '正文',
  brand: '品牌',
  button: '按钮',
  caption: '说明',
  clients: '客户',
  closing: '结尾',
  company: '公司',
  contact: '联系',
  cover: '封面',
  cta: '行动引导',
  desc: '介绍',
  description: '描述',
  email: '邮箱',
  eyebrow: '眉标题',
  feature: '亮点',
  headline: '主标题',
  intro: '介绍',
  item: '条目',
  label: '标签',
  left: '左侧',
  logo: 'Logo',
  mark: '标识',
  meta: '提示',
  metric: '数据',
  name: '名称',
  page: '页面',
  phone: '电话',
  product: '产品',
  projects: '项目',
  right: '右侧',
  scroll: '滚动',
  section: '区块',
  stat: '数据',
  strength: '实力',
  subtitle: '副标题',
  tagline: '标语',
  title: '标题',
  users: '用户',
  wechat: '微信',
  year: '年份',
};

function humanizeKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  if (TEXT_FIELD_LABELS_ZH[raw]) return TEXT_FIELD_LABELS_ZH[raw];

  const pageMatch = raw.match(/^page_(\d+)_(.+)$/);
  if (pageMatch) {
    const pageNo = String(Number(pageMatch[1]));
    return `第 ${pageNo} 页${humanizeKey(pageMatch[2])}`;
  }

  const parts = raw.split(/[_\s-]+/).filter(Boolean);
  const translated = parts.map((part) => {
    if (/^\d+$/.test(part)) return Number(part).toString();
    return TEXT_FIELD_TOKEN_LABELS_ZH[part] || part;
  });
  return translated.join('');
}

function scheduleTextSave() {
  clearTimeout(state.textSaveTimer);
  setSaveState('typing…');
  state.textSaveTimer = setTimeout(commitTextEdits, 500);
}

function setSaveState(text, kind = '') {
  const el = document.getElementById('text-save-state');
  if (el) {
    el.textContent = text;
    el.className = 'save-state ' + kind;
  }
}

async function commitTextEdits() {
  if (!state.selected) return;
  const dirty = state.textFields.filter((f) => f.current !== f.original);
  if (dirty.length === 0) {
    setSaveState('—');
    return;
  }
  setSaveState('saving…', 'saving');
  // Read the SAME source we'll write back to — the active frame's HTML
  // when there is one, otherwise the whole-project preview.
  const html = await fetchActiveFrameHtml();
  if (!html) { setSaveState('error', 'error'); return; }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const f of state.textFields) {
    const nodes = doc.querySelectorAll(`[data-hv-text="${cssEscape(f.key)}"]`);
    nodes.forEach((n) => { n.textContent = f.current; });
    f.original = f.current;
  }
  // Serialize back: include doctype because DOMParser drops it
  const serialized = '<!doctype html>\n' + doc.documentElement.outerHTML;
  const fid = state.activeFrameId;
  const url = fid
    ? `/api/projects/${state.selected.id}/frames/${encodeURIComponent(fid)}/raw-html`
    : `/api/projects/${state.selected.id}/raw-html`;
  let r;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: serialized }),
    });
    r = await res.json();
  } catch (e) {
    setSaveState('error: ' + (e?.message ?? e), 'error');
    return;
  }
  if (r?.error) {
    setSaveState('error: ' + r.error, 'error');
    return;
  }
  // Refresh project so frames-strip thumbnails cache-bust.
  if (fid) {
    try {
      const pr = await API.getProject(state.selected.id);
      state.selected = pr.project;
      renderFramesStrip();
    } catch {}
  } else if (r?.project) {
    state.selected = r.project;
  }
  setSaveState('saved', 'saved');
  reloadPreview();
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// ============== send message ==============
async function sendMessage() {
  if (state.composing || !state.selected) return;
  const ta = document.getElementById('composer-input');
  const text = ta.value.trim();
  const hasAttachments = state.pendingAttachments.length > 0;
  if (!text && !hasAttachments) return;

  // Intent shortcut: if the message is a clear "export to MP4" command
  // and there's something to export, run the export flow directly
  // instead of routing through the agent. The agent has nothing useful
  // to add for a deterministic export action.
  const p = state.selected;
  const canExport = !!(p && hasProjectPreview(p));
  if (canExport && !hasAttachments && isExportIntent(text)) {
    ta.value = '';
    state.messages.push({ role: 'user', content: text, ts: Date.now() });
    renderChatLog();
    startExportStream();
    return;
  }

  ta.value = '';
  state.composing = true;
  // The project this send belongs to — used to ignore late events / not clobber
  // a different project if the user switches away mid-generation.
  const genProjectId = state.selectedId;
  renderComposer();
  updateGenerationControls();

  // Iterate scope: when the user has selected a specific frame in the
  // strip, the iterate-phase server route should only rewrite that frame.
  // We pass the focus along on every send (server uses it only for iterate).
  const focusFrame = state.iterateFocusFrameId || '';

  // User message includes attachment summary + focus chip
  const attSummary = hasAttachments
    ? `\n\n📎 ${state.pendingAttachments.length} attachment(s): ${state.pendingAttachments.map(a => a.name).join(', ')}`
    : '';
  const focusSummary = focusFrame ? `\n\n🎯 focus: frame ${focusFrame}` : '';
  state.messages.push({
    role: 'user',
    content: text + attSummary + focusSummary,
    ts: Date.now(),
    ...(focusFrame ? { focusFrameId: focusFrame } : {}),
  });
  state.messages.push({ role: 'thinking', content: t('chat.thinking'), ts: Date.now() });
  const thinkingIdx = state.messages.length - 1;
  renderChatLog();

  let assistantIdx = -1;

  try {
    let res;
    if (hasAttachments) {
      const fd = new FormData();
      fd.append('content', text);
      if (focusFrame) fd.append('focus_frame_id', focusFrame);
      for (const a of state.pendingAttachments) fd.append('file', a.file, a.name);
      // Clear UI attachments before request so user sees them disappear
      state.pendingAttachments = [];
      renderAttachments();
      res = await fetch(`/api/projects/${state.selected.id}/messages`, {
        method: 'POST',
        body: fd,
      });
    } else {
      res = await fetch(`/api/projects/${state.selected.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: text,
          ...(focusFrame ? { focus_frame_id: focusFrame } : {}),
        }),
      });
    }
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      state.messages[thinkingIdx] = { role: 'system', content: '⚠️ ' + (err.error ?? 'agent failed'), ts: Date.now() };
      renderChatLog();
    } else {
      if (hasAttachments) {
        refreshProjectAssets(genProjectId);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // If the user switches away mid-generation, stop rendering its events into
      // the (now different) active project — the backend keeps running and
      // persists the result, so it's there when they switch back.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (state.selectedId !== genProjectId) { try { await reader.cancel(); } catch {} break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'text') {
            if (assistantIdx === -1) {
              // Replace thinking with assistant message
              state.messages[thinkingIdx] = { role: 'assistant', agent: 'AI助手', content: '', ts: Date.now() };
              assistantIdx = thinkingIdx;
            }
            state.messages[assistantIdx].content += ev.chunk;
            renderChatLog();
          } else if (ev.type === 'preview_ready') {
            const frameCount = ev.frames || 0;
            const focusedFrame = ev.focused_frame;
            const summary = focusedFrame
              ? '✓ 已更新选中页面'
              : frameCount > 0
                ? `✓ 已生成 ${frameCount} 页预览`
                : '✓ 预览已更新';
            const event = focusedFrame
              ? '预览已刷新'
              : frameCount > 0
                ? `预览已刷新（${frameCount} 页）`
                : '预览已刷新';
            if (assistantIdx === -1) {
              state.messages[thinkingIdx] = { role: 'assistant', agent: 'AI助手', content: summary, ts: Date.now() };
              assistantIdx = thinkingIdx;
            } else {
              state.messages[assistantIdx].content = summary;
            }
            state.messages.push({ role: 'preview-event', content: event, ts: Date.now() });
            renderChatLog();
            // Multi-frame turn replaces frames[]; reset active frame so the
            // first frame becomes the default again.
            if (frameCount > 0) state.activeFrameId = null;
            const pr = await API.getProject(state.selected.id);
            state.selected = pr.project;
            // Generating in-place writes a fresh content-graph, so the node→kind
            // map must be rebuilt — otherwise data frames don't get their ⚡
            // Remotion badge until the user switches projects and back.
            if (frameCount > 0) {
              state.frameKinds = {};
              try {
                const cg = await API.contentGraph(state.selected.id);
                if (cg?.graph?.nodes) for (const n of cg.graph.nodes) state.frameKinds[n.id] = n.kind;
              } catch { /* no graph — single-frame, fine */ }
            }
            renderPreview(); // also re-syncs soundtrack buttons via __hvSyncNarration
            await refreshTextFields();
            renderToolbar();
            renderFooter();
            updateGenerationControls();
          } else if (ev.type === 'warning') {
            if (assistantIdx === -1) {
              state.messages[thinkingIdx] = { role: 'assistant', agent: 'AI助手', content: '', ts: Date.now() };
              assistantIdx = thinkingIdx;
            }
            state.messages[assistantIdx].content += '\n\n⚠️ ' + ev.message;
            renderChatLog();
          } else if (ev.type === 'error') {
            if (assistantIdx === -1) {
              state.messages[thinkingIdx] = { role: 'system', content: '⚠️ ' + ev.message, ts: Date.now() };
            } else {
              state.messages[assistantIdx].content += '\n\n⚠️ ' + ev.message;
            }
            renderChatLog();
          }
        }
      }
    }
  } catch (e) {
    // Only surface the error if we're still on the project that started this
    // send — otherwise it's just the user having navigated away.
    if (state.selectedId === genProjectId) {
      state.messages[thinkingIdx] = { role: 'system', content: '⚠️ ' + (e.message ?? e), ts: Date.now() };
      renderChatLog();
    }
  }
  // Don't clobber composing if the user already switched to another project
  // (which may have its own generation running).
  if (state.selectedId === genProjectId) {
    state.composing = false;
    renderComposer();
    renderFooter();
    updateGenerationControls();
  }
}

// ============== gallery modal ==============
function openGallery() {
  if (!state.selected) return;
  document.getElementById('gallery-modal').classList.add('show');
  const grid = document.getElementById('gallery');

  // Each card's iframe loads the template's actual entry HTML (`index.html`,
  // dropped under templates/<id>/ so /template-asset/<id>/index.html serves
  // it). The 1920×1080 (or 1080×1920) source is transform-scaled to fit
  // the card via a CSS variable set per-card after layout.
  grid.innerHTML = state.templates.map(t => {
    const sel = state.selected?.templateId === t.id ? ' selected' : '';
    const tags = (t.tags || []).slice(0, 4).map((tg) => `<span class="tag">${esc(tg)}</span>`).join('');
    const portrait = isPortraitTemplate(t);
    const entry = templateEntryPath(t);
    // Poster-mode templates (entry only stitches sub-comps via
    // data-composition-src) iframe-render blank until the HF player ships —
    // show the shipped poster instead. Falls back to the iframe when the
    // backend couldn't find a poster file (poster_url null).
    const inner =
      t.preview_mode === 'poster' && t.poster_url
        ? `<img class="poster" src="${esc(t.poster_url)}" alt="${esc(t.name ?? t.id)}" loading="lazy" />`
        : `<iframe sandbox="allow-scripts allow-same-origin" src="/template-asset/${esc(t.id)}/${esc(entry)}" loading="lazy"></iframe>`;
    return `<div class="gallery-card${sel}" data-id="${t.id}">
      <div class="preview ${portrait ? 'portrait' : ''}" data-portrait="${portrait}">
        ${inner}
      </div>
      <div class="meta">
        <div class="name">${esc(t.name)}</div>
        <div class="desc">${esc(t.description ?? '')}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>`;
  }).join('');

  // Click → open the fullscreen preview modal so the user can confirm
  // before applying. Replaces the old "click immediately replaces template"
  // behaviour, which never let the user actually see the candidate first.
  grid.querySelectorAll('.gallery-card').forEach(card => {
    card.onclick = () => {
      const tid = card.dataset.id;
      const tpl = state.templates.find((x) => x.id === tid);
      if (tpl) openTemplatePreviewModal(tpl);
    };
  });

  // Resize observer recomputes --gallery-scale per card so 1920×1080 fits
  // the actual rendered card width.
  setTimeout(() => applyGalleryScales(grid), 0);
  if (galleryResizeObserver) galleryResizeObserver.disconnect();
  galleryResizeObserver = new ResizeObserver(() => applyGalleryScales(grid));
  grid.querySelectorAll('.gallery-card .preview').forEach((p) => galleryResizeObserver.observe(p));
}

function renderTemplateGrid(grid) {
  if (!grid) return;
  grid.innerHTML = state.templates.map((tpl) => templateCardHtml(tpl)).join('');
  grid.querySelectorAll('.gallery-card').forEach((card) => {
    card.onclick = () => {
      const tid = card.dataset.id;
      const tpl = state.templates.find((x) => x.id === tid);
      if (tpl) openTemplatePreviewModal(tpl);
    };
  });
  setTimeout(() => applyGalleryScales(grid), 0);
  if (galleryResizeObserver) galleryResizeObserver.disconnect();
  galleryResizeObserver = new ResizeObserver(() => applyGalleryScales(grid));
  grid.querySelectorAll('.gallery-card .preview').forEach((p) => galleryResizeObserver.observe(p));
}

function templateCardHtml(t) {
  const sel = state.selected?.templateId === t.id ? ' selected' : '';
  const tags = (t.tags || []).slice(0, 4).map((tg) => `<span class="tag">${esc(tg)}</span>`).join('');
  const portrait = isPortraitTemplate(t);
  const entry = templateEntryPath(t);
  const inner =
    t.preview_mode === 'poster' && t.poster_url
      ? `<img class="poster" src="${esc(t.poster_url)}" alt="${esc(t.name ?? t.id)}" loading="lazy" />`
      : `<iframe sandbox="allow-scripts allow-same-origin" src="/template-asset/${esc(t.id)}/${esc(entry)}" loading="lazy"></iframe>`;
  return `<div class="gallery-card${sel}" data-id="${esc(t.id)}">
    <div class="preview ${portrait ? 'portrait' : ''}" data-portrait="${portrait}">
      ${inner}
    </div>
    <div class="meta">
      <div class="name">${esc(t.name)}</div>
      <div class="desc">${esc(t.description ?? '')}</div>
      <div class="tags">${tags}</div>
    </div>
  </div>`;
}

let galleryResizeObserver = null;
function applyGalleryScales(grid) {
  grid.querySelectorAll('.gallery-card .preview').forEach((p) => {
    const w = p.clientWidth;
    if (!w) return;
    const portrait = p.dataset.portrait === 'true';
    // Landscape fills the 16:9 box by width. Portrait keeps the same 16:9
    // box but is scaled to fit the box HEIGHT (1080×1920 → fit by height,
    // centred), so its card stays the same height as the rest of the grid.
    const scale = portrait ? p.clientHeight / 1920 : w / 1920;
    p.style.setProperty('--gallery-scale', scale.toFixed(4));
  });
}

function isPortraitTemplate(t) {
  const aspects = t?.output?.resolution?.supported_aspects ?? [];
  return aspects.includes('9:16') && !aspects.includes('16:9');
}

function templateEntryPath(t) {
  // The template's entry HTML is declared as `source_entry` in its
  // template.html-video.yaml — some templates use `source/index.html`,
  // others a top-level `index.html`. The /api/templates response now
  // surfaces this field; fall back to `index.html` only if it's missing.
  const entry = t?.source_entry;
  return typeof entry === 'string' && entry ? entry : 'index.html';
}

function closeGallery() {
  document.getElementById('gallery-modal').classList.remove('show');
  if (galleryResizeObserver) {
    galleryResizeObserver.disconnect();
    galleryResizeObserver = null;
  }
}

// ============== Template fullscreen preview ==============
let _tplPreviewResizeObserver = null;
let _tplPreviewCurrent = null;
function openTemplatePreviewModal(tpl) {
  _tplPreviewCurrent = tpl;
  const modal = document.getElementById('tpl-preview-modal');
  if (!modal) return;
  modal.classList.add('show');

  document.getElementById('tpl-preview-name').textContent = tpl.name ?? tpl.id;
  document.getElementById('tpl-preview-desc').textContent = tpl.description ?? '';
  const dur = tpl?.output?.duration?.default_sec ?? tpl?.output?.duration?.max_sec ?? '?';
  const fps = tpl?.output?.fps?.default ?? '?';
  const aspect = (tpl?.output?.resolution?.supported_aspects ?? [])[0] ?? '16:9';
  document.getElementById('tpl-preview-meta').textContent = t('tpl_preview.fps_dur', {
    fps, duration: dur, aspect,
  });

  renderTemplateSource(tpl);

  const frame = document.getElementById('tpl-preview-frame');
  const portrait = isPortraitTemplate(tpl);
  frame.classList.toggle('portrait', portrait);

  const iframe = document.getElementById('tpl-preview-iframe');
  const poster = document.getElementById('tpl-preview-poster');
  const entry = templateEntryPath(tpl);
  // Poster-mode templates render blank in a live iframe (need the unbuilt HF
  // player) — show the shipped poster instead. Fall back to the iframe if the
  // backend reported no poster file (poster_url null).
  const usePoster = tpl.preview_mode === 'poster' && tpl.poster_url;
  if (usePoster) {
    iframe.src = 'about:blank';
    iframe.hidden = true;
    poster.src = `${tpl.poster_url}?t=${Date.now()}`;
    poster.hidden = false;
  } else {
    poster.src = '';
    poster.hidden = true;
    iframe.hidden = false;
    iframe.src = `/template-asset/${encodeURIComponent(tpl.id)}/${entry}?t=${Date.now()}`;
  }

  const apply = () => {
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    if (!w || !h) return;
    const baseW = portrait ? 1080 : 1920;
    const baseH = portrait ? 1920 : 1080;
    const s = Math.min(w / baseW, h / baseH);
    frame.style.setProperty('--tpl-preview-scale', s.toFixed(4));
  };
  apply();
  if (_tplPreviewResizeObserver) _tplPreviewResizeObserver.disconnect();
  _tplPreviewResizeObserver = new ResizeObserver(apply);
  _tplPreviewResizeObserver.observe(frame);

  const useBtn = document.getElementById('tpl-preview-use');
  const cancelBtn = document.getElementById('tpl-preview-cancel');
  const closeBtn = document.getElementById('tpl-preview-close');

  // If the project already has this template applied, downgrade the primary
  // action to a no-op "in use" label so the user doesn't reapply needlessly.
  const isCurrent = state.selected?.templateId === tpl.id;
  useBtn.textContent = !state.selected
    ? '新建项目并使用'
    : isCurrent
      ? t('settings.agent.in_use')
      : t('tpl_preview.use');
  useBtn.disabled = isCurrent;

  useBtn.onclick = async () => {
    let projectId = state.selected?.id ?? '';
    if (!projectId) {
      const r = await API.createProject({ name: tpl.name ?? 'Untitled' });
      if (!r?.project?.id) return;
      projectId = r.project.id;
      await refreshProjects();
    }
    // If the project already has a different template applied, confirm
    // before replacing — the user may have been just exploring.
    const current = state.selected?.templateId;
    if (current && current !== tpl.id) {
      if (!confirm(t('tpl_preview.replace_confirm', { name: tpl.name ?? tpl.id }))) return;
    }
    useBtn.disabled = true;
    try {
      await API.setTemplate(projectId, tpl.id);
      closeTemplatePreviewModal();
      closeGallery();
      await selectProject(projectId);
      toast(t('tpl_preview.applied', { name: tpl.name ?? tpl.id }), 'success');
    } finally {
      useBtn.disabled = false;
    }
  };
  cancelBtn.onclick = closeTemplatePreviewModal;
  closeBtn.onclick = closeTemplatePreviewModal;
}

// Render the three-layer provenance (RFC-07) for the previewed template so the
// upstream skill, its real author + license, and the original design lineage
// are visible in the studio — not just buried in the template's yaml.
function renderTemplateSource(tpl) {
  const box = document.getElementById('tpl-preview-source');
  if (!box) return;
  const p = tpl.provenance;
  const lic = tpl.license?.spdx;
  if (!p && !lic) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const rows = [];
  const via = p?.via_skill;
  if (via?.name) {
    // "Adapted from <skill link> · <author> · <license>"
    const skill = via.url
      ? `<a href="${esc(via.url)}" target="_blank" rel="noopener">${esc(via.name)}</a>`
      : esc(via.name);
    const bits = [skill];
    if (via.author) bits.push(esc(via.author));
    if (via.license) bits.push(`<span class="lic">${esc(via.license)}</span>`);
    rows.push(`<div class="row"><span class="lbl">${esc(t('tpl_preview.source_skill'))}</span><span class="val">${bits.join(' · ')}</span></div>`);
  }
  const origin = p?.origin;
  if (origin?.name && origin.name.toLowerCase() !== 'none') {
    rows.push(`<div class="row"><span class="lbl">${esc(t('tpl_preview.source_origin'))}</span><span class="val">${esc(origin.name)}</span></div>`);
  }
  // License row only stands alone when it wasn't already shown next to the skill.
  if (lic && !via?.license) {
    rows.push(`<div class="row"><span class="lbl">${esc(t('tpl_preview.source_license'))}</span><span class="val"><span class="lic">${esc(lic)}</span></span></div>`);
  }
  if (!rows.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.innerHTML = rows.join('');
  box.hidden = false;
}

function closeTemplatePreviewModal() {
  const modal = document.getElementById('tpl-preview-modal');
  if (modal) modal.classList.remove('show');
  if (_tplPreviewResizeObserver) {
    _tplPreviewResizeObserver.disconnect();
    _tplPreviewResizeObserver = null;
  }
  // Stop the iframe from continuing to play in the background.
  const iframe = document.getElementById('tpl-preview-iframe');
  if (iframe) iframe.src = 'about:blank';
  const poster = document.getElementById('tpl-preview-poster');
  if (poster) { poster.src = ''; poster.hidden = true; }
  _tplPreviewCurrent = null;
}

// ============== new-project modal ==============
function openNewModal() {
  document.getElementById('new-modal').classList.add('show');
  document.getElementById('new-name').focus();
}
function closeNewModal() {
  document.getElementById('new-modal').classList.remove('show');
  document.getElementById('new-name').value = '';
  document.getElementById('new-intent').value = '';
}

function wireModals() {
  document.getElementById('new-cancel').onclick = closeNewModal;
  document.getElementById('new-ok').onclick = async () => {
    const name = document.getElementById('new-name').value.trim();
    const intent = document.getElementById('new-intent').value.trim();
    if (!name) { toast(t('modal.new.name_required'), 'error'); return; }
    const r = await API.createProject({ name, ...(intent && { intent }) });
    closeNewModal();
    await refreshProjects();
    await selectProject(r.project.id);
    toast(t('modal.new.created', { name }), 'success');
  };
  document.getElementById('new-modal').addEventListener('click', e => {
    if (e.target.id === 'new-modal') closeNewModal();
  });
  document.getElementById('gallery-close').onclick = closeGallery;
  document.getElementById('gallery-modal').addEventListener('click', e => {
    if (e.target.id === 'gallery-modal') closeGallery();
  });
  const styleModal = document.getElementById('generation-style-modal');
  if (styleModal) {
    document.getElementById('generation-style-close').onclick = closeGenerationStyleModal;
    styleModal.addEventListener('click', (e) => {
      if (e.target.id === 'generation-style-modal') closeGenerationStyleModal();
    });
  }
  const pagesModal = document.getElementById('generation-pages-modal');
  if (pagesModal) {
    document.getElementById('generation-pages-close').onclick = closeGenerationPagesModal;
    document.getElementById('generation-pages-custom-ok').onclick = async () => {
      const value = Number(document.getElementById('generation-pages-custom')?.value || 0);
      if (!Number.isFinite(value) || value < 1) {
        toast('请输入有效页数', 'error');
        return;
      }
      closeGenerationPagesModal();
      await sendGenerationPageAdjust(`${Math.round(value)} 页`);
    };
    pagesModal.addEventListener('click', (e) => {
      if (e.target.id === 'generation-pages-modal') closeGenerationPagesModal();
    });
  }
  // Settings
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal) {
    document.getElementById('settings-close').onclick = closeSettingsModal;
    settingsModal.addEventListener('click', (e) => {
      if (e.target.id === 'settings-modal') closeSettingsModal();
    });
    settingsModal.querySelectorAll('.settings-nav-item').forEach((btn) => {
      btn.onclick = () => {
        settingsModal.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderSettingsPanel(btn.dataset.settingsTab);
      };
    });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeNewModal();
      closeGallery();
      closeSettingsModal();
    }
  });
}

// ============== Settings modal ==============
// Real brand logos (SVG, copied from open-design/agent-icons). Served from
// /agent-icons/<id>.svg. Agents without a brand logo fall back to a glyph.
const AGENT_LOGOS = {
  'anthropic-api': '/agent-icons/anthropic.svg',
  'claude': '/agent-icons/claude.svg',
  'cursor-agent': '/agent-icons/cursor-agent.svg',
  'codex': '/agent-icons/codex.svg',
  'hermes': '/agent-icons/hermes.svg',
  'amr': '/agent-icons/amr.svg',
  'gemini': '/agent-icons/gemini.svg',
  'grok': '/agent-icons/grok.svg',
  'qwen': '/agent-icons/qwen.svg',
  'opencode': '/agent-icons/opencode.svg',
  'copilot': '/agent-icons/copilot.svg',
  'aider': '/agent-icons/aider.png',
  'qoder-cli': '/agent-icons/qoder.svg',
};
const AGENT_ICON_FALLBACK = {
  'anthropic-api': '☁️',
};
function agentIconHtml(id) {
  const logo = AGENT_LOGOS[id];
  if (logo) return `<img src="${esc(logo)}" alt="" class="agent-logo" />`;
  return AGENT_ICON_FALLBACK[id] || '⚙️';
}
const AGENT_DESC = {
  'anthropic-api': 'Direct Messages API · streams reliably',
  'claude': 'Claude Code (claude --print)',
  'cursor-agent': 'Cursor command line',
  'codex': 'Codex CLI (codex exec)',
  'hermes': 'Hermes ACP CLI',
  'qoder-cli': 'Qoder CLI (qodercli -p)',
  'pi-agent': 'Pi Coding Agent (pi -p)',
};

function openSettingsModal(tab = 'agent') {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.add('show');
  modal.querySelectorAll('.settings-nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.settingsTab === tab);
  });
  renderSettingsPanel(tab);
}
function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.remove('show');
}

function renderSettingsPanel(tab) {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;
  if (tab === 'audio') return renderSettingsAudio(panel);
  if (tab === 'language') return renderSettingsLanguage(panel);
  if (tab === 'about') return renderSettingsAbout(panel);
  return renderSettingsAgent(panel);
}

async function renderSettingsAudio(panel) {
  panel.innerHTML = `
    <h3>${esc(t('settings.audio.title'))}</h3>
    <div class="panel-sub">${esc(t('settings.audio.subtitle'))}</div>
    <div class="audio-config" id="audio-config">
      <div class="audio-status" id="audio-status">${esc(t('settings.audio.loading'))}</div>
      <label class="audio-field">
        <span>${esc(t('settings.audio.api_key'))}</span>
        <input type="password" id="mm-api-key" placeholder="${esc(t('settings.audio.api_key_placeholder'))}" autocomplete="off" />
      </label>
      <label class="audio-field">
        <span>${esc(t('settings.audio.region'))}</span>
        <div class="audio-region" id="mm-region">
          <button type="button" class="st-preset" data-url="https://api.minimax.io/v1">${esc(t('settings.audio.region_intl'))}</button>
          <button type="button" class="st-preset" data-url="https://api.minimaxi.com/v1">${esc(t('settings.audio.region_cn'))}</button>
        </div>
      </label>
      <label class="audio-field">
        <span>${esc(t('settings.audio.base_url'))}</span>
        <input type="text" id="mm-base-url" placeholder="https://api.minimax.io/v1" autocomplete="off" />
      </label>
      <div class="audio-actions">
        <button class="audio-save primary-action" id="mm-save" style="background:var(--accent);border-color:var(--accent);color:var(--accent-fg)">${esc(t('settings.audio.save'))}</button>
        <button class="audio-clear" id="mm-clear">${esc(t('settings.audio.clear'))}</button>
        <span class="audio-save-state" id="mm-save-state"></span>
      </div>
      <p class="panel-sub" style="font-size:11.5px;margin-top:4px">${esc(t('settings.audio.hint'))}</p>
    </div>
  `;

  const statusEl = panel.querySelector('#audio-status');
  const keyInput = panel.querySelector('#mm-api-key');
  const baseInput = panel.querySelector('#mm-base-url');
  const saveState = panel.querySelector('#mm-save-state');

  const refresh = async () => {
    try {
      const s = await fetch('/api/config/minimax').then((r) => r.json());
      if (s.configured) {
        const src = s.source === 'env' ? t('settings.audio.source_env') : t('settings.audio.source_config');
        statusEl.innerHTML = `<span class="agent-status-dot ok"></span>${esc(t('settings.audio.configured', { key: s.maskedKey, source: src }))}`;
        if (s.baseUrl) baseInput.value = s.baseUrl;
      } else {
        statusEl.innerHTML = `<span class="agent-status-dot missing"></span>${esc(t('settings.audio.not_configured'))}`;
      }
    } catch {
      statusEl.textContent = t('settings.audio.not_configured');
    }
  };
  await refresh();

  // Region quick-pick: fills the Base URL with the correct regional endpoint.
  // MiniMax keys are region-bound (an api.minimax.io key won't auth against
  // api.minimaxi.com and vice-versa), so picking the wrong region is the #1
  // cause of voiceover failures (issue #4).
  panel.querySelectorAll('#mm-region .st-preset').forEach((btn) => {
    btn.onclick = () => {
      baseInput.value = btn.dataset.url;
      panel.querySelectorAll('#mm-region .st-preset').forEach((b) => b.classList.toggle('active', b === btn));
    };
  });

  panel.querySelector('#mm-save').onclick = async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) { saveState.textContent = t('settings.audio.need_key'); return; }
    saveState.textContent = t('settings.audio.saving');
    try {
      const r = await fetch('/api/config/minimax', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, baseUrl: baseInput.value.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      keyInput.value = '';
      saveState.textContent = t('settings.audio.saved');
      await refresh();
    } catch (e) {
      saveState.textContent = t('settings.audio.save_failed', { message: (e?.message ?? e) });
    }
  };

  panel.querySelector('#mm-clear').onclick = async () => {
    await fetch('/api/config/minimax', { method: 'DELETE' });
    keyInput.value = '';
    baseInput.value = '';
    saveState.textContent = '';
    await refresh();
  };
}

function renderSettingsAgent(panel) {
  const agents = state.agents ?? [];
  const list = agents.filter((a) => a.id === 'pi-agent');
  const currentId = 'pi-agent';

  panel.innerHTML = `
    <h3>${esc(t('settings.agent.title'))}</h3>
    <div class="panel-sub">${esc(t('settings.agent.subtitle'))}</div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:.08em;text-transform:uppercase">
        ${esc(t('settings.agent.detected', { count: list.length }))}
      </div>
      <button class="btn-rescan" style="background:transparent;border:1px solid var(--border);color:var(--text-muted);padding:5px 10px;border-radius:var(--radius-sm);cursor:pointer;font-size:11px;font-family:var(--font-mono)">
        ${esc(t('settings.agent.rescan'))}
      </button>
    </div>

    <div class="agent-list">
      ${list.map((a) => {
        const isCurrent = a.id === currentId && a.available;
        const desc = AGENT_DESC[a.id] || (a.bin ?? '');
        const ver = a.version ? esc(a.version) : (a.available ? '' : esc(t('settings.agent.unavailable')));
        const icon = agentIconHtml(a.id);
        return `<div class="agent-card ${isCurrent ? 'selected' : ''}" data-agent-id="${esc(a.id)}">
          <div class="agent-icon">${icon}</div>
          <div class="agent-meta">
            <div class="agent-name">
              <span class="agent-status-dot ${a.available ? 'ok' : 'missing'}"></span>${esc(a.name)}
            </div>
            <div class="agent-desc">${esc(desc)}</div>
            ${ver ? `<div class="agent-version">${ver}</div>` : ''}
          </div>
          <div class="agent-actions">
            ${a.available ? `<button data-act="test">${esc(t('settings.agent.test'))}</button>` : ''}
            ${a.available
              ? `<span style="font-size:11px;color:var(--accent);font-family:var(--font-mono)">${esc(t('settings.agent.in_use'))}</span>`
              : (a.installUrl ? `<a href="${a.installUrl}" target="_blank" rel="noopener" style="font-size:11px;color:var(--text-faint)">install ↗</a>` : '')}
          </div>
          <div class="agent-test-result" data-test-result="${esc(a.id)}" style="display:none;grid-column:1 / -1"></div>
        </div>`;
      }).join('')}
    </div>
  `;

  panel.querySelectorAll('.btn-rescan').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const r = await API.rescanAgents();
        state.agents = r.agents ?? state.agents;
        renderSettingsAgent(panel);
        toast(t('settings.agent.rescanned'), 'success');
      } finally {
        btn.disabled = false;
      }
    };
  });
  panel.querySelectorAll('.agent-card [data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const card = btn.closest('.agent-card');
      const aid = card.dataset.agentId;
      const act = btn.dataset.act;
      if (act === 'test') {
        const result = panel.querySelector(`[data-test-result="${aid}"]`);
        result.style.display = 'block';
        result.className = 'agent-test-result';
        result.textContent = t('settings.agent.testing');
        btn.disabled = true;
        try {
          const r = await API.testAgent(aid);
          if (r.ok) {
            result.classList.add('ok');
            result.textContent = t('settings.agent.test_ok', { ms: r.ms, bytes: r.bytes })
              + (r.stdout_head ? ` — ${r.stdout_head.slice(0, 60).replace(/\n/g, ' ')}` : '');
          } else {
            result.classList.add('error');
            result.textContent = t('settings.agent.test_fail', { message: r.error || `exit ${r.exit_code}` });
          }
        } catch (e) {
          result.classList.add('error');
          result.textContent = t('settings.agent.test_fail', { message: e?.message ?? String(e) });
        } finally {
          btn.disabled = false;
        }
      }
    };
  });
}

function renderSettingsLanguage(panel) {
  const cur = getLocale();
  panel.innerHTML = `
    <h3>${esc(t('settings.language.title'))}</h3>
    <div class="panel-sub">${esc(t('settings.language.subtitle'))}</div>
    <div class="lang-options">
      <button data-lang="en" class="${cur === 'en' ? 'active' : ''}">
        <div class="lang-name">${esc(t('settings.language.en'))}</div>
        <div class="lang-sub">${esc(t('settings.language.en_sub'))}</div>
      </button>
      <button data-lang="zh" class="${cur === 'zh' ? 'active' : ''}">
        <div class="lang-name">${esc(t('settings.language.zh'))}</div>
        <div class="lang-sub">${esc(t('settings.language.zh_sub'))}</div>
      </button>
    </div>
  `;
  panel.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.onclick = () => {
      setLocale(btn.dataset.lang);
      // re-render this panel itself with the new locale
      renderSettingsLanguage(panel);
    };
  });
}

function renderSettingsAbout(panel) {
  panel.innerHTML = `
    <h3>${esc(t('settings.about.title'))}</h3>
    <div class="panel-sub">${esc(t('settings.about.subtitle'))}</div>
    <div class="about-block">
      <div class="about-line"><span class="k">${esc(t('settings.about.version'))}</span><span class="v">studio · v0.7</span></div>
      <div class="about-line"><span class="k">${esc(t('settings.about.repo'))}</span><span class="v"><a href="https://github.com/nexu-io/html-video" target="_blank" rel="noopener">github.com/nexu-io/html-video</a></span></div>
      <div class="about-line"><span class="k">${esc(t('settings.about.discord'))}</span><span class="v"><a href="https://discord.com/invite/keeVPMrueT" target="_blank" rel="noopener">discord.com/invite/keeVPMrueT</a></span></div>
      <div class="about-line"><span class="k">${esc(t('settings.about.license'))}</span><span class="v">Apache-2.0</span></div>
      <div class="about-line"><span class="k">${esc(t('settings.about.related'))}</span><span class="v"><a href="https://github.com/nexu-io/open-design" target="_blank" rel="noopener">Open Design</a></span></div>
    </div>
  `;
}

// ============== utils ==============
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  setTimeout(() => t.classList.remove('show'), 2500);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

window.addEventListener('error', (e) => {
  console.error('[hv-studio] uncaught:', e.error || e.message);
  try { toast(`错误：${e.error?.message || e.message}`, 'error'); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[hv-studio] unhandled rejection:', e.reason);
  try { toast(`错误：${e.reason?.message || e.reason}`, 'error'); } catch {}
});
init().catch((e) => {
  console.error('[hv-studio] init failed:', e);
  try { toast(`init 失败：${e.message}`, 'error'); } catch {}
});

