
setTimeout(() => {
  $('.loaded').css('visibility', 'visible');
}, 1000);


var app = app || angular.module('myApp', []);

app.filter('dateX', function () {
  return function (_any) {
    return site.toDateX(_any);
  };
});

app.filter('dateXT', function () {
  return function (_any) {
    return site.toDateXT(_any);
  };
});

app.filter('dateXF', function () {
  return function (_any) {
    return site.toDateXF(_any);
  };
});

