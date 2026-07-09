import type { AgentDef } from '../types.js';

export const cursorAgent: AgentDef = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  versionArgs: ['--version'],
  buildArgs(_prompt, _ctx) {
    // Cursor Agent refuses non-interactive runs in a fresh workspace unless
    // trust is explicit. Studio cannot answer the prompt, so opt in here.
    return ['--print', '--trust'];
  },
  streamFormat: 'plain',
  promptViaStdin: true,
  installUrl: 'https://cursor.com/cli',
};
