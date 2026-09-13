const core = require('..');

const site = core({
  port: Number(process.env.PORT || 3000),
  request: {
    maxBodyBytes: 1024 * 1024
  },
  observability: {
    endpoints: true,
    prefix: '/_core',
    tracing: { enabled: true, max: 1000 }
  },
  gracefulShutdown: {
    signals: true,
    forceAfterMs: 5000
  }
});

const users = site.connectCollection('example_users');

site.use(site.rateLimitMiddleware({
  name: 'api',
  windowMs: 60_000,
  max: 300
}));

site.apiRoute('POST', '/api/users', {
  summary: 'Create user',
  tags: ['Users'],
  body: {
    type: 'object',
    required: ['name', 'email'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      email: { type: 'string', minLength: 5, maxLength: 320 }
    }
  },
  response: {
    type: 'object',
    required: ['ok', 'user'],
    properties: {
      ok: { type: 'boolean' },
      user: { type: 'object' }
    }
  }
}, async req => {
  const id = await users.newCode();
  const user = await users.add({
    id,
    name: req.body.name,
    email: req.body.email,
    createdAt: new Date().toISOString()
  });
  return { ok: true, user };
});

site.get('/api/users', async (req, res) => {
  const rows = await users.findMany({
    sort: { id: -1 },
    limit: Math.min(100, Number(req.query.limit || 25))
  });
  res.json({ rows });
});

site.get('/api/users/:id', async (req, res) => {
  const user = await users.findOne({ where: { id: String(req.params.id) } });
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  res.json(user);
});

site.enableOpenApiEndpoint('/openapi.json');

site.onShutdown(async () => {
  console.log('real-api shutdown complete');
});

site.run();
console.log('API:      http://localhost:' + (process.env.PORT || 3000) + '/api/users');
console.log('OpenAPI:  http://localhost:' + (process.env.PORT || 3000) + '/openapi.json');
console.log('Health:   http://localhost:' + (process.env.PORT || 3000) + '/_core/ready');
