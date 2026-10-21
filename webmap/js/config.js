/* Where the web map reads its time series from (js/app.js reads window.WEBMAP_CONFIG).
 *
 *   seriesBase  folder holding national_daily.csv and zone_daily.csv.
 *               A relative path = files shipped with the site (the daily-map automation publishes them
 *               to data/series/). An absolute URL, e.g. a blob container, also works if it allows GET
 *               from this site's origin (CORS). Must end with "/".
 *
 * If the series cannot be loaded the map falls back to the per-day files in data/daily/;
 * add ?data=legacy to a page URL to force that path.
 */
window.WEBMAP_CONFIG = {
  seriesBase: "data/series/"
};
