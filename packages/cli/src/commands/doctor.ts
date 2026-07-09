import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliContext } from '../context.js';
import { ok } from '../output.js';

interface Check {
  name: string;
  status: 'ok' | 'warning' | 'missing' | 'error';
  value?: string;
  install_hint?: string;
  detail?: string;
}

function which(cmd: string): string | null {
  try {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    return execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

function localFfmpeg(projectRoot: string): string | null {
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidate = join(projectRoot, 'tools', 'ffmpeg', 'bin', binary);
  return existsSync(candidate) ? candidate : null;
}

function chromeCandidates(): string[] {
  return process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/microsoft-edge',
        ];
}

function version(cmd: string, args = '--version'): string | null {
  try {
    return execSync(`${cmd} ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')[0]
      ?? null;
  } catch {
    return null;
  }
}

export async function runDoctor(ctx: CliContext): Promise<void> {
  const checks: Check[] = [];

  // Node
  const nodeV = process.version;
  checks.push({
    name: 'node-version',
    status: parseInt(nodeV.slice(1)) >= 20 ? 'ok' : 'warning',
    value: nodeV,
    detail: 'html-video targets Node 20+',
  });

  // ffmpeg
  const ffmpeg = localFfmpeg(ctx.projectRoot) ?? which('ffmpeg');
  if (ffmpeg) {
    const ffmpegCmd = ffmpeg.includes('\n') ? 'ffmpeg' : `"${ffmpeg}"`;
    checks.push({ name: 'ffmpeg', status: 'ok', value: version(ffmpegCmd, '-version')?.split(' ')[2] ?? ffmpeg });
  } else {
    checks.push({
      name: 'ffmpeg',
      status: 'missing',
      install_hint: 'Install ffmpeg on PATH, or place ffmpeg at tools/ffmpeg/bin/ffmpeg.exe on Windows.',
    });
  }

  // chromium / chrome (for HF puppeteer)
  const chromiumOk = chromeCandidates().some((p) => existsSync(p));
  checks.push({
    name: 'chromium',
    status: chromiumOk ? 'ok' : 'warning',
    detail: chromiumOk ? 'Chrome found in standard location' : 'Chrome/Chromium not detected; HF render will need a browser',
  });

  // Engines
  for (const engine of ctx.engines.list()) {
    checks.push({
      name: `adapter-${engine.id}`,
      status: 'ok',
      value: engine.upstreamVersion,
      detail: `${engine.name} adapter loaded`,
    });
  }

  // Templates
  const tcount = ctx.templates.list().length;
  checks.push({
    name: 'templates',
    status: tcount >= 1 ? 'ok' : 'warning',
    value: `${tcount} discovered`,
    detail: tcount === 0 ? 'No templates found in templates/ — install or scaffold some' : undefined,
  });

  const overall: 'ok' | 'warning' | 'error' = checks.some((c) => c.status === 'error')
    ? 'error'
    : checks.some((c) => c.status === 'missing' || c.status === 'warning')
      ? 'warning'
      : 'ok';

  ok({
    overall,
    project_root: ctx.projectRoot,
    checks,
  });
}
