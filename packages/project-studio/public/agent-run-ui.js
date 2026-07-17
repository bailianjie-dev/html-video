const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const VALIDATION_CODE_PARTS = [
  'INVALID',
  'REQUIRED',
  'UNKNOWN',
  'OUT_OF_RANGE',
  'NOT_FOUND',
  'NOT_AVAILABLE',
  'UNAVAILABLE',
  'UNSUPPORTED',
  'VALIDATION',
  'MISMATCH',
];

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortText(value, maxLength = 96) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (
    /<\/?(?:html|body|script|style|div|section)\b/i.test(text) ||
    /(?:https?:\/\/|file:\/\/)/i.test(text) ||
    /(?:^|\s)(?:[a-z]:\\|\/Users\/|\/home\/)/i.test(text)
  ) {
    return '[已隐藏]';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactIdentifier(value, maxLength = 32) {
  const text = shortText(value, maxLength);
  if (!text || text === '[已隐藏]') return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, 12)}…${text.slice(-8)}`;
}

export function summarizeToolArguments(name, input) {
  const args = objectValue(input);
  const parts = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    parts.push(`${label}：${value}`);
  };

  add('页码', finiteNumber(args.page_number));
  add('原文字', shortText(args.old_text, 48));
  add('新文字', shortText(args.new_text, 48));
  add('文字', shortText(args.target_text, 48));
  add('颜色', shortText(args.color, 32));
  add('目标', shortText(args.target_key, 48));
  add('资源', compactIdentifier(args.asset_id));
  add('预期版本', finiteNumber(args.expected_revision));
  add('确认操作', compactIdentifier(args.action_id));

  const request = args.request ?? args.instructions ?? args.requirements ?? args.topic;
  add('要求', shortText(request, 96));

  if (parts.length === 0) {
    const safeKeys = Object.keys(args)
      .filter((key) => !/(html|url|path|content|prompt|source)/i.test(key))
      .slice(0, 3);
    for (const key of safeKeys) {
      const value = args[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        add(key, shortText(value, 48));
      }
    }
  }

  return parts.length ? parts : ['无参数'];
}

export function extractToolResultDetails(output) {
  const result = objectValue(output);
  let details = objectValue(result.details);
  if (Object.keys(details).length === 0 && Array.isArray(result.content)) {
    const textItem = result.content.find(
      (item) => item?.type === 'text' && typeof item.text === 'string',
    );
    if (textItem) {
      try {
        details = objectValue(JSON.parse(textItem.text));
      } catch {
        /* structured details are optional */
      }
    }
  }

  const revision = finiteNumber(details.revision);
  const albumRevision = finiteNumber(details.album_revision);
  const previousRevision = finiteNumber(details.previous_revision);
  const currentRevision = finiteNumber(details.current_revision);
  const expectedRevision = finiteNumber(details.expected_revision);
  const pageNumber = finiteNumber(details.page_number);
  const pageCount = finiteNumber(details.page_count);
  const changedPages = Array.isArray(details.changed_pages)
    ? details.changed_pages.map(finiteNumber).filter((value) => value !== null)
    : [];

  return {
    ok: details.ok !== false && result.isError !== true,
    code: shortText(details.code, 64),
    message: shortText(details.message ?? details.error, 160),
    operation: shortText(details.operation, 64),
    revision: revision ?? albumRevision,
    albumRevision,
    previousRevision,
    currentRevision,
    expectedRevision,
    pageNumber,
    pageCount,
    changedPages,
    changedTextKeys: Array.isArray(details.changed_text_keys)
      ? details.changed_text_keys.length
      : 0,
    changedImageKeys: Array.isArray(details.changed_image_keys)
      ? details.changed_image_keys.map((key) => shortText(key, 64))
      : [],
    changedCtaKeys: Array.isArray(details.changed_cta_keys) ? details.changed_cta_keys.length : 0,
    changedStyleVariables: Array.isArray(details.changed_style_variables)
      ? details.changed_style_variables.length
      : 0,
    structuralChange: details.structural_change === true,
    confirmationRequired: details.confirmation_required === true,
    actionId: compactIdentifier(details.action_id),
    confirmationSummary: shortText(details.summary, 160),
    expiresAt: shortText(details.expires_at, 48),
    targetKey: shortText(details.target_key, 64),
    albumChanged: details.album_changed === true,
  };
}

function classifyToolResult(result, isError) {
  const code = String(result.code || '').toUpperCase();
  if (result.confirmationRequired || code === 'OVERWRITE_CONFIRMATION_REQUIRED')
    return 'confirmation_required';
  if (code === 'ALBUM_REVISION_CONFLICT') return 'conflict';
  if (code.includes('CANCEL')) return 'cancelled';
  if (isError || result.ok === false) {
    if (VALIDATION_CODE_PARTS.some((part) => code.includes(part))) return 'validation_failed';
    return 'failed';
  }
  return 'succeeded';
}

export function createAgentRunUiState({ runId = '', sessionId = '' } = {}) {
  return {
    version: 1,
    runId: String(runId || ''),
    sessionId: String(sessionId || ''),
    status: 'idle',
    statusText: '等待 Agent 启动',
    agent: '',
    model: '',
    lastSequence: 0,
    tools: [],
    latestRevision: null,
    confirmation: null,
    conflict: null,
    validationFailure: null,
    preview: null,
    error: null,
    updatedAt: Date.now(),
  };
}

export function isAgentRunExecutionActive({
  runStatus = '',
  composing = false,
  expectingInitialGeneration = false,
  backendGenerating = false,
  hasProgressTimer = false,
} = {}) {
  return !!(
    runStatus === 'running'
    || composing
    || expectingInitialGeneration
    || backendGenerating
    || hasProgressTimer
  );
}

function mergeTool(tools, callId, patch) {
  const id = String(callId || `tool-${tools.length + 1}`);
  const index = tools.findIndex((tool) => tool.callId === id);
  if (index === -1)
    return [...tools, { callId: id, name: 'unknown_tool', argumentSummary: ['无参数'], ...patch }];
  return tools.map((tool, toolIndex) => (toolIndex === index ? { ...tool, ...patch } : tool));
}

function settleRunningTools(tools, status) {
  return tools.map((tool) =>
    tool.status === 'running' ? { ...tool, status } : tool,
  );
}

function settleChangedAlbumTool(tools, callId, revision) {
  const id = String(callId || '');
  if (!id) return tools;
  return tools.map((tool) => {
    if (tool.callId !== id || tool.status !== 'running') return tool;
    return {
      ...tool,
      status: 'succeeded',
      result: tool.result || {
        ok: true,
        albumChanged: true,
        revision,
      },
    };
  });
}

export function reduceAgentRunUiEvent(previousState, event) {
  const base = previousState?.version === 1 ? previousState : createAgentRunUiState();
  if (!event || event.version !== 1 || typeof event.type !== 'string')
    return { state: base, effects: [] };
  const sequence = finiteNumber(event.sequence) ?? base.lastSequence + 1;
  if (sequence <= base.lastSequence) return { state: base, effects: [] };

  const data = objectValue(event.data);
  let state = {
    ...base,
    runId: String(event.runId || base.runId || ''),
    sessionId: String(event.sessionId || base.sessionId || ''),
    lastSequence: sequence,
    updatedAt: Date.now(),
  };
  const effects = [];

  if (event.type === 'run.started') {
    state = {
      ...state,
      status: 'running',
      statusText: data.executor === 'deterministic' ? '正在快速修改' : 'AI 助手正在思考',
      agent: shortText(data.agent, 48),
      model: shortText(data.model, 64),
      error: null,
    };
  } else if (event.type === 'assistant.delta') {
    state = { ...state, status: 'running', statusText: 'AI 助手正在组织回复' };
  } else if (event.type === 'tool.call.started') {
    state = {
      ...state,
      status: 'running',
      statusText: '正在执行工具',
      tools: mergeTool(state.tools, data.callId, {
        name: shortText(data.name, 64) || 'unknown_tool',
        argumentSummary: summarizeToolArguments(data.name, data.arguments),
        status: 'running',
        result: null,
      }),
    };
  } else if (event.type === 'tool.call.completed') {
    const result = extractToolResultDetails(data.output);
    const toolStatus = classifyToolResult(result, data.isError === true);
    state = {
      ...state,
      statusText: toolStatus === 'succeeded' ? '工具执行完成' : '工具需要处理',
      tools: mergeTool(state.tools, data.callId, { status: toolStatus, result }),
      latestRevision: result.revision ?? result.currentRevision ?? state.latestRevision,
      confirmation:
        toolStatus === 'confirmation_required'
          ? {
              actionId: result.actionId,
              summary: result.confirmationSummary,
              expectedRevision: result.expectedRevision,
              expiresAt: result.expiresAt,
            }
          : state.confirmation,
      conflict:
        toolStatus === 'conflict'
          ? {
              expectedRevision: result.expectedRevision,
              currentRevision: result.currentRevision,
            }
          : state.conflict,
      validationFailure:
        toolStatus === 'validation_failed'
          ? {
              code: result.code,
              message: result.message,
            }
          : state.validationFailure,
    };
  } else if (event.type === 'album.changed') {
    const revision = finiteNumber(data.revision);
    state = {
      ...state,
      statusText: '相册已保存，正在刷新预览',
      // album.changed is authoritative proof that the matching write tool has
      // finished. This also repairs a UI cursor gap if tool.call.completed was
      // missed while the artifact and preview already advanced.
      tools: settleChangedAlbumTool(state.tools, data.toolCallId, revision),
      latestRevision: revision ?? state.latestRevision,
    };
  } else if (event.type === 'preview.ready') {
    const revision = finiteNumber(data.revision);
    const preview = {
      url: shortText(data.previewUrl, 160),
      revision,
      previousRevision: finiteNumber(data.previousRevision),
      pageCount: finiteNumber(data.pageCount),
      changedPages: Array.isArray(data.changedPages)
        ? data.changedPages.map(finiteNumber).filter((value) => value !== null)
        : [],
      operation: shortText(data.operation, 64),
      pageNumber: finiteNumber(data.pageNumber),
      changeSummary: objectValue(data.changeSummary),
    };
    state = {
      ...state,
      statusText: '预览已刷新',
      latestRevision: revision ?? state.latestRevision,
      preview,
    };
    effects.push({ type: 'preview_ready', preview });
  } else if (event.type === 'assistant.completed') {
    state = { ...state, statusText: '回复已完成' };
  } else if (event.type === 'run.completed') {
    state = {
      ...state,
      status: 'completed',
      statusText: '本轮处理完成',
      // A terminal Run cannot still have an executing tool. Normally every
      // tool.call.completed event arrives first; this neutral fallback keeps a
      // restored/local cursor gap from leaving the card stuck at “执行中”.
      tools: settleRunningTools(state.tools, 'completed'),
    };
    effects.push({ type: 'terminal', status: 'completed' });
  } else if (event.type === 'run.failed') {
    state = {
      ...state,
      status: 'failed',
      statusText: '本轮执行失败',
      tools: settleRunningTools(state.tools, 'failed'),
      error: { code: shortText(data.code, 64), message: shortText(data.message, 180) },
    };
    effects.push({ type: 'terminal', status: 'failed' });
  } else if (event.type === 'run.cancelled') {
    state = {
      ...state,
      status: 'cancelled',
      statusText: '本轮已取消',
      tools: settleRunningTools(state.tools, 'cancelled'),
      error: { code: 'RUN_CANCELLED', message: shortText(data.message, 180) },
    };
    effects.push({ type: 'terminal', status: 'cancelled' });
  }

  return { state, effects };
}

/**
 * Server Session state is authoritative for whether a Run is still active.
 * Local storage only contributes the event cursor when it refers to that same
 * active Run; a stale locally-running card must not be resurrected after the
 * server has already cleared active_run.
 */
export function reconcileRestoredAgentRunUi(restored, activeRun, sessionId) {
  const activeRunId = String(activeRun?.run_id || activeRun?.runId || '');
  if (!activeRunId) return null;
  if (
    restored?.version === 1
    && restored.status === 'running'
    && restored.runId === activeRunId
    && (!restored.sessionId || restored.sessionId === sessionId)
  ) {
    return { ...restored, sessionId };
  }
  return {
    ...createAgentRunUiState({ runId: activeRunId, sessionId }),
    status: 'running',
    statusText: '正在恢复 Agent 运行状态',
  };
}

export function toolUiFromStoredMessage(message) {
  const result = extractToolResultDetails(message?.output);
  return {
    callId: String(message?.callId || message?.toolCallId || 'persisted-tool'),
    name: shortText(message?.tool, 64) || 'unknown_tool',
    argumentSummary: ['历史工具调用'],
    status: classifyToolResult(result, message?.isError === true),
    result,
  };
}

export function serializeAgentRunUiState(state) {
  if (!state || state.version !== 1 || !state.runId) return '';
  return JSON.stringify({ ...state, updatedAt: Date.now() });
}

export function restoreAgentRunUiState(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || parsed.version !== 1 || typeof parsed.runId !== 'string' || !parsed.runId)
      return null;
    const restored = createAgentRunUiState({ runId: parsed.runId, sessionId: parsed.sessionId });
    return {
      ...restored,
      ...parsed,
      tools: Array.isArray(parsed.tools) ? parsed.tools.slice(-20) : [],
      lastSequence: Math.max(0, finiteNumber(parsed.lastSequence) ?? 0),
      status:
        TERMINAL_RUN_STATUSES.has(parsed.status) || parsed.status === 'running'
          ? parsed.status
          : 'idle',
    };
  } catch {
    return null;
  }
}

export function buildAgentViewStateSnapshot({
  activePageIndex,
  pageCount,
  previewRevision,
  clientRevision,
}) {
  const count = Math.max(0, finiteNumber(pageCount) ?? 0);
  const page =
    count > 0 ? Math.max(0, Math.min(count - 1, finiteNumber(activePageIndex) ?? 0)) : null;
  return {
    activePageIndex: page,
    pageCount: count,
    previewRevision: Math.max(0, finiteNumber(previewRevision) ?? 0),
    clientRevision: Math.max(0, finiteNumber(clientRevision) ?? 0),
  };
}

export function preserveActivePageIndex(activePageIndex, pageCount) {
  const count = Math.max(0, finiteNumber(pageCount) ?? 0);
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, finiteNumber(activePageIndex) ?? 0));
}
