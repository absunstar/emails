# @social-browser/core

**Social Browser Core v6** is a zero-external-runtime-dependency Node.js application platform for building APIs, web applications, background workers, WebSocket services, persistent local applications, and distributed runtimes.

> **Important:** Native Core is the default runtime. iSite compatibility is optional and is loaded only when you explicitly enable `compatibility: 'isite'`.


## Production is the default

`@social-browser/core` is production-oriented with zero configuration:

```js
const site = require('@social-browser/core')();
```

The default runtime uses memory-first file/template caching, automatic startup prewarm,
production HTTP keep-alive settings, a larger response cache, and no per-request tracing
overhead unless tracing is explicitly enabled.

Development behavior is opt-in:

```js
const site = require('@social-browser/core')({
  mode: 'development'
});
```

or:

```bash
NODE_ENV=development node server.js
```

Explicit application options always override the production defaults.

```js
console.log(site.runtimeProfile); // production | development
console.log(site.fileCache.stats());
```

## What is included

- HTTP / HTTPS server runtime
- Router, middleware, request and response helpers
- Native WebSocket server and client
- Built-in persistent Core Storage
- Portable ORM with optional MongoDB, PostgreSQL, MySQL and SQLite providers
- Models, schema utilities and migrations
- Local and distributed-style sessions
- Cache, locks, idempotency, shared rate-limit counters and leader election
- Job queue / background workers
- Platform event bus with pluggable external transport
- Plugin system
- OpenAPI 3.1 route contracts and validation
- Resilience: retry/backoff and circuit breakers
- Observability: metrics, traces, health/readiness and structured logging
- Graceful drain / shutdown
- Optional Node cluster runtime with worker heartbeat and rolling restart
- Static files, templates, uploads and downloads
- Protocol runtime and clients/servers
- TypeScript declarations
- Optional iSite compatibility layer
- Security, fuzz, stress, soak and release certification suites

## Requirements

- Node.js **18.18+**
- No external runtime dependency is required for Native Core.
- Database drivers are optional and are installed by the application only when that provider is used.

## Installation

From npm after publishing:

```bash
npm install @social-browser/core
```

For a local `.tgz` build:

```bash
npm install /absolute/path/to/social-browser-core-6.0.0.tgz
```

Or directly from the unpacked source while developing:

```js
const core = require('/path/to/social-browser-core-v6.0.0-universal');
```

---

# 1. The smallest application

```js
const core = require('@social-browser/core');

const site = core({
  port: 3000
});

site.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Hello from Social Browser Core'
  });
});

site.run();
```

Open:

```text
http://localhost:3000/
```

`site.run()` and `site.start()` are aliases.

## Async routes

```js
site.get('/time', async (req, res) => {
  await new Promise(resolve => setTimeout(resolve, 10));
  res.json({ now: new Date().toISOString() });
});
```

---

# 2. Recommended real-project structure

A practical project can start like this:

```text
my-app/
├── app.js
├── config.json
├── package.json
├── routes/
│   ├── health.js
│   └── users.js
├── services/
│   └── users-service.js
├── jobs/
│   └── email-jobs.js
├── plugins/
├── public/
├── uploads/
└── data/
```

`app.js`:

```js
const path = require('path');
const core = require('@social-browser/core');

const site = core({
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  cwd: __dirname,

  request: {
    maxBodyBytes: 5 * 1024 * 1024,
    maxFileBytes: 25 * 1024 * 1024,
    uploadDir: path.join(__dirname, 'uploads')
  },

  observability: {
    endpoints: true,
    prefix: '/_core',
    tracing: {
      enabled: true,
      max: 2000
    }
  },

  resilience: {
    retries: 2,
    baseDelayMs: 50,
    maxDelayMs: 1000,
    jitter: 0.2
  },

  gracefulShutdown: {
    signals: true,
    forceAfterMs: 5000
  }
});

site.static('/assets', path.join(__dirname, 'public'), {
  cacheControl: 'public, max-age=3600'
});

require('./routes/users')(site);
require('./jobs/email-jobs')(site);

site.onShutdown(async () => {
  console.log('Application cleanup complete');
});

site.run();
```

A route module:

```js
module.exports = site => {
  site.get('/api/users/:id', async (req, res) => {
    const users = site.connectCollection('users');
    const user = await users.findOne({
      where: { id: Number(req.params.id) }
    });

    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    res.json(user);
  });
};
```

---

# 3. Native Core vs iSite compatibility

## Native Core — recommended for new applications

```js
const site = require('@social-browser/core')();
```

Native defaults include:

```text
Session cookie     sb.sid
Session directory  .social-browser/sessions
Core Storage       .social-browser/data
Uploads            .social-browser/uploads
```

Native Core does **not** load `compat/isite`.

## iSite compatibility — legacy applications only

```js
const site = require('@social-browser/core')({
  compatibility: 'isite'
});
```

Or enable it later:

```js
site.useCompatibility('isite');
```

Remove it:

```js
site.removeCompatibility('isite');
```

Compatibility mode supplies the legacy iSite parser, routing/request/response compatibility, security/session aliases and other legacy surfaces. The Native Core runtime remains independent from this layer.

---

# 4. Routing

## Basic routes

```js
site.get('/users/:id', (req, res) => {
  res.json({
    id: req.params.id,
    search: req.query.search || null
  });
});

site.post('/users', (req, res) => {
  res.status(201).json(req.body);
});

site.put('/users/:id', handler);
site.patch('/users/:id', handler);
site.delete('/users/:id', handler);
site.all('/debug', handler);
```

Native Core also exposes explicit `onVERB` names. These are first-class APIs in Native mode (they do not require iSite compatibility) and are useful when route registration should be visually distinct from ordinary application methods:

```js
site.onGET('/users/:id', handler);
site.onPOST('/users', handler);
site.onPUT('/users/:id', handler);
site.onPATCH('/users/:id', handler);
site.onDELETE('/users/:id', handler);
site.onALL('/debug', handler);
site.onANY('/debug', handler);
```

`onGET` and the other `onVERB` methods also accept the compact static descriptor form used by Social Browser extensions:

```js
site.onGET({
  name: '/tool',
  path: '/absolute/path/to/index.html'
});
```

WebSocket routes use the same explicit naming convention:

```js
site.onWS('/ws/:room', (ws, req) => {
  ws.send(`connected:${req.params.room}`);
});
```

## Middleware

```js
site.use(async (req, res, next) => {
  const started = Date.now();
  await next();
  console.log(req.method, req.path, Date.now() - started, 'ms');
});
```

## Local rate limiting

```js
site.use(site.rateLimitMiddleware({
  name: 'public-api',
  windowMs: 60_000,
  max: 120,
  key: req => req.ip
}));
```

Response headers include the current rate-limit state.

---

# 5. Request object

Common Native request fields include:

```js
req.method
req.url
req.path
req.query
req.params
req.body
req.files
req.headers
req.cookies
req.ip
req.session
req.sessionID
req.user
```

Authentication helpers are also attached during request dispatch:

```js
req.isAuthenticated()
req.login(user)
req.logout()
req.setIdentity(ref, user)
req.clearIdentity()
req.can(rule)
```

JSON bodies are parsed automatically for non-GET/HEAD/OPTIONS requests when the content type is JSON.

---

# 6. Response object

Typical usage:

```js
res.status(201).json({ ok: true });
res.status(404).send('Not found');
res.redirect('/login');
res.set('X-App-Version', '1');
```

File/static responses support ETag and byte-range behavior where applicable.

---

# 7. Static files

```js
site.static('/assets', './public', {
  cacheControl: 'public, max-age=3600'
});
```

The static server includes:

- ETag
- Last-Modified
- `304 Not Modified`
- `206 Partial Content`
- `416 Range Not Satisfiable`
- symlink/realpath containment
- path traversal protection

---

# 8. Uploads

Native multipart parsing is built in.

```js
const site = core({
  request: {
    maxBodyBytes: 20 * 1024 * 1024,
    maxFileBytes: 50 * 1024 * 1024,
    uploadDir: './uploads'
  }
});

site.post('/upload', (req, res) => {
  res.json({
    fields: req.body,
    files: req.files
  });
});
```

Uploaded file metadata includes fields such as:

```text
filepath
originalFilename
newFilename
mimetype
size
```

---

# 9. Templates

Native Core includes a small built-in renderer.

```html
<h1>{{ user.name }}</h1>
<div>{{{ trustedHtml }}}</div>

{{#if user}}
  Welcome {{user.name}}
{{/if}}

{{#each rows}}
  <div>{{item.name}}</div>
{{/each}}
```

Double braces escape HTML. Triple braces render trusted HTML without escaping.

For legacy iSite HTML parser behavior, use `compatibility: 'isite'`.

---

# 10. Sessions — local Native mode

Sessions are persistent by default.

```js
site.get('/counter', (req, res) => {
  req.session.count = (req.session.count || 0) + 1;

  res.json({
    sessionId: req.sessionID,
    count: req.session.count
  });
});
```

Explicit save:

```js
await req.session.$save();
```

Destroy:

```js
await req.session.destroy();
```

In the normal synchronous Native SessionStore these helpers may complete synchronously; using `await` keeps application code compatible with distributed async sessions.

---

# 11. Distributed Native sessions

For more than one process/server, switch the Native session backend to a shared cache adapter:

```js
site.setDistributedCache(sharedAdapter);
site.useDistributedSessions();
```

The built-in memory adapter is useful for one process, tests and development. A real multi-server deployment should supply a genuinely shared external adapter.

Adapter contract:

```js
const adapter = {
  async get(key) {},
  async set(key, value, options) {},
  async delete(key) {},

  // required for distributed rate limits
  async increment(key, amount, options) {}
};

site.setDistributedCache(adapter);
```

---

# 12. Core Storage — zero-dependency persistence

The easiest database is the built-in Core provider:

```js
const users = site.connectCollection('users');

const user = await users.add({
  id: 1,
  name: 'Amr',
  active: true
});

const rows = await users.findMany({
  where: { active: true },
  sort: { id: -1 },
  limit: 50
});
```

Default storage directory:

```text
.social-browser/data
```

## Common collection operations

```js
await users.add(doc);
await users.insertMany(docs);

await users.findOne({ where });
await users.findMany({ where, sort, limit, skip, projection });
await users.count({ where });
await users.distinct('country', { where });

await users.updateOne({ where, set });
await users.updateMany({ where, set });

await users.deleteOne({ where });
await users.deleteMany({ where });

await users.replaceOne(where, replacement, { upsert: true });
await users.upsert(where, set);
await users.bulkWrite(operations);
```

---

# 13. Portable ORM filters

Examples:

```js
await users.findMany({
  where: {
    age: { $gte: 18, $lt: 65 },
    status: { $in: ['active', 'pending'] }
  }
});
```

Logical filters:

```js
where: {
  $or: [
    { role: 'admin' },
    { permissions: { $in: ['users.manage'] } }
  ]
}
```

The portable query contract includes:

```text
$eq
$ne
$gt
$gte
$lt
$lte
$in
$nin
$exists
$and
$or
$nor
$not
$regex
```

Nested document paths are supported by the document-oriented providers where applicable.

Core also applies query-complexity and unsafe-regex guards before provider execution.

---

# 14. Projection, sorting and pagination

```js
const users = await collection.findMany({
  where: { active: true },
  projection: {
    name: 1,
    email: 1,
    _id: 0
  },
  sort: {
    createdAt: -1
  },
  skip: 0,
  limit: 25
});
```

---

# 15. Aggregation

Portable stages include:

```text
$match
$sort
$skip
$limit
$project
$count
$group
```

Group example:

```js
const totals = await orders.aggregate([
  { $match: { status: 'paid' } },
  {
    $group: {
      _id: '$country',
      revenue: { $sum: '$amount' },
      largest: { $max: '$amount' },
      orders: { $sum: 1 }
    }
  },
  { $sort: { revenue: -1 } }
]);
```

Supported group accumulators include:

```text
$sum
$min
$max
$first
$push
```

MongoDB can also expose its native driver capabilities when the MongoDB provider is used.

---

# 16. Models

```js
site.defineModel('users', {
  provider: 'core'
});

const model = site.getModel('users');
const users = model.collection();
```

For SQL relational providers a model can include schema metadata.

---

# 17. SQL relational schema

Example:

```js
site.defineModel('users', {
  provider: 'sqlite',
  mode: 'relational',
  schema: {
    version: 1,
    columns: {
      id: {
        type: 'integer',
        primary: true
      },
      name: {
        type: 'string',
        required: true
      },
      age: {
        type: 'integer'
      },
      metadata: {
        type: 'json'
      }
    }
  }
});

const users = site.connectCollection('users');
await users.ready();
```

Supported schema types include the Core relational type set such as strings/text, integers/numbers, booleans, dates, JSON and UUID values.

---

# 18. Database providers

Native Core does not force database drivers into your application.

| Provider | Core provider name | Application driver |
|---|---|---|
| Built-in Core Storage | `core` | none |
| MongoDB | `mongodb` | `mongodb` |
| PostgreSQL | `postgres` / `postgresql` | `pg` |
| MySQL | `mysql` | `mysql2` |
| SQLite | `sqlite` | `better-sqlite3` |

Example PostgreSQL setup:

```bash
npm install pg
```

```js
const site = core({
  database: {
    provider: 'postgres',
    postgres: {
      connectionString: process.env.DATABASE_URL
    }
  }
});
```

Check provider availability:

```js
console.log(site.databaseProviderStatus('postgres'));
console.log(site.databaseProviderStatuses());
```

Health probe:

```js
const health = await site.databaseHealth('postgres');
```

---

# 19. Migrations

```js
site.migrations.create('users', {
  provider: 'sqlite',
  collectionOptions: {
    mode: 'relational',
    schema
  },
  migrations: [
    {
      version: 2,
      async up({ execute }) {
        await execute(
          'CREATE INDEX IF NOT EXISTS "idx_users_name" ON "users" ("name")'
        );
      },
      async down({ execute }) {
        await execute('DROP INDEX IF EXISTS "idx_users_name"');
      }
    }
  ]
});

await site.migrations.up('users', 'sqlite');
await site.migrations.down('users', 'sqlite', { target: 1 });

console.log(await site.migrations.status('users', 'sqlite'));
```

Schema comparison:

```js
const diff = site.schema.diff(oldSchema, newSchema);
```

---

# 20. Transactions

```js
const users = site.connectCollection('users');

await users.transaction(async tx => {
  // provider-specific transaction context
});
```

Transaction details depend on the selected provider. SQL/MongoDB use their provider capabilities when the corresponding real driver is installed.

---

# 21. OpenAPI 3.1 route contracts

For production APIs, `site.apiRoute()` can validate requests and generate API metadata at the same time.

```js
site.apiRoute('POST', '/api/users', {
  summary: 'Create a user',
  tags: ['Users'],

  body: {
    type: 'object',
    required: ['name', 'email'],
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        minLength: 2,
        maxLength: 100
      },
      email: {
        type: 'string',
        minLength: 5,
        maxLength: 320
      }
    }
  },

  response: {
    type: 'object',
    required: ['ok', 'id'],
    properties: {
      ok: { type: 'boolean' },
      id: { type: 'integer' }
    }
  }
}, async req => {
  return {
    ok: true,
    id: 100
  };
});
```

Expose the generated spec:

```js
site.enableOpenApiEndpoint('/openapi.json');
```

Or obtain it programmatically:

```js
const document = site.openapiDocument();
```

You can also register reusable schemas/security schemes with `site.openapi`.

---

# 22. WebSocket

```js
site.onWS('/ws/:room', (ws, req) => {
  ws.json({
    type: 'connected',
    room: req.params.room
  });

  ws.on('message', (message, isBinary) => {
    if (!isBinary) {
      ws.send(`echo:${message}`);
    }
  });

  ws.on('close', () => {
    console.log('socket closed');
  });
});
```

Built-in WebSocket protections include maximum frame and receive-buffer limits.

---

# 23. Cache

The original local cache is available through:

```js
site.cache
```

The v6 platform distributed adapter surface is:

```js
site.distributed.cache
```

Built-in memory distributed cache:

```js
await site.distributed.cache.set('settings', { x: 1 }, {
  ttlMs: 60_000
});

const settings = await site.distributed.cache.get('settings');
```

Additional operations:

```js
await site.distributed.cache.increment('counter', 1, { ttlMs: 60_000 });
await site.distributed.cache.compareAndSet('state', 'old', 'new');
await site.distributed.cache.getOrSet('key', loadValue, { ttlMs: 10_000 });
```

---

# 24. Locks

```js
const lock = await site.distributed.locks.acquire('invoice:100', {
  ttlMs: 30_000,
  waitMs: 2_000
});

if (!lock) {
  throw new Error('Could not acquire lock');
}

try {
  // exclusive work
} finally {
  await lock.release();
}
```

Simpler form:

```js
await site.distributed.locks.using(
  'invoice:100',
  async () => {
    // exclusive work
  },
  { ttlMs: 30_000, waitMs: 2_000 }
);
```

---

# 25. Idempotency

Useful for payments, webhooks and retryable APIs:

```js
const result = await site.distributed.idempotency.run(
  'payment:order-100',
  async () => {
    return chargeCustomer();
  }
);

console.log(result.replayed, result.value);
```

---

# 26. Distributed rate limits

```js
const hit = await site.distributed.rateLimit(
  `user:${userId}`,
  100,
  60_000
);

if (!hit.allowed) {
  return res.status(429).json({ error: 'RATE_LIMITED' });
}
```

For a real multi-server rate limit, the installed distributed cache adapter must provide an atomic `increment()` implementation.

---

# 27. Leader election

```js
const leader = await site.distributed.leader.campaign();

if (leader) {
  console.log('This process is the leader');
}
```

Check:

```js
site.distributed.leader.isLeader();
```

Release leadership:

```js
await site.distributed.leader.resign();
```

Useful for one-per-cluster schedulers, migrations, cron coordinators and maintenance tasks.

---

# 28. Event bus

Publish:

```js
await site.publish('orders.created', {
  id: 100
});
```

Subscribe:

```js
const unsubscribe = site.subscribe(
  'orders.created',
  event => {
    console.log(event.payload);
  }
);

unsubscribe();
```

External transport:

```js
site.setEventAdapter({
  async publish(topic, payload, meta) {
    // send to Redis Streams, NATS, Kafka bridge, etc.
  }
});
```

The external transport is deliberately application-owned; Core stays zero-runtime-dependency.

---

# 29. Background jobs

Define:

```js
site.jobs.define('email.send', async payload => {
  console.log('sending email to', payload.to);
  return { sent: true };
}, {
  retryDelayMs: 500
});
```

Queue:

```js
const job = site.jobs.enqueue('email.send', {
  to: 'user@example.com'
}, {
  priority: 10,
  maxAttempts: 5,
  idempotencyKey: 'welcome:user-100'
});
```

Schedule:

```js
site.jobs.schedule(
  'email.send',
  { to: 'later@example.com' },
  Date.now() + 60_000
);
```

Status:

```js
site.jobs.get(job.id);
site.jobs.list({ state: 'failed' });
site.jobs.stats();
```

Control:

```js
site.jobs.cancel(job.id);
site.jobs.retry(job.id);
```

The built-in queue is process-local. Use its APIs directly for local workers, or bridge job persistence/transport through an application plugin/external adapter for a multi-server durable queue.

---

# 30. Plugins

```js
site.plugins.register({
  name: 'billing',
  version: '1.0.0',
  capabilities: ['billing.read', 'billing.write'],

  async setup(site, options) {
    site.billing = {
      enabled: true
    };

    return {
      startedAt: Date.now()
    };
  },

  async teardown(site) {
    delete site.billing;
  }
});

await site.plugins.enable('billing');
```

Check capability:

```js
site.plugins.hasCapability('billing.write');
```

List:

```js
site.plugins.list();
```

Plugins are disabled as part of graceful shutdown.

---

# 31. Retry and circuit breaker

General retry wrapper:

```js
const result = await site.withRetry(
  'remote.catalog.read',
  async ({ attempt }) => {
    return fetchCatalog();
  },
  {
    retries: 3,
    baseDelayMs: 50,
    maxDelayMs: 1000,
    jitter: 0.2
  }
);
```

Database-oriented helper:

```js
await site.databaseOperation(
  'postgres',
  'read',
  async () => queryDatabase()
);
```

Read/health/metadata operations can be retried. **Write operations default to zero automatic retries** unless the application explicitly opts in and guarantees idempotency.

Circuit breaker snapshots:

```js
console.log(site.resilience.snapshot());
```

---

# 32. Observability

Enable operational endpoints:

```js
const site = core({
  observability: {
    endpoints: true,
    prefix: '/_core',
    diagnostics: true,
    tracing: {
      enabled: true,
      max: 2000
    }
  }
});
```

Endpoints:

```text
/_core/live
/_core/ready
/_core/metrics
/_core/diagnostics   # only when diagnostics=true
```

## Tracing

```js
const span = site.trace('checkout.process', {
  orderId: 100
});

try {
  // work
  span.setAttribute('items', 4);
} catch (error) {
  span.error(error);
  throw error;
} finally {
  span.end();
}
```

HTTP requests are traced automatically when tracing is enabled.

Recent traces:

```js
site.tracer.recent(100);
```

## Metrics

```js
const text = site.prometheusMetrics();
```

The metrics endpoint exports Core counters/timings plus process memory and runtime state.

## Diagnostics snapshot

```js
const diagnostics = await site.observabilitySnapshot();
```

It includes runtime state such as:

- liveness/readiness
- metrics
- traces
- resilience/circuit breakers
- distributed cache stats
- leader state
- event bus stats
- jobs
- plugins
- cluster workers
- masked configuration
- protocol health
- security state

---

# 33. Structured logging

Human-readable default:

```js
site.logger.info('server started');
```

JSON logs:

```js
const site = core({
  logger: {
    json: true,
    level: 'info',
    base: {
      app: 'orders-api',
      environment: process.env.NODE_ENV
    }
  }
});
```

Child logger:

```js
const requestLog = site.logger.child({
  requestId: 'abc'
});

requestLog.info({ event: 'checkout' });
```

---

# 34. Configuration

Use normal JavaScript options for the main application configuration. The v6 config manager can also combine config files, profiles and environment overrides.

`config.json`:

```json
{
  "default": {
    "port": 3000,
    "features": {
      "payments": false
    }
  },
  "profiles": {
    "production": {
      "port": 8080,
      "features": {
        "payments": true
      }
    }
  }
}
```

```js
const site = core({
  config: {
    file: './config.json',
    profile: process.env.NODE_ENV || 'development'
  }
});
```

Read:

```js
site.config.get('features.payments', false);
```

Masked diagnostics-safe snapshot:

```js
site.config.snapshot({ masked: true });
```

Environment variables use `__` for nested paths:

```text
SB_CORE_DATABASE__HOST=127.0.0.1
SB_CORE_FEATURES__PAYMENTS=true
```

---

# 35. Graceful lifecycle

Drain manually:

```js
await site.drain({ timeoutMs: 5000 });
```

During drain, new HTTP requests receive `503 Service Unavailable` while in-flight work receives a grace period.

Shutdown hook:

```js
site.onShutdown(async () => {
  await closeExternalClient();
});
```

Stop:

```js
await site.stop({
  drainTimeoutMs: 5000,
  forceAfterMs: 5000
});
```

The stop sequence closes/clears:

- scheduler jobs
- background job queue
- leader lease
- plugins
- cluster runtime
- shutdown hooks
- HTTP servers/connections
- protocol servers
- ORM/database resources
- signal handlers

## OS signal handlers

Signal handling is opt-in:

```js
site.installSignalHandlers({
  signals: ['SIGTERM', 'SIGINT'],
  forceAfterMs: 5000
});
```

Or configure:

```js
const site = core({
  gracefulShutdown: {
    signals: true,
    forceAfterMs: 5000
  }
});
```

---

# 36. Cluster runtime

Cluster mode is optional:

```js
const site = core({
  cluster: {
    enabled: true,
    workers: 4,
    respawn: true,
    heartbeatMs: 2000
  }
});
```

The runtime tracks:

- worker id/state
- ready state
- heartbeat time
- RSS
- heap usage
- inflight request count
- worker exits

Status:

```js
site.cluster.status();
```

Rolling restart from the primary process:

```js
await site.cluster.rollingRestart({
  timeoutMs: 10_000,
  drainMs: 1000
});
```

Stop workers:

```js
await site.cluster.stop();
```

### Important cluster note

The built-in `cluster` module can distribute TCP connections between workers, but truly shared application state must still use shared backends/adapters. Do not rely on an in-memory cache, local sessions or a local job queue as distributed state across workers.

---

# 37. Security

Native Core includes application-layer protections such as:

- request body limits
- multipart limits
- URL/header/socket limits
- Host policy
- TRACE blocking
- CSRF/origin helpers
- SSRF target helper
- path traversal protection
- symlink containment
- WebSocket frame/buffer limits
- ORM query complexity bounds
- prototype-pollution path rejection
- unsafe regex guard
- connection/IP protection
- adaptive bans/circuit controls in SecurityShield

Examples:

```js
site.use(site.securityLimit('login', req => req.ip, {
  windowMs: 60_000,
  max: 20
}));
```

Origin guard:

```js
site.use(site.originGuard([
  'https://app.example.com'
]));
```

CSRF helper:

```js
site.use(site.csrfProtection());
```

Security runtime status:

```js
site.securityStatus();
```

> Core provides application-layer hardening. Volumetric DDoS protection still belongs in a reverse proxy, CDN, load balancer or firewall layer.

---

# 38. HTTPS

```js
const site = core({
  port: 3000,
  https: {
    enabled: true,
    port: 3443,
    keyFile: './certs/server.key',
    certFile: './certs/server.crt'
  }
});

site.run();
```

In many production environments, TLS termination is better handled by Nginx, HAProxy, a cloud load balancer or a CDN, with Core running HTTP behind it.

---

# 39. Protocol runtime

Core also exposes protocol-oriented capabilities, including the built-in/optional runtime surfaces for:

- HTTP / HTTPS / HTTP2
- TCP / TLS / UDP / DNS
- WebSocket / WSS
- FTP client/server
- SMTP client/server
- POP3 client/server
- IMAP client/server
- Redis RESP client/server
- MQTT client/broker
- SOCKS/proxy helpers
- HTTP proxy server
- SSH protocol helper surface

Useful APIs include:

```js
site.connectProtocol(uri, options);
site.createProtocolServer(protocol, options);
site.protocolCapabilities;
site.protocolSupervisor;
site.protocolMetrics;
```

Some protocol implementations intentionally provide a practical subset rather than a complete clone of every upstream protocol implementation. Check `protocolCapabilities` before depending on an advanced protocol feature.

---

# 40. TypeScript

The package ships `index.d.ts`.

```ts
import core = require('@social-browser/core');

const site = core({
  port: 3000
});

site.get('/hello', (req, res) => {
  res.json({ ok: true });
});
```

The definitions currently cover the main Site, Core options, ORM collection, provider and distributed adapter surfaces.

---

# 41. Production checklist

Before a real deployment:

1. Set explicit request/upload limits.
2. Decide whether local Core Storage is sufficient or configure a real external database provider.
3. If running multiple workers/servers, use a truly shared session/cache/lock adapter.
4. Do not enable iSite compatibility unless the application actually requires legacy behavior.
5. Enable health/readiness endpoints for the orchestrator/load balancer.
6. Keep diagnostics endpoint protected or disabled in public production environments.
7. Configure structured logs.
8. Add application-specific authentication and authorization rules.
9. Use HTTPS directly or terminate TLS in a trusted reverse proxy/load balancer.
10. Keep `trustProxy` disabled unless requests arrive only through a trusted proxy topology.
11. Use idempotency for payment/webhook/write retry workflows.
12. Avoid automatic retries for non-idempotent writes.
13. Register shutdown hooks for external clients.
14. Run the test/release gates before deploying.
15. Put volumetric DDoS protection upstream of the Node process.

See also `PRODUCTION-CHECKLIST.md`.

---

# 42. Testing and certification

Normal tests:

```bash
npm test
```

Zero dependency check:

```bash
npm run check
```

Major certification commands:

```bash
npm run certify:security
npm run certify:performance
npm run certify:reliability
npm run certify:observability
npm run certify:stress
npm run certify:distributed
npm run certify:cluster
npm run certify:platform
npm run certify:soak
npm run certify:databases
npm run certify:isite
```

Complete source release gate:

```bash
npm run certify
```

The release gate runs the full test/certification/audit/dry-publish suite.

The database certification intentionally reports unavailable optional infrastructure instead of producing a false PASS.

---

# 43. Current v6 certification status

The v6 source release was validated with:

```text
311 / 311 tests passing
0 npm audit vulnerabilities
zero external runtime dependencies
real Node cluster worker certification
8,000-request soak certification
17 / 17 Smart Code iSite compatibility processes starting
17 / 17 Smart Code processes uncaught-error free
```

Performance and soak numbers are environment-local regression measurements, not universal capacity claims.

---

# 44. Examples included with the package source

```text
examples/
├── 01-basic.js
├── 02-real-api.js
├── 03-advanced-platform.js
└── 04-isite-compat.js
```

Start with `examples/01-basic.js`, then move to `02-real-api.js` for a realistic API structure.

---

# 45. Recommended learning path

### Beginner

Learn:

```text
core()
site.get/post
req.params/query/body
res.json/status
site.run
```

Then add:

```text
Core Storage
sessions
static files
rate limiting
```

### Intermediate

Add:

```text
models
portable ORM queries
migrations
OpenAPI contracts
WebSocket
jobs
plugins
structured logging
```

### Advanced

Use:

```text
distributed sessions
locks
idempotency
leader election
external event/cache adapters
resilience
observability
cluster runtime
graceful rolling operations
soak/stress certification
```

### Legacy iSite application

Use:

```js
core({ compatibility: 'isite' });
```

and keep new Native Core code separated from compatibility-specific APIs wherever possible.

---

# License

MIT

---

# Core File & Template Cache

`@social-browser/core` includes a Native file/template performance engine. It is not an iSite-only feature; `compatibility: 'isite'` reuses the same Core engine.

## Default usage

No extra setup is required:

```js
const core=require('@social-browser/core');
const site=core();

site.render('page.html',{title:'Hello'});
site.static('/assets','./site_files');
```

Repeated template/static reads are served from the Core memory cache when the file is within the configured cacheable-size limit.

## Production configuration

```js
const site=core({
  fileCache:{
    enabled:true,
    mode:'production',
    maxEntries:10000,
    maxBytes:256*1024*1024,
    maxEntryBytes:8*1024*1024,
    maxCompiledEntries:4000,
    maxCompiledBytes:128*1024*1024,
    prewarm:true,
    prewarmExtensions:['.html','.css','.js','.json','.svg']
  }
});
```

Production mode is deliberately memory-first: after a file is cached, Core does not issue a filesystem `stat()` on every request. Core writes and deletes invalidate automatically.

## Development configuration

```js
const site=core({
  fileCache:{
    mode:'development',
    validation:'mtime',
    validateIntervalMs:250
  }
});
```

This checks modified times periodically rather than on every cache hit, so edited templates refresh without restoring the old per-request disk-I/O cost.

## Explicit cached reads

```js
const text=site.readFileCachedSync('./data/template.html');
const asyncText=await site.readFileCached('./data/template.html');
const buffer=site.readBufferCachedSync('./images/logo.png');
```

The traditional `readFile/readFileSync` APIs remain normal filesystem reads when an application explicitly wants uncached I/O.

## Invalidation

```js
site.invalidateFileCache('./site_files/html/home.html');
site.fileCache.clear();
```

Template dependencies are tracked. Invalidating an imported fragment also invalidates compiled parents that depend on it.

## Prewarm

```js
site.prewarmFiles('./site_files',{
  text:true,
  extensions:['.html','.css','.js']
});
```

## Cache statistics

```js
console.log(site.fileCache.stats());
```

Statistics include hits/misses, memory usage, LRU evictions, compiled-template hit rate, dependency count, invalidations and prewarm totals.

## Large files

Files larger than `maxEntryBytes` are intentionally streamed/read from disk rather than retained in memory. This prevents video, archive and other large downloads from exhausting the process heap.

## iSite compatibility

With:

```js
const site=core({compatibility:'isite'});
```

the compatibility parser uses the **same** Native Core cache for HTML, imports, master pages, JS/CSS/TXT content and compiled HTML trees. Request-specific session/data/permission processing still runs per request on a cloned tree; user-specific output is never stored as a shared compiled AST.

Run the cache certification with:

```bash
npm run certify:file-cache
```

---

## Familiar framework aliases

Native Core intentionally exposes familiar names where the behavior can map cleanly to the same internal implementation. These aliases do **not** enable iSite compatibility.

```js
const site = require('@social-browser/core')();

// Express-style
site.use(middleware);
site.route('/users')
  .get(listUsers)
  .post(createUser);
site.listen(3000);

// Fastify-style route object
site.route({
  method: 'GET',
  url: '/health',
  handler: (req, reply) => reply.send('ok')
});

// Hapi-style route object
site.route({
  method: 'GET',
  path: '/status',
  handler: (req, res) => res.json({ ok: true })
});

// Fastify-style decorators
site.decorate('service', service);
site.decorateRequest('tenant', null);
site.decorateReply('meta', null);

// WebSocket aliases
site.onWS('/ws', handler);
site.websocket('/ws2', handler);
```

Route aliases currently include `get`, `post`, `put`, `patch`, `delete`, `head`, `all` and the explicit `onGET`, `onPOST`, `onPUT`, `onPATCH`, `onDELETE`, `onHEAD`, `onOPTIONS`, `onALL`, `onANY` names. `site.options` remains the Core configuration object; HTTP OPTIONS routes use `onOPTIONS()`, `routeOptions()`, or `route('/x').options()`.

Aliases are added only when their semantics can be kept coherent with Core. A popular-library name is not added merely for cosmetic compatibility if it would imply a different lifecycle or isolation model.

## Plugin scopes

See `PLUGIN-SCOPES.md` for opt-in route/decorator/middleware encapsulation and nested plugin prefixes.


## Scoped lifecycle hooks

Plugin scopes support Fastify-familiar lifecycle hooks without making them global:

```js
site.register({
  name: 'api',
  setup(app) {
    app.addHook('onRequest', async (req, reply) => {
      // Runs only for routes in this plugin scope.
    });
    app.addHook('preHandler', (req, reply, done) => done());
    app.addHook('onResponse', async (req, reply) => {});
    app.addHook('onClose', async (app) => {});
    app.get('/health', (req, reply) => reply.send('ok'));
  }
}, { encapsulate: true, prefix: '/api' });
```

Nested scopes inherit parent hooks in root-to-child order. `onClose` runs in reverse plugin activation order during shutdown, so child scopes close before parents. See `PLUGIN-HOOKS.md`.


---

## Runtime storage root and permissions

Core resolves its built-in persistent directories from the configured `cwd`, not from the Node process working directory.

```js
const site = core({
  cwd: '/writable/application-data'
});
```

Default locations become:

```text
<writable/application-data>/.social-browser/sessions
<writable/application-data>/.social-browser/data
<writable/application-data>/.social-browser/uploads
```

When `session.enabled` is `false`, the SessionStore performs no session-directory creation or other session disk initialization. This is important for applications installed in read-only locations such as Windows `Program Files`.

Applications that prefer availability over persistent sessions can explicitly opt into an in-memory fallback when the session directory cannot be created:

```js
const site = core({
  cwd: '/preferred/data/path',
  session: {
    enabled: true,
    onStorageError: 'memory'
  }
});
```

The default remains fail-fast for enabled persistent sessions, so server applications do not silently lose session persistence. `fallbackToMemory: true` is an alias for `onStorageError: 'memory'`.
