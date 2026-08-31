/** Pure request policy for the Vite-only Atlas preview endpoint. */

import { PREVIEW_GRAPH } from './preview-graph.js';
import { previewSource } from './preview-media.js';

export interface PreviewApiResponse {
  readonly statusCode: number;
  readonly body: unknown;
  readonly contentType?: string;
  readonly assetPath?: string;
}

export function previewApiResponse(method: string, requestUrl: string): PreviewApiResponse {
  const path = new URL(requestUrl, 'http://atlas-preview.local').pathname;
  if (method === 'GET' && path === '/graph') {
    return { statusCode: 200, body: PREVIEW_GRAPH };
  }
  if (method === 'GET' && path === '/formation') {
    return { statusCode: 200, body: [] };
  }
  if (method === 'GET' && path.startsWith('/evidence/')) {
    const evidenceRef = decodeURIComponent(path.slice('/evidence/'.length));
    const source = previewSource(evidenceRef);
    if (source?.available === true && source.assetPath !== null) {
      return {
        statusCode: 200,
        body: null,
        contentType: source.assetPath.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
        assetPath: source.assetPath,
      };
    }
    return {
      statusCode: 404,
      body: {
        code: 'preview_evidence_unavailable',
        detail: 'This synthetic memory deliberately demonstrates unavailable source evidence.',
      },
    };
  }
  if (method !== 'GET') {
    return {
      statusCode: 403,
      body: {
        code: 'preview_read_only',
        detail: 'The Atlas preview cannot write data.',
      },
    };
  }
  return {
    statusCode: 404,
    body: {
      code: 'preview_route_not_found',
      detail: 'That resource is not part of the Atlas preview.',
    },
  };
}
