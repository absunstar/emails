module.exports = function init(site) {
  const sendmail = require('sendmail')();
  const $emails = site.connectCollection('emails');

  site.onGET({
    name: 'emails',
    path: __dirname + '/site_files/html/index.html',
    parser: 'html',
    compress: true,
    require: {
      permissions: ['login'],
    },
  });

  site.onPOST('/api/emails/add', (req, res) => {
    let response = {};
    response.done = false;
    let doc = req.body;

    if (doc.source !== 'isite' || !req.session.user) {
      res.json(response);
      return;
    }

    doc.message_type = 'send_mail';
    doc.message_status = false;
    doc.date = new Date();
    doc.guid = new Date().getTime();
    doc.$req = req;
    doc.$res = res;

    doc._created = site.security.getUserFinger({ $req: req, $res: res });

    $emails.add(doc, (err, new_doc) => {
      if (!err) {
        response.done = true;

        sendmail(
          {
            from: doc.from_email,
            to: doc.to_email,
            subject: doc.subject,
            html: doc.message,
          },
          function (err, reply) {
            if (err) {
            } else {
              new_doc.message_status = true;
              $emails.update(new_doc);
            }
          },
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
        },
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
        },
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
      },
    );
  });

  site.onPOST('/api/emails/all', (req, res) => {
    let response = {};
    response.done = false;

    if (!req.session.user) {
      res.json(response);
      return;
    }

    let where = req.data.where || {};

    if (where['from']) {
      where['from'] = new RegExp(where['from'], 'i');
    }

    if (where['to']) {
      where['to'] = new RegExp(where['to'], 'i');
    }

    if (where['message']) {
      where['message'] = new RegExp(where['message'], 'i');
    }

    $emails.findMany(
      {
        select: req.body.select || {},
        where: req.body.where,
      },
      (err, docs) => {
        if (!err) {
          response.done = true;
          response.list = docs;
        } else {
          response.error = err.message;
        }
        res.json(response);
      },
    );
  });
};
