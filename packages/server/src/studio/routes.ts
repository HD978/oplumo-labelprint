import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { repos } from '../store/repos.js';
import { StudioError, StudioService } from './service.js';

const service = new StudioService(path.join(config.dataDir, 'studio.json'), () =>
  repos.templates.all(),
);
export async function registerStudio(app: FastifyInstance, studio = service) {
  await app.register(async (scope) => {
    scope.setErrorHandler((error, _req, reply) => {
      if (error instanceof StudioError)
        return reply.code(error.statusCode).send({ error: error.message });
      scope.log.error(error);
      return reply.code(500).send({ error: 'Workspace operation failed' });
    });
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
