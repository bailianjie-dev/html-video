import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

export interface OssConfig {
  enabled: boolean;
  provider: 'aliyun';
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  publicBaseUrl: string;
  prefix: string;
  sourcePath: string;
}

export interface OssUploadInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface OssUploadResult {
  bucket: string;
  key: string;
  url: string;
  etag: string | null;
}

export function loadOssConfig(projectRoot: string): OssConfig | null {
  const candidates = [
    join(projectRoot, '.html-video', 'oss.toml'),
    join(projectRoot, 'oss.toml'),
  ];
  const sourcePath = candidates.find((path) => existsSync(path));
  if (!sourcePath) return null;
  const parsed = parseOssToml(readFileSync(sourcePath, 'utf8'));
  if (!parsed) return null;
  return { ...parsed, sourcePath };
}

export function maskedOssConfig(config: OssConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    provider: config.provider,
    endpoint: config.endpoint,
    bucket: maskName(config.bucket),
    public_base_url: config.publicBaseUrl,
    prefix: config.prefix,
    source_path: config.sourcePath,
  };
}

export async function uploadToAliyunOss(config: OssConfig, input: OssUploadInput): Promise<OssUploadResult> {
  const endpoint = normalizeEndpoint(config.endpoint);
  const protocol = endpoint.protocol;
  const host = `${config.bucket}.${endpoint.host}`;
  const encodedKey = encodeOssKey(input.key);
  const path = `/${encodedKey}`;
  const url = `${protocol}//${host}${path}`;
  const date = new Date().toUTCString();
  const contentType = input.contentType || 'application/octet-stream';
  const stringToSign = [
    'PUT',
    '',
    contentType,
    date,
    `/${config.bucket}/${input.key}`,
  ].join('\n');
  const signature = createHmac('sha1', config.accessKeySecret)
    .update(stringToSign)
    .digest('base64');

  const headers = {
    Authorization: `OSS ${config.accessKeyId}:${signature}`,
    Date: date,
    Host: host,
    'Content-Type': contentType,
    'Content-Length': String(input.body.byteLength),
  };

  const etag = await new Promise<string | null>((resolveFn, reject) => {
    const req = (protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'PUT',
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolveFn(typeof res.headers.etag === 'string' ? res.headers.etag.replace(/^"|"$/g, '') : null);
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        reject(new Error(`OSS upload failed (${res.statusCode ?? 'unknown'}): ${body || res.statusMessage || 'no response body'}`));
      });
    });
    req.on('error', reject);
    req.write(input.body);
    req.end();
  });

  return {
    bucket: config.bucket,
    key: input.key,
    url: `${config.publicBaseUrl.replace(/\/+$/, '')}/${encodedKey}`,
    etag,
  };
}

function parseOssToml(raw: string): Omit<OssConfig, 'sourcePath'> | null {
  let inOss = false;
  const values: Record<string, string | number | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      inOss = section[1] === 'oss';
      continue;
    }
    if (!inOss) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]!] = parseTomlValue(match[2]!.trim());
  }

  const endpoint = asString(values.endpoint);
  const bucket = asString(values.bucket);
  const accessKeyId = asString(values.access_key_id);
  const accessKeySecret = asString(values.access_key_secret);
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) return null;

  return {
    enabled: asBoolean(values.enabled, false),
    provider: 'aliyun',
    endpoint,
    bucket,
    accessKeyId,
    accessKeySecret,
    publicBaseUrl: asString(values.public_base_url) || defaultPublicBaseUrl(endpoint, bucket),
    prefix: stripSlashes(asString(values.prefix) || 'html-video/dev'),
  };
}

function parseTomlValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const quoted = /^"([\s\S]*)"$/.exec(value);
  if (quoted) return quoted[1]!.replace(/\\"/g, '"');
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeEndpoint(endpoint: string): URL {
  return new URL(endpoint.match(/^https?:\/\//) ? endpoint : `https://${endpoint}`);
}

function defaultPublicBaseUrl(endpoint: string, bucket: string): string {
  const normalized = normalizeEndpoint(endpoint);
  return `${normalized.protocol}//${bucket}.${normalized.host}`;
}

function encodeOssKey(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function maskName(name: string): string {
  if (name.length <= 4) return '****';
  return `${name.slice(0, 2)}***${name.slice(-2)}`;
}
