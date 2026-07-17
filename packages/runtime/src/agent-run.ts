import { spawnAgent } from './spawn.js';
import type { AgentDef, AgentInvokeContext } from './types.js';

export type AgentRunEventType =
  | 'run.started'
  | 'assistant.delta'
  | 'assistant.completed'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'album.changed'
  | 'preview.ready'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface AgentRunEvent<T = unknown> {
  version: 1;
  runId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: AgentRunEventType;
  data: T;
}

export type AgentRunEventListener = (event: AgentRunEvent) => void;

/** Ordered, replayable event log for one in-process agent run. */
export class AgentRunEventLog {
  readonly runId: string;
  readonly sessionId: string;
  private readonly events: AgentRunEvent[] = [];
  private readonly listeners = new Set<AgentRunEventListener>();

  constructor(runId: string, sessionId: string) {
    this.runId = runId;
    this.sessionId = sessionId;
  }

  append(type: AgentRunEventType, data: unknown = {}): AgentRunEvent {
    const event: AgentRunEvent = {
      version: 1,
      runId: this.runId,
      sessionId: this.sessionId,
      sequence: this.events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  list(afterSequence = 0): AgentRunEvent[] {
    return this.events.filter((event) => event.sequence > afterSequence);
  }

  subscribe(listener: AgentRunEventListener, afterSequence = 0): () => void {
    for (const event of this.list(afterSequence)) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface RunAgentTurnOptions {
  def: AgentDef;
  prompt: string;
  context: AgentInvokeContext;
  events: AgentRunEventLog;
  signal?: AbortSignal;
}

export interface AgentTurnResult {
  text: string;
  exitCode: number;
  cancelled: boolean;
  error?: string;
}

/** Run one SDK/agent turn and translate runtime events to the v1 event protocol. */
export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const { def, prompt, context, events, signal } = opts;
  let text = '';
  let error = '';

  events.append('run.started', {
    agent: def.id,
    model: context.model ?? def.defaultModel ?? null,
  });

  const handle = spawnAgent({
    def,
    prompt,
    context,
    ...(signal && { signal }),
    onEvent: (event) => {
      if (event.type === 'text') {
        text += event.chunk;
        events.append('assistant.delta', { text: event.chunk });
      } else if (event.type === 'tool_use') {
        events.append('tool.call.started', {
          callId: event.id ?? null,
          name: event.tool,
          arguments: event.input,
        });
      } else if (event.type === 'tool_result') {
        events.append('tool.call.completed', {
          callId: event.id ?? null,
          output: event.output,
          isError: event.isError ?? false,
        });
        const details = toolResultDetails(event.output);
        if (details?.album_changed === true) {
          events.append('album.changed', {
            revision: details.revision ?? null,
            previousRevision: details.previous_revision ?? null,
            pageCount: details.page_count ?? null,
            changedPages: details.changed_pages ?? [],
            changeSummary: details.change_summary ?? null,
            operation: details.operation ?? null,
            pageNumber: details.page_number ?? null,
            toolCallId: event.id ?? null,
          });
          events.append('preview.ready', {
            previewUrl: details.preview_url ?? null,
            revision: details.revision ?? null,
            previousRevision: details.previous_revision ?? null,
            pageCount: details.page_count ?? null,
            changedPages: details.changed_pages ?? [],
            changeSummary: details.change_summary ?? null,
            operation: details.operation ?? null,
            pageNumber: details.page_number ?? null,
          });
        }
      } else if (event.type === 'error') {
        error = event.message;
      }
    },
  });

  const { exitCode } = await handle.done;
  const cancelled = signal?.aborted ?? false;
  if (cancelled) {
    events.append('run.cancelled', { message: 'Agent run cancelled' });
  } else if (exitCode !== 0 || error || !text.trim()) {
    if (!error && !text.trim()) error = 'Agent returned an empty response';
    const tokenLimit = /OUTPUT_TOKEN_LIMIT|max_tokens|stop(?:ped)?(?:\s+with\s+reason:)?\s*length/i.test(error);
    events.append('run.failed', {
      code: tokenLimit
        ? 'OUTPUT_TOKEN_LIMIT'
        : (text.trim() ? 'AGENT_FAILED' : 'EMPTY_RESPONSE'),
      message: error || `Agent exited with code ${exitCode}`,
    });
  } else {
    events.append('assistant.completed', { text });
    events.append('run.completed', { reason: 'completed' });
  }

  return {
    text,
    exitCode,
    cancelled,
    ...(error && { error }),
  };
}

function toolResultDetails(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const details = (output as { details?: unknown }).details;
  return details && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown>
    : null;
}
