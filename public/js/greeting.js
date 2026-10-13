/* Header greeting + date, based on the visitor's own clock. */
(function () {
  function greetingFor(hour) {
    if (hour >= 5 && hour < 12) return 'Good Morning';
    if (hour >= 12 && hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  }

  function apply() {
    var now = new Date();
    var greeting = greetingFor(now.getHours());
    var date = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

    document.querySelectorAll('[data-greeting]').forEach(function (el) {
      if (el.textContent !== greeting) el.textContent = greeting;
    });
    document.querySelectorAll('[data-today]').forEach(function (el) {
      if (el.textContent !== date) el.textContent = date;
    });
  }

  apply();
  setInterval(apply, 60 * 1000);
})();
