module.exports = function init(site) {
  const sendmail = require('sendmail')();
  const $emails = site.connectCollection('emails');
  const $emailsTracking = site.connectCollection('emailsTracking');

  site.trackEmail = function (email) {
    if (!email || !email.name || !email.ip) {
      return;
    }

    $emailsTracking.find(
      {
        where: {
          name: email.name,
        },
        select: {},
      },
      (err, doc) => {
        if (!err) {
          if (doc) {
            doc.ipList = doc.ipList || [];
            let index = doc.ipList.findIndex((d) => d.ip == email.ip);
            if (index === -1) {
              doc.ipList.push({
                ip: email.ip,
                date: new Date(),
              });
            } else {
              doc.ipList[index].date = new Date();
            }
            $emailsTracking.update(doc);
          } else {
            $emailsTracking.add({
              name: email.name,
              ipList: [{ ip: email.ip, date: new Date() }],
            });
          }
        }
      }
    );
  };

  site.onGET({
    name: 'admin',
    path: __dirname + '/site_files/html/index.html',
    parser: 'html css js',
    compress: true,
    require: { features: ['browser.social'] },
  });

  site.onGET({
    name: ['', 'free', 'vip'],
    path: __dirname + '/site_files/html/free.html',
    parser: 'html css js',
    compress: true,
  });

  site.onPOST({ name: '/api/emails/add', require: { features: [] } }, (req, res) => {
    let response = {};
    response.done = false;
    let doc = req.body;

    if (doc.source !== 'isite' && !req.session.user) {
      response.error = 'You Are Not Authorized';
      res.json(response);
      return;
    }

    doc.folder = 'sending';
    doc.date = new Date();
    doc.guid = new Date().getTime();
    doc._created = req.getUserFinger();

    $emails.add(doc, (err, new_doc) => {
      if (!err) {
        response.done = true;

        sendmail(
          {
            from: doc.from,
            to: doc.to,
            subject: doc.subject,
            html: doc.html,
          },
          function (err, reply) {
            if (err) {
            } else {
              new_doc.folder = 'send';
              $emails.update(new_doc);
            }
          }
        );
      } else {
        response.error = err.message;
      }

      res.json(response);
    });
  });

  site.onPOST('/api/emails/update', (req, res) => {
    let response = {};
    response.done = false;

    if (!req.session.user) {
      res.json(response);
      return;
    }
    let doc = req.body;
    doc._updated = site.security.getUserFinger({ $req: req, $res: res });

    if (doc.id) {
      $emails.edit(
        {
          where: {
            id: doc.id,
          },
          set: doc,
          $req: req,
          $res: res,
        },
        (err) => {
          if (!err) {
            response.done = true;
          } else {
            response.error = err.message;
          }
          res.json(response);
        }
      );
    } else {
      res.json(response);
    }
  });

  site.onPOST('/api/emails/delete', (req, res) => {
    let response = {};
    response.done = false;

    if (!req.session.user) {
      res.json(response);
      return;
    }

    let id = req.body.id;
    if (id) {
      $emails.delete(
        {
          id: id,
          $req: req,
          $res: res,
        },
        (err, result) => {
          if (!err) {
            response.done = true;
          } else {
            response.error = err.message;
          }
          res.json(response);
        }
      );
    } else {
      response.error = 'no id';
      res.json(response);
    }
  });

  site.onPOST('/api/emails/view', (req, res) => {
    let response = {};
    let where = req.body;
    response.done = false;
    $emails.find(
      {
        where: where,
        sort: { id: -1 },
        select: {
          id: 1,
          guid: 1,
          from: 1,
          to: 1,
          subject: 1,
          date: 1,
          folder: 1,
          html: 1,
          text: 1,
        },
      },
      (err, doc) => {
        if (!err) {
          response.done = true;
          response.doc = doc;
        } else {
          response.error = err.message;
        }
        res.json(response);
      }
    );
  });

  site.onPOST('/api/emails/all', (req, res) => {
    let response = {};
    response.done = false;

    let user_where = req.data.where || {};

    let where = {};

    if (user_where['from']) {
      where['from'] = site.getRegExp(user_where['from']);
    }

    if (user_where['to']) {
      where['to'] = site.getRegExp(user_where['to']);
    }

    if (user_where['subject']) {
      where['subject'] = site.getRegExp(user_where['subject']);
    }

    if (user_where['html']) {
      where['html'] = site.getRegExp(user_where['html']);
    }
    if (user_where['text']) {
      where['text'] = site.getRegExp(user_where['text']);
    }
    if (user_where['search']) {
      where.$or = [
        {
          from: site.getRegExp(user_where['search']),
        },
        { to: site.getRegExp(user_where['search']) },
        { subject: site.getRegExp(user_where['search']) },
        { html: site.getRegExp(user_where['search']) },
        { text: site.getRegExp(user_where['search']) },
      ];
    }

    $emails.findMany(
      {
        select: req.data.select || {
          id: 1,
          guid: 1,
          from: 1,
          to: 1,
          subject: 1,
          date: 1,
          folder: 1,
          html: 1,
          text: 1,
        },
        where: where,
        limit: req.data.limit,
      },
      (err, docs) => {
        if (!err) {
          response.done = true;
          response.list = docs;
        } else {
          response.error = err.message;
        }
        res.json(response);
        if (user_where['to']) {
          site.trackEmail({
            name: user_where['to'],
            ip: req.ip,
          });
        }
      }
    );
  });

  site.onGET({ name: '/viewEmail' }, (req, res) => {
    $emails.find(
      {
        where: {
          _id: req.query._id,
        },
        select: {
          html: 1,
          text: 1,
        },
      },
      (err, doc) => {
        if (!err && doc) {
          res.sendHTML(doc.html || doc.text);
        } else {
          res.sendTEXT('<h1> Email Not Exists</h1>');
        }
      }
    );
  });

  site.onPOST('/api/emails/delete-all', (req, res) => {
    let response = {};
    response.done = false;

    let user_where = req.data.where || {};
    let where = {};
    if (user_where['from']) {
      where['from'] = site.getRegExp(user_where['from']);
    }

    if (user_where['to']) {
      where['to'] = site.getRegExp(user_where['to']);
    }
    if (user_where['subject']) {
      where['subject'] = site.getRegExp(user_where['subject']);
    }
    if (user_where['html']) {
      where['html'] = site.getRegExp(user_where['html']);
    }
    if (user_where['text']) {
      where['text'] = site.getRegExp(user_where['text']);
    }
    $emails.deleteAll(
      {
        where: where,
        limit: req.data.limit || 10,
      },
      (err, result) => {
        if (!err) {
          response.done = true;
          response.result = result;
        } else {
          response.error = err.message;
        }
        res.json(response);
      }
    );
  });
};
