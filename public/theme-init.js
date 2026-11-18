// Runs before the first paint: apply the saved theme so a dark theme does not flash white.
// Keep in sync with src/store/prefs.ts (key "pico2aprs.prefs", field "theme").
(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem("pico2aprs.prefs") || "null");
    if (prefs && (prefs.theme === "light" || prefs.theme === "dark")) {
      document.documentElement.dataset.theme = prefs.theme;
    }
  } catch (e) {
    // Storage blocked or junk: the system theme applies.
  }
})();
