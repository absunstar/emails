ufw allow 25



        let transporter = nodemailer.createTransport({
          host: '127.0.0.1',
          port: 25,
          secure: false, // true for 465, false for other ports
          auth: {
            user: doc.from_email, // generated ethereal user
            pass: doc.to_email, // generated ethereal password
          },
          tls: {
            rejectUnauthorized: false,
          },
        });
        var message = {
          from: doc.from_email,
          to: doc.to_email,
          subject: doc.subject,
          text: doc.message,
          html: doc.message,
          date : doc.date
        };

        transporter.sendMail(message, function (err) {
          if (err) {
            console.log(err);
          } else {
            new_doc.message_status = true;
            $emails.update(new_doc);
            console.log('Message Send OK ');
          }
          transport.close();
        });