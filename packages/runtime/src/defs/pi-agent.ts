import type { AgentDef } from '../types.js';

/**
 * Pi Coding Agent CLI (`pi`).
 *
 * `-p` / `--print` is the non-interactive mode: print the response and exit.
 * Pi also merges piped stdin into the prompt in print mode, which lets us pass
 * long HTML-generation prompts without putting them on the command line.
 *
 * `--no-approve` keeps this Studio flow non-interactive by ignoring
 * project-local Pi settings for the run.
 */
export const piAgent: AgentDef = {
  id: 'pi-agent',
  name: 'Pi Agent',
  bin: 'pi',
  versionArgs: ['--version'],
  buildArgs(_prompt, _ctx) {
    return ['-p', '--no-approve'];
  },
  streamFormat: 'plain',
  promptViaStdin: true,
  installUrl: 'https://pi.dev/docs/latest/quickstart',
};
