import { createHash } from 'node:crypto';
import {
  safeWorkDirectorySegment,
  type HtmlPublisher,
} from '@html-video/core';
import {
  loadOssConfig,
  uploadToAliyunOss,
} from './oss-config.js';

export function createHtmlOssPublisher(projectRoot: string): HtmlPublisher | undefined {
  const config = loadOssConfig(projectRoot);
  if (!config?.enabled) return undefined;

  return async ({ userId, projectId, nodeId, html }) => {
    const body = Buffer.from(html, 'utf8');
    const key = [
      config.prefix,
      'users',
      safeWorkDirectorySegment(userId, 'user'),
      'projects',
      safeWorkDirectorySegment(projectId, 'project'),
      'html',
      `${safeWorkDirectorySegment(nodeId, 'page')}.html`,
    ].filter(Boolean).join('/');
    const uploaded = await uploadToAliyunOss(config, {
      key,
      body,
      contentType: 'text/html; charset=utf-8',
    });
    return {
      bucket: uploaded.bucket,
      key: uploaded.key,
      url: uploaded.url,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
    };
  };
}
