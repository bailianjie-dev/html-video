/**
 * Pi Agent via official SDK (`@mariozechner/pi-coding-agent`), not the `pi -p` CLI.
 *
 * Studio supplies the system policy and user turn, then consumes the SDK event
 * stream. Built-in coding tools remain disabled; business tools are registered
 * explicitly by later Album Agent phases.
 *
 * Auth / endpoint (first match wins):
 *   API key:  HV_PI_API_KEY | DASHSCOPE_API_KEY | OPENAI_API_KEY
 *   Base URL: HV_PI_BASE_URL | DASHSCOPE_BASE_URL | OPENAI_BASE_URL
 *             default https://dashscope.aliyuncs.com/compatible-mode/v1
 *   Model:    context.model | HV_PI_MODEL | DASHSCOPE_MODEL | OPENAI_MODEL
 *             default qwen3.7-plus
 *   Max tokens (output): HV_PI_MAX_TOKENS | DASHSCOPE_MAX_TOKENS | OPENAI_MAX_TOKENS
 *             default 16384
 */
import type { Model } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ToolDefinition,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from '@mariozechner/pi-coding-agent';
import type { AgentDef, AgentEvent } from '../types.js';

const PROVIDER_ID = 'dashscope';
const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.7-plus';
export const DEFAULT_PI_MAX_TOKENS = 16_384;

export interface PiAgentResolvedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Max completion tokens sent as `max_tokens` to the provider. */
  maxTokens: number;
}

/** Parse a positive integer env value; invalid / missing → fallback. */
export function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

export function resolvePiAgentConfig(modelOverride?: string): PiAgentResolvedConfig | null {
  const apiKey = (
    process.env.HV_PI_API_KEY
    || process.env.DASHSCOPE_API_KEY
    || process.env.OPENAI_API_KEY
    || ''
  ).trim();
  if (!apiKey) return null;
  const baseUrl = (
    process.env.HV_PI_BASE_URL
    || process.env.DASHSCOPE_BASE_URL
    || process.env.OPENAI_BASE_URL
    || DEFAULT_BASE
  ).replace(/\/+$/, '');
  const model = (
    modelOverride
    || process.env.HV_PI_MODEL
    || process.env.DASHSCOPE_MODEL
    || process.env.OPENAI_MODEL
    || DEFAULT_MODEL
  ).trim();
  const maxTokens = parsePositiveIntEnv(
    process.env.HV_PI_MAX_TOKENS
    || process.env.DASHSCOPE_MAX_TOKENS
    || process.env.OPENAI_MAX_TOKENS,
    DEFAULT_PI_MAX_TOKENS,
  );
  return { apiKey, baseUrl, model, maxTokens };
}

const DEFAULT_PI_ABORT_GRACE_MS = 1_000;

/**
 * Ask the SDK to abort, but do not let its waitForIdle() contract keep the host
 * Run alive forever. Pi propagates the abort signal to the active model/tool
 * synchronously; the grace period only bounds the subsequent idle wait.
 */
export async function waitForPiPromptOrAbort(
  promptPromise: Promise<unknown>,
  abortSession: () => Promise<unknown>,
  signal: AbortSignal,
  abortGraceMs = DEFAULT_PI_ABORT_GRACE_MS,
): Promise<'completed' | 'aborted'> {
  let abortStarted = false;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
  const onAbort = () => {
    if (abortStarted) return;
    abortStarted = true;
    const settle = () => {
      if (abortTimer) clearTimeout(abortTimer);
      abortTimer = undefined;
      resolveAborted();
    };
    abortTimer = setTimeout(settle, Math.max(0, abortGraceMs));
    void abortSession().catch(() => { /* abort is best effort */ }).finally(settle);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([
      promptPromise.then(() => 'completed' as const),
      aborted.then(() => 'aborted' as const),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (abortTimer) clearTimeout(abortTimer);
  }
}

function buildDashScopeModel(
  baseUrl: string,
  modelId: string,
  maxTokens: number,
): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
    },
  };
}

async function runPiSdkSession(opts: {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  customTools?: ToolDefinition[];
  config: PiAgentResolvedConfig;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<{ exitCode: number }> {
  const { prompt, cwd, systemPrompt, customTools = [], config, onEvent, signal } = opts;
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(PROVIDER_ID, config.apiKey);
  // In-memory registry: do not inherit ~/.pi/agent/models.json from a prior CLI install.
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: systemPrompt ?? '',
  });
  await resourceLoader.reload();

  const model = buildDashScopeModel(config.baseUrl, config.model, config.maxTokens);
  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: 'off',
    noTools: customTools.length > 0 ? 'builtin' : 'all',
    ...(customTools.length > 0 && { customTools }),
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });

  let failed = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      if (ame.type === 'text_delta' && ame.delta) {
        onEvent({ type: 'text', chunk: ame.delta });
      }
      return;
    }
    if (event.type === 'tool_execution_start') {
      onEvent({
        type: 'tool_use',
        tool: event.toolName,
        input: event.args,
        id: event.toolCallId,
      });
      return;
    }
    if (event.type === 'tool_execution_end') {
      onEvent({
        type: 'tool_result',
        id: event.toolCallId,
        output: event.result,
        isError: event.isError,
      });
      return;
    }
    if (event.type === 'agent_end') {
      const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant');
      if (!lastAssistant || !('stopReason' in lastAssistant)) return;
      const stopReason = String(lastAssistant.stopReason || '');
      if (stopReason === 'error' || stopReason === 'aborted') {
        failed = true;
        const msg = ('errorMessage' in lastAssistant && lastAssistant.errorMessage)
          ? String(lastAssistant.errorMessage)
          : `Pi Agent stopped with reason: ${stopReason}`;
        onEvent({ type: 'error', message: msg });
        return;
      }
      // Provider hit the completion budget (config max_tokens) before a usable reply.
      if (stopReason === 'length') {
        failed = true;
        onEvent({
          type: 'error',
          message: 'OUTPUT_TOKEN_LIMIT: model stopped because max_tokens was reached',
        });
      }
    }
  });

  try {
    const outcome = await waitForPiPromptOrAbort(
      session.prompt(prompt),
      () => session.abort(),
      signal,
    );
    return { exitCode: failed || outcome === 'aborted' || signal.aborted ? -1 : 0 };
  } catch (err) {
    if (!signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: msg });
    }
    return { exitCode: -1 };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export const piAgent: AgentDef = {
  id: 'pi-agent',
  name: 'Pi Agent SDK',
  bin: 'pi-agent-sdk',
  versionArgs: [],
  buildArgs: () => [],
  streamFormat: 'plain',
  kind: 'http',
  defaultModel: DEFAULT_MODEL,
  installUrl: 'https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md',

  async httpProbe() {
    const cfg = resolvePiAgentConfig();
    if (!cfg) {
      return {
        available: false,
        hint: 'Set HV_PI_API_KEY (or DASHSCOPE_API_KEY / OPENAI_API_KEY). Optional: HV_PI_BASE_URL, HV_PI_MODEL, HV_PI_MAX_TOKENS.',
      };
    }
    let host = cfg.baseUrl;
    try {
      host = new URL(cfg.baseUrl).host;
    } catch { /* keep raw */ }
    return {
      available: true,
      version: `${cfg.model} via ${host} (Pi SDK)`,
    };
  },

  async httpHandler(prompt, ctx, onEvent, signal) {
    const cfg = resolvePiAgentConfig(ctx.model);
    if (!cfg) {
      onEvent({
        type: 'error',
        message: 'No HV_PI_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY configured for Pi Agent SDK',
      });
      return { exitCode: -1 };
    }
    return runPiSdkSession({
      prompt,
      cwd: ctx.cwd || process.cwd(),
      ...(ctx.systemPrompt && { systemPrompt: ctx.systemPrompt }),
      ...(ctx.customTools?.length && { customTools: ctx.customTools }),
      config: cfg,
      onEvent,
      signal,
    });
  },
};
