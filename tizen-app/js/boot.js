/* Runs before the page paints (loaded in <head>): puts the saved theme, accent,
 * text size and background on <html> so the first frame already looks right,
 * and keeps the screen behind a splash until the app has chosen its start
 * screen.  A timer lifts the splash regardless, so it can never stay stuck. */
(function () {
    var h = document.documentElement;
    try {
        var raw = localStorage.getItem('vlctv_settings_v1');
        var o = raw ? JSON.parse(raw) : null;
        if (o) {
            if (o.theme)    h.setAttribute('data-theme',  String(o.theme));
            if (o.accent)   h.setAttribute('data-accent', String(o.accent));
            if (o.textSize) h.setAttribute('data-text',   String(o.textSize));
        }
    } catch (e) {}
    h.className = (h.className + ' booting').replace(/^\s+/, '');
    setTimeout(function () {
        h.className = h.className.replace(/\bbooting\b/, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }, 4000);
})();
