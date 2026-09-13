const core = require('..');

// Use this only for a legacy iSite application.
const site = core({
  port: Number(process.env.PORT || 3000),
  compatibility: 'isite'
});

site.get('/compat-status', (req, res) => {
  res.json({
    ok: true,
    compatibility: !!site.compatibility.isite,
    cookieName: site.sessionStore.cookieName
  });
});

site.run();
