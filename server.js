/**
 * https://nodemailer.com/extras/smtp-server/
 * fuser -uv  25/tcp
 * fuser -kuv 25/tcp
 * kill 1432
 */

const SMTPServer = require('smtp-server').SMTPServer;
const parser = require('mailparser').simpleParser;

const site = require('../isite')({
    port: 60025,
    language: { id: 'En', dir: 'ltr', text: 'left' },
    lang: 'En',
    version: new Date().getTime(),
    require: {
        features: [],
        permissions: [],
    },
    security: {
        keys: ['a2797cd0076d385e86663865dc4d855b'],
    },
    mongodb: {
        db: 'smpt-server',
        limit: 100,
        identity: {
            enabled: !0,
        },
    },
});

let $emails = site.connectCollection('emails');
$emails.createUnique({
    guid: 1,
});

site.get('robots.txt', (req, res) => {
    res.txt('robots.txt');
});

site.__allowEmailTo = '*egytag.com*|*social-browser.com*|*mama-services.net*';
site.__blockFrom = '*contaboserver.net*';
site.__ignoreFrom =
    '*friendsuggestion@facebookmail.com*|*friends@facebookmail.com*|*notification@facebookmail.com*|*pageupdates@facebookmail.com*|*groupupdates@facebookmail.com*|*reminders@facebookmail.com*|*advertise-noreply@support.facebook.com*';
site.__ignoreSubject = '*just went live on Kick!*';

const server = new SMTPServer({
    onAuth(auth, session, callback) {
        // if (auth.username !== "abc" || auth.password !== "def") {
        //   return callback(new Error("Invalid username or password"));
        // }
        callback(null, { user: auth.username }); // where 123 is the user id or similar property
    },

    onConnect(session, callback) {
        console.log(' ... Connecting ... ' + session.remoteAddress);
        // if (session.remoteAddress === '127.0.0.1') {
        //   return callback(new Error('No connections from localhost allowed'));
        // }

        return callback(); // Accept the connection
    },
    onSecure(socket, session, callback) {
        // if (session.servername !== 'sni.example.com') {
        //     return callback(new Error('Only connections for sni.example.com are allowed'));
        // }
        return callback(); // Accept the connection
    },
    onClose(session) {
        console.log(' ... Closing ... ' + session.remoteAddress);
    },
    onMailFrom(address, session, callback) {
        console.log(' ... Mail From ... ' + address.address);
        if (address.address.like(site.__blockFrom)) {
            console.log('Block From Address : ' + address.address);
            return callback(new Error('not allowed email from : ' + address.address));
        }
        return callback(); // Accept the address
    },
    onRcptTo(address, session, callback) {
        console.log(' ... Mail To ... ' + address.address);
        if (!address.address.like(site.__allowEmailTo)) {
            console.log('Block to Address : ' + address.address);
            return callback(new Error('not allowed email to : ' + address.address));
        }
        return callback(); // Accept the address
    },
    onData(stream, session, callback) {
        parser(stream, {}, (err, parsed) => {
            if (err) {
                console.error('Error:', err);
            } else {
                try {
                    let message = {};

                    message.folder = 'inbox';
                    message.subject = parsed.subject || '';
                    message.from = parsed.from?.text || '';
                    message.to = parsed.to?.text || '';
                    message.date = new Date(parsed.date);
                    message.text = parsed.text || '';
                    message.html = parsed.html || '';
                    message.guid = parsed.messageId || site.md5(message.date + message.subject + message.from + message.to);
                    if (!message.subject.like(site.__ignoreSubject) && !message.from.like(site.__ignoreFrom)) {
                        site.emailList.push(message);
                        $emails.add(message, (err, docs) => {
                            if (err) {
                                console.error('Error on ADD : ', err.message);
                            }
                        });
                    }
                } catch (error) {
                    console.error(error);
                }
            }
        });

        stream.on('end', () => {
            callback();
        });
    },
    disabledCommands: ['AUTH'],
});

server.on('error', (err) => {
    console.error('Error %s', err.message);
});

server.listen(25);

site.onGET({
    name: '/js',
    path: site.dir + '/js',
});

site.onGET({
    name: '/css',
    path: site.dir + '/css',
});
site.onGET({
    name: '/fonts',
    path: site.dir + '/fonts',
});
site.onGET({
    name: '/images',
    path: site.dir + '/images',
});
site.onGET({
    name: '/json',
    path: site.dir + '/json',
});
site.onGET({
    name: '/html',
    path: site.dir + '/html',
});

site.loadLocalApp('client-side');
site.loadLocalApp('security');
site.start();
