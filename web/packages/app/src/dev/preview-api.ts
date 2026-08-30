/** Pure request policy for the Vite-only Atlas preview endpoint. */

import { PREVIEW_GRAPH } from './preview-graph.js';

export interface PreviewApiResponse {
  readonly statusCode: number;
  readonly body: unknown;
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
    return {
      statusCode: 404,
      body: {
        code: 'preview_evidence_unavailable',
        detail: 'Synthetic Atlas preview data has no source media.',
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
