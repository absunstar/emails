app.controller('emails', function ($scope, $http) {
  $scope.email = {};
  $scope.emailSearch = { to: '', from: '' };
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
          $scope.currentEmail.html = $scope.currentEmail.html || $scope.currentEmail.text;
          document.querySelector('#div-message').innerHTML = $scope.currentEmail.html;
        } else {
          $scope.error = response.data.error;
        }
      },
      function (err) {
        console.log(err);
      }
    );
  };

  $scope.details = function (email) {
    $scope.view(email);
    site.showModal('#viewEmailModal');
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

  $scope.searchAll = function (free = false) {
    let where = {};
    let minEmailLength = 8;
    if ('##req.url##'.indexOf('vip') !== -1) {
      minEmailLength = 1;
    }

    if ($scope.emailSearch.from) {
      where['from'] = $scope.emailSearch.from;
    }
    if ($scope.emailSearch.to) {
      where['to'] = $scope.emailSearch.to;
    }
    if ($scope.emailSearch.message) {
      where['html'] = $scope.emailSearch.message;
    }

    if (free) {
      if (!$scope.emailSearch.to || $scope.emailSearch.to.indexOf('@') === -1) {
        alert('Email Must include @ ');
        return;
      }
      if (!$scope.emailSearch.to || $scope.emailSearch.to.split('@')[0].length < minEmailLength) {
        alert('Email Length Must be 8 letter or more ...');
        return;
      }
    }
    $scope.loadAll(where, $scope.emailSearch.limit);

    site.hideModal('#SearchModal');
  };

  $scope.loadAll = function (where, limit) {
    $scope.busy = true;
    $http({
      method: 'POST',
      url: '/api/emails/all',
      data: {
        where: where,
        limit: limit,
        select: {},
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

  function makeid(length) {
    let result = '';
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
      counter += 1;
    }
    return result;
  }

  $scope.generateEmail = function () {
    $scope.emailSearch.to = makeid(10) + '@egytag.com';
  };

  $scope.copy = function () {
    if (window.SOCIALBROWSER) {
      SOCIALBROWSER.copy($scope.emailSearch.to);
    } else {
      navigator.clipboard.writeText($scope.emailSearch.to);
    }
  };
});
