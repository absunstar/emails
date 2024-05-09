module.exports = function init(site) {
  const sendmail = require('sendmail')();
  const $emails = site.connectCollection('emails');

  site.onGET({
    name: 'emails',
    path: __dirname + '/site_files/html/index.html',
    parser: 'html',
    compress: true,
  });

  site.onGET({
    name: 'free',
    path: __dirname + '/site_files/html/free.html',
    parser: 'html',
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
    response.done = false;
    $emails.find(
      {
        where: {
          id: req.body.id,
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

    if (!req.session.user) {
      res.json(response);
      return;
    }

    let user_where = req.data.where || {};
    let where = {};
    if (user_where['from']) {
      where['from'] = new RegExp(user_where['from'], 'i');
    }

    if (user_where['to']) {
      where['to'] = new RegExp(user_where['to'], 'i');
    }

    if (user_where['message']) {
      where['html'] = new RegExp(user_where['message'], 'i');
    }

    $emails.findMany(
      {
        select: req.data.select || {},
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
      }
    );
  });
};
