/**
 * Local runner for the /api/v1 function (T-009).
 *
 * `vercel dev` is the reference local runner (`npm run dev:vercel`), but it needs the Vercel CLI
 * installed globally and a linked project. This script is the dependency-free equivalent: it hosts
 * the very same Hono app the Vercel function exports, over `node:http`, using nothing but Node
 * built-ins and the already-approved `tsx` loader. Same middleware, same error mapping, same logs.
 *
 *   npm run dev:api            # http://127.0.0.1:3001/api/v1/health
 *
 * Environment comes from `.env.local` via Node's own `--env-file-if-exists` (see package.json);
 * the typed config module remains the only reader of the process environment.
 *
 * T-018 wires the SPA's Vite dev server to proxy `/api/v1` at whichever port this prints.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { defaultApiAccessDeps } from '../../src/server/domains/api-access/index.js';
import { defaultIntakeDeps } from '../../src/server/domains/intake/index.js';
import { defaultAlertsDeps } from '../../src/server/domains/alerts/index.js';
import { defaultAssignmentsDeps } from '../../src/server/domains/assignments/index.js';
import { defaultBrokersDeps } from '../../src/server/domains/brokers/index.js';
import { defaultBusinessRulesDeps } from '../../src/server/domains/business-rules/index.js';
import { defaultDashboardsDeps } from '../../src/server/domains/dashboards/index.js';
import { defaultExportsDeps } from '../../src/server/domains/exports/index.js';
import { defaultReportsDeps } from '../../src/server/domains/reports/index.js';
import { defaultSearchDeps } from '../../src/server/domains/search/index.js';
import { defaultLeadsDeps } from '../../src/server/domains/leads/index.js';
import {
  defaultAttachmentsDeps,
  defaultQuotesDeps,
} from '../../src/server/domains/quotes/index.js';
import { defaultPartiesDeps } from '../../src/server/domains/parties/index.js';
import {
  defaultGlobalTemplateDeps,
  defaultReferenceDataDeps,
} from '../../src/server/domains/reference-data/index.js';
import { defaultTenantsDeps } from '../../src/server/domains/tenants/index.js';
import { defaultMeDeps, defaultUserManagerDeps } from '../../src/server/domains/users/index.js';
import { defaultRbacDeps } from '../../src/server/domains/rbac/index.js';
import { defaultAuthDeps } from '../../src/server/lib/auth/index.js';
import { getConfig } from '../../src/server/lib/config/index.js';
import { logger } from '../../src/server/lib/logging/index.js';
import { defaultAlertReevaluationSeam } from '../../src/server/jobs/runtime.js';
import { API_BASE_PATH, buildApp } from '../../src/server/lib/router/app.js';
import { defaultTenancyDeps } from '../../src/server/lib/tenancy/index.js';

const DEFAULT_PORT = 3001;

function toWebRequest(req: IncomingMessage, origin: string): Request {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', origin);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      headers.append(name, single);
    }
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    res.write(chunk);
  }
  res.end();
}

function main(): void {
  const config = getConfig();
  // The T-034 alert re-evaluation seam, on BOTH slots — same reasoning as the Vercel root. The dev
  // server must publish the same messages the deployment does, or `npm run queue:worker` drains a
  // queue nothing ever writes to and local job behaviour silently diverges from production.
  const onLeadChanged = defaultAlertReevaluationSeam(config);
  const app = buildApp({
    config,
    auth: defaultAuthDeps(config),
    tenancy: defaultTenancyDeps(),
    rbac: defaultRbacDeps(),
    me: defaultMeDeps(),
    tenants: defaultTenantsDeps(),
    globalTemplate: defaultGlobalTemplateDeps(),
    userManager: defaultUserManagerDeps(),
    referenceData: defaultReferenceDataDeps(),
    brokers: defaultBrokersDeps(),
    parties: defaultPartiesDeps(),
    leads: defaultLeadsDeps(onLeadChanged),
    quotes: defaultQuotesDeps(onLeadChanged),
    attachments: defaultAttachmentsDeps(config),
    dashboards: defaultDashboardsDeps(),
    exports: defaultExportsDeps(),
    reports: defaultReportsDeps(),
    search: defaultSearchDeps(),
    businessRules: defaultBusinessRulesDeps(),
    alerts: defaultAlertsDeps(),
    assignments: defaultAssignmentsDeps(),
    apiAccess: defaultApiAccessDeps(config),
    intake: defaultIntakeDeps(config),
  });
  // Fixed port: reading a PORT override would mean reading the process environment directly,
  // which only the typed config module is allowed to do (AC-010).
  const port = DEFAULT_PORT;
  const origin = `http://127.0.0.1:${port}`;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await writeWebResponse(await app.fetch(toWebRequest(req, origin)), res);
      } catch (error) {
        // The app's own error boundary handles handler failures; this only catches adapter faults.
        logger.error('local api runner failed to serve a request', { err: error });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal Server Error');
      }
    })();
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info('local api runner listening', {
      url: `${origin}${API_BASE_PATH}`,
      health: `${origin}${API_BASE_PATH}/health`,
    });
  });
}

main();
