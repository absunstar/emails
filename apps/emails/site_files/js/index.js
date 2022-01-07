app.controller('emails', function ($scope, $http) {
    $scope.email = {};
    $scope.search = {};

    $scope.newEmail = function () {
        $scope.error = '';
        $scope.email = {
            image_url: '/images/email.png',
        };
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
                    $scope.loadAll();
                } else {
                    $scope.error = '##word.error##';
                }
            },
            function (err) {
                console.log(err);
            },
        );
    };

    $scope.edit = function (email) {
        $scope.error = '';
        $scope.view(email);
        $scope.email = {};
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
            },
        );
    };

    $scope.remove = function (email) {
        $scope.view(email);
        $scope.email = {};
        site.showModal('#deleteEmailModal');
    };

    $scope.view = function (email) {
        $scope.busy = true;
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
                    $scope.email = response.data.doc;
                } else {
                    $scope.error = response.data.error;
                }
            },
            function (err) {
                console.log(err);
            },
        );
    };

    $scope.details = function (email) {
        $scope.view(email);
        $scope.email = {};
        site.showModal('#viewEmailModal');
    };

    $scope.deleteAll = function () {
        $scope.list.forEach((mail, i) => {
            $scope.delete(mail);
        });
    };
    $scope.delete = function (email) {
        $scope.email = email || $scope.email;
        $scope.busy = true;
        $http({
            method: 'POST',
            url: '/api/emails/delete',
            data: {
                id: $scope.email.id,
                name: $scope.email.name,
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
            },
        );
    };

    $scope.searchAll = function () {
        $scope.emailSearch = $scope.emailSearch || {};
        let where = {};

        if ($scope.emailSearch.from) {
            where['from'] = $scope.emailSearch.from;
        }
        if ($scope.emailSearch.to) {
            where['to'] = $scope.emailSearch.to;
        }
        if ($scope.emailSearch.message) {
            where['message'] = $scope.emailSearch.message;
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
                select: {
                    id: 1,
                    date: 1,
                    from_email: 1,
                    to_email: 1,
                    subject: 1,
                    message: 1,
                    message_status: 1,
                    message_type: 1,
                },
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
            },
        );
    };

    $scope.loadAll();
});
