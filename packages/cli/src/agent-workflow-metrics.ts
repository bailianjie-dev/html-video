import type { AgentRunEvent } from '@html-video/runtime';

export type AgentRunOutcome = 'completed' | 'failed' | 'cancelled';

export interface AgentRunMetrics {
  event: 'agent_run';
  projectId: string;
  runId: string;
  outcome: AgentRunOutcome;
  toolCalls: number;
  toolFailures: number;
  toolFailureRate: number;
  cumulativeRuns: number;
  cumulativeToolCalls: number;
  cumulativeToolFailures: number;
  cumulativeToolFailureRate: number;
  failuresByTool: Record<string, number>;
  legacyFallbackUsed: false;
  legacyFallbackReason: null;
}

function toolResultFailed(event: AgentRunEvent): boolean {
  if (event.type !== 'tool.call.completed') return false;
  const data = isRecord(event.data) ? event.data : {};
  if (data.isError === true) return true;
  const output = isRecord(data.output) ? data.output : {};
  const details = isRecord(output.details) ? output.details : {};
  return details.ok === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Process-lifetime operational counters for the Agent-only Studio message path. */
export class AgentWorkflowMetrics {
  private cumulativeRuns = 0;
  private cumulativeToolCalls = 0;
  private cumulativeToolFailures = 0;

  record(args: {
    projectId: string;
    runId: string;
    outcome: AgentRunOutcome;
    events: AgentRunEvent[];
  }): AgentRunMetrics {
    const toolNames = new Map<string, string>();
    const failuresByTool: Record<string, number> = {};
    let toolCalls = 0;
    let toolFailures = 0;

    for (const event of args.events) {
      const data = isRecord(event.data) ? event.data : {};
      if (event.type === 'tool.call.started') {
        toolCalls += 1;
        if (typeof data.callId === 'string' && typeof data.name === 'string') {
          toolNames.set(data.callId, data.name);
        }
      } else if (event.type === 'tool.call.completed' && toolResultFailed(event)) {
        toolFailures += 1;
        const callId = typeof data.callId === 'string' ? data.callId : '';
        const toolName = toolNames.get(callId) ?? 'unknown_tool';
        failuresByTool[toolName] = (failuresByTool[toolName] ?? 0) + 1;
      }
    }

    this.cumulativeRuns += 1;
    this.cumulativeToolCalls += toolCalls;
    this.cumulativeToolFailures += toolFailures;
    return {
      event: 'agent_run',
      projectId: args.projectId,
      runId: args.runId,
      outcome: args.outcome,
      toolCalls,
      toolFailures,
      toolFailureRate: toolCalls ? toolFailures / toolCalls : 0,
      cumulativeRuns: this.cumulativeRuns,
      cumulativeToolCalls: this.cumulativeToolCalls,
      cumulativeToolFailures: this.cumulativeToolFailures,
      cumulativeToolFailureRate: this.cumulativeToolCalls
        ? this.cumulativeToolFailures / this.cumulativeToolCalls
        : 0,
      failuresByTool,
      legacyFallbackUsed: false,
      legacyFallbackReason: null,
    };
  }
}
