const core = require('..');

const site = core({
  port: Number(process.env.PORT || 3000),
  jobs: { concurrency: 4 },
  observability: {
    endpoints: true,
    prefix: '/_core',
    diagnostics: true,
    tracing: { enabled: true }
  },
  resilience: {
    retries: 2,
    baseDelayMs: 50,
    maxDelayMs: 1000
  }
});

site.jobs.define('audit.write', async payload => {
  await site.publish('audit.created', payload);
  return { stored: true };
});

site.subscribe('audit.created', event => {
  site.logger.info({ event: 'audit.created', payload: event.payload });
});

site.plugins.register({
  name: 'example-plugin',
  version: '1.0.0',
  capabilities: ['example.read'],
  async setup(site) {
    site.examplePlugin = { enabled: true };
  },
  async teardown(site) {
    delete site.examplePlugin;
  }
});

(async () => {
  await site.plugins.enable('example-plugin');

  site.post('/api/work', async (req, res) => {
    const idem = await site.distributed.idempotency.run(
      String(req.headers['idempotency-key'] || 'work:' + Date.now()),
      async () => {
        const job = site.jobs.enqueue('audit.write', {
          body: req.body,
          at: new Date().toISOString()
        });
        return { jobId: job.id };
      }
    );

    res.status(idem.replayed ? 200 : 202).json(idem);
  });

  site.get('/api/platform-status', async (req, res) => {
    res.json(await site.observabilitySnapshot());
  });

  site.run();
})();
