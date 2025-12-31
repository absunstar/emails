module.exports = function init(site) {
    const sendmail = require('sendmail')();
    const $emails = site.connectCollection('emails');
    const $emailsTracking = site.connectCollection('emailsTracking');
    const $emailsVIP = site.connectCollection('emailsVIP');

    site.emailList = [];
    site.trustedBrowserIDs = '*test*|*vip*|*developer*';
    site.vipEmailList = [];
    $emailsVIP.findAll({ limit: 100000 }, (err, docs, count) => {
        console.log('VIP Emails Count : ' + count);
        docs.forEach((doc) => {
            site.vipEmailList.push(doc);
        });
    });

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
            },
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

        if (doc.source !== 'isite') {
            response.error = 'You Are Not Authorized';
            res.json(response);
            return;
        }
        if (!doc.from || !doc.to || !doc.subject || (!doc.message && !doc.text && !doc.html)) {
            response.error = 'Invalid Email Fileds Request';
            res.json(response);
            return;
        }

        doc.folder = 'sending';
        doc.date = new Date();
        doc.guid = new Date().getTime();
        doc._created = req.getUserFinger();
        doc.ip = req.ip;

        $emails.add(doc, (err, new_doc) => {
            if (!err) {
                response.done = true;

                sendmail(
                    {
                        from: doc.from,
                        to: doc.to,
                        subject: doc.subject,
                        html: doc.message || doc.text || doc.html,
                    },
                    function (err, reply) {
                        if (err) {
                        } else {
                            new_doc.folder = 'send';
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

    site.onPOST('/api/emails/set-vip', (req, res) => {
        let response = {};
        response.done = true;

        let doc = req.body;

        let index = site.vipEmailList.findIndex((v) => v.email === doc.email);
        if (index === -1) {
            $emailsVIP.add(doc, (err, new_doc) => {
                if (!err) {
                    response.done = true;
                    response.doc = new_doc;
                    site.vipEmailList.push(new_doc);
                } else {
                    response.error = err.message;
                }
                res.json(response);
            });
        } else {
            $emailsVIP.update(
                {
                    where: {
                        email: doc.email,
                    },
                    set: doc,
                },
                (err, result) => {
                    if (!err) {
                        response.done = true;
                        response.result = result;
                        site.vipEmailList[index] = result.doc;
                    } else {
                        response.error = err.message;
                    }
                    res.json(response);
                },
            );
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
        let response = { done: false, list: [] };
        response.browserID = req.browserID;

        let where = req.body;
        if (where['to']) {
            response.list = site.emailList.filter((e) => e.to.contains(where['to']));
            response.memory = true;
        }

        if (response.list.length > 0) {
            response.done = true;

            response.isVIP = site.vipEmailList.some((v) => v.email.contains(where['to']));
            if (!response.isVIP) {
                response.doc = response.list.pop();
            } else if (response.isVIP && req.browserID && req.browserID.like(site.trustedBrowserIDs)) {
                response.isVIP = false;
                response.doc = response.list.pop();
            }
            res.json(response);
        } else {
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
                        vip: 1,
                    },
                },
                (err, doc) => {
                    if (doc) {
                        response.done = true;
                        response.isVIP = site.vipEmailList.some((v) => doc.to.contains(v.email));
                        if (!response.isVIP) {
                            response.doc = doc;
                        } else if (response.isVIP && req.browserID && req.browserID.like(site.trustedBrowserIDs)) {
                            response.isVIP = false;
                            response.doc = doc;
                        }
                    } else if (err) {
                        response.error = err?.message || 'Not Found';
                    }
                    res.json(response);
                },
            );
        }
    });

    site.onPOST('/api/emails/all', (req, res) => {
        let response = { done: false, list: [] };

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

        if (user_where['to']) {
            response.list = site.emailList.filter((e) => e.to.contains(user_where['to']));
            response.memory = true;
            if (response.list.length > 0) {
                response.done = true;
                response.list.forEach((doc) => {
                    doc.isVIP = site.vipEmailList.some((v) => doc.to.contains(v.email));
                    if (doc.isVIP) {
                        response.isVIP = true;
                    }
                    if (doc.isVIP && req.browserID && req.browserID.like(site.trustedBrowserIDs)) {
                        doc.isVIP = false;
                    }
                });
                response.list = response.list.filter((d) => !d.isVIP);

                res.json(response);
                return;
            }
        }

        if (response.list.length === 0) {
            {
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
                    (err, docs, count) => {
                        if (!err) {
                            response.done = true;
                            docs.forEach((doc) => {
                                response.isVIP = site.vipEmailList.some((v) => doc.to.contains(v.email));
                                if (doc.isVIP) {
                                    response.isVIP = true;
                                }
                                if (!doc.isVIP) {
                                    response.list.push(doc);
                                } else if (doc.isVIP && req.browserID && req.browserID.like(site.trustedBrowserIDs)) {
                                    response.isVIP = false;
                                    response.list.push(doc);
                                }
                            });
                            response.count = count;
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
                    },
                    true,
                );
            }
        }
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
            },
            true,
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
            },
            true,
        );
    });

    site.onPOST({ name: '/generate-new-email' }, (req, res) => {
        let response = { done: true };
        let result = '';

        let characters = 'abcdefghijklmnopqrstuvwxyz';
        let numbers = '0123456789';
        let length = site.random(8, 16);

        let counter = 0;
        let first = site.random(4, 6);

        while (counter < first) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
            counter += 1;
        }

        result += ['.', '', '_', '', '-'][site.random(0, 4)] || '';

        counter = 0;
        let last = site.random(4, 6);
        while (counter < last) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
            counter += 1;
        }

        if (length > first + last) {
            result += ['.', '', '_', '', '-'][site.random(0, 4)] || '';
            counter = 0;
            while (counter < length - (first + last)) {
                result += numbers.charAt(Math.floor(Math.random() * numbers.length));
                counter += 1;
            }
        }
        result += '@' + (req.data.domain || 'egytag.com');
        response.email = result;
        res.json(response);
    });
};
