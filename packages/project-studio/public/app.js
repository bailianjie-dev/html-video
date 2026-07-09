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
  composing: false,
  textFields: [],          // [{key, original, current}]
  textSaveTimer: null,
  pendingAttachments: [],  // [{file, dataUrl?, name, kind, size}] before send
  // v0.8: multi-frame timeline state
  activeFrameId: null,     // graphNodeId currently shown in iframe
  iterateFocusFrameId: null, // graphNodeId iterations should target only (null = whole video)
  editTextMode: false,     // when true, preview iframe accepts inline text edits
  exporting: false,        // export run in progress
  exportProgress: null,    // { pct, stage } during a streamed export
  lastGraph: null,         // last fetched ContentGraph (for download)
  // Phase C: per-frame native Remotion enhancement
  frameKinds: {},          // { [graphNodeId]: 'entity'|'data'|'text' } for the selected project
  enhancing: null,         // { nodeId, pct, stage } while a single-frame enhance render is in flight
};

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

async function enterStudio(user) {
  state.currentUser = user;
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('studio-app').hidden = false;
  if (studioInitialized) {
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

  renderMain();
}

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
  const passwordInput = document.getElementById('auth-password');
  passwordInput.value = '';
  passwordInput.focus();
}

async function logout() {
  try {
    await API.logout();
  } catch (error) {
    console.warn('logout failed:', error);
  }
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
    return;
  }
  if (!res.ok || !res.body) {
    state.exporting = false;
    state.exportProgress = null;
    const err = await res.text().catch(() => '');
    toast(t('export.failed_short', { message: err.slice(0, 200) }), 'error');
    renderToolbar();
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
        }
      }
    }
  } catch (e) {
    state.exporting = false;
    state.exportProgress = null;
    toast(t('export.stream_interrupted', { message: (e?.message ?? e) }), 'error');
    renderToolbar();
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

async function selectProject(id) {
  state.activePage = 'workspace';
  state.selectedId = id;
  state.selected = (await API.getProject(id)).project;
  state.activeFrameId = null;  // reset frame selection on project switch
  state.iterateFocusFrameId = null;
  state.editTextMode = false;
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
  await refreshTextFields();
}

const NAV_ITEMS = [
  { id: 'create', label: '新建相册', desc: '输入主题生成', icon: 'plus' },
  { id: 'album', label: '图片转相册', desc: '素材生成 HTML', icon: 'image' },
  { id: 'workspace', label: '项目编辑', desc: '预览与导出', icon: 'edit' },
  { id: 'history', label: '历史项目', desc: '管理已生成项目', icon: 'history' },
  { id: 'templates', label: '样例库', desc: '浏览视觉模板', icon: 'templates' },
  { id: 'settings', label: '系统设置', desc: 'Agent 与音频配置', icon: 'settings' },
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
  '活动回顾相册：开场、现场瞬间、嘉宾观点、精彩数据、结束致谢',
  '个人作品集：简介、代表作品、项目故事、能力标签、联系方式',
];

function makeAlbumProjectName(raw) {
  const first = String(raw || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '电子相册';
  return first.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 18) || '电子相册';
}

function buildAlbumPromptFromCreatePage() {
  const pick = (id) => document.getElementById(id)?.value || '';
  const raw = document.getElementById('create-topic-input')?.value.trim() || '';
  const wantsThinking = document.getElementById('btn-create-thinking')?.classList.contains('active');
  const attachmentNote = state.pendingAttachments.length
    ? `\n已上传 ${state.pendingAttachments.length} 个素材，请优先使用这些素材安排画面。`
    : '';
  return `帮我生成一个电子相册。

主题和素材说明：
${raw}

生成要求：
1. 页数：${pick('create-pages')}。
2. 受众：${pick('create-audience')}。
3. 场景：${pick('create-scene')}。
4. 语气：${pick('create-tone')}。
5. 比例：${pick('create-ratio')}。
6. 风格：${pick('create-style')}。
7. 必须是手机端下滑翻页、PC 端点击下一页查看下一页的交互式 HTML 电子相册。
8. 页面文案要适合直接对外展示，整体简洁、科技感、适合宣传。
9. ${wantsThinking ? '请先梳理内容结构，再生成最终 HTML。' : '直接生成最终 HTML。'}${attachmentNote}`;
}

function renderLandingAttachments() {
  const el = document.getElementById('create-attachment-state');
  if (!el) return;
  if (!state.pendingAttachments.length) {
    el.textContent = '未选择素材';
    return;
  }
  const names = state.pendingAttachments.map((a) => a.name).slice(0, 2).join('、');
  el.textContent = `${state.pendingAttachments.length} 个素材：${names}${state.pendingAttachments.length > 2 ? ' 等' : ''}`;
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
        <span>可一次选择多张，系统会按选择顺序生成相册页。</span>
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
  const ratio = document.getElementById('image-album-ratio')?.value || '16:9 横屏';
  const names = state.pendingAttachments.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
  return `请根据我上传的图片生成一个电子相册。

相册标题：${title}
补充说明：${note}

图片顺序：
${names}

生成要求：
1. 必须严格按照上传图片顺序生成页面，第 1 张图片对应第 1 页，第 2 张图片对应第 2 页，以此类推。
2. 每一页以对应图片为主体，搭配一句简短标题和一段不超过 40 字的说明。
3. 风格：${style}。
4. 比例：${ratio}。
5. 生成可独立运行的交互式 HTML 电子相册。
6. 手机端下滑翻页，PC 端点击下一页或使用键盘翻页。
7. 不要编造图片中看不出的具体事实；不确定的内容用中性表达。`;
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
  const btn = document.getElementById('btn-image-album-send');
  if (btn) btn.disabled = true;
  try {
    const title = document.getElementById('image-album-title')?.value.trim() || '图片电子相册';
    const r = await API.createProject({ name: makeAlbumProjectName(title) });
    if (!r?.project) throw new Error('project create failed');
    await refreshProjects();
    try {
      await API.setTemplate(r.project.id, 'album-scroll-story');
    } catch (e) {
      toast(`电子相册模板应用失败：${e?.message ?? e}`, 'error');
    }
    const prompt = buildImageAlbumPrompt();
    await selectProject(r.project.id);
    const input = document.getElementById('composer-input');
    if (input) {
      input.value = prompt;
      await sendMessage();
    }
  } catch (e) {
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
  const btn = document.getElementById('btn-create-send');
  if (btn) btn.disabled = true;
  try {
    const r = await API.createProject({ name: makeAlbumProjectName(raw) });
    if (!r?.project) throw new Error('project create failed');
    await refreshProjects();
    try {
      await API.setTemplate(r.project.id, 'album-scroll-story');
    } catch (e) {
      toast(`电子相册模板应用失败：${e?.message ?? e}`, 'error');
    }
    const prompt = buildAlbumPromptFromCreatePage();
    await selectProject(r.project.id);
    const input = document.getElementById('composer-input');
    if (input) {
      input.value = prompt;
      await sendMessage();
    }
  } catch (e) {
    toast(`创建电子相册失败：${e?.message ?? e}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderCreatePage() {
  return `
    <main class="create-page">
      <section class="create-hero">
        <h2>基于 Agent 的<span>电子相册工具</span></h2>
        <p>输入主题、上传素材，生成可下滑浏览的 HTML 电子相册</p>
      </section>

      <section class="generator-panel">
        <div class="generator-tabs" role="tablist" aria-label="creation mode">
          <button class="active" type="button" id="tab-create-topic">${navIcon('edit')}<span>输入主题</span></button>
        </div>

        <div class="generator-controls">
          <label><span>页数</span><select id="create-pages"><option>5 页</option><option>3 页</option><option>8 页</option><option>10 页</option></select></label>
          <label><span>受众</span><select id="create-audience"><option>大众</option><option>客户</option><option>投资人</option><option>内部团队</option></select></label>
          <label><span>场景</span><select id="create-scene"><option>企业宣传</option><option>产品介绍</option><option>活动回顾</option><option>作品展示</option></select></label>
          <label><span>语气</span><select id="create-tone"><option>温柔</option><option>专业</option><option>活泼</option><option>克制</option></select></label>
          <label><span>比例</span><select id="create-ratio"><option>16:9 横屏</option><option>9:16 竖屏</option><option>1:1 方形</option></select></label>
          <label><span>风格</span><select id="create-style"><option>科技深蓝</option><option>清爽留白</option><option>杂志感</option><option>暖色商务</option></select></label>
        </div>

        <div class="prompt-field">
          <textarea id="create-topic-input" rows="8" placeholder="请输入电子相册主题，例如：大米科技有限公司公司介绍，包含封面、公司简介、核心业务、团队优势、联系方式。"></textarea>
          <div class="prompt-bottom">
            <div class="prompt-tools">
              <button type="button" class="tool-btn" id="btn-create-attach">${navIcon('image')}<span>参考素材</span></button>
              <input type="file" id="create-file-input" multiple hidden />
              <span class="attachment-state" id="create-attachment-state">未选择素材</span>
            </div>
            <div class="prompt-actions">
              <button type="button" class="mini-action" id="btn-create-thinking">${navIcon('settings')}<span>深度思考</span></button>
              <button type="button" class="send-orb" id="btn-create-send" title="生成电子相册">${navIcon('plus')}</button>
            </div>
          </div>
        </div>

        <div class="topic-row">
          <span>热门主题：</span>
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
          <div class="kicker">Image To Album</div>
          <h2>图片转相册</h2>
          <p>先上传多张图片，再补充一句说明，系统会按图片顺序生成可翻页的 HTML 电子相册。</p>
        </section>

        <section class="image-album-flow">
          <div class="image-album-main">
            <div class="upload-drop" id="image-album-drop">
              <input type="file" id="image-album-input" accept="image/*" multiple hidden />
              <div class="upload-icon">${navIcon('image')}</div>
              <h3>上传相册图片</h3>
              <p>支持一次选择多张图片，生成时会严格按这里展示的顺序安排页面。</p>
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
                    <option>16:9 横屏</option>
                    <option>9:16 竖屏</option>
                    <option>1:1 方形</option>
                  </select>
                </label>
                <label class="stack-field">
                  <span>风格</span>
                  <select id="image-album-style">
                    <option>清爽留白</option>
                    <option>杂志感</option>
                    <option>科技深蓝</option>
                    <option>温暖纪实</option>
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
                <p>每张图片生成一页，图片作为页面主体；Agent 会补充短标题和说明文案。生成完成后可在项目编辑页继续预览、改字和导出。</p>
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

function renderProjectHistoryPage() {
  return `
    <main class="feature-page">
      <div class="feature-page-inner">
        <section class="feature-hero">
          <div class="kicker">Project History</div>
          <h2>项目历史</h2>
          <p>集中查看和继续编辑已经创建的 HTML 视频与电子相册项目。</p>
        </section>
        <section class="feature-panel">
          <div class="feature-panel-head">
            <div>
              <h3>全部项目</h3>
              <p>${state.projects.length} 个项目</p>
            </div>
            <button class="feature-btn primary" id="btn-history-new">新建项目</button>
          </div>
          <div class="history-list" id="history-list"></div>
        </section>
      </div>
    </main>
  `;
}

function renderProjectHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!state.projects.length) {
    list.innerHTML = `<div class="empty-list">还没有项目，点击上方新建一个。</div>`;
    return;
  }
  list.innerHTML = state.projects.map((p) => `
    <div class="history-row">
      <div>
        <div class="name">${esc(p.name)}</div>
        <div class="meta">${p.template_id ? esc(p.template_id) : 'no template'} · ${esc(p.status ?? '')}</div>
      </div>
      <div class="actions">
        <button class="feature-btn" data-open-project="${esc(p.id)}">打开</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-open-project]').forEach((btn) => {
    btn.onclick = () => selectProject(btn.dataset.openProject);
  });
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
            <div class="quick-card"><h4>Agent</h4><p>配置 Codex、Claude、AMR 等生成代理。</p></div>
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
      <div class="meta">${p.template_id ? esc(p.template_id) : 'no template'} · ${p.status}</div>
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
  const hasFrames = !!(p && Array.isArray(p.frames) && p.frames.length > 0);
  exportBtn.disabled = !p || (!p.templateId && !hasFrames) || !!state.exporting;
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
    exportHtmlBtn.textContent = 'Export HTML';
    exportHtmlBtn.title = p?.lastPreviewHtmlPath
      ? 'Download the current preview as standalone HTML'
      : 'Generate or pick a template first';
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
  pill.disabled = !p;
  const dot = document.getElementById('agent-dot');
  const logo = document.getElementById('agent-pill-logo');
  const label = document.getElementById('agent-pill-label');
  if (!p) {
    label.textContent = t('toolbar.agent_none');
    logo.innerHTML = '';
    dot.className = 'agent-dot';
    return;
  }
  const currentId = p.agentId ?? (state.agents.find((a) => a.available && a.id !== 'amr')?.id ?? 'anthropic-api');
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
  if (!state.selected || currentAgentId !== 'amr') { wrap.hidden = true; return; }
  wrap.hidden = false;
  // Fetch once per session; cache on state.
  if (!state._amrModels) {
    try {
      const data = await fetch('/api/agents/amr/models').then((r) => r.json());
      state._amrModels = data.models ?? [];
      state._amrDefaultModel = data.default ?? null;
    } catch { state._amrModels = []; }
  }
  const models = state._amrModels;
  if (!models.length) { wrap.hidden = true; return; }
  const chosen = state.selected.agentModel ?? state._amrDefaultModel ?? models[0].id;
  sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}"${m.id === chosen ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  sel.onchange = async () => {
    if (!state.selected) return;
    try {
      await API.setAgent(state.selected.id, 'amr', sel.value);
      state.selected = (await API.getProject(state.selected.id)).project;
      toast(`✓ ${sel.value}`, 'success');
    } catch (e) { toast(`${e?.message ?? e}`, 'error'); }
  };
}

/** Open/refresh the top-bar agent dropdown. */
function renderAgentMenu() {
  const menu = document.getElementById('agent-menu');
  if (!menu || !state.selected) return;
  const currentId = state.selected.agentId ?? (state.agents.find((a) => a.available && a.id !== 'amr')?.id ?? 'anthropic-api');
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
  const page = state.activePage || 'create';
  document.body.dataset.page = page;
  body.className = page === 'workspace' ? 'body workspace-body' : 'body feature-body';
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
          <details class="soundtrack-panel" id="soundtrack-panel">
            <summary>
              <span class="st-summary-main">${t('soundtrack.title')}</span>
              <span class="st-summary-sub">${t('soundtrack.summary_sub')}</span>
              <span class="soundtrack-badge">${t('soundtrack.optional')}</span>
            </summary>
            <div class="soundtrack-body">
              <!-- ===== Background music: its own input + generate ===== -->
              <div class="st-section">
                <div class="st-section-title">${t('soundtrack.music_label')}</div>
                <div class="st-presets" id="st-music-presets">
                  ${MUSIC_PRESETS.map((p) => `<button type="button" class="st-preset" data-prompt="${p.prompt}">${t('soundtrack.preset_' + p.key)}</button>`).join('')}
                </div>
                <textarea id="st-music-prompt" rows="2" placeholder="${t('soundtrack.music_placeholder')}"></textarea>
                <div class="st-vol-row"><label>${t('soundtrack.music_volume')} <input type="range" id="st-music-vol" min="-40" max="0" value="-18" /><b id="st-music-vol-val">-18 dB</b></label></div>
                <div class="st-section-actions">
                  <button class="st-generate" id="btn-st-gen-music">${t('soundtrack.gen_music')}</button>
                  <span class="st-status" id="st-music-status"></span>
                </div>
              </div>

              <!-- ===== Narration / voiceover ===== -->
              <!-- Two explicit steps so users don't confuse "write the text"
                   (AI drafts words, no audio) with "synthesize the voice"
                   (calls MiniMax, produces an mp3). See issues #4 / #5. -->
              <div class="st-section st-narration">
                <div class="st-section-title">${t('soundtrack.narration_label')}</div>

                <!-- Step 1: write the script (text only) -->
                <div class="st-substep">
                  <div class="st-substep-head">
                    <span class="st-step-badge">1</span>
                    <span class="st-step-label">${t('soundtrack.step_write')}</span>
                    <span class="st-narration-which" id="st-narration-which"></span>
                  </div>
                  <textarea id="st-narration-text" rows="2" placeholder="${t('soundtrack.narration_placeholder')}"></textarea>
                  <div class="st-draft-group">
                    <button type="button" class="st-draft" id="btn-st-draft-frame">${t('soundtrack.draft_frame')}</button>
                    <button type="button" class="st-draft" id="btn-st-draft-all">${t('soundtrack.draft_all')}</button>
                  </div>
                </div>

                <!-- Step 2: synthesize the voice (audio) -->
                <div class="st-substep">
                  <div class="st-substep-head">
                    <span class="st-step-badge">2</span>
                    <span class="st-step-label">${t('soundtrack.step_voice')}</span>
                  </div>
                  <div class="st-voice-row">
                    <span class="st-voice-label">${t('soundtrack.voice_label')}</span>
                    <select id="st-narration-voice" class="st-voice-select">
                      ${NARRATION_VOICES.map((v) => `<option value="${v.voiceId}">${t('soundtrack.voice_' + v.key)}</option>`).join('')}
                    </select>
                    <button type="button" class="st-fit" id="btn-st-fit" title="${t('soundtrack.fit_hint')}">${t('soundtrack.fit_durations')}</button>
                  </div>
                  <div class="st-vol-row"><label>${t('soundtrack.narration_volume')} <input type="range" id="st-narration-vol" min="-20" max="6" value="0" /><b id="st-narration-vol-val">0 dB</b></label></div>
                  <div class="st-section-actions">
                    <button class="st-generate" id="btn-st-gen-narration">${t('soundtrack.gen_narration')}</button>
                    <span class="st-status" id="st-narration-status"></span>
                  </div>
                </div>
              </div>

              <div class="soundtrack-actions">
                <button class="st-clear" id="btn-st-clear">${t('soundtrack.clear')}</button>
              </div>
              <div class="soundtrack-preview" id="st-preview"></div>
            </div>
          </details>
        </section>

        <section class="text-pane">
          <div class="text-pane-head">
            <h2>${t('text_pane.title')}</h2>
            <span class="save-state" id="text-save-state">${t('text_pane.save_state.idle')}</span>
            <button class="textfields-toggle" id="btn-textfields-toggle" title="${t('text_pane.collapse')}">›</button>
          </div>
          <div class="text-fields" id="text-fields">
            <div class="text-empty">${t('text_pane.empty_no_frames')}</div>
          </div>
        </section>
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
  const tfTog = document.getElementById('btn-textfields-toggle');
  if (tfTog) tfTog.onclick = () => document.body.classList.toggle('textfields-collapsed');
  if (state.selected) {
    renderChatLog();
    renderComposer();
    renderPreview();
    renderFooter();
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
    document.getElementById('btn-reload').onclick = () => { reloadPreview(); refreshTextFields(); };
    wireSoundtrackPanel();
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
          agentId: state.selected.agentId ?? (state.agents.find((a) => a.available && a.id !== 'amr')?.id ?? 'anthropic-api'),
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
    fs.innerHTML = `<b>${esc(p.name)}</b> · ${p.templateId ? `template <b>${esc(p.templateId)}</b>` : '<i>no template</i>'} · ${p.status}`;
  } else {
    fs.textContent = 'no project';
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

function renderMessage(m, idx) {
  if (m.role === 'user') {
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
      <div class="export-path"><code>${esc(path)}</code></div>
      <div class="export-actions">
        <button class="btn-reveal" data-export-action="reveal">${t('export.reveal')}</button>
        <button class="btn-copy-path" data-export-action="copy">${t('export.copy_path')}</button>
      </div>
      <div class="export-fname">${esc(fname)}</div>
    </div>`;
  }
  // assistant: try each card protocol in turn
  const raw = m.content ?? '';
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
      <div class="role">${esc(m.agent ?? 'agent')}</div>
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
      <div class="role">${esc(m.agent ?? 'agent')}</div>
      <div class="body">${md(sanitizeAssistantProse(confirmP.prose))}${confirmHtml}</div>
    </div>`;
  }
  // Default: hv-options + prose
  const { prose, options } = parseHvOptions(raw);
  // m.pickedOption is in-memory only — wiped on reload. Recover it from
  // history: any user turn AFTER this card is implicitly the answer.
  let picked = m.pickedOption;
  if (options && !picked) {
    const nextUser = state.messages.slice(idx + 1).find((x) => x.role === 'user');
    if (nextUser) picked = nextUser.content;
  }
  const optionsHtml = options ? renderOptionCard(options, picked, idx) : '';
  return `<div class="msg assistant">
    <div class="role">${esc(m.agent ?? 'agent')}</div>
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
  if (!p.templateId && !p.lastPreviewHtmlPath) {
    stage.innerHTML = `<div class="preview-placeholder"><div><div class="ico">🎞️</div>${t('preview.placeholder.pick_template')}</div></div>`;
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
  // Constrain the preview frame along the *long* axis so the whole frame stays
  // contained in the (bounded-height) stage. The base CSS only limits width
  // (width:100%; max-width:1280px) which is right for landscape, but for a
  // portrait frame (vh>vw) that lets it grow ~2275px tall and overflow — you'd
  // only see the top slice. For portrait, limit height instead and let width
  // follow the aspect-ratio. Square stays width-bound.
  const sizeStyle = vh > vw
    ? 'width:auto;max-width:none;height:100%;max-height:100%'
    : 'width:100%;max-width:1280px';
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
  // sandbox now grants same-origin so we can attach a text-edit overlay
  // from the parent window. allow-scripts keeps the page's own animations
  // running. forms / popups / top-navigation stay blocked.
  stage.innerHTML = `<div class="preview-frame ${state.editTextMode ? 'editing' : ''}" style="aspect-ratio:${vw}/${vh};${sizeStyle}">
    <iframe id="preview-iframe" sandbox="allow-scripts allow-same-origin" src="${iframeSrc}" style="width:${vw}px;height:${vh}px"></iframe>
    ${stamp ? `<div class="stamp">${esc(stamp)}</div>` : ''}
    <button class="edit-toggle" id="btn-edit-text"
      title="${state.editTextMode ? t('preview.edit_text_done_title') : t('preview.edit_text_title')}">
      ${state.editTextMode ? t('preview.edit_text_on') : t('preview.edit_text_off')}
    </button>
  </div>`;
  attachPreviewScaler();
  const editBtn = document.getElementById('btn-edit-text');
  if (editBtn) editBtn.onclick = togglePreviewEdit;
  // If the user just toggled into edit mode, attach the overlay once the
  // iframe loads. If already in edit mode and we re-rendered, attach now
  // (iframe might already be loaded when reusing a cached preview).
  const iframe = document.getElementById('preview-iframe');
  if (iframe && state.editTextMode) {
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
      attachTextEditOverlay(iframe);
    } else {
      iframe.addEventListener('load', () => attachTextEditOverlay(iframe), { once: true });
    }
  }
  renderFramesStrip();
  // Convergence point for every frame/preview change → keep soundtrack buttons
  // (draft / fit) and the per-frame narration line in sync, regardless of which
  // path triggered the change.
  if (typeof window.__hvSyncNarration === 'function') window.__hvSyncNarration();
}

function togglePreviewEdit() {
  state.editTextMode = !state.editTextMode;
  // When leaving edit mode, force-reload preview so any in-iframe styling
  // is dropped cleanly.
  renderPreview();
}

// Inject hover highlight + click-to-edit on every [data-hv-text] node in
// the preview iframe. On commit we replace text content in the iframe DOM,
// serialize it, and PUT to the right endpoint (frame-specific or whole-
// project preview).
function attachTextEditOverlay(iframe) {
  let doc;
  try { doc = iframe.contentDocument; } catch (err) {
    console.warn('[hv-edit] iframe.contentDocument blocked:', err);
    return;
  }
  if (!doc) {
    console.warn('[hv-edit] iframe.contentDocument is null (still loading? sandbox blocking?)');
    return;
  }
  if (!doc.body) {
    console.warn('[hv-edit] iframe document has no body yet — re-attaching on next load tick');
    iframe.addEventListener('load', () => attachTextEditOverlay(iframe), { once: true });
    return;
  }
  const tagged = doc.querySelectorAll('[data-hv-text]');
  console.log(`[hv-edit] attached overlay; found ${tagged.length} [data-hv-text] elements`);
  if (tagged.length === 0) {
    toast(t('preview.no_hv_text'), 'warn');
  }
  // Idempotent: tear down any prior overlay first.
  doc.querySelectorAll('[data-hv-edit-style]').forEach((el) => el.remove());
  const style = doc.createElement('style');
  style.setAttribute('data-hv-edit-style', '');
  style.textContent = `
    [data-hv-text] { outline: 1px dashed rgba(201, 100, 66, .6) !important;
      outline-offset: 3px !important; cursor: text !important;
      transition: outline-color .12s, background .12s; }
    [data-hv-text]:hover { outline: 2px solid rgb(201, 100, 66) !important;
      background: rgba(201, 100, 66, .08) !important; }
    [data-hv-text][contenteditable="true"] { outline: 2px solid rgb(201, 100, 66) !important;
      outline-offset: 3px !important; background: rgba(201, 100, 66, .12) !important; }
  `;
  (doc.head || doc.documentElement).appendChild(style);

  let dirty = false;
  const enableEdit = (el) => {
    if (el.getAttribute('contenteditable') === 'true') return;
    el.setAttribute('contenteditable', 'true');
    el.focus();
    // Place caret at end
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = doc.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  };
  const finishEdit = async (el) => {
    if (el.getAttribute('contenteditable') !== 'true') return;
    el.removeAttribute('contenteditable');
    if (!dirty) return;
    dirty = false;
    await commitInlineTextEdits(iframe);
  };

  doc.addEventListener('click', (e) => {
    const target = e.target.closest('[data-hv-text]');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    enableEdit(target);
  }, true);
  doc.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('[data-hv-text]')) {
      dirty = true;
    }
  });
  doc.addEventListener('keydown', (e) => {
    const target = e.target.closest && e.target.closest('[data-hv-text][contenteditable="true"]');
    if (!target) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); target.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); target.blur(); }
  });
  doc.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('[data-hv-text][contenteditable="true"]')) {
      finishEdit(t);
    }
  }, true);
}

async function commitInlineTextEdits(iframe) {
  if (!state.selected) return;
  const projectId = state.selected.id;
  const fid = state.activeFrameId;
  const url = fid
    ? `/api/projects/${projectId}/frames/${encodeURIComponent(fid)}/raw-html`
    : `/api/projects/${projectId}/raw-html`;
  // Read the current frame HTML from disk, walk its [data-hv-text] nodes,
  // sync each one's text from the iframe DOM. We do server-side merging
  // on the client to keep it simple.
  let serverHtml;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch failed ${r.status}`);
    serverHtml = await r.text();
  } catch (e) {
    toast(`保存失败：${e.message}`, 'error');
    return;
  }
  const parser = new DOMParser();
  const target = parser.parseFromString(serverHtml, 'text/html');
  const live = iframe.contentDocument;
  const liveByKey = new Map();
  if (live) {
    live.querySelectorAll('[data-hv-text]').forEach((el) => {
      const k = el.getAttribute('data-hv-text');
      if (k) liveByKey.set(k, el.textContent ?? '');
    });
  }
  let changed = 0;
  target.querySelectorAll('[data-hv-text]').forEach((el) => {
    const k = el.getAttribute('data-hv-text');
    if (!k || !liveByKey.has(k)) return;
    const newText = liveByKey.get(k);
    if (el.textContent !== newText) {
      el.textContent = newText;
      changed += 1;
    }
  });
  if (changed === 0) return;
  // Serialize the doc + ship it back.
  const out = '<!doctype html>\n' + target.documentElement.outerHTML;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: out }),
    });
    if (!r.ok) throw new Error(`save failed ${r.status}`);
    toast(`已保存 ${changed} 处修改`, 'success');
    // Refresh local project state so frames-strip thumbnails cache-bust.
    if (fid) {
      const pr = await API.getProject(projectId);
      state.selected = pr.project;
      renderFramesStrip();
    }
  } catch (e) {
    toast(`保存失败：${e.message}`, 'error');
  }
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
    strip.classList.remove('has-frames');
    strip.innerHTML = '';
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

function humanizeKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
  const canExport = !!(p && (p.templateId || (p.frames?.length ?? 0) > 0));
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
              state.messages[thinkingIdx] = { role: 'assistant', agent: state.selected.agentId ?? 'claude', content: '', ts: Date.now() };
              assistantIdx = thinkingIdx;
            }
            state.messages[assistantIdx].content += ev.chunk;
            renderChatLog();
          } else if (ev.type === 'preview_ready') {
            const frameCount = ev.frames || 0;
            const focusedFrame = ev.focused_frame;
            const summary = focusedFrame
              ? `✓ frame ${focusedFrame} updated`
              : frameCount > 0
                ? `✓ ${frameCount}-frame storyboard generated`
                : '✓ HTML preview updated';
            const event = focusedFrame
              ? `🎞 frame ${focusedFrame} reloaded`
              : frameCount > 0
                ? `🎞 storyboard reloaded (${frameCount} frames)`
                : '🎞 preview reloaded';
            if (assistantIdx === -1) {
              state.messages[thinkingIdx] = { role: 'assistant', agent: state.selected.agentId ?? 'claude', content: summary, ts: Date.now() };
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
          } else if (ev.type === 'warning') {
            if (assistantIdx === -1) {
              state.messages[thinkingIdx] = { role: 'assistant', agent: state.selected.agentId ?? 'claude', content: '', ts: Date.now() };
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
  // Default to local CLI mode; BYOK = anthropic-api which is itself an HTTP agent
  const mode = panel.dataset.mode || 'local';
  const agents = state.agents ?? [];
  const localAgents = agents.filter((a) => a.id !== 'anthropic-api');
  const httpAgents = agents.filter((a) => a.id === 'anthropic-api');
  const list = mode === 'byok' ? httpAgents : localAgents;
  const currentId = state.selected?.agentId
    || (agents.find((a) => a.available)?.id ?? 'anthropic-api');

  panel.innerHTML = `
    <h3>${esc(t('settings.agent.title'))}</h3>
    <div class="panel-sub">${esc(t('settings.agent.subtitle'))}</div>

    <div class="settings-mode-tabs">
      <button data-mode="local" class="${mode === 'local' ? 'active' : ''}">${esc(t('settings.agent.mode.local'))}</button>
      <button data-mode="byok" class="${mode === 'byok' ? 'active' : ''}">${esc(t('settings.agent.mode.byok'))}</button>
    </div>

    ${mode === 'byok' ? `
      <div class="panel-sub" style="margin-bottom:14px">
        ${esc(t('settings.agent.byok.intro'))}
        <ul style="margin:6px 0 0 18px;padding:0;font-family:var(--font-mono);font-size:11.5px">
          <li>${esc(t('settings.agent.byok.env_key'))}</li>
          <li>${esc(t('settings.agent.byok.env_base'))}</li>
        </ul>
      </div>
    ` : ''}

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
              ? (isCurrent
                  ? `<span style="font-size:11px;color:var(--accent);font-family:var(--font-mono)">${esc(t('settings.agent.in_use'))}</span>`
                  : `<button data-act="use" class="primary-action" style="background:var(--accent);border-color:var(--accent);color:var(--accent-fg)">${esc(t('settings.agent.use'))}</button>`)
              : (a.installUrl ? `<a href="${a.installUrl}" target="_blank" rel="noopener" style="font-size:11px;color:var(--text-faint)">install ↗</a>` : '')}
          </div>
          <div class="agent-test-result" data-test-result="${esc(a.id)}" style="display:none;grid-column:1 / -1"></div>
        </div>`;
      }).join('')}
    </div>
  `;

  panel.querySelectorAll('.settings-mode-tabs button').forEach((btn) => {
    btn.onclick = () => {
      panel.dataset.mode = btn.dataset.mode;
      renderSettingsAgent(panel);
    };
  });
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
      if (act === 'use') {
        if (!state.selected) {
          toast(t('composer.placeholder.no_project'), 'error');
          return;
        }
        await API.setAgent(state.selected.id, aid);
        state.selected = (await API.getProject(state.selected.id)).project;
        renderSettingsAgent(panel);
        toast(`✓ ${aid}`, 'success');
      } else if (act === 'test') {
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

