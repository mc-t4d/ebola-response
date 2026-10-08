// Applies a saved Trends map/plots split *before* first paint, so a stored
// preference doesn't flash the CSS default (60:40) for a frame before
// engine.js gets around to overriding it later in the load. If nothing is
// stored, the CSS default stands -- this only ever narrows the gap between
// "what the stylesheet says" and "what the user last dragged it to".
(function() {
  try {
    var v = localStorage.getItem("bdbv_trends_panel_width_pct");
    if (v !== null && v !== "") {
      var n = parseFloat(v);
      if (isFinite(n)) {
        n = Math.max(28, Math.min(72, n));
        document.documentElement.style.setProperty("--trends-panel-width", n + "%");
      }
    }
  } catch (e) {}
})();
