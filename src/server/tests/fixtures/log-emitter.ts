/**
 * Emits log lines through the real logger to the real process stdout so that V-014 can scan
 * genuine runtime output rather than an injected test sink.
 *
 * Run by src/server/tests/integration/log-scrubbing.test.ts via tsx.
 */
import { jobLogger, newCorrelationId, requestLogger } from '../../lib/logging/index.js';
import { fixtureDatabaseUrl, fixtureSecrets } from './log-fixture-secrets.js';

const correlationId = newCorrelationId();

const request = requestLogger({
  correlationId,
  userId: 'user-fixture',
  tenantId: 'tenant-fixture',
  route: 'POST /api/v1/auth/sign-in',
});

request.info('sign-in attempt', {
  email: 'user@example.com',
  password: fixtureSecrets.password,
});

request.info('token issued', {
  accessToken: fixtureSecrets.accessToken,
  refresh_token: fixtureSecrets.refreshToken,
});

request.info('bearer-authenticated request', {
  headers: {
    authorization: `Bearer ${fixtureSecrets.accessToken}`,
    'x-api-key': fixtureSecrets.apiKey,
    accept: 'application/json',
  },
  status: 200,
  durationMs: 12,
});

request.info('api credential regenerated', {
  credential: { id: 42, plaintextKey: fixtureSecrets.apiKey, pepper: fixtureSecrets.pepper },
});

request.error('attachment upload failed', {
  attachmentContent: 'JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGg',
  err: new Error(`storage rejected upload using ${fixtureSecrets.serviceRoleKey}`),
});

jobLogger({ jobName: 'alerts.sweep', correlationId }).error('job failed', {
  counts: { 'tenant-fixture': 3 },
  err: new Error(`connect ECONNREFUSED ${fixtureDatabaseUrl}`),
});
