import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { repos } from '../store/repos.js';
import { BulkService } from './bulk.js';
import { readExcel } from './excel.js';
import { StudioError, StudioService } from './service.js';

const bulk = new BulkService(path.join(config.dataDir, 'bulk'), () => repos.templates.all());
const service = new StudioService(path.join(config.dataDir, 'studio.json'), () =>
  repos.templates.all(),
);
export async function registerStudio(app: FastifyInstance, studio = service, bulkService = bulk) {
  await app.register(async (scope) => {
    scope.setErrorHandler((error, _req, reply) => {
      if (error instanceof StudioError)
        return reply.code(error.statusCode).send({ error: error.message });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: error.message });
      scope.log.error(error);
      return reply.code(500).send({ error: 'Workspace operation failed' });
    });
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post<{ Querystring: { name?: string } }>(
      '/api/studio/excel/read',
      { bodyLimit: 2 * 1024 * 1024 },
      (req) => readExcel(req.query.name ?? '', req.body as Buffer),
    );
    scope.post('/api/studio/bulk/preview', (req) => bulkService.preview(req.body));
    scope.get('/api/studio/bulk/history', () => bulkService.history());
    scope.post<{ Body: { input: unknown; fingerprint: unknown } }>(
      '/api/studio/bulk/pdf',
      async (req, reply) => {
        const result = await bulkService.generate(req.body?.input, req.body?.fingerprint);
        return reply
          .header(
            'Content-Type',
            result.record.format === 'zip' ? 'application/zip' : 'application/pdf',
          )
          .header(
            'Content-Disposition',
            `attachment; filename="oplumo-labels-${result.record.id.slice(0, 12)}.${result.record.format}"`,
          )
          .header('X-Label-Count', result.record.labels)
          .send(Buffer.from(result.data));
      },
    );
    scope.get('/api/studio', () => studio.view());
    scope.put('/api/studio/settings', (req) => studio.settings(req.body));
    scope.post('/api/studio/orders', (req) => studio.ingest(req.body));
    scope.post<{ Body: { deliveryDate?: unknown } }>('/api/studio/preview', (req) =>
      studio.preview(req.body?.deliveryDate),
    );
    scope.post<{ Body: { deliveryDate?: unknown } }>('/api/studio/batches', (req) =>
      studio.prepare(req.body?.deliveryDate),
    );
    scope.post<{ Params: { id: string } }>('/api/studio/batches/:id/approve', (req) =>
      studio.approve(req.params.id),
    );
  });
}
