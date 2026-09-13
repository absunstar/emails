const core = require('..');

const site = core({
  port: Number(process.env.PORT || 3000)
});

site.get('/', (req, res) => {
  res.json({
    ok: true,
    version: site.version,
    mode: 'native-core'
  });
});

site.get('/counter', (req, res) => {
  req.session.count = (req.session.count || 0) + 1;
  res.json({ count: req.session.count });
});

site.run();
console.log('Basic example: http://localhost:' + (process.env.PORT || 3000));
