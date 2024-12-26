app.controller('emails', function ($scope, $http) {
  $scope.email = {};
  $scope.emailSearch = { to: '', from: '', limit: 200, message: '' };
  $scope.newEmail = function () {
    $scope.error = '';
    $scope.email = {};
    site.showModal('#addEmailModal');
  };

  $scope.add = function () {
    $scope.error = '';
    const v = site.validated();
    if (!v.ok) {
      $scope.error = v.messages[0].ar;
      return;
    }

    $scope.busy = true;
    $http({
      method: 'POST',
      url: '/api/emails/add',
      data: $scope.email,
    }).then(
      function (response) {
        $scope.busy = false;
        if (response.data.done) {
          site.hideModal('#addEmailModal');
          $scope.list.push(response.data.doc);
        } else {
          $scope.error = '##word.error##';
        }
      },
      function (err) {
        console.log(err);
      }
    );
  };

  $scope.edit = function (email) {
    $scope.error = '';
    $scope.view(email);
    site.showModal('#updateEmailModal');
  };

  $scope.update = function () {
    $scope.busy = true;
    $http({
      method: 'POST',
      url: '/api/emails/update',
      data: $scope.email,
    }).then(
      function (response) {
        $scope.busy = false;
        if (response.data.done) {
          site.hideModal('#updateEmailModal');
          $scope.list.forEach((mail, i) => {
            if (mail.id == $scope.email.id) {
              $scope.list.splice(i, 1);
            }
          });
        } else {
          $scope.error = '##word.error##';
        }
      },
      function (err) {
        console.log(err);
      }
    );
  };

  $scope.remove = function (email) {
    $scope.view(email);
    site.showModal('#deleteEmailModal');
  };

  function replaceIframeContent(iframeElement, newHTML) {
    iframeElement.srcdoc = newHTML;
  }

  $scope.view = function (email) {
    $scope.busy = true;
    $scope.currentEmail = {};
    $http({
      method: 'POST',
      url: '/api/emails/view',
      data: {
        id: email.id,
      },
    }).then(
      function (response) {
        $scope.busy = false;
        if (response.data.done) {
          $scope.currentEmail = response.data.doc;
          document.querySelector('#div-message').src = document.location.protocol + '//' + document.location.hostname + '/viewEmail?_id=' + $scope.currentEmail._id;
        } else {
          $scope.error = response.data.error;
        }
      },
      function (err) {
        console.log(err);
      }
    );
  };

  $scope.openWindow = ({ url, title, w, h }) => {
    const dualScreenLeft = window.screenLeft !== undefined ? window.screenLeft : window.screenX;
    const dualScreenTop = window.screenTop !== undefined ? window.screenTop : window.screenY;

    const width = window.innerWidth ? window.innerWidth : document.documentElement.clientWidth ? document.documentElement.clientWidth : screen.width;
    const height = window.innerHeight ? window.innerHeight : document.documentElement.clientHeight ? document.documentElement.clientHeight : screen.height;

    const systemZoom = width / window.screen.availWidth;
    const left = (width - w) / 2 / systemZoom + dualScreenLeft;
    const top = (height - h) / 2 / systemZoom + dualScreenTop;
    const newWindow = window.open(
      url,
      title,
      `
      scrollbars=yes,
      width=${w / systemZoom}, 
      height=${h / systemZoom}, 
      top=${top}, 
      left=${left}
      `
    );

    if (window.focus) newWindow.focus();
  };

  $scope.details = function (email) {
    let url = document.location.protocol + '//' + document.location.hostname + '/viewEmail?_id=' + email._id;
    if (window.SOCIALBROWSER) {
      SOCIALBROWSER.ipc('[open new popup]', {
        partition: SOCIALBROWSER.partition,
        referrer: document.location.href,
        url: url,
        show: true,
        allowNewWindows: true,
        allowPopup: true,
        center: true,
        vip: true,
      });
    } else {
      $scope.openWindow({ url: url, title: email.title, w: 800, h: 600 });
    }
  };

  $scope.deleteAll = function () {
    $scope.list.forEach((mail, i) => {
      $scope.delete(mail);
    });
  };
  $scope.delete = function (email) {
    $scope.busy = true;
    $http({
      method: 'POST',
      url: '/api/emails/delete',
      data: {
        id: email.id,
        name: email.name,
      },
    }).then(
      function (response) {
        $scope.busy = false;
        if (response.data.done) {
          site.hideModal('#deleteEmailModal');
          $scope.list.forEach((mail, i) => {
            if (mail.id == email.id) {
              $scope.list.splice(i, 1);
            }
          });
        } else {
          $scope.error = response.data.error;
        }
      },
      function (err) {
        console.log(err);
      }
    );
  };
  $scope.deleteAllEmails = function () {
    $scope.busy = true;
    $http({
      method: 'POST',
      url: '/api/emails/delete-all',
      data: {
        where: $scope.emailSearch,
      },
    }).then(
      function (response) {
        $scope.busy = false;
        if (response.data.done) {
          alert('All Matched Message Deleted : ' + response.data.result.count);
        } else {
          $scope.error = response.data.error;
        }
      },
      function (err) {
        console.log(err);
      }
    );
  };
  $scope.searchAll = function (free = false) {
    let where = {};
    let minEmailLength = 8;
    if ('##req.url##'.indexOf('vip') !== -1) {
      minEmailLength = 1;
    }

    if (free) {
      if (!$scope.emailSearch.to) {
        alert('Write Your Email Address');
        return;
      }

      if ($scope.emailSearch.to.indexOf('@') === -1) {
        $scope.emailSearch.to = $scope.emailSearch.to + '@' + document.location.hostname.replace('emails.', '');
      }

      if ($scope.emailSearch.to.split('@')[0].length < minEmailLength) {
        alert('Email Length Must be ' + minEmailLength + ' letter or more ...');
        return;
      }
    }

    if ($scope.emailSearch.from) {
      where['from'] = $scope.emailSearch.from;
    }
    if ($scope.emailSearch.to) {
      where['to'] = $scope.emailSearch.to;
    }
    if ($scope.emailSearch.subject) {
      where['subject'] = $scope.emailSearch.subject;
    }
    if ($scope.emailSearch.text) {
      where['text'] = $scope.emailSearch.text;
    }

    $scope.loadAll(where, $scope.emailSearch.limit);

    site.hideModal('#SearchModal');
  };

  $scope.smartSearch = function (text = '') {
    let where = {};

    where.search = text || $scope.searchText;
    if (window.SOCIALBROWSER) {
      where.search = where.search || SOCIALBROWSER.electron.clipboard.readText();
    }
    $scope.loadAll(where, 500);
  };

  $scope.loadAll = function (where = {}, limit = 200) {
    $scope.busy = true;
    $scope.list = [];
    $http({
      method: 'POST',
      url: '/api/emails/all',
      data: {
        where: where,
        limit: limit,
      },
    }).then(
      function (response) {
        $scope.busy = false;
        if (response.data.done) {
          $scope.list = response.data.list;
        }
      },
      function (err) {
        $scope.busy = false;
        $scope.error = err;
      }
    );
  };

  function makeid(length = 12) {
    let result = '';

    const characters = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const charactersLength = characters.length;
    const numberLength = numbers.length;

    let length1 = length - 4;
    let length2 = 4;

    let counter1 = 0;
    while (counter1 < length1) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
      counter1 += 1;
    }

    let counter2 = 0;
    while (counter2 < length2) {
      result += numbers.charAt(Math.floor(Math.random() * numberLength));
      counter2 += 1;
    }

    return result;
  }

  $scope.generateEmail = function () {
    let host = document.location.hostname;
    host = host.split('.');
    if (host.length == 3) {
      host.splice(0, host.length - 2);
    }
    host = host.join('.');
    $scope.emailSearch.to = makeid(12) + '@' + host;
  };

  $scope.copy = function () {
    if (window.SOCIALBROWSER) {
      SOCIALBROWSER.copy($scope.emailSearch.to);
    } else {
      navigator.clipboard.writeText($scope.emailSearch.to);
    }
  };

  if ((email = '##req.query.email##')) {
    $scope.emailSearch.to = email;
    $scope.loadAll({ to: $scope.emailSearch.to }, 500);
  }
});
if (document.location.href.like('*vip*')) {
  document.querySelectorAll('.side1 , .side2').forEach((s) => {
    s.remove();
  });
}
