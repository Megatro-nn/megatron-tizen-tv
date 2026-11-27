/* Top-level app coordinator: state, view transitions, action dispatch.
 *
 * Views (mutually exclusive):
 *   home    — start screen with three tiles
 *   url     — keyboard-input URL entry
 *   browse  — file browser (USB / local roots), and a playlist's entries
 *   player  — fullscreen video with OSD
 *   viewer  — picture or text viewer (js/viewer.js) over a browser folder
 */

(function () {

    /* ── Recently-played (localStorage-backed, capped) ───────────────── */
    var RECENT_KEY = 'vlctv_recent_v1';
    function getRecent() {
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
        catch (e) { return []; }
    }
    function pushRecent(item) {
        if (!Settings.get('recentHistory')) return;   // switched off (issue #142)
        /* Subtitle entries carry a Tizen File object that won't survive
         * JSON.stringify (it serializes to {}).  Keep only the plain
         * fields needed to find the same sibling SRT on the next replay —
         * Browser.readSubtitleText will lazily re-resolve the File from
         * the path when it's actually needed.  Extracted-from-MP4 subs
         * are skipped: they live in wgt-private-tmp with random names and
         * get re-generated on next file open anyway. */
        var subs = (item.subtitles || [])
            .filter(function (s) { return s && !s._extracted; })
            .map(function (s) {
                var keep = {
                    name:     s.name,
                    lang:     s.lang || '',
                    ext:      s.ext  || '',
                    fullPath: s.fullPath || '',
                    uri:      s.uri || ''
                };
                if (s.loose) keep.loose = true;
                if (s.dir)   keep.dir = s.dir;
                return keep;
            });
        var entry = { uri: item.uri, title: item.title };
        if (subs.length) entry.subtitles = subs;
        // Where a share file's tags are read when it plays through the
        // transcode server (a URL; a USB File wouldn't survive JSON).
        if (typeof item.tagSrc === 'string') entry.tagSrc = item.tagSrc;
        if (typeof item.art === 'string') entry.art = item.art;

        // The same USB file under the name the drive was mounted by last
        // time is the same entry (issue #181).
        var key = UsbPaths.key(entry.uri);
        var list = getRecent().filter(function (x) { return UsbPaths.key(x.uri) !== key; });
        list.unshift(entry);
        setRecent(list.slice(0, 20));
    }
    function setRecent(list) {
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    }

    function clearRecent() {
        try { localStorage.removeItem(RECENT_KEY); } catch (e) {}
    }
    /* The Home tiles that follow a setting: Recently Played (issue #142),
     * and Servers, which is only a refusal while network access is off.
     * The grid lays out whichever tiles are left, still centred; with
     * Recently Played hidden the cursor starts on Favorites. */
    function applyHomeTiles() {
        var recent  = document.querySelector('.tile[data-action="browse-recent"]');
        if (recent) recent.classList.toggle('hidden', !Settings.get('recentHistory'));
        var servers = document.querySelector('.tile[data-action="browse-servers"]');
        if (servers) servers.classList.toggle('hidden', NetworkAccess.level() === 'none');
    }

    /* ── Watched marks and resume positions: js/watch-history.js ─────
     * A file is marked watched when playback finishes (oncomplete) or the
     * user leaves after ≥ 90 % of it; anything short of that keeps its
     * position so the file can pick up where it left off. */
    /* Aim the resume seek this far BEFORE the saved position.  AVPlay can
     * only land on keyframes and rounds the seek target forward to the
     * next one (~5-6 s GOPs are typical), so an exact-target seek ends up
     * PAST where the user left off.  Backing off 10 s makes the snap land
     * at or just before the exit point — replaying a few seconds of
     * context instead of silently skipping content. */
    var RESUME_BACKOFF_MS = 10000;
    /* Prev doubles as Restart: past this point in the file it seeks to 0,
     * and only a press within the first seconds jumps to the previous item
     * (the music-player convention).  Also the floor for dimming the OSD
     * button when there is neither a previous item nor anything to rewind. */
    var RESTART_THRESHOLD_MS = 3000;

    // Where the error hints send people for the transcode server.
    var RELEASES_URL = 'github.com/PatrickSt1991/tessel-tizen-tv/releases';

    /* ── State ────────────────────────────────────────────────────── */
    var state = {
        view:       'home',        // home | url | browse | player
        browseDir:  null,          // current Tizen File or null at root listing
        browseAtRoot: true,        // true when listing the virtual roots
        browseRoot: null,          // { name, fullPath } of the virtual root being browsed, if known
        playingUri: null,
        playingTitle: '',
        // Where the current playback was launched from, so exiting the
        // player returns to that menu instead of always jumping home.
        origin:     'home',        // 'browse' | 'recent' | 'url' | 'home'
        originDir:  null,          // Tizen File of the browse folder when origin==='browse'
        // Ordered playable siblings + position, powering auto-play / next-prev.
        playlist:   [],            // [{ uri, title, subtitles }]
        playlistIndex: -1,
        // Set while smart routing plays a share file directly instead of
        // through the transcode server: { uri, title, opts } to replay if the
        // direct open never starts.  See retryThroughServer().
        directFallback: null,
        // Set while the browse view lists a playlist's entries: what BACK does
        // there instead of going up a folder.  See openPlaylist().
        listBack:   null,
        // The playlist being shown, so leaving the player can return to it:
        // { src, entries, group }.
        playlistView: null,
        // Where leaving the player goes when the list came from elsewhere
        // (the SMB browser hands this over): fn({ uri, title }).
        originBack: null,
        // Music playing on while the user browses, with the mini-player up
        // (issue #105).  See minimizePlayer().
        background: false,
        playingIsAudio: false,
        // Files that failed in a row in the background, so a folder of
        // broken files can't cycle forever under repeat-all.
        bgErrors:   0
    };
    // Latest progress sample, used to decide partial-watch → watched on exit.
    var lastProgress = { time: 0, duration: 0 };
    // Throttle for the periodic resume-position checkpoint.
    var lastResumeSaveAt = 0;
    // Set once the current file's duration has been passed to MediaInfo.
    var durationNoted = false;
    /* Store the duration AVPlay reports for the browser's length column.
     * Only USB files are stored, since only they carry a File object. */
    function noteDuration(ms) {
        var item = state.playlist[state.playlistIndex];
        if (!item || !item.file || item.uri !== state.playingUri) return;
        MediaInfo.put({ uri: item.uri, size: item.file.fileSize, mtime: item.file.modified }, { dur: ms });
    }
    // Whether the OSD Prev button is currently lit as "Restart".
    var prevRestartLit = false;

    /* When the TV goes to standby, Tizen suspends the WebView.  AVPlay does
     * NOT survive this cleanly: on wake the session comes back with A/V
     * desync (short standby) or in a broken state where every operation
     * returns a codec-shaped error (long standby — the "MKV couldn't be
     * played" false report in issue #42).  Instead of trusting whatever
     * AVPlay hands back, we snapshot the current file + position on hidden
     * and re-open it from scratch on visible.  See onVisibilityChange +
     * the pendingResume block in the onstatechange('playing') handler. */
    var standbySnapshot = null;
    var pendingResume   = null;

    /* ── Init ─────────────────────────────────────────────────────── */
    function init() {
        startGlobalClock();
        Remote.init();

        // Wire button data-action click → dispatch.  Buttons stay
        // keyboard-activatable too because UI.activateFocused() calls click().
        document.body.addEventListener('click', function (ev) {
            var t = ev.target.closest('[data-action]');
            if (t) handleAction(t.dataset.action, t);
        });

        // Collapsible Settings sections (issue #28): clicking a section
        // toggle expands or collapses the next-sibling .settings-group it
        // points at via data-toggle.  Because the collapsed state uses
        // display:none, the inputs inside fall out of the focusable list
        // and the D-pad can't accidentally land on them — which is what
        // was popping the on-screen keyboard repeatedly and lagging /
        // crashing the app on slower Tizen firmware.
        document.body.addEventListener('click', function (ev) {
            var t = ev.target.closest('.settings-section-toggle');
            if (!t) return;
            var grp = document.getElementById(t.getAttribute('data-toggle'));
            if (!grp) return;
            var opening = grp.classList.contains('is-collapsed');
            grp.classList.toggle('is-collapsed', !opening);
            t.setAttribute('aria-expanded', opening ? 'true' : 'false');
            UI.refreshFocusables();
        });

        watchPlaylistList();

        // Preset URL chips
        document.querySelectorAll('.preset').forEach(function (el) {
            el.addEventListener('click', function () {
                document.getElementById('url-input').value = el.dataset.url;
                openUrl(el.dataset.url);
            });
        });

        // Global remote handler — dispatched per current view
        Remote.push(globalKeyHandler);

        // Player events
        Player.setListener('onstatechange', function (s) {
            if (typeof Debug !== 'undefined') Debug.player('state → ' + s);
            updatePlayPauseButton(s);
            updateMiniPlayer();
            if (s === 'playing') {
                state.bgErrors = 0;
                /* Don't clear the watchdog here — it needs to keep running so
                 * it can detect the "PLAYING but stuck at time=0" case.  The
                 * watchdog disarms itself once it sees time advancing. */
                hideSpinner();
                showOSD(true);
                scheduleOSDHide();
                applyLanguagePreferences();
                updateSpeedButton();   // Player.open reset speed to 1×; reflect it on the OSD

                /* Post-standby resume (issue #42): apply the saved position
                 * + paused state once the freshly-reopened file is actually
                 * playing.  Left paused so pressing Play resumes on the
                 * user's terms rather than blasting audio on TV wake. */
                if (pendingResume) {
                    var pr = pendingResume; pendingResume = null;
                    if (typeof Debug !== 'undefined')
                        Debug.player('standby-resume: seekTo=' + pr.pos + ' paused=' + pr.paused);
                    try {
                        if (pr.pos > 1500) {
                            Player.seekTo(pr.pos);
                            if (pr.announce) UI.toast(I18n.t('player.resumedFrom', fmtTime(pr.pos)));
                        }
                        if (pr.paused) Player.pause();
                    } catch (e) {}
                }
            }
        });
        Player.setListener('onerror', function (msg) {
            var text = typeof msg === 'string' ? msg
                       : (msg && msg.message ? msg.message : JSON.stringify(msg));
            if (typeof Debug !== 'undefined') Debug.error('player onerror: ' + text);
            if (retryThroughServer('player error: ' + text)) return;
            // If the failing URL is an SMB or WebDAV proxy stream, drain the
            // service's ring-buffer log to the PC listener so we can diagnose
            // what the proxy was doing when AVPlay gave up.
            if (typeof SMB !== 'undefined' && SMB.isStreamUrl && (SMB.isStreamUrl(state.playingUri) ||
                (typeof WebDAV !== 'undefined' && WebDAV.isStreamUrl(state.playingUri)))) {
                try { SMB.dumpServiceLogs(); } catch (e) {}
            }
            // A USB file that isn't there (the drive was unplugged, or the
            // file deleted) fails as PLAYER_ERROR_INVALID_URI, which on an
            // MKV read as a codec problem (issue #181).  Ask the drives
            // before blaming the file.
            var failed = state.playingUri;
            if (typeof tizen === 'undefined' || !tizen.filesystem || !UsbPaths.split(failed)) { showError(text); return; }
            UsbPaths.exists(tizen.filesystem, failed, function (there) {
                if (state.playingUri !== failed) return;
                if (there === false) {
                    if (typeof Debug !== 'undefined') Debug.error('not on any USB drive: ' + failed);
                    showError(I18n.t('err.fileGone'), 'gone');
                } else {
                    showError(text);
                }
            });
        });
        Player.setListener('onbuffering', function (active) {
            if (active) showSpinner(I18n.t('player.buffering'));
            else hideSpinner();
        });
        Player.setListener('onprogress', function (p) {
            lastProgress = { time: (p && p.time) || 0, duration: (p && p.duration) || 0 };
            if (lastProgress.duration && !durationNoted) {
                durationNoted = true;
                noteDuration(lastProgress.duration);
            }
            // A committed scrub seek stays "waiting" until the playhead
            // lands near its target (async AVPlay seeks report the pre-seek
            // position for a while), with a timeout for failed seeks.
            if (scrub.waiting && !scrub.active &&
                (Math.abs(lastProgress.time - scrub.pos) <= SCRUB_SETTLE_TOL_MS ||
                 Date.now() - scrub.commitAt > SCRUB_SETTLE_MAX_MS))
                scrub.waiting = false;
            // While scrubbing or settling, the bar shows the preview
            // position, not the real playhead.
            if (!scrub.active && !scrub.waiting)
                updateProgress(p && p.time, p && p.duration);
            checkNextUp();
            if (state.background) updateMiniProgress();
            // Prev lights up as Restart once past the first seconds.
            var canRestart = lastProgress.time > RESTART_THRESHOLD_MS;
            if (canRestart !== prevRestartLit) { prevRestartLit = canRestart; updateNextPrevButtons(); }
            // Checkpoint the position every 5 s so it survives a power-off
            // or app kill where exitPlayer never gets a chance to run.
            if (state.playingUri && lastProgress.time >= WatchHistory.RESUME_MIN_MS &&
                Date.now() - lastResumeSaveAt > 5000) {
                lastResumeSaveAt = Date.now();
                WatchHistory.saveResumePos(state.playingUri, lastProgress.time, lastProgress.duration);
            }
        });
        Player.setListener('oncomplete', function () {
            if (Settings.get('repeatMode') === 'one' && state.playingUri) {
                if (typeof Debug !== 'undefined') Debug.player('oncomplete: repeating');
                Player.seekTo(0);
                Player.play();
                return;
            }
            // A file that played to the end counts as watched.
            WatchHistory.markWatched(state.playingUri);
            if (sleepAtEnd) { cancelSleep(); UI.toast(I18n.t('toast.sleepStop')); exitPlayer(); return; }
            // Auto-play the next sibling if enabled and one exists; repeat-all
            // goes on by definition, wrapping round at the end.
            if ((Settings.get('autoPlay') || Settings.get('repeatMode') === 'all') && playNext(true)) return;
            UI.toast(I18n.t('player.finished'));
            if (state.background) stopBackground();
            else exitPlayer();
        });
        // A track being read out of the container, or one that turned out
        // unreadable — the only place the user hears about either.
        Player.setListener('onsubnotice', function (msg) {
            if (msg) UI.toast(msg);
        });
        Player.setListener('onsubsupdated', function () {
            // Tracks the container declared but AVPlay never listed land
            // here — give an unmatched language preference another go.
            retrySubtitlePreference();
            // MP4 embedded-sub extraction completed.  If the CC menu is
            // currently open, re-render it so the new entries appear.
            var menu = document.getElementById('track-menu');
            if (menu && !menu.classList.contains('hidden')) {
                openTrackMenu();
            }
        });

        // Reflow display rect on size changes
        window.addEventListener('resize', Player.setDisplayRect);

        // Standby-safe playback restore (issue #42).
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Second path for dedicated remote media keys (issue #42): on some
        // Samsung Smart Monitors the remote's Play / Pause / FF / RW keys
        // never arrive as `keydown` events at all — they're routed through
        // Chromium's MediaSession API instead.  Register handlers so those
        // remotes control playback too.  Only meaningful for the HTML5
        // backend (MP4/HLS); the AVPlay backend doesn't own a media element
        // and never becomes the browser's "active" media session, so this
        // is best-effort — the tvinputdevice path in remote.js remains the
        // primary route for AVPlay files.
        installMediaSessionHandlers();

        applyHomeTiles();            // Recently Played / Servers tiles on or off
        UI.showView('view-home');
        updateRepeatButton();        // reflect saved repeat preference on OSD
        updateShuffleButton();       // reflect saved shuffle preference on OSD
        /* A mode saved by an older build that no longer exists — the zoom
           and crop modes AVPlay turned out to be incapable of — would show
           as Fit on the OSD while the stored value said otherwise. */
        if (!AspectRatio.isKnown(Settings.get('aspectMode'))) Settings.set('aspectMode', 'fit');
        updateAspectButton();        // reflect the saved aspect mode on the OSD
        SubtitleStyle.apply();       // push saved subtitle appearance onto the overlay
        applyAppearance();           // Megatron: theme, accent, text size
        if (appearanceCode('background', BG_KEYS, 'default') === 'picture') loadBgPicture();
        installBrowseViews();        // Megatron: folder view modes
        window.addEventListener('keyup', function (ev) { if (ev.keyCode === 13) holdOkEnd(); });
        openStartScreen();           // straight on to the chosen screen (issue #149)
        finishBoot();                // lift the splash now that the right screen is up
    }

    /* Open the screen Settings → Start screen names, as if its Home tile
     * had been pressed: Home stays underneath, so Back from that screen
     * lands there the same way it does after pressing the tile.  Recently
     * Played switched off, or a list that turns out empty (its tile only
     * toasts), leaves the app on Home. */
    function openStartScreen() {
        var code = Settings.get('startScreen');
        var action = StartScreen.actionFor(code);
        if (!action) return;
        if (code === 'recent' && !Settings.get('recentHistory')) return;
        if (code === 'servers' && NetworkAccess.level() === 'none') return;
        if (typeof Debug !== 'undefined') Debug.view('start screen: ' + code);
        handleAction(action);
    }

    /* ── Action dispatcher ────────────────────────────────────────── */
    function handleAction(action, el) {
        if (typeof Debug !== 'undefined') Debug.action(action);
        switch (action) {
            case 'open-url':           openUrlView(); break;
            case 'browse-usb':         openBrowserAtRoot(); break;
            case 'browse-servers':     if (NetworkAccess.checkFeature(I18n.t('home.servers'), Servers.openBrowser)) Servers.openBrowser(); break;
            // No longer tiles — the Servers tile covers all three — but a
            // start screen chosen before 1.31.0 still names one of them.
            case 'browse-smb':         if (NetworkAccess.checkFeature(I18n.t('home.smb'), SMB.openBrowser)) SMB.openBrowser(); break;
            case 'browse-dlna':        if (NetworkAccess.checkFeature(I18n.t('home.dlna'), DLNA.openBrowser)) DLNA.openBrowser(); break;
            case 'browse-webdav':      if (NetworkAccess.checkFeature(I18n.t('home.webdav'), WebDAV.openBrowser)) WebDAV.openBrowser(); break;
            case 'browse-recent':      openRecent(); break;
            case 'browse-favorites':   openFavorites(); break;
            case 'open-settings':      openSettings(); break;
            case 'open-current-url': {
                var v = document.getElementById('url-input').value.trim();
                if (v) openUrl(v);
                else UI.toast(I18n.t('url.enterFirst'));
                break;
            }
            case 'fetch-remote-url':   fetchRemoteUrl(); break;
            case 'save-current-url':   saveCurrentUrl(); break;
            case 'play-saved':         playSaved(el.dataset.id); break;
            case 'saved-menu':         openSavedMenu(el.dataset.id); break;
            case 'saved-edit-done':    finishSavedEdit(); break;
            case 'saved-edit-cancel':  closeSavedEdit(); break;
            case 'back-home':          backToHome(); break;
            case 'play-pause':         Player.togglePause(); scheduleOSDHide(); break;
            case 'stop':               exitPlayer(); break;
            case 'prev':               handlePrev(); break;
            case 'next':               if (!playNext(false)) UI.toast(I18n.t('player.noNext'));     break;
            case 'rewind':             Player.seekRel(-skipShortMs()); flashOSD(); break;
            case 'forward':            Player.seekRel( skipShortMs()); flashOSD(); break;
            case 'seek-backward':      Player.seekRel(-60000); flashOSD(); break;
            case 'seek-forward':       Player.seekRel( 60000); flashOSD(); break;
            case 'toggle-repeat':      toggleRepeat(); break;
            case 'toggle-shuffle':     toggleShuffle(); break;
            case 'open-speed-picker':  openSpeedPicker(); break;
            case 'open-aspect-picker': openAspectPicker(); break;
            case 'open-track-menu':    openTrackMenu('subs'); break;
            case 'open-settings-panel': openTrackMenu('video'); break;
            case 'panel-tab':          openTrackMenu(el.getAttribute('data-tab'), true); break;
            case 'next-now':           hideNextUp(); if (!playNext(false)) UI.toast(I18n.t('player.noNext')); break;
            case 'toggle-time-mode':   toggleTimeMode(); break;
            case 'close-track-menu':   closeTrackMenu(); break;
            case 'setting-ui-lang':       openUiLangPicker(); break;
            case 'setting-start-screen':  openStartScreenPicker(); break;
            case 'setting-audio-lang':    openLangPicker('audioLang',    I18n.t('settings.audioLang'), LanguageList.forAudio());    break;
            case 'setting-subtitle-lang2': openLangPicker('subtitleLang2', I18n.t('settings.subtitleLang2'), LanguageList.forSubtitle2()); break;
            case 'setting-subtitle-outline':  openSubtitlePicker('subtitleOutline',  I18n.t('settings.subOutline'),  SubtitleStyle.forOutline());  break;
            case 'setting-subtitle-shadow':   openSubtitlePicker('subtitleShadow',   I18n.t('settings.subShadow'),   SubtitleStyle.forShadow());   break;
            case 'setting-subtitle-opacity':  openSubtitlePicker('subtitleOpacity',  I18n.t('settings.subOpacity'),  SubtitleStyle.forOpacity());  break;
            case 'setting-subtitle-looks':    openLooksPicker(); break;
            case 'setting-subtitle-lang': openLangPicker('subtitleLang', I18n.t('settings.subtitleLang'), LanguageList.forSubtitle()); break;
            case 'setting-repeat-mode':   openRepeatPicker(); break;
            case 'setting-auto-play':     openAutoPlayPicker(); break;
            case 'setting-resume-mode':   openResumeModePicker(); break;
            case 'setting-recent':        openRecentPicker(); break;
            case 'setting-network':       openNetworkPicker(); break;
            case 'setting-recent-clear':  confirmRecentClear(); break;
            case 'setting-new-code':      confirmNewCode(); break;
            case 'setting-shuffle':       openShufflePicker(); break;
            case 'setting-aspect-mode':   openAspectPicker(); break;
            case 'setting-browse-filter': openBrowseFilterPicker(); break;
            case 'bar-sort':              openBrowseSortPicker(); break;
            case 'setting-theme':         openAppearancePicker('theme',    'settings.theme',    THEME_KEYS,  'dark');   break;
            case 'setting-accent':        openAppearancePicker('accent',   'settings.accent',   ACCENT_KEYS, 'sky');    break;
            case 'setting-text-size':     openAppearancePicker('textSize', 'settings.textSize', TEXT_KEYS,   'normal'); break;
            case 'setting-poster-cache':  openPosterCachePicker(); break;
            case 'setting-time-mode':     openAppearancePicker('timeMode',  'settings.timeMode',  TIME_KEYS, 'total'); break;
            case 'setting-skip-short':    openSkipPicker('skipShort', 'settings.skipShort', 10); break;
            case 'setting-skip-long':     openSkipPicker('skipLong',  'settings.skipLong',  30); break;
            case 'picker-custom-save':    saveSkipCustom(); break;
            case 'setting-background':    openBackgroundPicker(); break;
            case 'setting-fanart':        openAppearancePicker('fanart', 'settings.fanart', FANART_KEYS, 'subtle'); break;
            case 'bar-view':              openBrowseViewPicker(); break;
            case 'setting-show-hidden':   openShowHiddenPicker(); break;
            case 'setting-folder-play':   openFolderPlayPicker(); break;
            case 'setting-slideshow-interval': openSlideshowPicker(); break;
            case 'setting-subtitle-size':     openSubtitlePicker('subtitleSize',     I18n.t('settings.subSize'),     SubtitleStyle.forSize());     break;
            case 'setting-subtitle-font':     openSubtitlePicker('subtitleFont',     I18n.t('settings.subFont'),     SubtitleStyle.forFont());     break;
            case 'setting-subtitle-color':    openSubtitlePicker('subtitleColor',    I18n.t('settings.subColor'),    SubtitleStyle.forColor());    break;
            case 'setting-subtitle-weight':   openSubtitlePicker('subtitleWeight',   I18n.t('settings.subWeight'),   SubtitleStyle.forWeight());   break;
            case 'setting-subtitle-position': openSubtitlePicker('subtitlePosition', I18n.t('settings.subPosition'), SubtitleStyle.forPosition()); break;
            case 'setting-subtitle-bg':       openSubtitlePicker('subtitleBg',       I18n.t('settings.subBg'),       SubtitleStyle.forBg());       break;
            case 'close-picker':       closePicker(); break;
        }
    }

    /* ── URL playback ─────────────────────────────────────────────── */
    function openUrlView() {
        closeSavedEdit(true);
        renderSavedStreams();
        UI.showView('view-url'); state.view = 'url';
    }
    function openUrl(url, title) {
        if (!NetworkAccess.check(url, null, function () { openUrl(url, title); })) return;
        title = title || urlBaseName(url);
        // A channel or song list can't go to AVPlay as it is (issue #110):
        // read it first.  An HLS manifest turns out to be one when read, and
        // is then played exactly as before — so is anything that can't be
        // read here, which leaves AVPlay to try it.
        if (Playlist.isPlaylistUrl(url)) {
            openPlaylist({
                title:   title,
                read:    function (cb) { fetchBytes(url, cb); },
                resolve: function (ref) { return Playlist.resolveUrl(ref, url); },
                playAsStream: function () { playStreamUrl(url, title); },
                // Drawn again: a channel may have been saved in the list.
                back:    function () { renderSavedStreams(); UI.showView('view-url'); state.view = 'url'; }
            });
            return;
        }
        playStreamUrl(url, title);
    }
    function playStreamUrl(url, title) {
        state.origin    = 'url';
        state.originDir = null;
        state.playlist  = [{ uri: url, title: title }];
        state.playlistIndex = 0;
        playUri(url, title, { askResume: true });
    }

    /* ── Saved streams (issue #119) ───────────────────────────────────
     * The user's own named list on the URL screen: OK on a chip plays it,
     * the ⋯ chip beside it edits, moves or removes it.  Saving and editing
     * share one name + URL form that takes the screen while it's open. */
    var savedEditing = null;           // id being edited, '' for a new one, null when closed
    var savedMenuFor = null;           // whose ⋯ menu was opened last, to come back to

    function renderSavedStreams() {
        var box  = document.getElementById('saved-streams');
        var list = document.getElementById('saved-streams-list');
        if (!box || !list) return;
        var items = SavedStreams.list();
        list.innerHTML = '';
        items.forEach(function (s) {
            var row = document.createElement('div');
            row.className = 'saved-item';
            var play = document.createElement('button');
            play.className = 'preset saved-stream';
            play.dataset.action = 'play-saved';
            play.dataset.id = s.id;
            play.textContent = s.name;
            play.title = s.url;
            var more = document.createElement('button');
            more.className = 'preset saved-more';
            more.dataset.action = 'saved-menu';
            more.dataset.id = s.id;
            more.textContent = '⋯';
            more.setAttribute('aria-label', I18n.t('saved.options', s.name));
            row.appendChild(play);
            row.appendChild(more);
            list.appendChild(row);
        });
        box.classList.toggle('hidden', !items.length);
        if (state.view === 'url') UI.refreshFocusables();
    }

    /* Focus a saved stream's chip once the list has been drawn again;
     * Play when the list has nothing left to land on. */
    function focusSaved(id, which) {
        setTimeout(function () {
            var el = id && document.querySelector('#saved-streams-list [data-action="' +
                         (which || 'play-saved') + '"][data-id="' + id + '"]');
            UI.focusOn(el || document.querySelector('#view-url [data-action="open-current-url"]'));
        }, 0);
    }

    function playSaved(id) {
        var s = SavedStreams.get(id);
        if (!s) return;
        document.getElementById('url-input').value = s.url;
        openUrl(s.url, s.name);
    }

    function saveCurrentUrl() {
        var url = document.getElementById('url-input').value.trim();
        if (!url) { UI.toast(I18n.t('url.enterFirst')); return; }
        var dup = SavedStreams.findByUrl(url);
        if (dup) { UI.toast(I18n.t('saved.already', dup.name)); focusSaved(dup.id); return; }
        openSavedEdit('', urlBaseName(url), url);
    }

    function openSavedEdit(id, name, url) {
        savedEditing = id;
        document.getElementById('saved-name').value = name;
        document.getElementById('saved-url').value  = url;
        document.getElementById('view-url').classList.add('editing');
        UI.refreshFocusables();
        UI.focusOn(document.getElementById('saved-name'));
    }
    /* quiet: closing on the way into the screen, nothing to put focus back on. */
    function closeSavedEdit(quiet) {
        var id = savedEditing;
        savedEditing = null;
        var view = document.getElementById('view-url');
        if (!view.classList.contains('editing')) return;
        view.classList.remove('editing');
        UI.refreshFocusables();
        if (!quiet) focusSaved(id, id ? 'saved-menu' : null);
    }
    function finishSavedEdit() {
        var name = document.getElementById('saved-name').value;
        var url  = document.getElementById('saved-url').value.trim();
        if (!url) { UI.toast(I18n.t('url.enterFirst')); return; }
        var s = savedEditing ? SavedStreams.update(savedEditing, name, url)
                             : SavedStreams.add(name, url);
        if (!s) return;
        savedEditing = null;
        document.getElementById('view-url').classList.remove('editing');
        renderSavedStreams();
        UI.toast(I18n.t('saved.saved', s.name));
        focusSaved(s.id);
    }

    function openSavedMenu(id) {
        var items = SavedStreams.list();
        var at = -1;
        for (var i = 0; i < items.length; i++) if (items[i].id === id) at = i;
        if (at < 0) return;
        var s = items[at];
        savedMenuFor = id;
        var opts = [{ code: 'edit', name: I18n.t('saved.edit') }];
        if (at > 0)                opts.push({ code: 'up',   name: I18n.t('saved.moveUp') });
        if (at < items.length - 1) opts.push({ code: 'down', name: I18n.t('saved.moveDown') });
        opts.push({ code: 'remove', name: I18n.t('saved.remove') });
        openPicker(s.name, opts, null, function (code) {
            if (code === 'edit') {
                setTimeout(function () { openSavedEdit(s.id, s.name, s.url); }, 0);
                return;
            }
            if (code === 'remove') { confirmSavedRemove(s); return; }
            SavedStreams.move(s.id, code === 'up' ? -1 : 1);
            renderSavedStreams();
            focusSaved(s.id, 'saved-menu');
        });
    }
    function confirmSavedRemove(s) {
        // The picker that asked closes once this returns; open the next one after.
        setTimeout(function () {
            openPicker(I18n.t('saved.removeConfirm', s.name), [
                { code: 'remove', name: I18n.t('saved.remove') },
                { code: 'keep',   name: I18n.t('common.cancel') }
            ], 'keep', function (code) {
                if (code === 'remove') {
                    var items = SavedStreams.list(), next = null;
                    for (var i = 0; i < items.length; i++)
                        if (items[i].id === s.id) next = items[i + 1] || items[i - 1] || null;
                    SavedStreams.remove(s.id);
                    renderSavedStreams();
                    UI.toast(I18n.t('saved.removed', s.name));
                    focusSaved(next && next.id, 'saved-menu');
                } else {
                    focusSaved(s.id, 'saved-menu');
                }
            });
        }, 0);
    }

    /* ── URL drop (paste from any device) ─────────────────────────────
     * Pull the most recent URL the user pasted from their phone/tablet/laptop
     * and play it. The field is filled first so the URL is visible if
     * playback fails. Pairing (code + QR) lives in Settings. */
    function fetchRemoteUrl() {
        if (typeof UrlDrop === 'undefined') { UI.toast(I18n.t('url.dropUnavailable')); return; }
        if (!NetworkAccess.check(UrlDrop.service(), I18n.t('cast.section'), fetchRemoteUrl)) return;
        UI.toast(I18n.t('url.checking'));
        UrlDrop.fetchLatest(function (err, url) {
            if (err) {
                if (typeof Debug !== 'undefined') Debug.error('url-drop: ' + err);
                UI.toast(I18n.t('url.serviceDown'));
                return;
            }
            if (!url) {
                UI.toast(I18n.t('url.nothingWaiting'));
                return;
            }
            var input = document.getElementById('url-input');
            if (input) input.value = url;
            UI.toast(I18n.t('url.gotIt'));
            openUrl(url);
        });
    }

    /* Pairing block in Settings: code + bare page URL + a locally-generated
     * QR (encodes the page URL with the code in the hash, so scanning opens
     * the device page already paired). QR is rendered offline — the code
     * never leaves the TV via a third-party QR service. */
    function renderPairingBlock() {
        if (typeof UrlDrop === 'undefined') return;
        var urlEl  = document.getElementById('pair-url');
        var codeEl = document.getElementById('pair-code');
        if (urlEl)  urlEl.textContent  = UrlDrop.pageUrl();
        if (codeEl) codeEl.textContent = UrlDrop.code();

        renderAboutBlock();
        var qrEl = document.getElementById('pair-qr');
        if (!qrEl) return;
        if (typeof qrcode === 'undefined') { qrEl.textContent = ''; return; }
        try {
            var qr = qrcode(0, 'M');
            qr.addData(UrlDrop.deviceUrl());
            qr.make();
            qrEl.innerHTML = '<img alt="' + escapeHtml(I18n.t('cast.qrAlt')) + '" ' +
                'style="width:100%;height:100%;image-rendering:pixelated" src="' +
                qr.createDataURL(8, 8) + '">';
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.error('pair-qr: ' + e);
            qrEl.textContent = '';
        }
    }
    /* "About Megatron": a QR code that opens the project page. */
    var PROJECT_URL = 'https://github.com/Megatro-nn/megatron-tizen-tv';
    function renderAboutBlock() {
        var urlEl = document.getElementById('about-url'), qrEl = document.getElementById('about-qr');
        if (urlEl) urlEl.textContent = PROJECT_URL.replace(/^https?:\/\//, '');
        if (!qrEl || typeof qrcode === 'undefined') return;
        try {
            var qr = qrcode(0, 'M');
            qr.addData(PROJECT_URL);
            qr.make();
            qrEl.innerHTML = '<img alt="" style="width:100%;height:100%;image-rendering:pixelated" src="' + qr.createDataURL(8, 8) + '">';
        } catch (e) { qrEl.textContent = ''; }
    }
    function urlBaseName(url) {
        try {
            var p = url.split('?')[0].split('#')[0];
            var seg = p.split('/').filter(Boolean);
            return decodeURIComponent(seg[seg.length - 1] || url);
        } catch (e) { return url; }
    }

    /* ── File browser ─────────────────────────────────────────────── */
    function openBrowserAtRoot(focusPath) {
        state.browseAtRoot = true;
        state.browseDir   = null;
        state.listBack    = null;
        // Emptied before the view comes up.  Listing the drives takes a
        // moment, and until it was done the view showed the rows of
        // whatever was listed last — Recently Played, Favorites, the drives
        // themselves — with the cursor on the first of them (issue #181).
        document.getElementById('browse-list').innerHTML = '';
        UI.showView('view-browse'); state.view = 'browse';
        document.getElementById('browse-title').textContent = I18n.t('browse.storage');
        document.getElementById('browse-path').textContent = '/';

        Browser.listRoots(function (err, roots) {
            var ul = document.getElementById('browse-list');
            ul.innerHTML = '';
            if (err) {
                ul.innerHTML = '<li><span class="icon">!</span><span class="name">' +
                               err.message + '</span></li>';
                return;
            }
            // The app's own system folders mean nothing to a viewer; "Show hidden files" brings them back.
            if (!Settings.get('showHidden')) {
                roots = roots.filter(function (r) { return !/^wgt-(package|private|private-tmp)$/i.test(r.name); });
            }
            if (!roots.length) {
                ul.innerHTML = '<li><span class="icon">i</span>'
                             + '<span class="name">' + escapeHtml(I18n.t('browse.noStorage')) + '</span></li>';
                return;
            }
            var focus = null;
            roots.forEach(function (r, i) {
                var li = document.createElement('li');
                li.dataset.tag = 'root-' + i;
                li.dataset.idx = i;
                var pretty = prettifyRootName(r.name);
                var isUsb  = /removable|usb/i.test(r.name);
                li.innerHTML  =
                    '<span class="icon k-' + (isUsb ? 'usb' : 'dir') + '">' + kindIconSvg(isUsb ? 'usb' : 'dir') + '</span>' +
                    '<span class="name">' + escapeHtml(pretty) + '</span>' +
                    '<span class="meta">' + escapeHtml(r.fullPath) + '</span>';
                li.addEventListener('click', function () {
                    state.browseAtRoot = false;
                    state.browseRoot   = { name: r.name, fullPath: r.fullPath };
                    listInto(r.dir);
                });
                ul.appendChild(li);
                if (focusPath && r.fullPath === focusPath) focus = li;
            });
            UI.focusInList(ul, focus);
        });
    }

    function listInto(dir, focusUri, barFocus) {
        if (!dir) return;
        state.browseDir = dir;
        state.listBack  = null;
        remoteRelist = null;
        document.getElementById('browse-title').textContent = dir.name || I18n.t('browse.folder');
        document.getElementById('browse-path').textContent = dir.fullPath;

        Browser.listDir(dir, function (err, entries) {
            var ul = document.getElementById('browse-list');
            ul.innerHTML = '';
            if (err) {
                ul.innerHTML = '<li><span class="icon">!</span><span class="name">'
                             + err.message + '</span></li>';
                return;
            }
            // The folder's cover picture, for music without art of its own —
            // looked up before the filter, which may hide pictures.
            var artName = FileTypes.folderArt(entries.map(function (e) { return e.isDir ? '' : e.name; }));
            var art = null;
            entries.forEach(function (e) { if (!e.isDir && e.name === artName) art = e.uri; });
            var filter = Settings.get('browseFilter'), showHidden = Settings.get('showHidden');
            entries = entries.filter(function (e) {
                return (showHidden || !FileTypes.isHidden(e.name)) && FileTypes.shown(filter, e.kind);
            });
            sortBrowseEntries(entries);
            // Ordered list of playable media in this folder — the playlist
            // that auto-play and next/prev walk through.
            var playlist = entries
                .filter(function (e) { return e.playable; })
                .map(function (e) {
                    return { uri: e.uri, title: e.name, subtitles: e.subtitles, file: e.file,
                             art: e.kind === 'audio' ? art : null };
                });
            // …and the pictures, which the viewer steps through the same way.
            var pictures = entries
                .filter(function (e) { return e.kind === 'image'; })
                .map(function (e) { return { uri: e.uri, title: e.name, size: e.size }; });
            function backHere(uri) {
                return function (last) {
                    UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = false;
                    listInto(dir, (last && last.uri) || uri);
                };
            }

            // On return from the player or viewer, focus the entry just
            // shown unless it is finished; otherwise focus the file to
            // continue with.
            var hist = WatchHistory.snapshot();
            if (!focusUri || hist.state(focusUri).finished)
                focusUri = hist.continueAt(playlist.map(function (p) { return p.uri; })) || focusUri;

            var focus = null, rows = [];   // rows whose duration is still unknown
            var view = browseViewCode();
            applyBrowseView(ul, view);
            updateBrowseCount(entries);
            findFolderFanart(dir, entries);
            entries.forEach(function (e) {
                var li = document.createElement('li');
                li.dataset.uri = e.uri || '';
                li.dataset.dir = e.isDir ? '1' : '0';
                var seen = e.playable ? hist.state(e.uri) : null;
                var watched = !!(seen && seen.watched);
                if (watched) li.classList.add('watched-item');
                if (seen && seen.lastTs) li.dataset.seen = '1';   // enables the ◄ hint
                if (e.isDir || e.playable) { li.dataset.history = '1'; li.dataset.name = e.name; }   // marks rows ◄ can forget
                if (e.kind === 'other') li.classList.add('unopenable');
                // Percent watched: its own bar and badge, so a long (two-line) name can't clip it.
                var pct = (seen && seen.progress !== null && !watched) ? Math.round(seen.progress * 100) : null;
                if (pct !== null) li.classList.add('has-progress');
                var subBadge = (e.subtitles && e.subtitles.length)
                    ? '<span class="meta">CC ×' + e.subtitles.length + '</span>'
                    : '';
                // Show the cached duration, if any; fillLengths() probes the others.
                var media = e.playable ? MediaInfo.get(e) : null;
                var length = media ? media.dur : null;
                var dateTxt = fmtDate(e.mtime), typeTxt = typeText(e);
                var sizeTxt = e.isDir ? '' : Browser.humanSize(e.size);
                var lenTxt  = (e.playable && length) ? fmtLength(length) : '';
                var seenTxt = watched ? '✓' : (seen && seen.progress !== null ? Math.round(seen.progress * 100) + '%' : '');
                // Every view gets every column; the CSS of the chosen view
                // decides which ones show (css: .vm-details, .vm-large …).
                li.innerHTML =
                    watchedIcon(watched, e.kind) +
                    '<span class="name">' + escapeHtml(e.name) + '</span>' +
                    (e.isDir ? '<span class="fav-mark">♥</span>' : '') +
                    subBadge.replace('class="meta"', 'class="meta c-cc"') +
                    '<span class="meta c-date">' + escapeHtml(dateTxt) + '</span>' +
                    '<span class="meta c-type">' + escapeHtml(typeTxt) + '</span>' +
                    '<span class="meta length">' + lenTxt + '</span>' +
                    '<span class="meta c-size">' + escapeHtml(sizeTxt) + '</span>' +
                    '<span class="meta c-seen">' + seenTxt + '</span>' +
                    '<span class="meta c-sub">' + escapeHtml([typeTxt, sizeTxt, dateTxt].filter(Boolean).join('  ·  ')) + '</span>' +
                    (pct !== null ? '<span class="pbar"><i style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>' : '');
                li._meta = { name: e.name, isDir: e.isDir, kind: e.kind, size: e.size, mtime: e.mtime };
                // Clean line icons instead of emoji (a ✓ stays for watched files).
                if (!watched) {
                    li.firstChild.innerHTML = kindIconSvg(e.kind);
                    li.firstChild.classList.add('k-' + e.kind);
                }
                // A folder may carry a poster; looked for when its tile scrolls into sight.
                if (e.isDir && (view === 'large' || view === 'small' || view === 'tiles')) {
                    li._dirFile = e.file; li._dirKey = e.fullPath;
                    li.firstChild.classList.add('has-thumb');
                }
                // Photos get a real thumbnail in the icon views, loaded as they scroll into sight.
                if (e.kind === 'image' && e.uri && (view === 'large' || view === 'small' || view === 'tiles')) {
                    li.dataset.thumb = e.uri;
                    li.dataset.thumbKey = copyKey(e.uri, e.size, e.mtime ? +e.mtime : 0);
                    li.dataset.thumbSize = e.size || 0;
                    if (/\.png$/i.test(e.name) || /logo|banner|clearart|disc/i.test(e.name)) li.firstChild.classList.add('contain');
                    li.firstChild.classList.add('has-thumb');
                }
                if (e.isDir) markFavoriteRow(li, usbFavorite(e.file, e.name));
                else if (e.playable && !media) rows.push({ entry: e, li: li });
                li.addEventListener('click', function () {
                    switch (e.kind) {
                        case 'dir':
                            listInto(e.file); return;
                        case 'video': case 'audio':
                            var idx = playlist.findIndex(function (p) { return p.uri === e.uri; });
                            playFromList('browse', playlist, idx >= 0 ? idx : 0, dir);
                            return;
                        case 'image':
                            state.view = 'viewer';
                            Viewer.openImage(pictures,
                                pictures.findIndex(function (p) { return p.uri === e.uri; }), backHere(e.uri));
                            return;
                        case 'text':
                            state.view = 'viewer';
                            Viewer.openText({ title: e.name, src: e.file, size: e.size }, backHere(e.uri));
                            return;
                        case 'playlist':
                            openPlaylist({
                                title:   e.name,
                                read:    function (cb) { Browser.readHead(e.file, MAX_PLAYLIST_BYTES, cb); },
                                resolve: function (ref) { return Playlist.resolveUrl(ref, e.uri); },
                                // A local HLS manifest: what the browser always did with it.
                                playAsStream: function () {
                                    playFromList('browse', [{ uri: e.uri, title: e.name, file: e.file }], 0, dir);
                                },
                                back:    backHere(e.uri)
                            });
                            return;
                    }
                    UI.toast(I18n.t('browse.cantOpen'));
                });
                ul.appendChild(li);
                if (focusUri && e.uri === focusUri) focus = li;
            });
            if (!ul.children.length)
                ul.innerHTML = '<li><span class="icon">i</span><span class="name">' + escapeHtml(I18n.t('browse.empty')) + '</span></li>';
            // Play all / Shuffle all on top when there are subfolders to
            // take along (issue #159); focus stays on the first entry.
            if (entries.some(function (e) { return e.isDir; })) {
                focus = focus || ul.firstElementChild;
                FolderPlay.addRows(ul, ul.firstElementChild, dir, usbMusic, function (tracks) {
                    playFromList('browse', tracks, 0, dir);
                });
            }
            markNowPlaying();
            UI.focusInList(ul, focus);
            if (barFocus) { var bb = document.getElementById(barFocus); if (bb) UI.focusOn(bb); }
            watchBrowseThumbs(ul);
            fillLengths(rows);
        });
    }

    /* One USB folder for FolderPlay: its subfolders and its music, each
     * track with the folder's cover picture. */
    function usbMusic(dir, cb) {
        Browser.listDir(dir, function (err, entries) {
            if (err) return cb(err);
            var artName = FileTypes.folderArt(entries.map(function (e) { return e.isDir ? '' : e.name; }));
            var art = null;
            entries.forEach(function (e) { if (!e.isDir && e.name === artName) art = e.uri; });
            var s = FolderPlay.split(entries);
            cb(null, {
                dirs:   s.dirs.map(function (e) { return e.file; }),
                tracks: s.audio.map(function (e) { return { uri: e.uri, title: e.name, file: e.file, art: art }; })
            });
        });
    }

    /* Read the durations a folder listing didn't have cached, two files at
     * a time, and write them into the rows.  Opening another listing
     * cancels the previous queue. */
    var lengthsRun = 0;
    /* ── Folder view modes + sorting (Megatron) ───────────────────── */
    var BROWSE_VIEWS = ['details', 'list', 'large', 'small', 'tiles'];
    var BROWSE_SORTS = ['name-asc', 'name-desc', 'date-desc', 'date-asc',
                        'size-desc', 'size-asc', 'type-asc', 'type-desc'];
    // Literal keys (not built by concatenation) so the i18n tests can see them.
    var VIEW_KEYS = { details: 'view.details', list: 'view.list', large: 'view.large',
                      small: 'view.small', tiles: 'view.tiles' };
    var SORT_KEYS = { 'name-asc': 'sort.name-asc', 'name-desc': 'sort.name-desc',
                      'date-desc': 'sort.date-desc', 'date-asc': 'sort.date-asc',
                      'size-desc': 'sort.size-desc', 'size-asc': 'sort.size-asc',
                      'type-asc': 'sort.type-asc', 'type-desc': 'sort.type-desc' };
    var thumbObs = null;

    function browseViewCode() {
        var v = Settings.get('browseView');
        return BROWSE_VIEWS.indexOf(v) >= 0 ? v : 'large';
    }
    function browseSortCode() {
        var s = Settings.get('browseSort');
        return BROWSE_SORTS.indexOf(s) >= 0 ? s : 'name-asc';
    }

    /* The view classes live on #browse-list and are dropped whenever
     * anything empties the list (innerHTML = …).  Every other screen that
     * uses this list (drives, favourites, recent, SMB, WebDAV, DLNA,
     * playlists) clears it first, so they keep their plain look. */
    function installBrowseViews() {
        var ul = document.getElementById('browse-list');
        if (!ul || ul.__megatronViews) return;
        var desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (!desc || !desc.set) return;
        ul.__megatronViews = true;
        Object.defineProperty(ul, 'innerHTML', {
            configurable: true,
            get: function () { return desc.get.call(this); },
            set: function (v) {
                this.className = this.className.replace(/\bvm-\S+/g, '').replace(/\s+$/, '');
                var head = document.getElementById('browse-head');
                if (head) head.classList.remove('on');
                var bar = document.getElementById('browse-bar');
                if (bar) bar.classList.remove('on');
                if (folderFanart) {
                    clearTimeout(fanartClearTimer);
                    fanartClearTimer = setTimeout(function () { folderFanart = null; applyBackground(); }, 150);
                }
                ['browse-count', 'browse-info'].forEach(function (id) {
                    var el = document.getElementById(id); if (el) el.classList.remove('on');
                });
                if (thumbObs) { try { thumbObs.disconnect(); } catch (e) {} thumbObs = null; }
                desc.set.call(this, v);
            }
        });
        // Keep the info bar in step with the highlighted tile (and with lengths that arrive later).
        if (typeof MutationObserver !== 'undefined') {
            var infoTimer = null;
            new MutationObserver(function () {
                clearTimeout(infoTimer);
                infoTimer = setTimeout(updateBrowseInfo, 50);
            }).observe(ul, { attributes: true, attributeFilter: ['class'], subtree: true,
                             childList: true, characterData: true });
        }
        // The fanart belongs to the file browser only: follow the screen that is showing.
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(function () { applyBackground(); })
                .observe(document.documentElement, { attributes: true, attributeFilter: ['data-view'] });
        }
    }

    function applyBrowseView(ul, view) {
        ul.className = ul.className.replace(/\bvm-\S+/g, '').replace(/\s+$/, '') + ' vm-' + view;
        updateBrowseBar();
        var info = document.getElementById('browse-info');
        if (info) { info.innerHTML = ''; info.classList.add('on'); }
        var head = document.getElementById('browse-head');
        if (!head) return;
        if (view === 'details') {
            head.innerHTML =
                '<span class="icon"></span>' +
                '<span class="name">' + escapeHtml(I18n.t('col.name')) + '</span>' +
                '<span class="meta c-date">' + escapeHtml(I18n.t('col.date')) + '</span>' +
                '<span class="meta c-type">' + escapeHtml(I18n.t('col.type')) + '</span>' +
                '<span class="meta length">' + escapeHtml(I18n.t('col.length')) + '</span>' +
                '<span class="meta c-size">' + escapeHtml(I18n.t('col.size')) + '</span>' +
                '<span class="meta c-seen">' + escapeHtml(I18n.t('col.seen')) + '</span>';
            head.classList.add('on');
        } else {
            head.classList.remove('on');
        }
    }

    function fmtDate(d) {
        if (!d || !d.getFullYear) return '';
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
               ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function extOf(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    }
    function typeText(e) {
        if (e.isDir) return I18n.t('type.folder');
        var x = extOf(e.name);
        return x ? x.toUpperCase() : I18n.t('type.file');
    }

    /* Folders stay on top; then the chosen order; name breaks ties. */
    function sortBrowseEntries(entries) {
        var parts = browseSortCode().split('-');
        var key = parts[0], dir = parts[1] === 'desc' ? -1 : 1;
        function byName(a, b) {
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { numeric: true });
        }
        function primary(a, b) {
            switch (key) {
                case 'date': return (a.mtime ? +a.mtime : 0) - (b.mtime ? +b.mtime : 0);
                case 'size': return (a.size || 0) - (b.size || 0);
                case 'type':
                    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
                    var xa = extOf(a.name), xb = extOf(b.name);
                    return xa === xb ? 0 : (xa < xb ? -1 : 1);
                default: return byName(a, b);
            }
        }
        entries.sort(function (a, b) {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            var r = primary(a, b) * dir;
            return r !== 0 ? r : byName(a, b);
        });
    }

    /* ── Icons ────────────────────────────────────────────────────── */
    var KIND_SVG = {
        dir:      '<path class="back" d="M6 15a5 5 0 0 1 5-5h13l6 6h23a5 5 0 0 1 5 5v27a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/><path d="M6 25a5 5 0 0 1 5-5h42a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/>',
        video:    '<rect x="7" y="12" width="50" height="40" rx="8"/><path class="cut" d="M27 23v18l15-9z"/>',
        audio:    '<path d="M24 10l30-6v36a9 9 0 1 1-6-8.4V17l-18 3.6V46a9 9 0 1 1-6-8.4z"/>',
        image:    '<rect x="7" y="10" width="50" height="44" rx="8"/><circle class="cut" cx="22" cy="25" r="5"/><path class="cut" d="M10 48l15-14 10 9 8-7 11 12z"/>',
        text:     '<path d="M15 6h22l14 14v32a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6z"/><path class="cut" d="M18 30h28v4H18zm0 9h28v4H18zm0-18h14v4H18z"/>',
        playlist: '<rect x="7" y="12" width="50" height="40" rx="8"/><path class="cut" d="M16 22h5v5h-5zm9 1h23v3H25zm-9 8h5v5h-5zm9 1h23v3H25zm-9 8h5v5h-5zm9 1h23v3H25z"/>',
        other:    '<path d="M15 6h22l14 14v32a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6z"/><path class="cut" d="M37 6v14h14z" opacity=".35"/>',
        usb:      '<rect x="19" y="26" width="26" height="32" rx="6"/><path d="M24 26V9h16v17" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path class="cut" d="M27 14h4v6h-4zM33 14h4v6h-4z"/>'
    };
    function kindIconSvg(kind) {
        return '<svg viewBox="0 0 64 64" aria-hidden="true">' + (KIND_SVG[kind] || KIND_SVG.other) + '</svg>';
    }

    /* ── Thumbnails, folder posters and their cache ───────────────── */
    var POSTER_KEY = 'megatron_posters_v1';
    var COPY_STATE_KEY = 'megatron_copystate';
    var posterCache = loadPosterMap();   // folder path -> { u: poster URI, s: size, m: modified }
    var posterNone  = {};                // folders with no poster (this session only)
    var posterQueue = [], posterBusy = 0, posterSaveTimer = null;
    var copyState = 'unknown';           // 'unknown' | 'on' | 'blocked'  (small copies of pictures)
    var copyCount = 0, copyFails = 0, copyBusy = false, copyQueue = [], copyQueued = {};
    var thumbDB = null;                  // IndexedDB holding the small copies

    try { copyState = localStorage.getItem(COPY_STATE_KEY) || 'unknown'; } catch (e) {}

    function loadPosterMap() {
        try { return JSON.parse(localStorage.getItem(POSTER_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function savePosterMap() {
        clearTimeout(posterSaveTimer);
        posterSaveTimer = setTimeout(function () {
            try {
                var keys = Object.keys(posterCache);
                if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach(function (k) { delete posterCache[k]; });
                localStorage.setItem(POSTER_KEY, JSON.stringify(posterCache));
            } catch (e) {}
        }, 800);
    }
    function copyKey(uri, size, mtime) { return uri + '|' + (size || 0) + '|' + (mtime || 0); }

    /* The picture that stands for a folder: poster.jpg, folder.jpg,
     * cover.jpg, "<movie>-poster.jpg" …  Fan art and logos are not it. */
    function pickPoster(files) {
        var best = null, rank = 99;
        (files || []).forEach(function (f) {
            if (f.isDirectory || FileTypes.kind(f.name) !== 'image') return;
            var base = f.name.toLowerCase().replace(/\.[^.]+$/, ''), r = 99;
            if (base === 'poster') r = 0;
            else if (base === 'folder') r = 1;
            else if (base === 'cover') r = 2;
            else if (/(^|[-_. ])poster$/.test(base)) r = 3;
            else if (base === 'movie' || base === 'front') r = 4;
            if (r < rank) { rank = r; best = f; }
        });
        return best;
    }
    function fileUri(f) { return typeof f.toURI === 'function' ? f.toURI() : 'file://' + f.fullPath; }

    /* — small copies, kept in IndexedDB — */
    function openThumbDB(cb) {
        if (thumbDB) return cb(thumbDB);
        if (thumbDB === false || typeof indexedDB === 'undefined') return cb(null);
        var req;
        try { req = indexedDB.open('megatron-thumbs', 2); } catch (e) { thumbDB = false; return cb(null); }
        req.onupgradeneeded = function () {
            var d = req.result;
            if (!d.objectStoreNames.contains('t'))  d.createObjectStore('t');
            if (!d.objectStoreNames.contains('bg')) d.createObjectStore('bg');
        };
        req.onsuccess = function () {
            thumbDB = req.result; cb(thumbDB);
            try { var c = thumbDB.transaction('t', 'readonly').objectStore('t').count();
                  c.onsuccess = function () { copyCount = c.result || 0; }; } catch (e) {}
        };
        req.onerror = req.onblocked = function () { thumbDB = false; cb(null); };
    }
    function thumbGet(key, cb) {
        openThumbDB(function (db) {
            if (!db) return cb(null);
            try {
                var r = db.transaction('t', 'readonly').objectStore('t').get(key);
                r.onsuccess = function () { cb(r.result || null); };
                r.onerror   = function () { cb(null); };
            } catch (e) { cb(null); }
        });
    }
    function thumbPut(key, blob) {
        openThumbDB(function (db) {
            if (!db) return;
            try {
                var tx = db.transaction('t', 'readwrite'), st = tx.objectStore('t');
                if (copyCount > 2500) { st.clear(); copyCount = 0; }     // simple reset keeps it bounded
                st.put({ b: blob, t: Date.now() }, key);
                tx.oncomplete = function () { copyCount++; };
            } catch (e) {}
        });
    }
    function setCopyState(s) {
        if (copyState === s) return;
        copyState = s;
        try { localStorage.setItem(COPY_STATE_KEY, s); } catch (e) {}
    }
    /* Read the file as a blob (same-origin, so the canvas stays clean), shrink it, hand back a small JPEG/PNG. */
    function makeSmallCopy(uri, cb, maxSide) {
        var done = false;
        function fin(b) { if (!done) { done = true; cb(b); } }
        var x = new XMLHttpRequest();
        try { x.open('GET', uri, true); x.responseType = 'blob'; } catch (e) { return fin(null); }
        x.onload = function () {
            if (!x.response) return fin(null);
            var url = URL.createObjectURL(x.response), im = new Image();
            im.onload = function () {
                try {
                    var w = im.naturalWidth, h = im.naturalHeight;
                    if (!w || !h) { URL.revokeObjectURL(url); return fin(null); }
                    var sc = Math.min(1, (maxSide || 420) / Math.max(w, h));
                    var cv = document.createElement('canvas');
                    cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(h * sc));
                    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
                    cv.toBlob(function (b) { URL.revokeObjectURL(url); fin(b); },
                              /\.png$/i.test(uri) ? 'image/png' : 'image/jpeg', 0.8);
                } catch (e) { URL.revokeObjectURL(url); fin(null); }
            };
            im.onerror = function () { URL.revokeObjectURL(url); fin(null); };
            im.src = url;
        };
        x.onerror = function () { fin(null); };
        try { x.send(); } catch (e) { fin(null); }
    }
    function drainCopies() {
        if (copyBusy || !copyQueue.length) return;
        copyBusy = true;
        var j = copyQueue.shift();
        makeSmallCopy(j.uri, function (blob) {
            if (blob) { thumbPut(j.key, blob); copyFails = 0; setCopyState('on'); }
            else if (++copyFails >= 3 && copyState !== 'on') setCopyState('blocked');
            copyBusy = false;
            setTimeout(drainCopies, 200);
        });
    }
    function queueCopy(key, uri, size) {
        if (copyState === 'blocked' || typeof indexedDB === 'undefined' || copyQueued[key]) return;
        if (size > 12000000) return;                    // very large files are not worth reading twice
        copyQueued[key] = true;
        copyQueue.push({ key: key, uri: uri });
        drainCopies();
    }
    function clearPosterCache() {
        posterCache = {}; posterNone = {}; copyQueued = {}; copyQueue = []; copyCount = 0;
        try { localStorage.removeItem(POSTER_KEY); } catch (e) {}
        openThumbDB(function (db) {
            if (!db) return;
            try { db.transaction('t', 'readwrite').objectStore('t').clear(); } catch (e) {}
        });
        UI.toast(I18n.t('cache.cleared'));
    }
    function posterCacheText() {
        var st = copyState === 'on' ? I18n.t('cache.on', copyCount)
               : copyState === 'blocked' ? I18n.t('cache.blocked') : I18n.t('cache.unknown');
        return I18n.t('cache.value', Object.keys(posterCache).length, st);
    }
    function openPosterCachePicker() {
        pickerSetting = 'posterCache';
        openPicker(I18n.t('settings.posterCache'), [{ code: 'clear', name: I18n.t('cache.clear') }], null,
            function (val) { if (val === 'clear') clearPosterCache(); });
    }

    /* — showing a picture in a tile — */
    function showThumb(li) {
        var ic = li.querySelector('.icon');
        if (!ic || !li.dataset.thumb || ic.querySelector('img')) return;
        var uri = li.dataset.thumb, key = li.dataset.thumbKey || uri, size = +li.dataset.thumbSize || 0;
        var token = ic.__tok = (ic.__tok || 0) + 1;
        function show(src, fromCopy) {
            if (ic.__tok !== token || ic.querySelector('img')) return;
            var img = document.createElement('img');
            img.alt = '';
            if (fromCopy) img.__blobUrl = src;
            img.onload = function () {
                img.className = 'ok'; ic.classList.add('loaded');
                if (!fromCopy) queueCopy(key, uri, size);
            };
            img.onerror = function () {
                if (img.parentNode) img.parentNode.removeChild(img);
                ic.classList.remove('loaded');
                if (img.__blobUrl) URL.revokeObjectURL(img.__blobUrl);
                if (fromCopy) { show(uri, false); return; }          // the copy was bad: use the original
                if (li._dirKey && posterCache[li._dirKey] && !li._rescanned) {   // the poster is gone: look again
                    li._rescanned = true;
                    delete posterCache[li._dirKey]; savePosterMap();
                    delete li.dataset.thumb; delete li.dataset.thumbKey;
                    findPoster(li);
                }
            };
            ic.appendChild(img);
            img.src = src;
        }
        thumbGet(key, function (rec) {
            if (ic.__tok !== token) return;
            if (rec && rec.b) show(URL.createObjectURL(rec.b), true);
            else show(uri, false);
        });
    }
    function hideThumb(li) {
        var ic = li.querySelector('.icon');
        if (!ic) return;
        ic.__tok = (ic.__tok || 0) + 1;
        var img = ic.querySelector('img');
        if (img) { if (img.__blobUrl) URL.revokeObjectURL(img.__blobUrl); ic.removeChild(img); }
        ic.classList.remove('loaded');
    }
    function drainPosters() {
        while (posterBusy < 3 && posterQueue.length) {
            var li = posterQueue.shift();
            if (!li.parentNode) continue;                 // the list was redrawn meanwhile
            posterBusy++;
            (function (li) {
                var done = false;
                function fin(file) {
                    if (done) return; done = true; posterBusy--;
                    if (file) {
                        var uri = fileUri(file), s = file.fileSize || 0, m = file.modified ? +file.modified : 0;
                        posterCache[li._dirKey] = { u: uri, s: s, m: m }; savePosterMap();
                        if (li.parentNode) {
                            li.dataset.thumb = uri; li.dataset.thumbKey = copyKey(uri, s, m); li.dataset.thumbSize = s;
                            if (li.__vis) showThumb(li);
                        }
                    } else {
                        posterNone[li._dirKey] = true;
                    }
                    drainPosters();
                }
                try { li._dirFile.listFiles(function (files) { fin(pickPoster(files)); }, function () { fin(null); }); }
                catch (e) { fin(null); }
            })(li);
        }
    }
    function findPoster(li) {
        var key = li._dirKey, c = posterCache[key];
        if (c && c.u) {                                   // remembered from an earlier visit: no folder scan
            li.dataset.thumb = c.u; li.dataset.thumbKey = copyKey(c.u, c.s, c.m); li.dataset.thumbSize = c.s || 0;
            if (li.__vis) showThumb(li);
            return;
        }
        if (posterNone[key]) return;
        posterQueue.push(li); drainPosters();
    }

    /* An <img> exists only while its tile is on (or near) the screen, so a
     * folder of big photos doesn't fill the TV's memory. */
    function watchBrowseThumbs(ul) {
        if (thumbObs) { try { thumbObs.disconnect(); } catch (e) {} thumbObs = null; }
        posterQueue = [];
        if (typeof IntersectionObserver === 'undefined') return;
        var items = ul.querySelectorAll('li[data-thumb], li[data-dir="1"]');
        if (!items.length) return;
        thumbObs = new IntersectionObserver(function (changes) {
            changes.forEach(function (c) {
                var li = c.target;
                var seen = c.isIntersecting !== undefined ? c.isIntersecting : c.intersectionRatio > 0;
                li.__vis = seen;
                if (seen) {
                    if (li.dataset.thumb) showThumb(li);
                    else if (li._dirFile) findPoster(li);
                } else {
                    hideThumb(li);
                }
            });
        }, { root: ul, rootMargin: '300px' });
        for (var i = 0; i < items.length; i++) thumbObs.observe(items[i]);
    }

    /* ── Item count (top-left) and info bar (bottom) ───────────────── */
    function updateBrowseCount(entries) {
        var el = document.getElementById('browse-count');
        if (!el) return;
        var total = 0;
        entries.forEach(function (e) { if (!e.isDir) total += e.size || 0; });
        el.textContent = entries.length + ' ' + I18n.t('count.items') + (total ? '  ·  ' + Browser.humanSize(total) : '');
        el.classList.add('on');
    }
    function updateBrowseInfo() {
        var box = document.getElementById('browse-info');
        if (!box || !box.classList.contains('on')) return;
        var li = document.querySelector('#browse-list li.focused');
        var m = li && li._meta;
        if (!m) { box.innerHTML = ''; return; }
        var chips = [typeText(m)];
        if (!m.isDir && m.size) chips.push(Browser.humanSize(m.size));
        var date = fmtDate(m.mtime);
        if (date) chips.push(date);
        var len = li.querySelector('.length');
        if (len && len.textContent) chips.push(len.textContent);
        var seen = li.querySelector('.c-seen');
        if (seen && seen.textContent) {
            chips.push(seen.textContent === '✓' ? I18n.t('info.watched') : I18n.t('info.watchedPct', parseInt(seen.textContent, 10)));
        }
        box.innerHTML = '';
        var nm = document.createElement('div'); nm.className = 'bi-name'; nm.textContent = m.name;
        var mt = document.createElement('div'); mt.className = 'bi-meta';
        chips.forEach(function (c) { var sp = document.createElement('span'); sp.textContent = c; mt.appendChild(sp); });
        box.appendChild(nm); box.appendChild(mt);
    }

    /* ── Theme, accent colour, text size ──────────────────────────── */
    var THEME_KEYS  = { dark: 'theme.dark', amoled: 'theme.amoled', light: 'theme.light', midnight: 'theme.midnight',
                        forest: 'theme.forest', warmlight: 'theme.warmlight', highcontrast: 'theme.highcontrast',
                        babyblue: 'theme.babyblue', grey: 'theme.grey', blackwhite: 'theme.blackwhite' };
    var ACCENT_KEYS = { sky: 'accent.sky', blue: 'accent.blue', green: 'accent.green',
                        orange: 'accent.orange', purple: 'accent.purple', pink: 'accent.pink', teal: 'accent.teal',
                        red: 'accent.red', gold: 'accent.gold', lime: 'accent.lime', indigo: 'accent.indigo',
                        white: 'accent.white' };
    var TEXT_KEYS   = { normal: 'text.normal', large: 'text.large', xlarge: 'text.xlarge' };
    function appearanceCode(setting, map, def) {
        var v = Settings.get(setting);
        return Object.prototype.hasOwnProperty.call(map, v) ? v : def;
    }
    function finishBoot() {
        var h = document.documentElement;
        h.className = h.className.replace(/\bbooting\b/, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }
    function applyAppearance() {
        var h = document.documentElement;
        h.setAttribute('data-theme',  appearanceCode('theme',    THEME_KEYS,  'dark'));
        h.setAttribute('data-accent', appearanceCode('accent',   ACCENT_KEYS, 'sky'));
        h.setAttribute('data-text',   appearanceCode('textSize', TEXT_KEYS,   'normal'));
        applyBackground();
    }
    /* ── Background picture, built-in backgrounds and fanart ───────── */
    var BG_KEYS     = { 'default': 'bg.default', aurora: 'bg.aurora', picture: 'bg.picture' };
    var FANART_KEYS = { off: 'fanart.off', subtle: 'fanart.subtle', strong: 'fanart.strong' };
    var bgPicUrl = null;          // object URL of the saved background picture
    var folderFanart = null;      // fanart of the folder being browsed
    var fanartCache = {}, fanartToken = 0;

    function bgGet(cb) {
        openThumbDB(function (db) {
            if (!db) return cb(null);
            try {
                var r = db.transaction('bg', 'readonly').objectStore('bg').get('picture');
                r.onsuccess = function () { cb(r.result || null); };
                r.onerror   = function () { cb(null); };
            } catch (e) { cb(null); }
        });
    }
    function bgPut(blob, cb) {
        openThumbDB(function (db) {
            if (!db) return cb(false);
            try {
                var tx = db.transaction('bg', 'readwrite');
                tx.objectStore('bg').put(blob, 'picture');
                tx.oncomplete = function () { cb(true); };
                tx.onerror = tx.onabort = function () { cb(false); };
            } catch (e) { cb(false); }
        });
    }
    function loadBgPicture(done) {
        bgGet(function (blob) {
            if (bgPicUrl) { try { URL.revokeObjectURL(bgPicUrl); } catch (e) {} bgPicUrl = null; }
            if (blob) bgPicUrl = URL.createObjectURL(blob);
            applyBackground();
            if (done) done(!!blob);
        });
    }
    /* One layer behind the menu screens: a built-in style, the chosen picture,
     * or the fanart of the folder you are in.  A picture is loaded first and only
     * shown once it really loaded, so a picture the TV cannot read never leaves a
     * dark screen behind. */
    var bgToken = 0, bgFailShown = false, fanartClearTimer = null;
    function applyBackground() {
        var layer = document.getElementById('app-bg');
        if (!layer) return;
        var root = document.documentElement;
        var img = layer.querySelector('.bg-img'), dim = layer.querySelector('.bg-dim');
        var mode = appearanceCode('background', BG_KEYS, 'default');
        var fan  = appearanceCode('fanart', FANART_KEYS, 'subtle');
        var inBrowse = root.getAttribute('data-view') === 'view-browse';
        var uri = null, amount = 0.35;
        if (inBrowse && folderFanart && fan !== 'off') { uri = folderFanart; amount = fan === 'strong' ? 0.2 : 0.75; }
        else if (mode === 'picture' && bgPicUrl) { uri = bgPicUrl; amount = 0.35; }
        function show(cls) {
            layer.className = cls;
            root.setAttribute('data-bgon', cls ? '1' : '0');
        }
        var token = ++bgToken;
        if (uri) {
            var pre = new Image();
            pre.onload = function () {
                if (token !== bgToken) return;
                img.style.backgroundImage = 'url("' + String(uri).replace(/"/g, '%22') + '")';
                dim.style.opacity = amount;
                show('on pic');
            };
            pre.onerror = function () {
                if (token !== bgToken) return;
                img.style.backgroundImage = '';
                show('');
                if (!bgFailShown) { bgFailShown = true; UI.toast(I18n.t('bg.loadFailed')); }
            };
            pre.src = uri;
            return;
        }
        img.style.backgroundImage = '';
        show(mode === 'aurora' ? 'on aurora' : '');
    }
    function setFolderFanart(uri) {
        if ((folderFanart || null) === (uri || null)) return;
        folderFanart = uri || null;
        applyBackground();
    }
    /* fanart.jpg, backdrop.jpg, background.jpg or "<movie>-fanart.jpg" */
    function pickFanart(list) {
        var best = null, rank = 99;
        (list || []).forEach(function (e) {
            if (e.isDir || e.kind !== 'image') return;
            var base = e.name.toLowerCase().replace(/\.[^.]+$/, ''), r = 99;
            if (base === 'fanart') r = 0;
            else if (base === 'backdrop') r = 1;
            else if (base === 'background') r = 2;
            else if (/(^|[-_. ])fanart$/.test(base)) r = 3;
            if (r < rank) { rank = r; best = e; }
        });
        return best;
    }
    /* The folder's own fanart, or else its parent's (so Season 1 uses the show's). */
    function findFolderFanart(dir, entries) {
        var token = ++fanartToken;
        clearTimeout(fanartClearTimer);
        if (appearanceCode('fanart', FANART_KEYS, 'subtle') === 'off') { setFolderFanart(null); return; }
        var own = pickFanart(entries);
        if (own) { setFolderFanart(own.uri); return; }
        var key = dir && dir.fullPath;
        if (!key) { setFolderFanart(null); return; }
        if (key in fanartCache) { setFolderFanart(fanartCache[key] || null); return; }
        var par = dir.parent;
        if (!par || !par.fullPath) { fanartCache[key] = ''; setFolderFanart(null); return; }
        Browser.listDir(par, function (err, list) {
            var f = (!err && list) ? pickFanart(list) : null;
            fanartCache[key] = f ? f.uri : '';
            if (token === fanartToken) setFolderFanart(fanartCache[key] || null);
        });
    }
    function useAsBackground(li) {
        var uri = li.dataset.uri;
        if (!uri) return;
        UI.toast(I18n.t('bg.saving'));
        makeSmallCopy(uri, function (blob) {
            if (!blob) { UI.toast(I18n.t('bg.failed')); return; }
            bgPut(blob, function (ok) {
                if (!ok) { UI.toast(I18n.t('bg.failed')); return; }
                Settings.set('background', 'picture');
                loadBgPicture(function () { UI.toast(I18n.t('bg.saved')); });
            });
        }, 1600);
    }
    function openBackgroundPicker() {
        pickerSetting = 'background';
        var opts = Object.keys(BG_KEYS).map(function (c) { return { code: c, name: I18n.t(BG_KEYS[c]) }; });
        openPicker(I18n.t('settings.background'), opts, appearanceCode('background', BG_KEYS, 'default'), function (val) {
            if (val === 'picture') {
                bgGet(function (blob) {
                    if (!blob) { UI.toast(I18n.t('bg.needPicture')); return; }
                    Settings.set('background', 'picture');
                    loadBgPicture();
                    refreshSettingsValues();
                });
                return;
            }
            Settings.set('background', val);
            applyBackground();
            refreshSettingsValues();
        });
    }

    function openAppearancePicker(setting, titleKey, map, def) {
        pickerSetting = setting;
        var opts = Object.keys(map).map(function (c) { return { code: c, name: I18n.t(map[c]) }; });
        openPicker(I18n.t(titleKey), opts, appearanceCode(setting, map, def), function (val) {
            Settings.set(setting, val);
            applyAppearance();
            refreshSettingsValues();
        });
    }

    /* ── Toolbar above the list (Sort / View) ─────────────────────── */
    function updateBrowseBar() {
        var bar = document.getElementById('browse-bar');
        if (!bar) return;
        document.getElementById('bar-sort').textContent =
            I18n.t('toolbar.sort') + ':  ' + I18n.t(SORT_KEYS[browseSortCode()]);
        document.getElementById('bar-view').textContent =
            I18n.t('toolbar.view') + ':  ' + I18n.t(VIEW_KEYS[browseViewCode()]);
        bar.classList.add('on');
    }
    /* Draw the current USB folder again after Sort or View changed, with the
     * cursor staying on the toolbar button that was used. */
    function relistBrowse(barId) {
        if (remoteRelist && inViewModeList()) { remoteBar = barId; remoteRelist(); return; }
        if (state.view !== 'browse' || state.browseAtRoot || !state.browseDir) return;
        if (!/\bvm-/.test(document.getElementById('browse-list').className)) return;
        listInto(state.browseDir, null, barId);
    }
    function inViewModeList() {
        return /\bvm-/.test(document.getElementById('browse-list').className);
    }

    /* ── Network shares (SMB, WebDAV, DLNA) use the same views and sort ── */
    var remoteRelist = null, remoteBar = null;
    window.RemoteViews = {
        sort: function (entries, kindFn) {
            entries.forEach(function (e) {
                if (e.name === undefined) e.name = e.title || '';
                e.kind = kindFn(e);
            });
            sortBrowseEntries(entries);
        },
        begin: function (ul, entries, rerender) {
            remoteRelist = rerender;
            applyBrowseView(ul, browseViewCode());
            updateBrowseCount(entries);
        },
        decorate: function (li, e, kind, opts) {
            opts = opts || {};
            var name = e.name || e.title || '';
            var sizeTxt = (!e.isDir && e.size) ? Browser.humanSize(e.size) : '';
            var typeTxt = typeText({ name: name, isDir: e.isDir });
            li.innerHTML =
                '<span class="icon">' + kindIconSvg(kind) + '</span>' +
                '<span class="name">' + escapeHtml(name) + '</span>' +
                (e.isDir ? '<span class="fav-mark">♥</span>' : '') +
                (opts.cc ? '<span class="meta c-cc">CC ×' + opts.cc + '</span>' : '') +
                '<span class="meta c-date"></span>' +
                '<span class="meta c-type">' + escapeHtml(typeTxt) + '</span>' +
                '<span class="meta length">' + escapeHtml(opts.len || '') + '</span>' +
                '<span class="meta c-size">' + escapeHtml(sizeTxt) + '</span>' +
                '<span class="meta c-seen"></span>' +
                '<span class="meta c-sub">' + escapeHtml([typeTxt, sizeTxt, opts.len || ''].filter(Boolean).join('  ·  ')) + '</span>';
            li.firstChild.classList.add('k-' + kind);
            li._meta = { name: name, isDir: !!e.isDir, kind: kind, size: e.size || 0, mtime: null };
        },
        end: function () {
            if (!remoteBar) return;
            var b = document.getElementById(remoteBar); remoteBar = null;
            if (b) UI.focusOn(b);
        }
    };

    /* ── Hold OK on a USB row: Favorites / Forget watched menu ────── */
    var hold = null;
    function holdOkStart() {
        var li = document.querySelector('#browse-list li.focused');
        if (!li || !inViewModeList()) return false;
        if (!li.dataset.history && !(li._meta && li._meta.kind === 'image')) return false;
        var h = hold = { li: li, fired: false };
        h.timer  = setTimeout(function () { h.fired = true; openRowMenu(li); }, 600);
        h.expire = setTimeout(function () { if (hold === h) hold = null; }, 2500);   // never stay stuck
        return true;
    }
    function holdOkEnd() {
        if (!hold) return;
        var h = hold; hold = null;
        clearTimeout(h.timer); clearTimeout(h.expire);
        if (!h.fired && h.li.parentNode && h.li.classList.contains('focused')) h.li.click();   // a short press opens, as always
    }
    function openRowMenu(li) {
        var opts = [], fav = null;
        if (li._meta && li._meta.kind === 'image') {          // a picture: offer it as the app background
            openPicker(li.dataset.name || (li._meta && li._meta.name) || '', [{ code: 'bg', name: I18n.t('menu.useBackground') }], null,
                function (val) { if (val === 'bg') setTimeout(function () { useAsBackground(li); }, 0); });
            return;
        }
        try { fav = li.dataset.fav ? JSON.parse(li.dataset.fav) : null; } catch (e) {}
        if (fav) opts.push({ code: 'fav', name: I18n.t(Favorites.find(fav) ? 'menu.removeFav' : 'menu.addFav') });
        opts.push({ code: 'forget', name: I18n.t('menu.forget') });
        openPicker(li.dataset.name || '', opts, null, function (val) {
            // Later, so a confirm picker (folders) opens after this one has closed.
            setTimeout(function () {
                if (val === 'fav') toggleFavoriteRow(li);
                else if (val === 'forget') forgetWatchedRow(li);
            }, 0);
        });
    }

    function openBrowseViewPicker() {
        pickerSetting = 'browseView';
        openPicker(I18n.t('settings.browseView'),
            BROWSE_VIEWS.map(function (v) { return { code: v, name: I18n.t(VIEW_KEYS[v]) }; }),
            browseViewCode(), function (val) {
                Settings.set('browseView', val);
                relistBrowse('bar-view');
            });
    }
    function openBrowseSortPicker() {
        pickerSetting = 'browseSort';
        openPicker(I18n.t('settings.browseSort'),
            BROWSE_SORTS.map(function (s) { return { code: s, name: I18n.t(SORT_KEYS[s]) }; }),
            browseSortCode(), function (val) {
                Settings.set('browseSort', val);
                relistBrowse('bar-sort');
            });
    }

    function fillLengths(rows) {
        var run = ++lengthsRun, queue = rows.slice(), busy = 0, draining = false;
        function one(row) {
            busy++;
            MediaInfo.lookup(row.entry, function (err, media) {
                busy--;
                if (run !== lengthsRun) return;
                if (err && typeof Debug !== 'undefined') Debug.browse('header of ' + row.entry.name + ': ' + (err.message || err));
                if (media && media.dur) row.li.querySelector('.length').textContent = fmtLength(media.dur);
                next();
            });
        }
        // Loop rather than recurse: lookup() may call back synchronously
        // (unparsed containers).
        function next() {
            if (draining) return;
            draining = true;
            while (busy < 2 && queue.length && run === lengthsRun) one(queue.shift());
            draining = false;
        }
        next();
    }

    /* ── Favorites (issue #140) ───────────────────────────────────── */
    /* What pinning this local folder stores.  The virtual root it is on is
     * kept when known, because `removable_…/Shows` resolves on every
     * firmware where a bare /opt/media/… path may not. */
    function usbFavorite(file, name) {
        var fav = { kind: 'usb', path: (file && file.fullPath) || '', name: name || (file && file.name) || '' };
        var root = state.browseRoot;
        if (root && fav.path.indexOf(root.fullPath + '/') === 0) {
            fav.root = root.name; fav.rootPath = root.fullPath;
        }
        return fav;
    }
    /* A folder row that ► can pin or unpin: what to pin rides on the row,
     * the ♥ shows it is pinned. */
    function markFavoriteRow(li, fav) {
        if (!fav || !fav.path) return;
        li.dataset.fav = JSON.stringify(fav);
        li.classList.toggle('is-fav', !!Favorites.find(fav));
    }
    function favoriteWhere(f) {
        if (f.kind === 'smb') {
            var srv = SMB.serverById(f.srv);
            return (srv && srv.host ? SMB.serverLabel(srv) : '\\\\?') + f.path.replace(/\//g, '\\');
        }
        if (f.kind === 'webdav') {
            var dav = WebDAV.serverById(f.srv);
            return (dav ? WebDAV.serverLabel(dav) : '?') + f.path;
        }
        return f.path;
    }
    function openFavorites() {
        var list = Favorites.list();
        if (!list.length) { UI.toast(I18n.t('favorites.none')); return; }
        if (typeof Debug !== 'undefined') Debug.view('favorites');
        UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = true;
        state.listBack = null;
        document.getElementById('browse-title').textContent = I18n.t('home.favorites');
        document.getElementById('browse-path').textContent = '';
        var ul = document.getElementById('browse-list'); ul.innerHTML = '';
        list.forEach(function (f) {
            var li = document.createElement('li');
            li.dataset.dir = '1';
            li.dataset.favId = f.id;
            li.innerHTML = '<span class="icon">' + (f.kind === 'usb' ? '💾' : '📁') + '</span>' +
                           '<span class="name">' + escapeHtml(f.name) + '</span>' +
                           '<span class="fav-mark">♥</span>' +
                           '<span class="meta">' + escapeHtml(favoriteWhere(f)) + '</span>';
            markFavoriteRow(li, f);
            li.addEventListener('click', function () { openFavorite(f); });
            ul.appendChild(li);
        });
        UI.focusInList(ul);
    }
    function openFavorite(f) {
        if (typeof Debug !== 'undefined') Debug.action('favorite ' + f.kind + ' ' + f.path);
        if (f.kind !== 'usb' && !NetworkAccess.checkFeature(f.name, function () { openFavorite(f); })) return;
        if (f.kind === 'smb') {
            // The SMB browser takes over the view and BACK; leaving the
            // folder walks up to the share root and out to Home as usual.
            state.view = 'home';
            if (!SMB.openFolder(f.srv, f.path)) {
                state.view = 'browse';
                UI.toast(I18n.t('favorites.serverGone'));
            }
            return;
        }
        if (f.kind === 'webdav') {
            state.view = 'home';
            if (!WebDAV.openFolder(f.srv, f.path)) {
                state.view = 'browse';
                UI.toast(I18n.t('dav.serverGone'));
            }
            return;
        }
        openUsbFolder(f);
    }
    /* A pinned local folder: resolved through its virtual root first, by
     * full path when the root is unknown or has gone.  When it is at
     * neither, the drive may be mounted under another name than when the
     * folder was pinned (USBDriveB1 then, USBDriveA1 now): the folder is
     * looked for on the drives plugged in, and the entry updated to where
     * it turned up (issue #181). */
    function openUsbFolder(f) {
        if (typeof tizen === 'undefined' || !tizen.filesystem) { UI.toast(I18n.t('favorites.folderGone')); return; }
        var tries = [];
        if (f.root && f.rootPath && f.path.indexOf(f.rootPath + '/') === 0)
            tries.push(f.root + f.path.slice(f.rootPath.length));
        tries.push(f.path);
        function show(dir, root) {
            state.browseAtRoot = false;
            state.browseRoot   = root;
            UI.showView('view-browse'); state.view = 'browse';
            listInto(dir);
        }
        function elsewhere() {
            UsbPaths.drives(tizen.filesystem, function (drives) {
                UsbPaths.locate(tizen.filesystem, drives, f.path, true, function (hit) {
                    if (!hit) { UI.toast(I18n.t('favorites.folderGone')); return; }
                    var root = { name: hit.drive.label, fullPath: hit.drive.fullPath };
                    var path = hit.file.fullPath || '';
                    var onRoot = !!root.fullPath && path.indexOf(root.fullPath + '/') === 0;
                    if (typeof Debug !== 'undefined') Debug.browse('favorite ' + f.path + ' found at ' + path);
                    if (path) Favorites.move(f.id, onRoot ? { path: path, root: root.name, rootPath: root.fullPath }
                                                          : { path: path });
                    show(hit.file, onRoot ? root : null);
                });
            });
        }
        (function next(i) {
            if (i >= tries.length) { elsewhere(); return; }
            try {
                tizen.filesystem.resolve(tries[i], function (dir) {
                    if (!dir || !dir.isDirectory) { next(i + 1); return; }
                    show(dir, f.root && f.rootPath ? { name: f.root, fullPath: f.rootPath } : null);
                }, function () { next(i + 1); }, 'r');
            } catch (e) { next(i + 1); }
        })(0);
    }
    /* Handle ◄ in a USB folder listing.  On a file, forget its watched mark
     * and resume position.  On a folder, ask for confirmation, then forget
     * the history of every file below it.  Return false unless the focused
     * row comes from listInto (data-history). */
    function forgetWatchedRow(given) {
        var li = given || document.querySelector('#browse-list li.focused');
        if (!given && inViewModeList()) return false;   // ◄ ► move between tiles now
        if (!li || !li.dataset.history || !li.dataset.uri || state.view !== 'browse' || !state.browseDir) return false;
        var dir = state.browseDir, uri = li.dataset.uri, name = li.dataset.name;
        if (li.dataset.dir === '0') {
            if (!WatchHistory.forget([uri])) { UI.toast(I18n.t('watched.fileNothing')); return true; }
            UI.toast(I18n.t('watched.fileForgotten', name));
            listInto(dir, uri);
            return true;
        }
        var prefix = uri.replace(/\/+$/, '') + '/';
        var n = WatchHistory.urisUnder(prefix).length;
        if (!n) { UI.toast(I18n.t('watched.nothing')); return true; }
        openPicker(I18n.t('watched.forgetConfirm', name, n), [
            { code: 'keep',   name: I18n.t('watched.keep') },
            { code: 'forget', name: I18n.t('watched.forget') }
        ], 'keep', function (val) {
            if (val !== 'forget') return;
            WatchHistory.forgetUnder(prefix);
            UI.toast(I18n.t('watched.forgotten', name));
            listInto(dir, uri);
        });
        return true;
    }
    /* ► on a folder row pins it to Favorites, or takes it off again; on the
     * Favorites list itself ► takes the row away. */
    function toggleFavoriteRow(given) {
        var li = given || document.querySelector('#browse-list li.focused');
        if (!given && inViewModeList()) return false;
        if (!li || !li.dataset.fav) return false;
        var fav = null;
        try { fav = JSON.parse(li.dataset.fav); } catch (e) { return false; }
        var have = Favorites.find(fav);
        if (have) {
            Favorites.remove(have.id);
            UI.toast(I18n.t('favorites.removed', have.name));
            if (li.dataset.favId) {
                var sibling = li.nextElementSibling || li.previousElementSibling;
                li.parentNode.removeChild(li);
                UI.refreshFocusables();
                if (sibling) UI.focusOn(sibling); else backToHome();
                return true;
            }
        } else {
            have = Favorites.add(fav);
            if (have) UI.toast(I18n.t('favorites.added', have.name));
        }
        li.classList.toggle('is-fav', !!Favorites.find(fav));
        return true;
    }
    /* The browse list is on screen — also under the SMB browser, which
     * draws into the same view without touching state.view. */
    function browseShowing() {
        var v = document.getElementById('view-browse');
        return !!v && !v.classList.contains('hidden');
    }

    /* Go up a level, with the cursor on the folder that was listed. */
    function browseUp() {
        if (state.browseAtRoot) { backToHome(); return; }
        var p = Browser.parentOf(state.browseDir);
        if (!p) { openBrowserAtRoot(state.browseDir && state.browseDir.fullPath); return; }
        listInto(p, Browser.avplayURI(state.browseDir));
    }

    function openRecent() {
        var list = getRecent();
        if (!list.length) { UI.toast(I18n.t('recent.none')); return; }
        UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = true;
        state.listBack = null;
        document.getElementById('browse-title').textContent = I18n.t('home.recent');
        document.getElementById('browse-path').textContent = '';
        var ul = document.getElementById('browse-list'); ul.innerHTML = '';
        var playlist = list.map(function (item) {
            return { uri: item.uri, title: item.title, subtitles: item.subtitles, tagSrc: item.tagSrc, art: item.art };
        });
        // Until the USB files have been looked up (below), OK on a row
        // waits for that rather than opening a path that may have moved.
        var located = false, waiting = null, rows = [];
        function play(entry) {
            if (!located) { waiting = entry; return; }
            var i = playlist.indexOf(entry);
            if (i >= 0) playFromList('recent', playlist, i, null);
        }
        playlist.forEach(function (entry) {
            var li = document.createElement('li');
            li.dataset.uri = entry.uri;
            var watched = WatchHistory.isWatched(entry.uri);
            if (watched) li.classList.add('watched-item');
            li.innerHTML = watchedIcon(watched, 'recent') +
                           '<span class="name">' + escapeHtml(entry.title) + '</span>' +
                           '<span class="meta">' + escapeHtml(entry.uri) + '</span>';
            li.addEventListener('click', function () { play(entry); });
            ul.appendChild(li);
            rows.push({ li: li, entry: entry });
        });
        markNowPlaying();
        UI.focusInList(ul);

        /* A USB drive doesn't get the same mount every time it is plugged
         * in (USBDriveA1, then USBDriveB1), and an entry keeps the path
         * its file had when it was played.  Find each file on the drives
         * that are there now; the stored list and these rows follow
         * (issue #181).  A list without USB files is done at once. */
        UsbPaths.relocate(typeof tizen !== 'undefined' ? tizen.filesystem : null,
                          playlist.map(function (p) { return p.uri; }), function (moves) {
            var n = Object.keys(moves).length;
            if (n) {
                if (typeof Debug !== 'undefined') Debug.browse('recent: ' + n + ' file(s) found under another USB mount');
                // Read again: something may have played, and been added,
                // while the drives were asked.
                var stored = UsbPaths.relocateItems(getRecent(), moves);
                if (stored.changed) setRecent(stored.list);
            }
            located = true;
            // Another list has replaced this one in the meantime.
            if (state.view !== 'browse' || !rows.length || rows[0].li.parentNode !== ul) return;
            if (n) {
                var seen = {}, focusLost = false;
                rows.forEach(function (row) {
                    var now = UsbPaths.relocateItems([row.entry], moves).list[0];
                    for (var k in now) row.entry[k] = now[k];
                    if (seen[row.entry.uri]) {
                        // The same file as a row above, now that both are found.
                        if (row.li.classList.contains('focused')) focusLost = true;
                        if (waiting === row.entry) waiting = seen[row.entry.uri];
                        playlist.splice(playlist.indexOf(row.entry), 1);
                        ul.removeChild(row.li);
                        return;
                    }
                    seen[row.entry.uri] = row.entry;
                    row.li.dataset.uri = row.entry.uri;
                    row.li.lastElementChild.textContent = row.entry.uri;
                });
                markNowPlaying();
                if (focusLost) UI.focusInList(ul); else UI.refreshFocusables();
            }
            if (waiting) play(waiting);
        });
    }

    /* ── Playlists (issue #110) ───────────────────────────────────────
     * src: {
     *   title,
     *   read(cb)      — cb(err, Uint8Array) with the list's bytes,
     *   resolve(ref)  — an entry's reference → the URI to play, or null,
     *   playAsStream()— play the list itself (it's an HLS manifest),
     *   back()        — where BACK goes from the list
     * }
     * Entries show in the browse view, grouped by group-title when the list
     * has more than one group — a big IPTV list is thousands of channels,
     * which is too many to scroll through, and too many for the TV to lay
     * out in one go. */
    var MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

    function openPlaylist(src) {
        state.listBack = null;
        UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = false;
        document.getElementById('browse-title').textContent = src.title;
        document.getElementById('browse-path').textContent = '';
        var ul = document.getElementById('browse-list');
        ul.innerHTML = '<li><span class="icon">…</span><span class="name">' +
                       escapeHtml(I18n.t('playlist.reading')) + '</span></li>';
        // BACK works while it loads too.
        state.listBack = src.back;
        var seq = ++playlistSeq;

        src.read(function (err, bytes) {
            // Left meanwhile: BACK clears listBack, other lists replace it.
            if (seq !== playlistSeq || state.view !== 'browse' || state.listBack !== src.back) return;
            var parsed = null;
            if (!err) {
                var d = TextDecode.decode(bytes);
                if (!d.binary) parsed = Playlist.parse(d.text);
            }
            if (!parsed || parsed.hls) {
                if (typeof Debug !== 'undefined')
                    Debug.player('playlist ' + src.title + ': ' + (parsed ? 'HLS manifest' :
                                 'unreadable (' + (err && err.message || 'binary') + ')') + ' → playing as a stream');
                state.listBack = null;
                src.playAsStream();
                return;
            }
            var entries = [];
            parsed.entries.forEach(function (e) {
                var uri = src.resolve(e.ref);
                if (uri) entries.push({ uri: uri, title: e.title, group: e.group, art: logoUrl(e.logo, src) });
            });
            if (typeof Debug !== 'undefined')
                Debug.player('playlist ' + src.title + ': ' + entries.length + ' of ' +
                             parsed.entries.length + ' entries playable');
            if (!entries.length) {
                ul.innerHTML = '<li><span class="icon">i</span><span class="name">' +
                               escapeHtml(I18n.t('playlist.empty')) + '</span></li>';
                return;
            }
            state.playlistView = { src: src, entries: entries, group: null, filter: '' };
            document.getElementById('playlist-filter').value = '';
            renderPlaylist();
        });
    }
    var playlistSeq = 0;

    /* The groups, or one group's entries (all entries when there's only one
     * group), or — while the filter has text — the matching entries of every
     * group.  focusUri puts the cursor back on the entry just played;
     * keepFocus leaves it in the filter field while the user types. */
    function renderPlaylist(focusUri, keepFocus) {
        var pv = state.playlistView;
        if (!pv) return;
        var groups = Playlist.groups(pv.entries);
        var grouped = groups.length > 1;
        var query = foldText(pv.filter || '');
        if (!keepFocus) { UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = false; }
        document.getElementById('browse-title').textContent = pv.src.title;
        document.getElementById('browse-path').textContent = query ? '' :
            grouped && pv.group !== null ? groupName(pv.group) : '';
        var ul = document.getElementById('browse-list');
        ul.innerHTML = '';
        var focus = null;
        if (logoObserver) { logoObserver.disconnect(); logoObserver = null; }

        if (grouped && pv.group === null && !query) {
            state.listBack = pv.src.back;
            groups.forEach(function (g) {
                var li = document.createElement('li');
                li.dataset.dir = '1';
                li.dataset.playlist = '1';
                li.innerHTML = '<span class="icon">📁</span>' +
                               '<span class="name">' + escapeHtml(groupName(g.name)) + '</span>' +
                               '<span class="meta">' + g.count + '</span>';
                li.addEventListener('click', function () { pv.group = g.name; renderPlaylist(); });
                ul.appendChild(li);
                if (focusUri === 'group:' + g.name) focus = li;
            });
        } else {
            // Back clears the filter before it leaves the group or the list.
            state.listBack = query ? clearPlaylistFilter
                : grouped
                ? function () { var was = pv.group; pv.group = null; renderPlaylist('group:' + was); }
                : pv.src.back;
            var items = pv.entries.filter(function (e) {
                if (query) return foldText(e.title).indexOf(query) >= 0 ||
                                  (grouped && foldText(groupName(e.group)).indexOf(query) >= 0);
                return !grouped || (e.group || '') === pv.group;
            });
            // What the keyboard really typed, for a layout that doesn't find
            // what it should (Cyrillic was reported, issue #126).
            if (query && typeof Debug !== 'undefined')
                Debug.info('playlist filter ' + describeText(pv.filter) + ' (' + (lastFilterEvent || '?') +
                           '): ' + items.length + ' of ' + pv.entries.length);
            if (!items.length) {
                ul.innerHTML = '<li data-playlist="1"><span class="icon">i</span><span class="name">' +
                               escapeHtml(I18n.t('playlist.noMatches', pv.filter.trim())) + '</span></li>';
            }
            items.forEach(function (e, i) {
                var li = document.createElement('li');
                li.dataset.playlist = '1';
                li.dataset.uri = e.uri;
                li.dataset.channel = e.title;
                if (e.art) li.dataset.logo = e.art;
                li.innerHTML = '<span class="icon channel-icon"><span class="glyph">' + FileTypes.icon(entryKind(e)) + '</span></span>' +
                               '<span class="name">' + escapeHtml(e.title) + '</span>' +
                               (query && grouped ? '<span class="meta">' + escapeHtml(groupName(e.group)) + '</span>' : '') +
                               '<span class="saved-mark">★</span>';
                li.classList.toggle('is-saved', !!SavedStreams.findByUrl(e.uri));
                li.addEventListener('click', function () {
                    state.listBack = null;
                    playFromList('playlist', items, i, null);
                });
                ul.appendChild(li);
                if (focusUri && e.uri === focusUri) focus = li;
            });
        }
        markNowPlaying();
        loadLogos(ul);
        if (keepFocus) UI.refreshFocusables();
        else UI.focusInList(ul, focus);
    }

    /* The playlist filter (issue #122): what's typed matches anywhere in a
     * title, folded the same way on both sides (Playlist.foldText), across
     * every group.  Redrawn a moment after typing stops, so a 10 000-channel
     * list keeps up. */
    var foldText = Playlist.foldText;
    /* `"Спорт" [U+0421 U+043F …]`: text with its code points, for the log —
     * the one way to see what a keyboard layout really put in a field. */
    function describeText(s) {
        s = String(s || '');
        var cps = [];
        for (var i = 0; i < s.length && i < 16; i++)
            cps.push('U+' + ('000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4));
        return JSON.stringify(s) + ' [' + cps.join(' ') + (s.length > 16 ? ' …' : '') + ']';
    }
    var filterTimer = null, lastFilterEvent = '';
    function onPlaylistFilterInput(ev) {
        lastFilterEvent = (ev && ev.type) || '';
        clearTimeout(filterTimer);
        filterTimer = setTimeout(function () {
            var pv = state.playlistView;
            var input = document.getElementById('playlist-filter');
            if (!pv || state.view !== 'browse' || pv.filter === input.value) return;
            pv.filter = input.value;
            renderPlaylist(null, true);
        }, 250);
    }
    function clearPlaylistFilter() {
        var pv = state.playlistView;
        clearTimeout(filterTimer);
        document.getElementById('playlist-filter').value = '';
        if (!pv) return;
        pv.filter = '';
        renderPlaylist();
    }
    /* The field only while a playlist is listed; every browse list is drawn
     * into the same <ul>, which also tells the ► and ◄ hints when to show. */
    function watchPlaylistList() {
        var ul = document.getElementById('browse-list');
        var hint = document.getElementById('hint-save');
        var hintFav = document.getElementById('hint-fav');
        var hintForget = document.getElementById('hint-forget');
        var filter = document.getElementById('playlist-filter-wrap');
        var input = document.getElementById('playlist-filter');
        // Not every keyboard layout reports typing as `input` on every
        // firmware (Cyrillic was reported not to filter, issue #126), so
        // every event that can follow a change is heard; the handler only
        // redraws when the text actually differs.
        if (input) ['input', 'change', 'keyup', 'compositionend'].forEach(function (ev) {
            input.addEventListener(ev, onPlaylistFilterInput);
        });
        if (!ul || typeof MutationObserver === 'undefined') return;
        new MutationObserver(function () {
            if (hint) hint.classList.toggle('hidden', !ul.querySelector('li[data-channel]'));
            var usbList = /\bvm-/.test(ul.className);
            var hintMenu = document.getElementById('hint-menu');
            if (hintMenu) hintMenu.classList.toggle('hidden', !usbList);
            if (hintFav) hintFav.classList.toggle('hidden', usbList || !ul.querySelector('li[data-fav]'));
            // Also show it for folders, since files below them may have history.
            if (hintForget) hintForget.classList.toggle('hidden', usbList || !ul.querySelector('li[data-seen], li[data-history][data-dir="1"]'));
            if (filter) filter.classList.toggle('hidden', !ul.querySelector('li[data-playlist]'));
        }).observe(ul, { childList: true });
    }

    /* Channel logos (tvg-logo, issue #123).  A relative one sits beside the
     * list, like the streams; only web addresses are kept, which covers
     * the list's own folder on SMB too (the service serves it over http). */
    function logoUrl(logo, src) {
        if (!logo) return null;
        var u = /^https?:/i.test(logo) ? logo : src.resolve(logo);
        if (!NetworkAccess.allows(u)) return null;   // <img> loads bypass the XHR check, so check here
        return u && /^https?:/i.test(u) ? u : null;
    }
    /* A list of thousands of channels mustn't fetch thousands of pictures:
     * a logo is fetched once its row scrolls near the screen.  Until it has
     * loaded, and for good when it can't, the row keeps its plain icon. */
    var logoObserver = null;
    var LOGOS_WITHOUT_OBSERVER = 40;
    function loadLogos(ul) {
        var rows = ul.querySelectorAll('li[data-logo]');
        if (!rows.length) return;
        if (typeof IntersectionObserver === 'undefined') {
            for (var i = 0; i < rows.length && i < LOGOS_WITHOUT_OBSERVER; i++) showLogo(rows[i]);
            return;
        }
        logoObserver = new IntersectionObserver(function (seen, obs) {
            seen.forEach(function (s) {
                if (!s.isIntersecting) return;
                obs.unobserve(s.target);
                showLogo(s.target);
            });
        }, { root: ul, rootMargin: '400px 0px' });
        for (var j = 0; j < rows.length; j++) logoObserver.observe(rows[j]);
    }
    function showLogo(li) {
        var slot = li.querySelector('.channel-icon');
        if (!slot || slot.querySelector('img')) return;
        var img = document.createElement('img');
        img.alt = '';
        img.onload  = function () { slot.classList.add('has-logo'); };
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
        img.src = li.dataset.logo;
        slot.appendChild(img);
    }
    function groupName(g) { return g || I18n.t('playlist.ungrouped'); }

    /* Right on a channel row puts it on Saved streams, or takes it off
     * again (issue #121), so a few channels out of a big IPTV list play
     * straight from the URL screen.  The ★ shows which are on it. */
    function toggleSavedChannel() {
        var li = document.querySelector('#browse-list li.focused');
        if (!li || li.dataset.channel == null) return false;
        var s = SavedStreams.findByUrl(li.dataset.uri);
        if (s) {
            SavedStreams.remove(s.id);
            UI.toast(I18n.t('saved.removed', s.name));
        } else {
            s = SavedStreams.add(li.dataset.channel, li.dataset.uri);
            if (s) UI.toast(I18n.t('saved.saved', s.name));
        }
        li.classList.toggle('is-saved', !!SavedStreams.findByUrl(li.dataset.uri));
        return true;
    }

    /* A stream URL has no extension more often than not; call it video. */
    function entryKind(e) {
        var k = FileTypes.kind(String(e.uri).split('?')[0]);
        return k === 'audio' ? 'audio' : 'video';
    }

    /* The bytes behind a URL, for a playlist typed on the URL screen.  A
     * plain GET: an IPTV panel rarely answers Range requests. */
    function fetchBytes(url, cb) {
        var done = false;
        function finish(err, bytes) { if (!done) { done = true; cb(err, bytes); } }
        try {
            var x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.responseType = 'arraybuffer';
            x.timeout = 20000;
            x.onload = function () {
                if (x.status < 200 || x.status >= 300) { finish(new Error('HTTP ' + x.status)); return; }
                var b = new Uint8Array(x.response || new ArrayBuffer(0));
                finish(null, b.length > MAX_PLAYLIST_BYTES ? b.subarray(0, MAX_PLAYLIST_BYTES) : b);
            };
            x.onerror   = function () { finish(new Error('network error')); };
            x.ontimeout = function () { finish(new Error('timed out')); };
            x.send();
        } catch (e) { finish(e); }
    }

    /* ── Standby handling (issue #42) ────────────────────────────────
     * Tizen sends `visibilitychange` when the TV screen turns off / the app
     * gets hidden by another surface.  AVPlay's session doesn't survive
     * that reliably (see the standbySnapshot comment above); we tear down
     * on hidden and, on wake, re-open the same file with the saved
     * subtitles list and defer a seek-to-position + pause until the new
     * session actually reaches PLAYING (handled in the onstatechange
     * listener). */
    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            if ((state.view !== 'player' && !state.background) || !state.playingUri) return;
            var subs = [];
            var cur = state.playlist[state.playlistIndex];
            if (cur && cur.subtitles) subs = cur.subtitles;
            standbySnapshot = {
                uri:       state.playingUri,
                title:     state.playingTitle,
                subtitles: subs,
                // Preserve the live Tizen File object for standby resumes;
                // it carries size/path APIs used by incremental extraction.
                file:      cur && cur.file ? cur.file : null,
                tagSrc:    cur && cur.tagSrc ? cur.tagSrc : null,
                background: state.background,
                pos:       Player.currentTime() || 0,
                paused:    Player.state() === 'PAUSED'
            };
            if (typeof Debug !== 'undefined')
                Debug.player('visibility=hidden: snapshot pos=' + standbySnapshot.pos + 'ms paused=' + standbySnapshot.paused);
            // Persist the exact position too — if the TV never wakes back
            // into the app, the next launch still resumes from here.
            WatchHistory.saveResumePos(state.playingUri, standbySnapshot.pos, lastProgress.duration);
            try { Player.stop(); } catch (e) {}
        } else if (document.visibilityState === 'visible') {
            if (!standbySnapshot) return;
            var ss = standbySnapshot; standbySnapshot = null;
            if (typeof Debug !== 'undefined')
                Debug.player('visibility=visible: restoring ' + ss.uri + ' at ' + ss.pos + 'ms');
            playUri(ss.uri, ss.title, {
                subtitles: ss.subtitles,
                file:      ss.file,
                tagSrc:    ss.tagSrc,
                background: ss.background,
                resume:    { pos: ss.pos, paused: ss.paused }
            });
        }
    }

    /* ── Common: open a URI in player view ────────────────────────── */
    var openWatchdog = null;
    function playUri(uri, title, opts) {
        opts = opts || {};
        if (!NetworkAccess.check(uri, title, function () { playUri(uri, title, opts); })) return;
        if (typeof Debug !== 'undefined') Debug.player('playUri uri=' + uri + '  title=' + title);

        /* Issue #78: a file opened from a list or the URL screen that has a
         * saved position asks Continue / Start over first (Settings → Resume
         * playback = Ask).  The prompt runs BEFORE anything below touches
         * player state, so BACK / Cancel simply leaves the user where they
         * were.  Next/Prev, auto-play and standby wakes never ask. */
        if (opts.askResume && !opts.resume &&
            Settings.get('resumeMode') === 'ask' && WatchHistory.resumePosFor(uri)) {
            var again = {};
            for (var k in opts) again[k] = opts[k];
            again.askResume = false;
            openPicker(title || uri, [
                { code: 'continue', name: I18n.t('resume.continueFrom', fmtTime(WatchHistory.resumePosFor(uri))) },
                { code: 'restart',  name: I18n.t('resume.restart') }
            ], 'continue', function (val) {
                again.fromStart = (val === 'restart');
                playUri(uri, title, again);
            });
            return;
        }
        // Reset the once-per-file gate so applyLanguagePreferences runs for
        // the new file (and not for the previous file).
        prefsAppliedFor = null;
        lastProgress = { time: 0, duration: 0 };
        hideNextUp(); nextUpDismissedFor = null;
        lastResumeSaveAt = 0;
        durationNoted = false;
        prevRestartLit = false;
        resetScrub();          // a scrub/settle from the previous file must
                               // not freeze the new file's progress bar

        /* Seek-once-playing (applied in the onstatechange('playing')
         * handler): a standby wake passes an explicit resume point via
         * opts.resume; otherwise fall back to the persisted last-watched
         * position so a reopened file continues where the user left off.
         * Always assigned, so a stale pendingResume from a restore that
         * never reached PLAYING can't leak into the next file. */
        if (opts.resume) {
            pendingResume = { pos: opts.resume.pos, paused: opts.resume.paused };
        } else if (opts.fromStart || Settings.get('resumeMode') === 'never') {
            // Starting over: drop the saved position so the file also opens
            // clean next time (until playback saves a new one).
            WatchHistory.clearResumePos(uri);
            pendingResume = null;
        } else {
            var resumeAt = WatchHistory.resumePosFor(uri);
            pendingResume = resumeAt
                ? { pos: Math.max(0, resumeAt - RESUME_BACKOFF_MS), paused: false, announce: true }
                : null;
        }

        state.playingUri = uri;
        state.playingTitle = title || uri;
        state.directFallback = null;
        updateNextPrevButtons();
        // In the background (next track while browsing) the screen stays
        // where the user is; only the mini-player follows along.
        if (opts.background) {
            state.background = true;
        } else {
            state.background = false;
            UI.showView('view-player'); state.view = 'player';
            if (typeof Debug !== 'undefined') Debug.view('player');
        }

        document.getElementById('osd-title').textContent = title || uri;
        var isAudio = FileTypes.kind(title || '') === 'audio' ||
                      FileTypes.kind(String(uri).split('?')[0]) === 'audio';
        document.getElementById('audio-card').classList.toggle('hidden', !isAudio);
        document.getElementById('audio-title').textContent = isAudio ? (title || uri) : '';
        state.playingIsAudio = isAudio;
        showAudioTags(isAudio ? uri : null, opts);
        updateMiniPlayer();
        markNowPlaying();
        // Through showOSD when the player is on screen, so the cursor lands
        // on play/pause.  The view was switched above with the controls
        // still hidden, so nothing in it could take the cursor yet, and OK
        // in the first seconds went to the list row the file was opened
        // from: the file opened again, or asked Continue / Start over
        // (issue #178).
        if (opts.background) {
            document.getElementById('osd-top').classList.remove('hidden');
            document.getElementById('osd-bottom').classList.remove('hidden');
        } else {
            showOSD(true);
        }
        showSpinner(I18n.t('player.openingShort'));
        hideError();

        // Defer slightly so the <object> element is laid out before AVPlay
        // tries to bind to it.  No need to call setDisplayRect here — AVPlay
        // is in an idle state before open() and would error with INVALID_STATE.
        // The proper setDisplayRect happens after prepareAsync succeeds.
        setTimeout(function () {
            // A USB / internal file may be routed through the paired transcode
            // server (for surround, or a codec the TV can't decode), and with
            // smart routing a share file the server would only remux skips it.
            // That changes which URL AVPlay opens, not the identity of what's
            // playing — `uri` stays the key for recents, resume, watched and
            // subtitle lookup, and the resolver hands back `uri` unchanged
            // whenever routing isn't on or isn't available.
            var resolve = (typeof TranscodeServer !== 'undefined' && TranscodeServer.resolvePlaybackUri)
                ? TranscodeServer.resolvePlaybackUri
                : function (u, done) { done(u); };
            resolve(uri, function (openUrl, route) {
                // Arming the relay or probing is async; the user may have
                // backed out or started something else in the meantime.
                if (state.playingUri !== uri) return;
                state.directFallback = (route && route.fallback)
                    ? { uri: uri, title: title, opts: opts } : null;
                if (openUrl !== uri && typeof Debug !== 'undefined')
                    Debug.player((state.directFallback ? 'smart routing: playing directly → '
                                                       : 'routing through transcode server → ') + openUrl);
                Player.open(openUrl, {
                    title:     title,
                    subtitles: opts.subtitles || [],
                    file:      opts.file || null,
                    // Where embedded subtitles are read from.  On the direct
                    // route that's the file itself — `uri` would be the
                    // server's /play URL, and reading it starts a transcode.
                    sourceUri: state.directFallback ? openUrl : uri
                });
            });
        }, 50);

        // Watchdog: detect two failure modes —
        //   1. AVPlay never reaches PLAYING within 20 s (stuck in IDLE/READY)
        //   2. AVPlay reports PLAYING but currentTime stays at 0 for 10 s
        //      AND we're not buffering — i.e. a real codec stall, not a
        //      slow source still filling its buffer (common on the SMB
        //      proxy path for small or oddly-laid-out files).
        clearInterval(openWatchdog);
        var watchdogStart = Date.now();
        openWatchdog = setInterval(function () {
            var elapsed = Date.now() - watchdogStart;
            var state   = Player.state();
            var time    = Player.currentTime();
            var buffering  = (typeof Player.isBuffering === 'function') ? Player.isBuffering() : false;
            var lastBuffer = (typeof Player.lastBufferingMs === 'function') ? Player.lastBufferingMs() : 0;
            var bufferingRecent = buffering || (lastBuffer && Date.now() - lastBuffer < 5000);

            if (elapsed > 20000 && state !== 'PLAYING' && state !== 'PAUSED' && !bufferingRecent) {
                clearInterval(openWatchdog);
                if (retryThroughServer('stuck loading, AVPlay state ' + state)) return;
                showError(I18n.t('player.stuck', state), 'codec');
                return;
            }
            if (elapsed > 10000 && state === 'PLAYING' && (!time || time === 0) && !bufferingRecent) {
                clearInterval(openWatchdog);
                if (retryThroughServer('playhead not advancing')) return;
                showError(I18n.t('player.stalled'));
                return;
            }
            if (state === 'PLAYING' && time > 0) {
                // We're actually progressing — disarm.
                clearInterval(openWatchdog);
            }
        }, 1000);

        pushRecent({ uri: uri, title: title || uri, subtitles: opts.subtitles, tagSrc: opts.tagSrc, art: folderArtFor(uri) });
        scheduleOSDHide();
    }

    /* ── Now playing: tags and cover art (issue #105) ────────────────
     * Read out of the head of the file itself — the USB File, or the share
     * file straight off the smbproxy even when the transcode server is the
     * one playing it (its HLS carries no tags).  A stream URL with no music
     * extension is left alone: it may be a live radio that never ends. */
    var tagSeq = 0, artUrl = null;
    var TAG_FIRST_READ = 128 * 1024;

    function tagSourceFor(uri, opts) {
        if (opts.tagSrc) return opts.tagSrc;
        if (opts.file)   return opts.file;
        var s = String(uri || '');
        if (typeof SMB !== 'undefined' && SMB.isStreamUrl && SMB.isStreamUrl(s)) return s;
        if (typeof WebDAV !== 'undefined' && WebDAV.isStreamUrl && WebDAV.isStreamUrl(s)) return s;
        if (/^file:/i.test(s)) return s;
        if (/^https?:/i.test(s) && FileTypes.kind(s.split('?')[0].split('#')[0]) === 'audio') return s;
        return null;
    }

    /* The folder's cover picture (cover.jpg …) the list put on this file,
     * if it is the one playing; shown when the file carries no art itself. */
    function folderArtFor(uri) {
        var cur = state.playlist[state.playlistIndex];
        return cur && cur.uri === uri && cur.art ? cur.art : null;
    }

    function showAudioTags(uri, opts) {
        var seq = ++tagSeq;
        setCoverArt(null);
        document.getElementById('audio-sub').textContent = '';
        var folderArt = uri ? folderArtFor(uri) : null;
        var src = uri ? tagSourceFor(uri, opts || {}) : null;
        if (!src || typeof AudioTags === 'undefined') {
            if (folderArt) setCoverArt({ url: folderArt });
            return;
        }
        var want = TAG_FIRST_READ;
        (function read(round) {
            Browser.readHead(src, want, function (err, bytes, total) {
                if (seq !== tagSeq) return;   // another file started meanwhile
                if (err) {
                    if (typeof Debug !== 'undefined') Debug.player('tags: read failed: ' + (err.message || err));
                    if (folderArt) setCoverArt({ url: folderArt });
                    return;
                }
                var t = AudioTags.parse(bytes);
                // Cover art bigger than the first read: go again for the rest.
                if (t.need && t.need > bytes.length && round < 3 &&
                    !(total && bytes.length >= total) && bytes.length >= want) {
                    want = t.need;
                    read(round + 1);
                    return;
                }
                if (!t.picture && folderArt) t.picture = { url: folderArt };
                applyAudioTags(t);
            });
        })(0);
    }

    function applyAudioTags(t) {
        var artist = t.artist || t.albumArtist || '';
        if (typeof Debug !== 'undefined')
            Debug.player('tags: ' + JSON.stringify({ title: t.title, artist: artist, album: t.album,
                                                     art: t.picture ? (t.picture.url || t.picture.bytes.length) : 0 }));
        if (t.title) {
            document.getElementById('audio-title').textContent = t.title;
            document.getElementById('osd-title').textContent = (artist ? artist + ' — ' : '') + t.title;
        }
        document.getElementById('audio-sub').textContent =
            [artist, t.album].filter(Boolean).join('  ·  ');
        if (t.picture) setCoverArt(t.picture);
        updateMiniPlayer();
    }

    /* pic: { bytes, mime } out of the file's tags, made into a blob: URL
     * that is released again with the next file — or { url } of the
     * folder's cover picture. */
    function setCoverArt(pic) {
        var img = document.getElementById('audio-art');
        var note = document.getElementById('audio-note');
        if (artUrl) { try { URL.revokeObjectURL(artUrl); } catch (e) {} artUrl = null; }
        img.onerror = null;
        img.removeAttribute('src');
        img.classList.add('hidden');
        note.classList.remove('hidden');
        if (!pic) return;
        var src = pic.url;
        if (!src) {
            try {
                src = artUrl = URL.createObjectURL(new Blob([pic.bytes], { type: pic.mime }));
            } catch (e) { return; }
        }
        // A picture the TV can't decode leaves the note up.
        img.onload  = function () { img.classList.remove('hidden'); note.classList.add('hidden'); updateMiniPlayer(); };
        img.onerror = function () { setCoverArt(null); };
        img.src = src;
    }

    /* Smart routing sent this share file straight to AVPlay and it never
     * started: remember that, and replay it through the transcode server —
     * where it would have gone without smart routing (issue #87).  Only
     * before anything has played; past that an error is about the file or
     * the network, not the route. */
    function retryThroughServer(why) {
        var fb = state.directFallback;
        if (!fb || fb.uri !== state.playingUri || lastProgress.time > 0) return false;
        state.directFallback = null;
        clearInterval(openWatchdog);
        if (typeof Debug !== 'undefined')
            Debug.player('smart routing: direct play failed (' + why + ') — retrying through the transcode server');
        if (typeof TranscodeServer !== 'undefined' && TranscodeServer.markDirectFailed)
            TranscodeServer.markDirectFailed(fb.uri);
        try { Player.stop(); } catch (e) {}
        UI.toast(I18n.t('player.viaServer'));
        var again = {};
        for (var k in fb.opts) again[k] = fb.opts[k];
        again.askResume = false;   // already answered for this open
        playUri(fb.uri, fb.title, again);
        return true;
    }

    /* ── Playlist navigation (auto-play + next/prev) ──────────────── */
    /* Fisher-Yates on a copy.  When shuffle is on we still put the user's
     * clicked item at index 0 so playback starts with what they picked and
     * only *subsequent* items are randomized — matches how music apps
     * behave when you tap a specific track with shuffle enabled. */
    function shufflePlaylist(list, keepFirstIdx) {
        var out = list.slice();
        for (var i = out.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
        }
        if (keepFirstIdx >= 0 && keepFirstIdx < list.length) {
            var pinned = list[keepFirstIdx];
            var cur = out.indexOf(pinned);
            if (cur > 0) { out[cur] = out[0]; out[0] = pinned; }
        }
        return out;
    }
    function playFromList(origin, playlist, idx, dir, back) {
        // OK on the song that's playing on in the background: back to it,
        // not a restart.
        var picked = playlist && playlist[idx];
        if (state.background && picked && picked.uri === state.playingUri) { restorePlayer(); return; }
        state.origin        = origin;
        state.originDir     = dir;
        state.originBack    = back || null;
        if (Settings.get('shuffle') && playlist && playlist.length > 1) {
            state.playlist      = shufflePlaylist(playlist, idx);
            state.playlistIndex = 0;
        } else {
            state.playlist      = playlist || [];
            state.playlistIndex = idx;
        }
        var item = state.playlist[state.playlistIndex];
        if (!item) return;
        playUri(item.uri, item.title, { subtitles: item.subtitles || [], file: item.file || null, tagSrc: item.tagSrc || null, askResume: true });
    }
    /* The next (+1) or previous (−1) item to play, wrapping round under
     * repeat-all, or -1.  In the background only music counts: a video in
     * the same folder would play on behind the list with nobody seeing it. */
    function stepIndex(dir) {
        var n = state.playlist.length, i = state.playlistIndex;
        if (i < 0 || !n) return -1;
        var wrap = Settings.get('repeatMode') === 'all';
        for (var k = 0; k < n; k++) {
            i += dir;
            if (i < 0 || i >= n) {
                if (!wrap) return -1;
                i = (i + n) % n;
            }
            if (i === state.playlistIndex) return -1;   // all the way round
            var it = state.playlist[i];
            // A DLNA title has no extension; its URL usually does.
            if (!state.background || FileTypes.kind(it.title || '') === 'audio' ||
                FileTypes.kind(String(it.uri).split('?')[0]) === 'audio') return i;
        }
        return -1;
    }
    function playNext(isAuto) {
        var ni = stepIndex(+1);
        if (ni < 0) return false;
        var item = state.playlist[ni];
        state.playlistIndex = ni;
        if (isAuto) UI.toast(I18n.t('player.upNext', item.title));
        playUri(item.uri, item.title, { subtitles: item.subtitles || [], file: item.file || null, tagSrc: item.tagSrc || null,
                                        background: state.background });
        return true;
    }
    /* OSD Prev / MediaTrackPrevious: restart the current file when we're
     * past the first few seconds, otherwise go to the previous item.  A
     * second press right after a restart therefore lands on the previous
     * item, exactly like a music player. */
    function handlePrev() {
        if (lastProgress.time > RESTART_THRESHOLD_MS) {
            if (scrub.active) cancelScrub(false);
            Player.seekTo(0);
            updateProgress(0, lastProgress.duration);
            flashOSD();
            UI.toast(I18n.t('player.restarted'));
            return;
        }
        if (!playPrev()) UI.toast(I18n.t('player.noPrev'));
    }
    function playPrev() {
        var pi = stepIndex(-1);
        if (pi < 0) return false;
        var item = state.playlist[pi];
        state.playlistIndex = pi;
        playUri(item.uri, item.title, { subtitles: item.subtitles || [], file: item.file || null, tagSrc: item.tagSrc || null,
                                        background: state.background });
        return true;
    }
    /* Dim the prev/next OSD buttons when there's nothing on that side.
     * Prev stays lit once the file is far enough in to restart. */
    function updateNextPrevButtons() {
        var prev = document.getElementById('btn-prev');
        var next = document.getElementById('btn-next');
        var wraps = Settings.get('repeatMode') === 'all' && state.playlist.length > 1;
        var hasPrev = wraps || state.playlistIndex > 0;
        var hasNext = state.playlistIndex >= 0 && (wraps || state.playlistIndex + 1 < state.playlist.length);
        var changed = false;
        if (prev && prev.classList.contains('hidden') === hasPrev) { prev.classList.toggle('hidden', !hasPrev); changed = true; }
        if (next && next.classList.contains('hidden') === hasNext) { next.classList.toggle('hidden', !hasNext); changed = true; }
        if (changed) UI.refreshFocusables();
    }

    /* Leave the player and return to the menu playback was launched from,
     * rather than always jumping back to the home screen. */
    function exitPlayer() {
        // Paint the list first, then release the decoder a moment later: on
        // the TV av.close() can freeze the screen black for a second or more.
        document.documentElement.setAttribute('data-leaving', '1');
        returnToOrigin();
        setTimeout(function () {
            stopPlayback();
            setTimeout(function () { document.documentElement.removeAttribute('data-leaving'); }, 400);
        }, 60);
    }

    /* Stop for good: watched / resume bookkeeping, the decoder released, the
     * mini-player gone. */
    function stopPlayback() {
        cancelSleep(); hideNextUp();
        // Watched ≥ 90 % counts as seen even if the user stops before the end
        // (markWatched also drops the resume position); anything short of
        // that keeps its position so the file can pick up where it left off.
        if (lastProgress.duration && lastProgress.time / lastProgress.duration >= WatchHistory.WATCHED_FRACTION)
            WatchHistory.markWatched(state.playingUri);
        else if (lastProgress.time > 0)   // time===0 → playback never started;
            WatchHistory.saveResumePos(state.playingUri, lastProgress.time, lastProgress.duration);

        resetScrub();
        Player.stop();
        state.background = false;
        hideMiniPlayer();
        markNowPlaying();
        hideError();
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        closeTrackMenu();
    }

    /* ── Music in the background (issue #105) ────────────────────────
     * BACK on a song that's playing doesn't stop it: the user goes back to
     * the list it came from and it plays on, with a mini-player in the
     * corner and auto-play / repeat carrying on through the folder.  The
     * media keys still work from any screen (see backgroundKeys); OK on
     * the playing song, or INFO, brings the full player back, and Stop
     * ends it.  Video always stops on BACK, as before. */
    function minimizePlayer() {
        if (scrub.active) commitScrub();
        state.background = true;
        closeTrackMenu();
        clearTimeout(osdHideTimer);
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        if (typeof Debug !== 'undefined') Debug.player('playing on in the background: ' + state.playingTitle);
        returnToOrigin();
        updateMiniPlayer();
        markNowPlaying();
    }
    function restorePlayer() {
        if (!state.background) return;
        if (typeof SMB !== 'undefined' && SMB.detach) SMB.detach();   // its BACK would steer the player
        if (typeof DLNA !== 'undefined' && DLNA.detach) DLNA.detach();
        if (typeof WebDAV !== 'undefined' && WebDAV.detach) WebDAV.detach();
        state.listBack = null;
        state.background = false;
        hideMiniPlayer();
        UI.showView('view-player'); state.view = 'player';
        flashOSD();
    }
    function stopBackground() {
        stopPlayback();
        UI.toast(I18n.t('mini.stopped'));
    }
    /* A file that won't play in the background: say so and move on, but
     * give up after a whole list of failures. */
    function backgroundError(msg) {
        clearInterval(openWatchdog);
        if (typeof Debug !== 'undefined') Debug.error('background: ' + msg);
        UI.toast(I18n.t('mini.skipped', state.playingTitle));
        state.bgErrors++;
        if (state.bgErrors < Math.max(1, state.playlist.length) && playNext(true)) return;
        stopBackground();
    }

    /* The remote while music plays on behind another screen. */
    function backgroundKeys(code) {
        var K = Remote.KEY;
        switch (code) {
            case K.PLAY: case K.PAUSE: case K.PLAYPAUSE:
                Player.togglePause(); updateMiniPlayer(); return true;
            case K.STOP:    stopBackground(); return true;
            case K.FF:      Player.seekRel( skipLongMs()); return true;
            case K.REWIND:  Player.seekRel(-skipLongMs()); return true;
            case K.CH_UP:   case K.TRACK_NEXT:
                if (!playNext(false)) UI.toast(I18n.t('player.noNext')); return true;
            case K.CH_DOWN: case K.TRACK_PREV:
                handlePrev(); return true;
            case K.INFO:    restorePlayer(); return true;
        }
        return false;
    }

    function updateMiniPlayer() {
        var mini = document.getElementById('mini-player');
        if (!mini) return;
        var on = state.background && !!state.playingUri;
        document.body.classList.toggle('mini-on', on);
        if (!on) { mini.classList.add('hidden'); return; }
        mini.classList.remove('hidden');
        document.getElementById('mini-title').textContent = document.getElementById('audio-title').textContent || state.playingTitle;
        document.getElementById('mini-sub').textContent   = document.getElementById('audio-sub').textContent;
        var art = document.getElementById('audio-art'), mArt = document.getElementById('mini-art');
        var hasArt = !art.classList.contains('hidden') && art.getAttribute('src');
        if (hasArt) mArt.src = art.getAttribute('src'); else mArt.removeAttribute('src');
        mArt.classList.toggle('hidden', !hasArt);
        document.getElementById('mini-note').classList.toggle('hidden', !!hasArt);
        document.getElementById('mini-state').textContent = Player.state() === 'PAUSED' ? '❚❚' : '▶';
        updateMiniProgress();
    }
    function updateMiniProgress() {
        var f = document.getElementById('mini-fill');
        if (!f) return;
        var pct = lastProgress.duration ? Math.min(100, lastProgress.time / lastProgress.duration * 100) : 0;
        f.style.width = pct.toFixed(1) + '%';
    }
    function hideMiniPlayer() {
        var mini = document.getElementById('mini-player');
        if (mini) mini.classList.add('hidden');
        document.body.classList.remove('mini-on');
    }
    /* ♪ on the row of whatever plays on in the background. */
    function markNowPlaying() {
        var uri = state.background ? state.playingUri : null;
        var rows = document.querySelectorAll('#browse-list li[data-uri]');
        for (var i = 0; i < rows.length; i++)
            rows[i].classList.toggle('now-playing', !!uri && rows[i].dataset.uri === uri);
    }

    /* Back to the list playback was launched from, rather than always
     * jumping home. */
    function returnToOrigin() {
        if (state.originBack) {
            if (typeof Debug !== 'undefined') Debug.view('origin (return)');
            state.view = 'browse';
            state.originBack({ uri: state.playingUri, title: state.playingTitle });
        } else if (state.origin === 'browse' && state.originDir) {
            if (typeof Debug !== 'undefined') Debug.view('browse (return)');
            UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = false;
            listInto(state.originDir, state.playingUri);
        } else if (state.origin === 'playlist' && state.playlistView) {
            if (typeof Debug !== 'undefined') Debug.view('playlist (return)');
            renderPlaylist(state.playingUri);
        } else if (state.origin === 'recent' && Settings.get('recentHistory') && getRecent().length) {
            if (typeof Debug !== 'undefined') Debug.view('recent (return)');
            openRecent();
        } else {
            backToHome();
        }
    }

    function backToHome() {
        if (typeof Debug !== 'undefined') Debug.view('home');
        resetScrub();
        // Music playing on in the background keeps playing on the home screen.
        if (!state.background) Player.stop();
        state.view = 'home';
        state.listBack = null;
        state.playlistView = null;
        UI.showView('view-home');
        hideError();
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        closeTrackMenu();
    }

    /* Cleanly quit the app from the home view (issue #57).  Tizen exposes
     * this on the current-application object; window.close() is a fallback
     * for the emulator / desktop-preview environment where the tizen
     * namespace isn't present.  Player is stopped first so AVPlay isn't
     * left holding a decoder handle if the user quit mid-playback via
     * exitPlayer → home → BACK. */
    function exitApp() {
        if (typeof Debug !== 'undefined') Debug.action('exit-app');
        try { Player.stop(); } catch (e) {}
        try {
            if (typeof tizen !== 'undefined' && tizen.application) {
                tizen.application.getCurrentApplication().exit();
                return;
            }
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('tizen.application.exit failed: ' + (e.message || e));
        }
        try { window.close(); } catch (e) {}
    }

    /* ── OSD show/hide ────────────────────────────────────────────── */
    var osdHideTimer = null;
    function showOSD(visible) {
        // Music in the background: no OSD to show, and focusing its buttons
        // would pull the cursor out of the list the user is in.
        if (visible && state.view !== 'player') return;
        var wasHidden = document.getElementById('osd-bottom').classList.contains('hidden');
        document.getElementById('osd-top').classList.toggle('hidden', !visible);
        document.getElementById('osd-bottom').classList.toggle('hidden', !visible);
        /* Subtitles ride above the bar while it is up (CSS: body.osd-up). */
        document.body.classList.toggle('osd-up', !!visible);
        if (visible) { updateOsdClock(); startOsdClock(); } else stopOsdClock();
        if (visible) {
            UI.refreshFocusables();
            // Auto-focus the play-pause button when the OSD first appears, so
            // Up/Down navigation has an anchor and ENTER activates something.
            if (wasHidden) {
                var pp = document.getElementById('btn-playpause');
                if (pp) UI.focusOn(pp);
            }
        }
    }
    function scheduleOSDHide() {
        clearTimeout(osdHideTimer);
        osdHideTimer = setTimeout(function () { showOSD(false); }, 5000);
    }
    function flashOSD() { showOSD(true); scheduleOSDHide(); }

    /* ── Fast seeking / scrub mode (issue: percentage-based seeking) ──
     * Left/Right and RW/FF no longer fire a real seek per press.  They move
     * a preview position along the progress bar, and the seek is committed
     * only after the keys go quiet for a moment (or instantly on OK).  Held
     * or rapid presses accelerate from the familiar 10 s step up to
     * duration-relative jumps (1–2 % of the file), so crossing a 3-hour
     * movie takes seconds while a couple of taps still nudge by 10 s.
     * BACK cancels a scrub without seeking.  Files with no known duration
     * (live streams) keep the old immediate fixed-step seek. */
    var scrub = { active: false, waiting: false, pos: 0, dir: 0, steps: 0, timer: null, commitAt: 0 };
    var SCRUB_COMMIT_MS = 600;   // quiet time before the preview position is seeked
    // AVPlay's seekTo is asynchronous: getCurrentTime() keeps reporting the
    // PRE-seek playhead until the pipeline flushes — seconds, on SMB/network
    // streams.  So after committing we keep painting the preview position
    // (scrub.waiting) until a progress sample lands near the target, with a
    // hard timeout in case the seek silently fails.
    var SCRUB_SETTLE_TOL_MS = 4000;
    var SCRUB_SETTLE_MAX_MS = 10000;

    function scrubStepSize(n, durMs, baseMs) {
        // n = consecutive steps in one direction within this scrub session.
        // A session ends after SCRUB_COMMIT_MS of silence, so slow discrete
        // presses never accelerate — only holds / rapid taps do.
        var ms;
        if      (n <= 3)  ms = 10000;
        else if (n <= 8)  ms = 30000;
        else if (n <= 15) ms = Math.max(60000,  durMs * 0.01);
        else              ms = Math.max(120000, durMs * 0.02);
        return Math.max(baseMs, ms);
    }

    function scrubStep(dir, baseMs) {
        var dur = Player.duration() || lastProgress.duration;
        if (!dur || dur <= 0) {              // duration unknown → seek directly
            Player.seekRel(dir * baseMs);
            flashOSD();
            return;
        }
        if (!scrub.active) {
            scrub.active = true;
            // If a committed seek is still in flight, currentTime() is stale
            // (pre-seek) — continue from the target we already committed to.
            if (!scrub.waiting)
                scrub.pos = Player.currentTime() || lastProgress.time;
            scrub.dir    = 0;
            scrub.steps  = 0;
        }
        if (dir !== scrub.dir) { scrub.dir = dir; scrub.steps = 0; }
        scrub.steps++;
        scrub.pos = Math.max(0, Math.min(dur - 1000,
                        scrub.pos + dir * scrubStepSize(scrub.steps, dur, baseMs)));
        updateProgress(scrub.pos, dur);
        updateScrubUI(true, scrub.pos);
        // Pin the OSD while scrubbing; the hide timer restarts on commit.
        showOSD(true);
        clearTimeout(osdHideTimer);
        clearTimeout(scrub.timer);
        scrub.timer = setTimeout(commitScrub, SCRUB_COMMIT_MS);
    }

    function commitScrub() {
        if (!scrub.active) return;
        clearTimeout(scrub.timer);
        scrub.active = false;
        scrub.steps  = 0;
        scrubSeekTo(scrub.pos);
        updateScrubUI(false);
        flashOSD();
    }

    /* Seek and keep painting `ms` on the bar until the seek completes.
     * Shared by scrub commits and 0-9 jumps.  Completion comes from
     * Player.seekTo's callback — AVPlay lands on a keyframe, possibly tens
     * of seconds from the target, so distance-to-target can't detect it
     * (SCRUB_SETTLE_* in onprogress remain as backstops in case a firmware
     * never fires the callback).  The seq token keeps a late callback from
     * an overridden seek from unfreezing a newer one still in flight. */
    function scrubSeekTo(ms) {
        scrub.pos      = ms;
        scrub.waiting  = true;
        scrub.commitAt = Date.now();
        scrub.seq      = (scrub.seq || 0) + 1;
        var seq = scrub.seq;
        Player.seekTo(ms, function () {
            if (seq !== scrub.seq || !scrub.waiting) return;
            scrub.waiting = false;
            if (!scrub.active)
                updateProgress(Player.currentTime(), Player.duration() || lastProgress.duration);
        });
        updateProgress(ms, Player.duration() || lastProgress.duration);
    }

    function cancelScrub(restoreBar) {
        clearTimeout(scrub.timer);
        scrub.active = false;
        scrub.steps  = 0;
        updateScrubUI(false);
        if (restoreBar) {
            // A still-settling earlier commit means the bar should show its
            // target, not the stale pre-seek playhead.
            if (scrub.waiting) updateProgress(scrub.pos, Player.duration() || lastProgress.duration);
            else               updateProgress(lastProgress.time, lastProgress.duration);
            flashOSD();
        }
    }

    /* Full reset — leaving the player or starting a new file.  Unlike
     * cancelScrub this also drops the settle-wait, which would otherwise
     * suppress the next file's progress updates. */
    function resetScrub() {
        cancelScrub(false);
        scrub.waiting  = false;
        scrub.commitAt = 0;
    }

    function updateScrubUI(on, posMs) {
        document.getElementById('progress-fill').classList.toggle('scrubbing', !!on);
        var delta = document.getElementById('time-scrub-delta');
        if (!delta) return;
        if (!on) { delta.classList.add('hidden'); return; }
        var d = posMs - lastProgress.time;
        delta.textContent = (d < 0 ? '−' : '+') + fmtTime(Math.abs(d));
        delta.classList.remove('hidden');
    }

    function installMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        function ifPlaying(fn) {
            return function () { if (state.view === 'player') { fn(); flashOSD(); } };
        }
        var pairs = [
            ['play',          ifPlaying(function () { Player.play(); })],
            ['pause',         ifPlaying(function () { Player.pause(); })],
            ['stop',          ifPlaying(function () { exitPlayer(); })],
            ['seekbackward',  ifPlaying(function () { Player.seekRel(-30000); })],
            ['seekforward',   ifPlaying(function () { Player.seekRel( 30000); })],
            ['previoustrack', ifPlaying(function () { handlePrev(); })],
            ['nexttrack',     ifPlaying(function () { playNext(false); })]
        ];
        for (var i = 0; i < pairs.length; i++) {
            try { navigator.mediaSession.setActionHandler(pairs[i][0], pairs[i][1]); } catch (e) {}
        }
    }

    function showSpinner(msg) {
        var sp = document.getElementById('spinner');
        sp.querySelector('.spinner-text').textContent = msg || I18n.t('common.loading');
        sp.classList.remove('hidden');
    }
    function hideSpinner() { document.getElementById('spinner').classList.add('hidden'); }

    /* kind 'codec': the message is our own (and so translated), and the
     * codec hint below can't be matched out of its text.
     * kind 'gone': the file isn't there; no hint about what is in it. */
    function showError(msg, kind) {
        if (state.background) { backgroundError(msg); return; }
        // Hide all sibling overlays so the error stays the only focusable thing
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        document.getElementById('track-menu').classList.add('hidden');
        hideSpinner();
        clearInterval(openWatchdog);

        // Hint for opaque codec-not-supported errors
        var hint = '';
        var uri = state.playingUri || '';
        // AVPlay-failed-on-MKV is signalled with the "MKV_CODEC:" prefix from
        // player.js.  The old "MKV not supported" HTML5 message is kept in the
        // match for safety, but AVPlay DOES support the MKV container on these
        // TVs — a failure is a codec inside it, most often DTS/TrueHD audio.
        var isMkv = /^MKV_CODEC:/.test(msg) || /\.mkv($|\?)/i.test(uri) || /MKV not supported/i.test(msg);
        // Legacy containers that AVPlay opens but rejects fast on codec grounds
        // — DivX/Xvid AVI, WMV (VC-1/WMV9), FLV, old MPEG.  We see this as a
        // sub-second "Unknown error" from AVPlay after a clean network/SMB
        // transport.  No path forward in-app: TV's hardware decoder doesn't
        // know these codecs.
        var isLegacyContainer = /\.(avi|wmv|flv|rm|rmvb|mpe?g|vob|divx|asf)($|\?)/i.test(uri);

        if (kind === 'gone') {
            hint = '';
        } else if (isLegacyContainer) {
            var ext = (uri.match(/\.([a-z0-9]+)(?:[?#]|$)/i) || [,''])[1].toLowerCase();
            msg = I18n.t('err.legacyTitle', ext.toUpperCase());
            hint = I18n.t('err.legacyHint', ext.toUpperCase(), RELEASES_URL,
                          'ffmpeg -i input.' + ext + ' -c:v libx264 -preset fast -c:a aac -b:a 192k output.mp4');
        } else if (isMkv) {
            msg = I18n.t('err.mkvTitle');
            hint = I18n.t('err.mkvHint', RELEASES_URL, 'ffmpeg -i input.mkv -c:v copy -c:a ac3 -b:a 640k output.mkv');
        } else if (kind === 'codec' || /unknown error|not supported|invalid|stuck loading|unsupported source/i.test(msg)) {
            hint = I18n.t('err.codecHint', 'ffmpeg -i input.ext -c copy output.mp4');
        } else if (/connection|network|timeout/i.test(msg)) {
            hint = I18n.t('err.networkHint');
        }

        document.getElementById('error-title').textContent = msg;
        document.getElementById('error-hint').textContent  = hint;
        document.getElementById('error-overlay').classList.remove('hidden');

        UI.refreshFocusables();
        var btn = document.querySelector('#error-overlay .btn');
        if (btn) UI.focusOn(btn);
    }
    function hideError() {
        document.getElementById('error-overlay').classList.add('hidden');
    }

    var PLAYER_ICON_PLAY  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    var PLAYER_ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>';
    function updatePlayPauseButton(state) {
        var btn = document.getElementById('btn-playpause');
        btn.innerHTML = state === 'playing' ? PLAYER_ICON_PAUSE : PLAYER_ICON_PLAY;
    }

    function updateProgress(timeMs, durMs) {
        document.getElementById('time-current').textContent  = fmtTime(timeMs);
        var dEl = document.getElementById('time-duration');
        dEl.textContent = (Settings.get('timeMode') === 'remaining' && durMs > 0)
            ? '-' + fmtTime(Math.max(0, durMs - (timeMs || 0))) : fmtTime(durMs);
        var pct = (durMs && durMs > 0) ? Math.min(100, (timeMs / durMs) * 100) : 0;
        document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';
    }

    /* Format a duration for the browser's length column: "23m", "1h47m". */
    function fmtLength(ms) {
        var m = Math.round(ms / 60000), h = Math.floor(m / 60);
        return (h ? h + 'h' : '') + (m % 60) + 'm';
    }

    /* Return the row's icon: a check if the file is watched, otherwise the
     * icon for kind ('recent' gives the Recently Played star). */
    function watchedIcon(watched, kind) {
        if (watched) return '<span class="icon" title="' + escapeHtml(I18n.t('browse.watched')) + '">✓</span>';
        return '<span class="icon">' + (kind === 'recent' ? '★' : FileTypes.icon(kind)) + '</span>';
    }

    function fmtTime(ms) {
        if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '00:00';
        var s = Math.floor(ms / 1000);
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60);   s -= m * 60;
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return (h ? p(h) + ':' : '') + p(m) + ':' + p(s);
    }

    /* ── Settings view ────────────────────────────────────────────── */
    function openSettings() {
        UI.showView('view-settings'); state.view = 'settings';
        refreshSettingsValues();
        renderPairingBlock();
        renderTvInfo();
    }
    function refreshSettingsValues() {
        document.getElementById('setting-ui-lang-value').textContent       = uiLanguageName(Settings.get('uiLanguage'));
        document.getElementById('setting-start-screen-value').textContent  = StartScreen.nameFor(Settings.get('startScreen'));
        document.getElementById('setting-audio-lang-value').textContent    = LanguageList.nameFor(Settings.get('audioLang'));
        document.getElementById('setting-subtitle-lang-value').textContent = LanguageList.nameFor(Settings.get('subtitleLang'));
        document.getElementById('setting-repeat-mode-value').textContent   = repeatName(Settings.get('repeatMode'));
        document.getElementById('setting-auto-play-value').textContent     = I18n.t(Settings.get('autoPlay') ? 'common.on' : 'common.off');
        document.getElementById('setting-resume-mode-value').textContent   = resumeModeName(Settings.get('resumeMode'));
        document.getElementById('setting-recent-value').textContent        = I18n.t(Settings.get('recentHistory') ? 'common.on' : 'common.off');
        document.getElementById('setting-shuffle-value').textContent       = I18n.t(Settings.get('shuffle') ? 'common.on' : 'common.off');
        document.getElementById('setting-aspect-mode-value').textContent   = AspectRatio.nameFor(Settings.get('aspectMode'));
        document.getElementById('setting-browse-filter-value').textContent = browseFilterName(Settings.get('browseFilter'));
        document.getElementById('setting-theme-value').textContent      = I18n.t(THEME_KEYS[appearanceCode('theme', THEME_KEYS, 'dark')]);
        document.getElementById('setting-accent-value').textContent     = I18n.t(ACCENT_KEYS[appearanceCode('accent', ACCENT_KEYS, 'sky')]);
        document.getElementById('setting-text-size-value').textContent  = I18n.t(TEXT_KEYS[appearanceCode('textSize', TEXT_KEYS, 'normal')]);
        document.getElementById('setting-poster-cache-value').textContent = posterCacheText();
        document.getElementById('setting-time-mode-value').textContent   = I18n.t(TIME_KEYS[appearanceCode('timeMode', TIME_KEYS, 'total')]);
        document.getElementById('setting-skip-short-value').textContent  = skipLabel(skipSeconds('skipShort', 10));
        document.getElementById('setting-skip-long-value').textContent   = skipLabel(skipSeconds('skipLong', 30));
        document.getElementById('setting-background-value').textContent  = I18n.t(BG_KEYS[appearanceCode('background', BG_KEYS, 'default')]);
        document.getElementById('setting-fanart-value').textContent      = I18n.t(FANART_KEYS[appearanceCode('fanart', FANART_KEYS, 'subtle')]);
        document.getElementById('setting-show-hidden-value').textContent   = I18n.t(Settings.get('showHidden') ? 'common.on' : 'common.off');
        document.getElementById('setting-folder-play-value').textContent   = I18n.t(Settings.get('folderPlayRows') ? 'common.on' : 'common.off');
        document.getElementById('setting-network-value').textContent       = networkLevelName(NetworkAccess.level());
        document.getElementById('setting-slideshow-interval-value').textContent = slideshowName(Settings.get('slideshowSeconds'));
        document.getElementById('setting-subtitle-size-value').textContent     = SubtitleStyle.nameForSize(Settings.get('subtitleSize'));
        document.getElementById('setting-subtitle-font-value').textContent     = SubtitleStyle.nameForFont(Settings.get('subtitleFont'));
        document.getElementById('setting-subtitle-color-value').textContent    = SubtitleStyle.nameForColor(Settings.get('subtitleColor'));
        document.getElementById('setting-subtitle-weight-value').textContent   = SubtitleStyle.nameForWeight(Settings.get('subtitleWeight'));
        document.getElementById('setting-subtitle-position-value').textContent = SubtitleStyle.nameForPosition(Settings.get('subtitlePosition'));
        document.getElementById('setting-subtitle-bg-value').textContent       = SubtitleStyle.nameForBg(Settings.get('subtitleBg'));
        document.getElementById('setting-subtitle-lang2-value').textContent    = Settings.get('subtitleLang2') ? LanguageList.nameFor(Settings.get('subtitleLang2')) : I18n.t('common.none');
        document.getElementById('setting-subtitle-outline-value').textContent  = SubtitleStyle.nameForOutline(Settings.get('subtitleOutline'));
        document.getElementById('setting-subtitle-shadow-value').textContent   = SubtitleStyle.nameForShadow(Settings.get('subtitleShadow'));
        document.getElementById('setting-subtitle-opacity-value').textContent  = SubtitleStyle.nameForOpacity(Settings.get('subtitleOpacity'));
        // Mirror repeat + aspect state to the OSD buttons if visible
        updateRepeatButton();
        updateAspectButton();
    }
    function renderTvInfo() {
        var box  = document.getElementById('tvinfo');
        var pInfo = TvInfo.getProductInfo();
        var codecs = TvInfo.getCodecs();
        var ua = TvInfo.getUA();

        // Kick off the async build query; we render placeholder rows first.
        TvInfo.getBuild(function (b) {
            var rows = [];
            function row(k, v) { rows.push('<div class="row"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v || '—') + '</div></div>'); }
            row(I18n.t('tv.appVersion'),   TvInfo.getAppVersion() || '—');
            row(I18n.t('tv.model'),        pInfo.realModel || b.model || '—');
            row(I18n.t('tv.marketingName'), pInfo.tvName    || b.buildDescription || '—');
            row(I18n.t('tv.firmware'),     pInfo.firmwareVersion || b.buildVersion || '—');
            row(I18n.t('tv.buildRelease'), b.buildReleaseDate || '—');
            row(I18n.t('tv.manufacturer'), b.manufacturer || '—');
            row('User-Agent',              ua);
            function codec(name, cls, label) {
                return '<div class="codec"><span class="name">' + escapeHtml(name) + '</span>' +
                       '<span class="status ' + cls + '">' + escapeHtml(label) + '</span></div>';
            }

            var codecHtml = '<h3>' + escapeHtml(I18n.t('tv.html5Codecs')) + '</h3><div class="codecs">';
            Object.keys(codecs).forEach(function (name) {
                var status = codecs[name];
                var cls = status === 'probably' ? 'ok' : status === 'maybe' ? 'maybe' : 'no';
                var label = status === 'probably' ? '✓ ' + I18n.t('tv.supported') :
                            status === 'maybe'    ? '? ' + I18n.t('tv.possibly') :
                                                    '✗ ' + I18n.t('tv.notSupported');
                codecHtml += codec(name, cls, label);
            });
            codecHtml += '</div>';

            codecHtml += '<h3>' + escapeHtml(I18n.t('tv.streaming')) + '</h3><div class="codecs">';
            codecHtml += codec('HLS / DASH', 'ok', '✓ ' + I18n.t('tv.supported'));
            codecHtml += codec('RTSP / RTMP', 'ok', '✓ ' + I18n.t('tv.supported'));
            codecHtml += codec(I18n.t('tv.usbFiles'), 'ok', '✓ ' + I18n.t('tv.viaHtml5'));
            codecHtml += codec(I18n.t('tv.mkv'), 'ok', '✓ ' + I18n.t('tv.viaAvplay'));
            codecHtml += codec(I18n.t('tv.dtsAudio'), 'no', '✗ ' + I18n.t('tv.cantDecode'));
            codecHtml += '</div>';

            box.innerHTML = rows.join('') + codecHtml;
        });
    }

    /* ── Picker (generic option list, used for settings choices) ──── */
    var pickerSetting = null;        // which setting we're editing
    /* The element that had the cursor when the picker opened, to put it
     * back on close.  Without this the cursor stayed on the picker's hidden
     * row: a hidden element has a zero rect at the top-left corner, so the
     * next Up or Down in Settings jumped to whatever lay nearest that
     * corner rather than the row below the one just changed (issue #149). */
    var pickerReturnTo = null;
    function openPicker(title, options, currentValue, onPick) {
        var had = document.querySelector('.focused');
        if (had && !had.closest('#picker')) pickerReturnTo = had;
        document.getElementById('picker-title').textContent = title;
        var ul = document.getElementById('picker-options');
        ul.innerHTML = '';
        options.forEach(function (opt) {
            var li = document.createElement('li');
            li.tabIndex = 0;
            li.textContent = opt.name;
            if (opt.code === currentValue) li.classList.add('active');
            li.addEventListener('click', function () {
                onPick(opt.code);
                closePicker();
            });
            ul.appendChild(li);
        });
        document.getElementById('picker').classList.remove('hidden');
        UI.refreshFocusables();
        var first = document.querySelector('#picker .active') ||
                    document.querySelector('#picker li, #picker button');
        if (first) UI.focusOn(first);
    }
    function closePicker() {
        document.getElementById('picker').classList.add('hidden');
        document.getElementById('picker-custom-row').classList.add('hidden'); skipCustomFor = null;
        pickerSetting = null;
        UI.refreshFocusables();
        var back = pickerReturnTo; pickerReturnTo = null;
        // Still on screen — the OSD may have faded, or the view changed.
        if (back && back.offsetParent !== null) UI.focusOn(back);
    }
    function openLangPicker(settingKey, title, options) {
        pickerSetting = settingKey;
        var cur = Settings.get(settingKey);
        openPicker(title, options, cur, function (val) {
            Settings.set(settingKey, val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', title, LanguageList.nameFor(val)));
        });
    }
    /* The app's own language.  Every language is listed by its own name, so
     * someone stuck in a language they can't read still finds theirs. */
    function uiLanguageName(code) {
        return code ? I18n.languageName(I18n.match(code))
                    : I18n.t('uiLang.followTv', I18n.languageName(I18n.current()));
    }
    function openUiLangPicker() {
        pickerSetting = 'uiLanguage';
        var opts = [{ code: '', name: uiLanguageName('') }].concat(I18n.languages());
        openPicker(I18n.t('settings.uiLang'), opts, Settings.get('uiLanguage'), function (val) {
            if (val === Settings.get('uiLanguage')) return;
            I18n.setLanguage(val);
        });
    }
    function openRepeatPicker() {
        pickerSetting = 'repeatMode';
        var cur = Settings.get('repeatMode');
        openPicker(I18n.t('settings.repeatMode'), [
            { code: 'off', name: I18n.t('common.off') },
            { code: 'one', name: I18n.t('repeat.current') },
            { code: 'all', name: I18n.t('repeat.allOption') }
        ], cur, function (val) {
            Settings.set('repeatMode', val);
            refreshSettingsValues();
            updateNextPrevButtons();
            UI.toast(I18n.t('toast.repeat', repeatName(val)));
        });
    }
    /* Subtitle-appearance pickers — share the generic option list, then
     * re-apply the live style so changes show immediately on the overlay. */
    function openSubtitlePicker(settingKey, title, options) {
        pickerSetting = settingKey;
        var cur = Settings.get(settingKey);
        openPicker(title, options, cur, function (val) {
            Settings.set(settingKey, val);
            SubtitleStyle.apply();
            refreshSettingsValues();
            refreshStyleRows();
            UI.toast(I18n.t('toast.updated', title));
        });
    }
    /* Start screen (issue #149): Home, or one of its tiles opened at launch. */
    function openStartScreenPicker() {
        pickerSetting = 'startScreen';
        openPicker(I18n.t('settings.startScreen'), StartScreen.forList(), Settings.get('startScreen'), function (val) {
            Settings.set('startScreen', val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.startScreen'), StartScreen.nameFor(val)));
        });
    }
    /* Playback-speed picker (issue #28 part 3).  Six rates from 0.5× to 2×,
     * applied via Player.setSpeed() which targets AVPlay's setSpeed on the
     * TV and HTMLVideoElement.playbackRate as the fallback.  Speed is
     * deliberately session-only — every Player.open() resets to 1× so a
     * binge-watch session doesn't accidentally play episode 2 at 1.5×
     * because episode 1 was. */
    function openSpeedPicker() {
        var cur = String(Player.getSpeed ? Player.getSpeed() : 1);
        /* On the AVPlay backend, non-1× rates silence audio (Samsung
         * hardware-decoder limitation — issue #49).  Note that inline in
         * the option labels so the user isn't blindsided by a mute the
         * moment they pick 1.5×. */
        var avplay = Player.getBackend && Player.getBackend() === 'avplay';
        var muteNote = avplay ? '  ' + I18n.t('speed.mutedNote') : '';
        openPicker(I18n.t('player.speed'), [
            { code: '0.5',  name: '0.5×' + muteNote },
            { code: '0.75', name: '0.75×' + muteNote },
            { code: '1',    name: I18n.t('speed.normalOption') },
            { code: '1.25', name: '1.25×' + muteNote },
            { code: '1.5',  name: '1.5×' + muteNote },
            { code: '2',    name: '2×' + muteNote }
        ], cur, function (val) {
            if (!Player.setSpeed(parseFloat(val))) {
                UI.toast(I18n.t('speed.unsupported'));
                return;
            }
            updateSpeedButton();
            var msg = I18n.t('toast.speed', val === '1' ? I18n.t('speed.normal') : val + '×');
            if (Player.isSpeedMuted && Player.isSpeedMuted())
                msg += ' — ' + I18n.t('speed.mutedToast');
            UI.toast(msg);
        });
    }
    function updateSpeedButton() {
        refreshVideoRows();
        var btn = document.getElementById('btn-speed');
        if (!btn) return;
        var s = Player.getSpeed ? Player.getSpeed() : 1;
        // Compact label: "1×" / "1.5×" — no trailing zeros so "1.5×" not "1.50×".
        var label = (s === Math.floor(s) ? s : (Math.round(s * 100) / 100)) + '×';
        // 🔇 postfix when audio is silenced by the speed change so the OSD
        // makes the trade-off visible at a glance (issue #49).
        if (Player.isSpeedMuted && Player.isSpeedMuted()) label += ' 🔇';
        btn.textContent = label;
    }
    /* Video aspect (user request: "remove the black bars").  Unlike playback
     * speed this IS persisted — someone who wants a filled screen wants it
     * for every file, not just the one that's open.  Applying it mid-playback
     * is safe on both backends, so the OSD button and the settings row share
     * this one picker. */
    function openAspectPicker() {
        var cur = Settings.get('aspectMode');
        openPicker(I18n.t('settings.aspect'), AspectRatio.forList(), cur, function (val) {
            Settings.set('aspectMode', val);
            Player.applyAspect();
            updateAspectButton();
            refreshSettingsValues();
            UI.toast(I18n.t('toast.aspect', AspectRatio.nameFor(val)) + aspectToastNote());
        });
    }

    /* Fit / Fill / Wide all come out identical on a file whose frame already
     * matches the panel — the usual case, since most rips are 16:9 on a 16:9
     * TV — and any black bars on such a file are inside the picture, where
     * nothing AVPlay can do will reach them (settings.js says why).  Telling
     * the user that beats letting them cycle every mode looking for the one
     * that isn't broken. */
    function aspectToastNote() {
        if (typeof Player.describeAspect !== 'function') return '';
        var d;
        try { d = Player.describeAspect(); } catch (e) { return ''; }
        if (!d || !d.noop) return '';
        return ' — ' + I18n.t('aspect.noop');
    }
    function updateAspectButton() {
        refreshVideoRows();
        var btn = document.getElementById('btn-aspect');
        if (!btn) return;
        var mode = Settings.get('aspectMode');
        btn.textContent = AspectRatio.shortFor(mode);
        // Highlight whenever the picture is NOT in the default fit mode, so
        // a cropped/stretched picture is never a mystery.
        btn.classList.toggle('aspect-on', AspectRatio.isKnown(mode) && mode !== 'fit');
    }
    function browseFilterName(code) {
        return I18n.t(code === 'media' ? 'browseFilter.media' : 'browseFilter.all');
    }
    function openBrowseFilterPicker() {
        pickerSetting = 'browseFilter';
        openPicker(I18n.t('settings.browseFilter'), [
            { code: 'all',   name: I18n.t('browseFilter.all') },
            { code: 'media', name: I18n.t('browseFilter.media') }
        ], Settings.get('browseFilter'), function (val) {
            Settings.set('browseFilter', val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.browseFilter'), browseFilterName(val)));
        });
    }
    /* Dot-named files and folders in the USB, SMB and WebDAV lists (issue #147). */
    function openShowHiddenPicker() {
        pickerSetting = 'showHidden';
        var cur = Settings.get('showHidden') ? 'on' : 'off';
        openPicker(I18n.t('settings.showHidden'), [
            { code: 'off', name: I18n.t('hidden.offOption') },
            { code: 'on',  name: I18n.t('hidden.onOption') }
        ], cur, function (val) {
            Settings.set('showHidden', val === 'on');
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.showHidden'), I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    /* The Play all / Shuffle all rows on top of a folder (issue #174). */
    function openFolderPlayPicker() {
        pickerSetting = 'folderPlayRows';
        var cur = Settings.get('folderPlayRows') ? 'on' : 'off';
        openPicker(I18n.t('settings.folderPlayRows'), [
            { code: 'on',  name: I18n.t('common.on') },
            { code: 'off', name: I18n.t('common.off') }
        ], cur, function (val) {
            Settings.set('folderPlayRows', val === 'on');
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.folderPlayRows'), I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    /* How long each picture stays in a slideshow (issue #126). */
    var SLIDESHOW_SECONDS = [3, 5, 10, 15, 30, 60];
    function slideshowName(sec) { return I18n.t('slideshow.seconds', sec); }
    function openSlideshowPicker() {
        pickerSetting = 'slideshowSeconds';
        openPicker(I18n.t('settings.slideshow'), SLIDESHOW_SECONDS.map(function (s) {
            return { code: s, name: slideshowName(s) };
        }), Settings.get('slideshowSeconds'), function (val) {
            Settings.set('slideshowSeconds', val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.slideshow'), slideshowName(val)));
        });
    }
    function openAutoPlayPicker() {
        pickerSetting = 'autoPlay';
        var cur = Settings.get('autoPlay') ? 'on' : 'off';
        openPicker(I18n.t('settings.autoPlay'), [
            { code: 'off', name: I18n.t('common.off') },
            { code: 'on',  name: I18n.t('autoPlay.on') }
        ], cur, function (val) {
            Settings.set('autoPlay', val === 'on');
            refreshSettingsValues();
            UI.toast(I18n.t('toast.autoPlay', I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    var RESUME_MODES = [
        { code: 'ask',    name: I18n.t('resume.askOption') },
        { code: 'always', name: I18n.t('resume.alwaysOption') },
        { code: 'never',  name: I18n.t('resume.neverOption') }
    ];
    function resumeModeName(code) {
        return I18n.t(code === 'always' ? 'resume.always' : code === 'never' ? 'resume.never' : 'resume.ask');
    }
    function openResumeModePicker() {
        pickerSetting = 'resumeMode';
        openPicker(I18n.t('settings.resume'), RESUME_MODES, Settings.get('resumeMode'), function (val) {
            Settings.set('resumeMode', val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.resume', resumeModeName(val)));
        });
    }
    /* ── Recently Played on/off + clear (issue #142) ───────────────── */
    function openRecentPicker() {
        pickerSetting = 'recentHistory';
        var cur = Settings.get('recentHistory') ? 'on' : 'off';
        openPicker(I18n.t('home.recent'), [
            { code: 'on',  name: I18n.t('recent.onOption') },
            { code: 'off', name: I18n.t('recent.offOption') }
        ], cur, function (val) {
            Settings.set('recentHistory', val === 'on');
            applyHomeTiles();
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('home.recent'), I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    /* ── Network access (js/network-access.js) ───────────────────── */
    var NET_LEVELS = [
        { code: 'all',  nameKey: 'net.all',  optionKey: 'net.allOption' },
        { code: 'own',  nameKey: 'net.own',  optionKey: 'net.ownOption' },
        { code: 'none', nameKey: 'net.none', optionKey: 'net.noneOption' }
    ];
    function networkLevelName(lvl) {
        for (var i = 0; i < NET_LEVELS.length; i++) if (NET_LEVELS[i].code === lvl) return I18n.t(NET_LEVELS[i].nameKey);
        return lvl;
    }
    function openNetworkPicker() {
        pickerSetting = 'networkAccess';
        openPicker(I18n.t('settings.network'), NET_LEVELS.map(function (l) {
            return { code: l.code, name: I18n.t(l.optionKey) };
        }), NetworkAccess.level(), function (val) {
            Settings.set('networkAccess', val);
            applyHomeTiles();
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.network'), networkLevelName(val)));
        });
    }
    /* Show the dialog for a blocked action: keep the current level, or raise
     * it to the level the action needs and retry. */
    NetworkAccess.setPrompt(function (what, needed, retry) {
        openPicker(I18n.t('net.needs', what), [
            { code: 'keep',  name: I18n.t('net.keep') },
            { code: 'allow', name: I18n.t(needed === 'all' ? 'net.allowAll' : 'net.allowOwn') }
        ], 'keep', function (val) {
            if (val !== 'allow') return;
            Settings.set('networkAccess', needed);
            applyHomeTiles();
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', I18n.t('settings.network'), networkLevelName(needed)));
            if (retry) retry();
        });
    });
    function confirmNewCode() {
        if (typeof UrlDrop === 'undefined') return;
        openPicker(I18n.t('cast.newCodeConfirm'), [
            { code: 'new',  name: I18n.t('cast.newCode') },
            { code: 'keep', name: I18n.t('common.cancel') }
        ], 'keep', function (code) {
            if (code !== 'new') return;
            UrlDrop.newCode();
            renderPairingBlock();
            UI.toast(I18n.t('cast.newCodeDone'));
        });
    }
    function confirmRecentClear() {
        if (!getRecent().length) { UI.toast(I18n.t('recent.none')); return; }
        openPicker(I18n.t('recent.clearConfirm'), [
            { code: 'clear', name: I18n.t('recent.clear') },
            { code: 'keep',  name: I18n.t('common.cancel') }
        ], 'keep', function (code) {
            if (code !== 'clear') return;
            clearRecent();
            UI.toast(I18n.t('recent.cleared'));
        });
    }

    /* ── Repeat toggle from the OSD ───────────────────────────────── */
    /* Off → all → one → off, like a music player's repeat button. */
    function toggleRepeat() {
        var cur = Settings.get('repeatMode');
        var next = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off';
        Settings.set('repeatMode', next);
        updateRepeatButton();
        updateNextPrevButtons();
        UI.toast(I18n.t('toast.repeat', repeatName(next)));
    }
    function repeatName(code) {
        return I18n.t(code === 'one' ? 'repeat.one' : code === 'all' ? 'repeat.all' : 'common.off');
    }
    function updateRepeatButton() {
        refreshVideoRows();
        var btn = document.getElementById('btn-repeat');
        if (!btn) return;
        var mode = Settings.get('repeatMode');
        btn.classList.toggle('repeat-on', mode === 'one' || mode === 'all');
        btn.classList.toggle('repeat-one', mode === 'one');
    }

    /* ── Shuffle (issue #43) ──────────────────────────────────────────
     * Randomize playlist order for folder + recent playback.  Toggling
     * during playback re-shuffles the live playlist in place, keeping the
     * currently-playing item at index 0 so the current file isn't yanked
     * mid-play; turning it back off would ideally restore the alphabetical
     * order, but the app doesn't retain the pre-shuffle list — restoring
     * alphabetical requires re-entering the folder, which is a fair trade
     * for keeping the state minimal. */
    function openShufflePicker() {
        pickerSetting = 'shuffle';
        var cur = Settings.get('shuffle') ? 'on' : 'off';
        openPicker(I18n.t('settings.shuffle'), [
            { code: 'off', name: I18n.t('shuffle.offOption') },
            { code: 'on',  name: I18n.t('shuffle.onOption') }
        ], cur, function (val) {
            applyShuffle(val === 'on');
            refreshSettingsValues();
            UI.toast(I18n.t('toast.shuffle', I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    function toggleShuffle() {
        var next = !Settings.get('shuffle');
        applyShuffle(next);
        UI.toast(I18n.t('toast.shuffle', I18n.t(next ? 'common.on' : 'common.off')));
    }
    function applyShuffle(on) {
        Settings.set('shuffle', !!on);
        updateShuffleButton();
        // If a playlist is live and shuffle just turned on, reshuffle
        // the remaining items around the currently-playing one.
        if (on && state.playlist.length > 1 && state.playlistIndex >= 0) {
            state.playlist = shufflePlaylist(state.playlist, state.playlistIndex);
            state.playlistIndex = 0;
            updateNextPrevButtons();
        }
    }
    function updateShuffleButton() {
        refreshVideoRows();
        var btn = document.getElementById('btn-shuffle');
        if (!btn) return;
        btn.classList.toggle('shuffle-on', !!Settings.get('shuffle'));
    }

    /* ── Track menu ───────────────────────────────────────────────── */
    /* "Audio" / "Subtitle (23)" — the count is what tells a user with a
     * 20-track rip that the list they're looking at is complete and simply
     * scrolls, rather than truncated. */
    function setTrackSectionTitle(id, label, count) {
        var h = document.getElementById(id);
        if (h) h.textContent = count > 1 ? (label + ' (' + count + ')') : label;
    }
    /* Re-rendering while a track is being read out of the container must not
     * throw the cursor back to the active row — the user may be part way
     * down a 40-item list, and the progress label updates every few
     * seconds. */
    function focusedTrackRow() {
        var el = document.querySelector('#track-menu li.focused');
        var ul = el && el.parentNode;
        if (!ul || (ul.id !== 'audio-tracks' && ul.id !== 'subtitle-tracks' && ul.id !== 'subtitle-style')) return null;
        return { list: ul.id, index: [].indexOf.call(ul.children, el) };
    }
    function restoreTrackRowFocus(mark) {
        if (!mark) return false;
        var ul = document.getElementById(mark.list);
        var li = ul && ul.children[mark.index];
        if (!li) return false;
        UI.focusOn(li);
        return true;
    }
    /* Subtitle appearance rows in the CC menu (issue #149): one per
     * setting, each opening the same picker Settings uses.  The value
     * labels are updated in place rather than re-rendered, so the cursor
     * can come back to the row after the picker closes. */
    var STYLE_ROWS = [
        { key: 'subtitleSize',     label: 'settings.subSize',     options: function () { return SubtitleStyle.forSize(); },     name: function (c) { return SubtitleStyle.nameForSize(c); } },
        { key: 'subtitleFont',     label: 'settings.subFont',     options: function () { return SubtitleStyle.forFont(); },     name: function (c) { return SubtitleStyle.nameForFont(c); } },
        { key: 'subtitleColor',    label: 'settings.subColor',    options: function () { return SubtitleStyle.forColor(); },    name: function (c) { return SubtitleStyle.nameForColor(c); } },
        { key: 'subtitleWeight',   label: 'settings.subWeight',   options: function () { return SubtitleStyle.forWeight(); },   name: function (c) { return SubtitleStyle.nameForWeight(c); } },
        { key: 'subtitlePosition', label: 'settings.subPosition', options: function () { return SubtitleStyle.forPosition(); }, name: function (c) { return SubtitleStyle.nameForPosition(c); } },
        { key: 'subtitleBg',       label: 'settings.subBg',       options: function () { return SubtitleStyle.forBg(); },       name: function (c) { return SubtitleStyle.nameForBg(c); } },
        { key: 'subtitleOutline',  label: 'settings.subOutline',  options: function () { return SubtitleStyle.forOutline(); },  name: function (c) { return SubtitleStyle.nameForOutline(c); } },
        { key: 'subtitleShadow',   label: 'settings.subShadow',   options: function () { return SubtitleStyle.forShadow(); },   name: function (c) { return SubtitleStyle.nameForShadow(c); } },
        { key: 'subtitleOpacity',  label: 'settings.subOpacity',  options: function () { return SubtitleStyle.forOpacity(); },  name: function (c) { return SubtitleStyle.nameForOpacity(c); } }
    ];
    /* ── Subtitle delay, text encoding, looks (Build 3b) ──────────────── */
    var DELAY_STEPS = [0.5, 1, 5, 10], delayStepIdx = 0, delayNow = 0;
    var DELAY_KEY = 'megatron_subdelay_v1';
    function readDelays() { try { return JSON.parse(localStorage.getItem(DELAY_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function loadSubDelay(uri) { var v = readDelays()[uri]; return typeof v === 'number' ? v : 0; }
    function saveSubDelay(uri, sec) {
        if (!uri) return;
        var all = readDelays();
        if (sec) { all[uri] = sec; } else { delete all[uri]; }
        var keys = Object.keys(all);
        while (keys.length > 200) { delete all[keys.shift()]; }   // oldest first
        try { localStorage.setItem(DELAY_KEY, JSON.stringify(all)); } catch (e) {}
    }
    function fmtDelay(s) { return (s > 0 ? '+' : (s < 0 ? '−' : '')) + Math.abs(s).toFixed(1) + ' s'; }
    function delayValueText() {
        if (!Player.canDelaySub()) return I18n.t('subdelay.na');
        return '◄ ' + fmtDelay(delayNow) + ' ►  ' + I18n.t('subdelay.step', DELAY_STEPS[delayStepIdx]);
    }
    function setDelay(sec) {
        sec = Math.max(-300, Math.min(300, Math.round(sec * 10) / 10));
        delayNow = sec; Player.setSubDelay(sec); saveSubDelay(state.playingUri, sec);
        var v = document.querySelector('#subtitle-style li.delay-row .style-value');
        if (v) v.textContent = delayValueText();
    }
    /* ◄ ► while the Delay row has the cursor: returns true when it took the key. */
    function nudgeDelayRow(dir) {
        var li = document.querySelector('#subtitle-style li.delay-row.focused');
        if (!li) return false;
        if (!Player.canDelaySub()) { UI.toast(I18n.t('subdelay.na')); return true; }
        setDelay(delayNow + dir * DELAY_STEPS[delayStepIdx]);
        return true;
    }
    var ENCODINGS = [
        { code: '',             name: 'Auto' , key: 'common.auto' },
        { code: 'utf-8',        name: 'UTF-8' },
        { code: 'windows-1256', name: 'Arabic (Windows-1256)' },
        { code: 'iso-8859-6',   name: 'Arabic (ISO-8859-6)' },
        { code: 'windows-1252', name: 'Western (Windows-1252)' },
        { code: 'windows-1251', name: 'Cyrillic (Windows-1251)' },
        { code: 'windows-1250', name: 'Central European (Windows-1250)' },
        { code: 'windows-1253', name: 'Greek (Windows-1253)' },
        { code: 'windows-1254', name: 'Turkish (Windows-1254)' },
        { code: 'windows-1255', name: 'Hebrew (Windows-1255)' },
        { code: 'utf-16le',     name: 'UTF-16' }
    ];
    function encodingName(code) {
        for (var i = 0; i < ENCODINGS.length; i++) if (ENCODINGS[i].code === code)
            return ENCODINGS[i].key ? I18n.t(ENCODINGS[i].key) : ENCODINGS[i].name;
        return code;
    }
    function openEncodingPicker() {
        if (!Player.canSetEncoding()) { UI.toast(I18n.t('subenc.na')); return; }
        var opts = ENCODINGS.map(function (e) { return { code: e.code, name: e.key ? I18n.t(e.key) : e.name }; });
        openPicker(I18n.t('subenc.title'), opts, Player.getSubEncoding(), function (val) {
            Player.setSubEncoding(val);
            renderStyleRows();
            UI.refreshFocusables();
            UI.toast(I18n.t('toast.updated', I18n.t('subenc.title')));
        });
    }
    function openLooksPicker() {
        var opts = SubtitleStyle.forPresets().map(function (p) { return { code: p.code, name: p.name }; });
        if (SubtitleStyle.hasCustom()) opts.push({ code: 'custom', name: I18n.t('sub.preset.mine') });
        opts.push({ code: 'save', name: I18n.t('sub.preset.save') });
        openPicker(I18n.t('sub.preset.title'), opts, null, function (val) {
            if (val === 'save') { SubtitleStyle.saveCustom(); UI.toast(I18n.t('sub.preset.saved')); refreshSettingsValues(); return; }
            SubtitleStyle.applyPreset(val);
            refreshSettingsValues();
            renderStyleRows();
            UI.refreshFocusables();
            UI.toast(I18n.t('toast.updated', I18n.t('sub.preset.title')));
        });
    }
    function renderStyleRows() {
        var ul = document.getElementById('subtitle-style');
        ul.innerHTML = '';
        function extra(label, value, cls, fn) {
            var li = document.createElement('li');
            li.className = 'style-row' + (cls ? ' ' + cls : '');
            var n = document.createElement('span'); n.textContent = label; li.appendChild(n);
            if (value !== null) { var v = document.createElement('span'); v.className = 'style-value'; v.textContent = value; li.appendChild(v); }
            li.addEventListener('click', fn);
            ul.appendChild(li);
        }
        delayNow = Player.getSubDelay();
        extra(I18n.t('subdelay.title'), delayValueText(), 'delay-row', function () {
            if (!Player.canDelaySub()) { UI.toast(I18n.t('subdelay.na')); return; }
            delayStepIdx = (delayStepIdx + 1) % DELAY_STEPS.length;
            var v = document.querySelector('#subtitle-style li.delay-row .style-value');
            if (v) v.textContent = delayValueText();
        });
        extra(I18n.t('subdelay.reset'), null, '', function () {
            if (!Player.canDelaySub()) return;
            setDelay(0); UI.toast(I18n.t('subdelay.resetDone'));
        });
        extra(I18n.t('subenc.title'), encodingName(Player.getSubEncoding()), '', openEncodingPicker);
        extra(I18n.t('sub.preset.title'), null, '', openLooksPicker);
        STYLE_ROWS.forEach(function (r) {
            var li = document.createElement('li');
            li.className = 'style-row';
            var name = document.createElement('span');
            name.textContent = I18n.t(r.label);
            var val = document.createElement('span');
            val.className = 'style-value';
            val.dataset.setting = r.key;
            val.textContent = r.name(Settings.get(r.key));
            li.appendChild(name); li.appendChild(val);
            li.addEventListener('click', function () {
                openSubtitlePicker(r.key, I18n.t(r.label), r.options());
            });
            ul.appendChild(li);
        });
    }
    function refreshStyleRows() {
        var vals = document.querySelectorAll('#subtitle-style .style-value');
        for (var i = 0; i < vals.length; i++) {
            for (var j = 0; j < STYLE_ROWS.length; j++)
                if (STYLE_ROWS[j].key === vals[i].dataset.setting)
                    vals[i].textContent = STYLE_ROWS[j].name(Settings.get(STYLE_ROWS[j].key));
        }
    }
    /* The OSD button the CC / INFO menu opened from, so Up and Down on the
     * OSD carry on from there once the menu closes (same hidden-row cursor
     * problem as the picker, see pickerReturnTo). */
    var trackMenuReturnTo = null;
    /* ── Player panel: tabs, Video rows, time, clock, sleep ─ */
    var panelTab = 'subs', lastVideoRow = 0;
    var TIME_KEYS = { total: 'timeMode.total', remaining: 'timeMode.remaining' };
    /* Skip length: 5, 10, 15, 20 or 30 s from the list, or any whole number
     * of seconds (1 to 600) typed in as Custom. */
    var SKIP_CHOICES = [5, 10, 15, 20, 30];
    function skipSeconds(setting, def) {
        var n = parseInt(Settings.get(setting), 10);
        return (n >= 1 && n <= 600) ? n : def;
    }
    function skipLabel(n) { return I18n.t('skip.seconds', n); }
    function skipShortMs() { return skipSeconds('skipShort', 10) * 1000; }
    function skipLongMs()  { return skipSeconds('skipLong', 30) * 1000; }
    var skipCustomFor = null;
    function openSkipPicker(setting, titleKey, def) {
        pickerSetting = setting;
        var cur = skipSeconds(setting, def);
        var list = SKIP_CHOICES.slice();
        if (list.indexOf(cur) < 0) { list.push(cur); list.sort(function (a, b) { return a - b; }); }
        var opts = list.map(function (n) { return { code: String(n), name: skipLabel(n) }; });
        opts.push({ code: 'custom', name: I18n.t('skip.custom') });
        openPicker(I18n.t(titleKey), opts, String(cur), function (val) {
            if (val === 'custom') { setTimeout(function () { openSkipCustom(setting, titleKey); }, 0); return; }
            Settings.set(setting, val);
            refreshSettingsValues();
        });
    }
    function openSkipCustom(setting, titleKey) {
        skipCustomFor = setting;
        openPicker(I18n.t(titleKey), [], null, function () {});
        var row = document.getElementById('picker-custom-row');
        var inp = document.getElementById('picker-custom');
        row.classList.remove('hidden'); inp.value = '';
        UI.refreshFocusables();
        UI.focusOn(inp);
    }
    function saveSkipCustom() {
        var inp = document.getElementById('picker-custom');
        var n = parseInt(inp.value, 10);
        if (!(n >= 1 && n <= 600)) { UI.toast(I18n.t('skip.invalid')); return; }
        Settings.set(skipCustomFor, String(n));
        closePicker();
        refreshSettingsValues();
        UI.toast(I18n.t('toast.setTo', I18n.t(skipCustomFor === 'skipShort' ? 'settings.skipShort' : 'settings.skipLong'), skipLabel(n)));
    }

    function syncTabToFocus() {
        var f = document.querySelector('#track-menu .panel-tab.focused');
        if (f && f.getAttribute('data-tab') !== panelTab) openTrackMenu(f.getAttribute('data-tab'), true);
    }

    function speedLabel() {
        var s = Player.getSpeed ? Player.getSpeed() : 1;
        var label = (s === Math.floor(s) ? s : (Math.round(s * 100) / 100)) + '×';
        if (Player.isSpeedMuted && Player.isSpeedMuted()) label += ' 🔇';
        return label;
    }
    function renderVideoRows() {
        var ul = document.getElementById('video-rows');
        if (!ul) return;
        ul.innerHTML = '';
        var idx = 0;
        function add(label, value, fn) {
            var li = document.createElement('li'), i = idx++;
            li.className = 'style-row';
            var a = document.createElement('span'); a.textContent = label; li.appendChild(a);
            if (value !== null) {
                var b = document.createElement('span'); b.className = 'style-value'; b.textContent = value; li.appendChild(b);
            }
            li.addEventListener('click', function () { lastVideoRow = i; fn(); });
            ul.appendChild(li);
        }
        add(I18n.t('player.speed'),  speedLabel(), openSpeedPicker);
        add(I18n.t('player.aspect'), AspectRatio.nameFor(Settings.get('aspectMode')), openAspectPicker);
        if (state.playlist.length > 1) {
            add(I18n.t('player.repeat'),  repeatName(Settings.get('repeatMode')), toggleRepeat);
            add(I18n.t('player.shuffle'), I18n.t(Settings.get('shuffle') ? 'common.on' : 'common.off'), toggleShuffle);
        }
        add(I18n.t('vrow.sleep'), sleepText(), openSleepPicker);
        add(I18n.t('vrow.stop'), null, exitPlayer);
    }
    /* A value changed while the Video tab is open: redraw its rows and put the
     * cursor back on the row that was used. */
    function refreshVideoRows() {
        var menu = document.getElementById('track-menu');
        if (!menu || menu.classList.contains('hidden') || panelTab !== 'video') return;
        renderVideoRows();
        UI.refreshFocusables();
        var rows = document.querySelectorAll('#video-rows li');
        var li = rows[Math.min(lastVideoRow, rows.length - 1)];
        if (li) UI.focusOn(li);
    }

    /* Total length or time remaining on the right of the bar. */
    function toggleTimeMode() {
        var next = Settings.get('timeMode') === 'remaining' ? 'total' : 'remaining';
        Settings.set('timeMode', next);
        updateProgress(lastProgress.time, lastProgress.duration);
        UI.toast(I18n.t('toast.timeMode', I18n.t(TIME_KEYS[next])));
        flashOSD();
    }

    /* Clock and "ends at" in the top bar while the controls are up. */
    var osdClockTimer = null;
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function updateOsdClock() {
        var el = document.getElementById('osd-clock');
        if (!el) return;
        var now = new Date(), txt = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
        var speed = (Player.getSpeed ? Player.getSpeed() : 1) || 1;
        var left = (lastProgress.duration - lastProgress.time) / speed;
        if (lastProgress.duration > 0 && left > 0) {
            var end = new Date(now.getTime() + left);
            txt += '  ·  ' + I18n.t('osd.endsAt', pad2(end.getHours()) + ':' + pad2(end.getMinutes()));
        }
        el.textContent = txt;
    }
    /* Megatron: the current time, top right, on every screen but the player
     * (the player bar has its own clock). */
    function updateGlobalClock() {
        var el = document.getElementById('global-clock');
        if (!el) return;
        var now = new Date();
        el.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    }
    function startGlobalClock() { updateGlobalClock(); setInterval(updateGlobalClock, 15000); }
    function startOsdClock() { stopOsdClock(); osdClockTimer = setInterval(updateOsdClock, 15000); }
    function stopOsdClock()  { clearInterval(osdClockTimer); osdClockTimer = null; }

    /* Next episode: a countdown in the last 15 s, with a Skip button (OK skips
     * when the controls are hidden, Back dismisses it). */
    var nextUpDismissedFor = null;
    function nextUpVisible() { var el = document.getElementById('next-up'); return !!el && !el.classList.contains('hidden'); }
    function hideNextUp() {
        var el = document.getElementById('next-up');
        if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); UI.refreshFocusables(); }
    }
    function dismissNextUp() { nextUpDismissedFor = state.playingUri; hideNextUp(); }
    function checkNextUp() {
        var el = document.getElementById('next-up');
        if (!el) return;
        var rem = lastProgress.duration - lastProgress.time;
        var hasNext = state.playlistIndex >= 0 && state.playlistIndex + 1 < state.playlist.length;
        var want = state.view === 'player' && !state.background && hasNext && lastProgress.duration > 90000 &&
                   rem > 500 && rem <= 15000 && nextUpDismissedFor !== state.playingUri &&
                   Settings.get('autoPlay') && Settings.get('repeatMode') !== 'one';
        if (!want) { hideNextUp(); return; }
        var item = state.playlist[state.playlistIndex + 1] || {};
        document.getElementById('next-up-text').textContent =
            I18n.t('player.nextUpIn', item.title || '', Math.ceil(rem / 1000));
        if (el.classList.contains('hidden')) { el.classList.remove('hidden'); UI.refreshFocusables(); }
    }

    /* Sleep timer: stops playback after a set time, or at the end of this item. */
    var sleepTimer = null, sleepEndAt = 0, sleepAtEnd = false;
    function cancelSleep() { clearTimeout(sleepTimer); sleepTimer = null; sleepEndAt = 0; sleepAtEnd = false; }
    function fireSleep() {
        sleepTimer = null; sleepEndAt = 0;
        if (state.playingUri) { UI.toast(I18n.t('toast.sleepStop')); exitPlayer(); }
    }
    function sleepText() {
        if (sleepAtEnd) return I18n.t('sleep.end');
        if (sleepEndAt) return I18n.t('sleep.left', Math.max(1, Math.ceil((sleepEndAt - Date.now()) / 60000)));
        return I18n.t('common.off');
    }
    function openSleepPicker() {
        var opts = [{ code: 'off', name: I18n.t('common.off') },
                    { code: '15', name: I18n.t('sleep.minutes', 15) }, { code: '30', name: I18n.t('sleep.minutes', 30) },
                    { code: '60', name: I18n.t('sleep.minutes', 60) }, { code: '90', name: I18n.t('sleep.minutes', 90) },
                    { code: 'end', name: I18n.t('sleep.end') }];
        openPicker(I18n.t('vrow.sleep'), opts, (!sleepAtEnd && !sleepEndAt) ? 'off' : null, function (val) {
            cancelSleep();
            if (val === 'end') sleepAtEnd = true;
            else if (val !== 'off') { var m = parseInt(val, 10); sleepEndAt = Date.now() + m * 60000; sleepTimer = setTimeout(fireSleep, m * 60000); }
            UI.toast(I18n.t('toast.sleepSet', sleepText()));
            refreshVideoRows();
        });
    }

    function rememberMenuOpener() {
        var had = document.querySelector('.focused');
        if (had && !had.closest('#track-menu') && !had.closest('#picker'))
            trackMenuReturnTo = had;
    }
    function openTrackMenu(tab, keepOnTab) {
        tab = tab || panelTab; panelTab = tab;
        var menuEl = document.getElementById('track-menu');
        menuEl.setAttribute('data-tab', tab);
        [].forEach.call(menuEl.querySelectorAll('.panel-tab'), function (b) { b.classList.toggle('sel', b.getAttribute('data-tab') === tab); });
        var keepFocus = keepOnTab ? null : focusedTrackRow();
        if (document.getElementById('track-menu').classList.contains('hidden')) rememberMenuOpener();
        var t = Player.getTracks();
        var aUL = document.getElementById('audio-tracks');
        var sUL = document.getElementById('subtitle-tracks');
        aUL.innerHTML = ''; sUL.innerHTML = '';
        setTrackSectionTitle('audio-tracks-title', I18n.t('tracks.audio'), t.audio.length);
        // Count only real, selectable tracks: not the synthetic "Off" row and
        // not the "+N can't be drawn" note.
        var subCount = 0;
        t.subtitle.forEach(function (tr) { if (!tr.off && !tr.muted) subCount++; });
        setTrackSectionTitle('subtitle-tracks-title', I18n.t('tracks.subtitle'), subCount);

        if (!t.audio.length) {
            aUL.innerHTML = '<li class="muted">' + escapeHtml(I18n.t('tracks.oneAudio')) + '</li>';
        } else {
            t.audio.forEach(function (tr) {
                var li = document.createElement('li');
                li.textContent = tr.name;
                if (tr.active) li.classList.add('active');
                li.addEventListener('click', function () {
                    Player.setAudioTrack(tr.index);
                    UI.toast(I18n.t('toast.audio', tr.name));
                    markActiveTrack(li);
                });
                aUL.appendChild(li);
            });
        }

        // Subtitle list always has at least the "Off" entry from getTracks()
        t.subtitle.forEach(function (tr) {
            var li = document.createElement('li');
            li.textContent = tr.name;
            if (tr.active) li.classList.add('active');
            // Informational rows (e.g. "+3 embedded tracks this TV can't
            // draw") are shown but not selectable — .muted keeps them out of
            // the focus order too.
            if (tr.muted) { li.classList.add('muted'); sUL.appendChild(li); return; }
            li.addEventListener('click', function () {
                // The row, not just its index: a track AVPlay can't select
                // is read out of the container instead, and that path needs
                // the container's own track number.
                var how = Player.setSubtitleTrack(tr.off ? -1 : tr);
                // 'extracting' announces itself through onsubnotice — a
                // second toast here would only overwrite it.
                if (how !== 'extracting') {
                    UI.toast(I18n.t(how === null ? 'tracks.cantShow' : 'toast.subtitle', tr.name));
                }
                if (how !== null) markActiveTrack(li);
            });
            sUL.appendChild(li);
        });
        renderStyleRows();
        renderVideoRows();
        if (tab === 'info') renderFileInfo();

        document.getElementById('track-menu').classList.remove('hidden');
        UI.refreshFocusables();
        // Switching tabs keeps the cursor on the tab; a re-render keeps the row the
        // user was on; otherwise the active track of this tab, else its first row.
        if (keepOnTab) { var selTab = menuEl.querySelector('.panel-tab.sel'); if (selTab) UI.focusOn(selTab); return; }
        if (restoreTrackRowFocus(keepFocus)) return;
        var scope = '#track-menu .track-section[data-tab="' + tab + '"]';
        var first = document.querySelector(scope + ' .active') ||
                    document.querySelector(scope + ' li:not(.muted)') ||
                    document.querySelector('#track-menu .panel-tab.sel') ||
                    document.querySelector('#track-menu button');
        if (first) UI.focusOn(first);
    }
    /* Picking a track leaves the menu open, so audio and subtitles can be
     * set in one visit; Back or Close dismisses it. */
    function markActiveTrack(li) {
        [].forEach.call(li.parentNode.children, function (el) { el.classList.remove('active'); });
        li.classList.add('active');
    }
    function closeTrackMenu() {
        var wasOpen = !document.getElementById('track-menu').classList.contains('hidden');
        document.getElementById('track-menu').classList.add('hidden');
        UI.refreshFocusables();
        var back = trackMenuReturnTo; trackMenuReturnTo = null;
        if (wasOpen && back && back.offsetParent !== null && state.view === 'player') UI.focusOn(back);
    }

    /* INFO (issue #128): what's playing, as far as the player can tell —
     * codec and picture size, HDR (with a warning for Dolby Vision, which
     * no Samsung TV decodes), the audio tracks, how many subtitle tracks,
     * the duration.  Rows the player knows nothing about are left out. */
    function toggleInfoTab() {
        var open = !document.getElementById('track-menu').classList.contains('hidden');
        if (open && panelTab === 'info') { closeTrackMenu(); return; }
        openTrackMenu('info');
    }
    function renderFileInfo() {
        var d = Player.describe();
        var dl = document.getElementById('file-info-list');
        dl.innerHTML = '';
        function row(label, value, warn) {
            if (!value) return;
            var dt = document.createElement('dt'), dd = document.createElement('dd');
            dt.textContent = label;
            if (Array.isArray(value)) value.forEach(function (v, i) {
                if (i) dd.appendChild(document.createElement('br'));
                dd.appendChild(document.createTextNode(v));
            }); else dd.textContent = value;
            if (warn) dd.className = 'warn';
            dl.appendChild(dt); dl.appendChild(dd);
        }
        var size = d.video.width && d.video.height ? d.video.width + ' × ' + d.video.height : '';
        row(I18n.t('info.video'), [d.video.codec, size].filter(Boolean).join(' · '));
        // As the stream declares it; AVPlay doesn't report one for every file.
        if (d.video.bitrate > 0) row(I18n.t('info.bitrate'), (d.video.bitrate / 1e6).toFixed(1) + ' Mbps');
        if (d.hdr) {
            var h = d.hdr, text, warn = false;
            if (h.kind === 'DV') {
                warn = true;
                text = h.profile === 5 ? I18n.t('info.dv5') : I18n.t('info.dv', h.profile || '?');
            } else text = I18n.t(h.kind === 'HDR10' ? 'info.hdr10' : h.kind === 'HLG' ? 'info.hlg' : 'info.sdr');
            row(I18n.t('info.hdr'), text, warn);
        }
        row(I18n.t('tracks.audio'), d.audio.length ? d.audio : '');
        row(I18n.t('tracks.subtitle'), d.subtitles ? String(d.subtitles) : I18n.t('info.none'));
        row(I18n.t('info.duration'), d.duration > 0 ? fmtTime(d.duration) : '');
        row(I18n.t('info.container'), d.container);
        if (!dl.childElementCount) row(I18n.t('info.video'), I18n.t('info.unknown'));
        if (typeof Debug !== 'undefined') Debug.player('file info: ' + JSON.stringify(d));
    }

    /* Type a digit from a remote number key (0-9) into the focused text field.
     * The TV's on-screen keyboard handles letters; the hardware number keys
     * arrive as key events that the browser doesn't insert on their own, so we
     * insert them ourselves (handy for IP / port / numeric entry). Returns true
     * if a field actually took the digit. */
    function typeDigitIntoField(digit) {
        var el = document.querySelector('.focused') || document.activeElement;
        if (!el || el.tagName !== 'INPUT') return false;
        var t = (el.type || 'text').toLowerCase();
        if (t !== 'text' && t !== 'password' && t !== 'search' && t !== 'tel' && t !== 'number') return false;
        var ch = String(digit);
        try {
            var s = el.selectionStart, e = el.selectionEnd;
            if (s != null && e != null) {
                el.value = el.value.slice(0, s) + ch + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s + ch.length;
            } else { el.value += ch; }
        } catch (ex) { el.value += ch; }
        return true;
    }

    function isTextField(el) {
        return !!el && el.tagName === 'INPUT';
    }

    /* A text field holds the cursor read-only (UI.focusOn), so that landing
     * on it never opens the on-screen keyboard.  OK makes it editable and
     * focuses it afresh, which is what raises the keyboard (issue #174). */
    function openKeyboardFor(el) {
        if (!el.readOnly) return;
        el.readOnly = false;
        try { el.blur(); el.focus(); } catch (e) {}
    }

    /* A character typed on a USB or Bluetooth keyboard goes straight into
     * the field under the cursor, without OK first. */
    function unlockForTyping(ev) {
        var el = document.activeElement;
        if (!isTextField(el) || !el.readOnly || !el.classList.contains('focused')) return;
        var typed = ev && typeof ev.key === 'string' && ev.key.length === 1 &&
                    !ev.ctrlKey && !ev.altKey && !ev.metaKey;
        if (typed || (ev && (ev.key === 'Backspace' || ev.key === 'Delete'))) el.readOnly = false;
    }

    /* Left / Right in a text field move the cursor through what's typed, so
     * a typo can be fixed (issue #115); only past either end do they move
     * focus on.  The key is then left to the browser. */
    function caretCanMove(delta) {
        var el = document.activeElement;
        if (!isTextField(el) || !el.classList.contains('focused')) return false;
        try {
            var s = el.selectionStart, e = el.selectionEnd;
            if (s == null || e == null) return false;
            return delta < 0 ? e > 0 : s < el.value.length;
        } catch (ex) { return false; }
    }

    /* Number-key seek: digit n → n × 10 % of the duration.  Returns false
     * when an overlay owns the keys or the duration isn't known yet. */
    function seekToTenth(digit) {
        if (!document.getElementById('error-overlay').classList.contains('hidden') ||
            !document.getElementById('track-menu').classList.contains('hidden') ||
            !document.getElementById('picker').classList.contains('hidden')) return false;
        var dur = Player.duration() || lastProgress.duration;
        if (digit > 0 && !dur) return false;
        var target = digit ? Math.floor(dur * digit / 10) : 0;
        if (scrub.active) cancelScrub(false);
        Player.seekTo(target);
        updateProgress(target, dur || lastProgress.duration);
        flashOSD();
        UI.toast(digit ? I18n.t('player.jumped', digit * 10, fmtTime(target)) : I18n.t('player.restarted'));
        return true;
    }

    /* ── Global remote key dispatcher ─────────────────────────────── */
    function globalKeyHandler(code, ev) {
        var K = Remote.KEY;
        if (typeof Debug !== 'undefined') Debug.key('code=' + code + ' view=' + state.view);

        if (state.background && state.view !== 'player' && backgroundKeys(code)) return true;

        // Remote number buttons (0-9) type into a focused text field, so the
        // hardware keys work alongside the on-screen keyboard. Only consumes the
        // key when a text field actually took it, otherwise it falls through.
        if (code >= K.ZERO && code <= K.NINE && typeDigitIntoField(code - K.ZERO)) return true;
        unlockForTyping(ev);

        // In the player, the number keys jump by tenths: 0 restarts, 1–9 go
        // to 10 %–90 % of the file (issue #78).  Only when nothing modal is
        // up, and only for files with a known duration (0 always works).
        if (code >= K.ZERO && code <= K.NINE && state.view === 'player' &&
            seekToTenth(code - K.ZERO)) return true;

        // URL input view: OK on the field opens the on-screen keyboard (see
        // ENTER below), and the keyboard's Done moves on to the Play button.
        // The keyboard's Done in the playlist filter: filter now, then on to
        // the first result.
        if (state.view === 'browse' && code === K.IME_DONE && document.activeElement &&
            document.activeElement.id === 'playlist-filter' && state.playlistView) {
            clearTimeout(filterTimer);
            // A composing keyboard layout may still be committing its last
            // word when Done arrives, so the field is read a moment later.
            var field = document.activeElement;
            lastFilterEvent = 'done';
            setTimeout(function () {
                if (!state.playlistView || state.view !== 'browse') return;
                state.playlistView.filter = field.value;
                renderPlaylist();
            }, 50);
            return true;
        }

        if (code === K.IME_DONE && skipCustomFor && document.activeElement && document.activeElement.id === 'picker-custom') { saveSkipCustom(); return true; }
        if (state.view === 'url') {
            if (code === K.BACK) {
                if (!document.getElementById('picker').classList.contains('hidden')) {
                    closePicker();
                    if (savedMenuFor) focusSaved(savedMenuFor, 'saved-menu');
                } else if (savedEditing !== null) closeSavedEdit();
                else backToHome();
                return true;
            }
            // In the save form the keyboard's Done goes on to the URL, then saves.
            if (code === K.IME_DONE && savedEditing !== null && document.activeElement) {
                if (document.activeElement.id === 'saved-name') {
                    UI.focusOn(document.getElementById('saved-url'));
                    return true;
                }
                if (document.activeElement.id === 'saved-url') { finishSavedEdit(); return true; }
            }
            // Done on the URL field fills it in and lands on Play, so Save
            // and the other buttons are one step away rather than the
            // stream already playing (issue #126).
            if (code === K.IME_DONE && document.activeElement &&
                document.activeElement.id === 'url-input') {
                UI.focusOn(document.querySelector('#view-url [data-action="open-current-url"]'));
                return true;
            }
        }

        // When the error overlay is up, route ALL navigation/activation to it
        // (no seeking, no OSD flashing — the only thing on screen that matters
        // is the "Back to Home" button).
        var errorUp = !document.getElementById('error-overlay').classList.contains('hidden');

        // Track menu / settings picker open? Routes through normal focus.
        var trackMenuOpen = !document.getElementById('track-menu').classList.contains('hidden');
        var pickerOpen    = !document.getElementById('picker').classList.contains('hidden');
        // OSD currently visible? Determines whether keys navigate within OSD
        // or perform seek shortcuts.
        var osdVisible = !document.getElementById('osd-bottom').classList.contains('hidden');

        switch (code) {
            // Player view key mapping (issue #28 part 2 + fast seeking):
            //   Up/Down  → cycle between OSD buttons (no-op when OSD hidden,
            //              just brings it up)
            //   Left     → scrub backward (starts at 10 s, accelerates when
            //              held/tapped rapidly, up to 1–2 % of the duration)
            //   Right    → scrub forward, same acceleration
            //   FF/RW    → same scrub with a 30 s floor
            // Scrub steps only preview on the progress bar; the real seek is
            // committed after a short pause in input, or instantly on OK.
            // BACK during a scrub cancels it without seeking.
            case K.UP:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(-1);
                    flashOSD();
                    return true;
                }
                if (state.view === 'settings' && !pickerOpen) {
                    scrollSettingsIfNoFocusMove(-200, 'up');
                    return true;
                }
                UI.moveFocus('up');
                return true;
            case K.DOWN:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(+1);
                    flashOSD();
                    return true;
                }
                if (state.view === 'settings' && !pickerOpen) {
                    scrollSettingsIfNoFocusMove(+200, 'down');
                    return true;
                }
                UI.moveFocus('down');
                return true;
            case K.LEFT:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    scrubStep(-1, skipShortMs());
                    return true;
                }
                if (state.view === 'player' && trackMenuOpen && !pickerOpen) { if (nudgeDelayRow(-1)) return true; UI.moveFocus('left'); syncTabToFocus(); return true; }
                if (caretCanMove(-1)) return false;
                if (browseShowing() && !pickerOpen && forgetWatchedRow()) return true;
                UI.moveFocus('left');  return true;
            case K.RIGHT:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    scrubStep(+1, skipShortMs());
                    return true;
                }
                if (state.view === 'player' && trackMenuOpen && !pickerOpen) { if (nudgeDelayRow(+1)) return true; UI.moveFocus('right'); syncTabToFocus(); return true; }
                if (caretCanMove(+1)) return false;
                if (browseShowing() && !pickerOpen && (toggleSavedChannel() || toggleFavoriteRow())) return true;
                UI.moveFocus('right'); return true;
            case K.ENTER:
                // Megatron: a USB row — short press opens, hold OK opens the menu.
                if (hold) return true;
                if (state.view === 'browse' && !pickerOpen && holdOkStart()) return true;
                // In player view: OK activates the focused OSD button if the OSD
                // is up (so Stop / CC-Audio / etc. are reachable).  If the OSD
                // is hidden, OK toggles play/pause AND brings the OSD up —
                // matches YouTube-on-TV / Netflix, and gives users whose
                // remote's dedicated Play/Pause hard key isn't delivered to
                // the app (Smart Monitor M5 and friends — issues #42, #57)
                // a working way to pause without opening the OSD first.
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (scrub.active) { commitScrub(); return true; }
                    // Next episode counting down and the controls hidden: OK skips ahead.
                    if (!osdVisible && nextUpVisible()) { hideNextUp(); if (!playNext(false)) UI.toast(I18n.t('player.noNext')); return true; }
                    if (!osdVisible) { Player.togglePause(); flashOSD(); return true; }
                    if (!UI.activateFocused()) flashOSD();
                    return true;
                }
                // A text field: let OK through untouched.  That key press is
                // the user action that opens the on-screen keyboard — merely
                // landing on the field no longer does (config.xml, issue #111).
                if (!UI.activateFocused() && isTextField(document.activeElement)) {
                    openKeyboardFor(document.activeElement);
                    return false;
                }
                return true;
            case K.INFO:
                if (state.view === 'player' && !errorUp) { toggleInfoTab(); return true; }
                return false;
            case K.BACK:
                if (pickerOpen)                 { closePicker();     return true; }
                if (trackMenuOpen)              { closeTrackMenu();  return true; }
                // A dead channel is routine in an IPTV list: back to the list,
                // not all the way home.
                if (errorUp && state.origin === 'playlist') { exitPlayer(); return true; }
                if (errorUp)                    { backToHome();      return true; }
                if (state.view === 'browse' && state.listBack) {
                    var listBack = state.listBack; state.listBack = null;
                    listBack();
                    return true;
                }
                if (state.view === 'browse')    { browseUp();        return true; }
                if (state.view === 'player' && scrub.active) { cancelScrub(true); return true; }
                if (state.view === 'player' && nextUpVisible()) { dismissNextUp(); return true; }
                if (state.view === 'player' && state.playingIsAudio) { minimizePlayer(); return true; }
                // Megatron: Back leaves the video straight away, even with the
                // controls on screen (no extra press to put them away first).
                if (state.view === 'player')    { exitPlayer();      return true; }
                if (state.view === 'url')       { backToHome();      return true; }
                if (state.view === 'settings')  { backToHome();      return true; }
                /* Home view: explicitly exit the app rather than trusting the
                 * TV launcher to intercept an unhandled BACK — that fallback
                 * doesn't fire on Smart Monitors, leaving the user with no
                 * way out (issue #57). */
                if (state.view === 'home')      { exitApp();         return true; }
                return false;
            case K.PLAY:
            case K.PAUSE:
            case K.PLAYPAUSE:
                if (state.view === 'player') {
                    if (scrub.active) commitScrub();
                    Player.togglePause(); flashOSD(); return true;
                }
                return false;
            case K.STOP:
                if (state.view === 'player') { exitPlayer(); return true; }
                return false;
            // Channel ± and the track keys step through the list (issue #105).
            case K.CH_UP: case K.TRACK_NEXT:
                if (state.view === 'player' && !errorUp) {
                    if (!playNext(false)) UI.toast(I18n.t('player.noNext'));
                    return true;
                }
                return false;
            case K.CH_DOWN: case K.TRACK_PREV:
                if (state.view === 'player' && !errorUp) { handlePrev(); return true; }
                return false;
            case K.REWIND:
                if (state.view === 'player') { scrubStep(-1, skipLongMs()); return true; }
                return false;
            case K.FF:
                if (state.view === 'player') { scrubStep(+1, skipLongMs()); return true; }
                return false;
        }
        return false;
    }

    /* ── Auto-apply preferred audio + subtitle language ─────────────
     * Called after the player reaches state=PLAYING so the AVPlay/HTML5
     * track list is populated.  Finds the first track whose name (or, for
     * HTML5 external subs, lang tag) matches the preferred ISO code and
     * activates it.  Subtitle 'off' explicitly disables.  No-op if the
     * preference is empty (Auto). */
    /* Pick the audio track to play, balancing two goals:
     *   1. the user's preferred audio language (Settings → audioLang), and
     *   2. actually getting sound — Samsung TVs can't decode DTS/TrueHD, so a
     *      track flagged `unsupported` by Player.getTracks() plays silently.
     * Priority: preferred-language + decodable  >  any decodable  >  the
     * preferred-language track even if silent (at least it's the right
     * language).  Only switches when it improves on the current/default track,
     * and surfaces a toast so the user understands a silent file. */
    function chooseAudioTrack(tracks) {
        var audio = (tracks && tracks.audio) || [];
        if (!audio.length) return;

        var pref = (Settings.get('audioLang') || '').toLowerCase();
        function langMatches(t) {
            if (!pref) return false;
            // Shared with the subtitle picker: matches the language tag, the
            // ISO 639-2 spelling ('ger', 'vie'), the English name and the
            // endonym — see LanguageList.matchScore in settings.js.
            return LanguageList.matchScore(pref, t.lang, t.name) > 0;
        }
        function firstSupported(list) {
            for (var i = 0; i < list.length; i++) if (!list[i].unsupported) return list[i];
            return null;
        }

        var active = null;
        for (var i = 0; i < audio.length; i++) if (audio[i].active) { active = audio[i]; break; }

        var target = null;
        if (pref) {
            var matchSupported = null, matchAny = null;
            for (var j = 0; j < audio.length; j++) {
                if (!langMatches(audio[j])) continue;
                if (!matchAny) matchAny = audio[j];
                if (!audio[j].unsupported && !matchSupported) matchSupported = audio[j];
            }
            if (matchSupported)      target = matchSupported;          // ideal
            else if (matchAny)       target = firstSupported(audio) || matchAny;
        }
        // No preference (or none usable): only step in if the current track is
        // undecodable but a decodable one exists.
        if (!target && active && active.unsupported) target = firstSupported(audio);

        if (target && (!active || target.index !== active.index)) {
            Player.setAudioTrack(target.index);
            if (active && active.unsupported && !target.unsupported)
                UI.toast(target.codec && active.codec
                    ? I18n.t('audio.switched', target.codec, active.codec)
                    : I18n.t('audio.switchedGeneric'));
            if (typeof Debug !== 'undefined')
                Debug.player('chooseAudioTrack → ' + target.name +
                             ' (active was ' + (active ? active.name : 'none') + ')');
        }

        // If we still can't get a decodable track, tell the user why it's silent.
        var finalT = target || active;
        if (finalT && finalT.unsupported && !firstSupported(audio)) {
            UI.toast(I18n.t('audio.noneDecodable', finalT.codec || 'DTS/TrueHD'));
        }
    }

    var prefsAppliedFor = null;
    var subPrefSettled  = false;
    function applyLanguagePreferences() {
        // Only apply once per file to avoid clobbering manual selections
        if (prefsAppliedFor === state.playingUri) return;
        prefsAppliedFor = state.playingUri;
        delayNow = loadSubDelay(state.playingUri); Player.setSubDelay(delayNow);
        subPrefSettled  = false;

        var prefSub   = Settings.get('subtitleLang');
        var tracks    = Player.getTracks();

        // Audio: honour the language preference, but never leave the user on a
        // track the TV can't decode (DTS/TrueHD) when a playable one exists.
        chooseAudioTrack(tracks);

        // Subtitle: 'off' explicit, '' auto (sidecar, else the file's
        // default track), code → match
        if (prefSub === 'off') {
            Player.setSubtitleTrack(-1);
            subPrefSettled = true;
            if (typeof Debug !== 'undefined') Debug.player('subtitle pref: off (silent)');
        } else if (subLangs().length) {
            // First language, then the second.  When neither is there, fall
            // back like Auto does: a file with no tag, the only file, the
            // app's language, else the track the file marks default.
            if (!applySubtitlePreference(subLangs(), tracks)) {
                if (!adoptSidecarSubtitle(tracks)) adoptFileDefaultSubtitle(tracks);
            }
        } else {
            subPrefSettled = true;
            if (!adoptSidecarSubtitle(tracks)) adoptFileDefaultSubtitle(tracks);
        }
    }

    /* 'Auto (file default)', first half: a subtitle file next to the video
     * (issue #165).  Which one is LanguageList.pickAutoSubtitle's call —
     * the untagged Film.txt, else the one in the app's language, else the
     * only one there is.  The AVPlay backend has usually applied it already
     * before play() (player.js, the no-seek point); then it is just left
     * showing rather than re-read.  The HTML5 backend gets it here. */
    function adoptSidecarSubtitle(tracks) {
        var sidecars = [];
        for (var j = 0; j < tracks.subtitle.length; j++) {
            var st = tracks.subtitle[j];
            if (st.off || st.muted) continue;
            if (st.type === 'AVPLAY_EXTERNAL' || st.type === 'HTML5_EXTERNAL') sidecars.push(st);
        }
        var pick = LanguageList.pickAutoSubtitle(sidecars, I18n.current());
        if (!pick) return false;
        if (!pick.active) {
            var how = Player.setSubtitleTrack(pick);
            if (typeof Debug !== 'undefined')
                Debug.player('subtitle pref: auto → subtitle file ' + pick.name + ' (' + how + ')');
            if (how !== 'extracting' && how !== null) UI.toast(I18n.t('toast.subAuto', pick.name));
        } else if (typeof Debug !== 'undefined') {
            Debug.player('subtitle pref: auto → subtitle file ' + pick.name + ' (already showing)');
        }
        return true;
    }

    /* 'Auto (file default)': show the track the file itself marks default.
     * AVPlay opens with that track current, and used to leave it there:
     * the CC menu marked it selected, but the subtitle callback stays gated
     * until a track is selected through Player.setSubtitleTrack, so nothing
     * reached the screen until the user toggled it off and on (issue #73).
     * Select it the way the CC menu does, so what the menu says and what
     * the screen shows are the same thing. */
    function adoptFileDefaultSubtitle(tracks) {
        for (var j = 0; j < tracks.subtitle.length; j++) {
            var st = tracks.subtitle[j];
            if (st.off || st.muted || !st.avCurrent) continue;
            var how = Player.setSubtitleTrack(st);
            if (typeof Debug !== 'undefined')
                Debug.player('subtitle pref: auto → file default ' + st.name + ' (' + how + ')');
            return true;
        }
        if (typeof Debug !== 'undefined')
            Debug.player('subtitle pref: auto — file has no default subtitle track');
        return false;
    }

    /* Score every candidate and take the best.  External subs are reliable
     * on this firmware and embedded ones often aren't, so they win ties. */
    /* The wanted languages, in order: first choice, then second choice. */
    function subLangs() {
        var out = [], p1 = Settings.get('subtitleLang'), p2 = Settings.get('subtitleLang2');
        if (p1 && p1 !== 'off') out.push(p1);
        if (p2 && p2 !== 'off' && p2 !== p1) out.push(p2);
        return out;
    }
    function applySubtitlePreference(prefs, tracks) {
        if (typeof prefs === 'string') prefs = [prefs];
        var prefSub = prefs.join(' / ');
        var bestMatch = null;
        var bestScore = 0;
        // The first language that has any matching track wins; within it the
        // best-scoring track (sidecar over embedded, .srt over .ass, forced
        // and SDH last).
        for (var w = 0; w < prefs.length && !bestMatch; w++) {
            var wantSub = prefs[w].toLowerCase();
            for (var j = 0; j < tracks.subtitle.length; j++) {
                var st = tracks.subtitle[j];
                if (st.off || st.muted) continue;
                var ext = st.type === 'AVPLAY_EXTERNAL' || st.type === 'HTML5_EXTERNAL';
                var sc = LanguageList.subScore(wantSub, st.lang, st.name, st.ext, ext);
                if (!sc) continue;
                if (sc > bestScore) { bestScore = sc; bestMatch = st; }
            }
            bestScore = 0;
            if (bestMatch) break;
        }
        if (bestMatch) {
            subPrefSettled = true;
            var how0 = Player.setSubtitleTrack(bestMatch);
            if (how0 !== 'extracting' && how0 !== null) UI.toast(I18n.t('toast.subAuto', bestMatch.name));
            if (typeof Debug !== 'undefined')
                Debug.player('applied subtitle pref ' + prefSub + ' → ' + bestMatch.name +
                             ' (score ' + bestScore + ')');
            return true;
        }
        if (typeof Debug !== 'undefined')
            Debug.player('subtitle pref ' + prefSub + ': no matching track in ' +
                         tracks.subtitle.map(function (x) { return x.name; }).join(' / '));
        return false;
    }

    /* The container's own track list is read after playback starts, so a
     * preferred language that only exists in the tail of a 40-track mux
     * becomes matchable a second or two late.  Retry then — but never over
     * the top of a subtitle that is already showing, which would undo a
     * choice the user just made by hand. */
    function retrySubtitlePreference() {
        if (subPrefSettled) return;
        if (prefsAppliedFor !== state.playingUri) return;
        var langs = subLangs();
        if (!langs.length) { subPrefSettled = true; return; }
        var tracks = Player.getTracks();
        if (!tracks.subtitle.length || !tracks.subtitle[0].active) return;   // one is showing
        applySubtitlePreference(langs, tracks);
    }

    /* On the settings view, after the last focusable row there's a TV-info
     * panel that has no focusables.  Up/Down should:
     *   1. Try to move focus geometrically (noWrap = don't cyclic-fallback).
     *   2. If no element is in that direction, scroll the settings-content
     *      panel instead so the user can read past the bottom of the info.
     * Without noWrap the cyclic fallback would jump focus back to the
     * opposite end and never trigger the scroll. */
    function scrollSettingsIfNoFocusMove(dy, dir) {
        if (UI.moveFocus(dir, /*noWrap*/ true)) return;   // focus moved, done
        var c = document.querySelector('.settings-content');
        if (c) {
            if (c.scrollBy) c.scrollBy({ top: dy, behavior: 'smooth' });
            else            c.scrollTop += dy;
        }
    }

    /* ── Helpers ──────────────────────────────────────────────────── */
    function prettifyRootName(name) {
        if (!name) return I18n.t('root.unknown');
        if (/^removable.*/i.test(name)) return I18n.t('browse.usbTitle');
        if (/^usb/i.test(name)) return I18n.t('browse.usbTitle');
        if (name === 'downloads') return I18n.t('root.downloads');
        if (name === 'videos')    return I18n.t('root.videos');
        if (name === 'music')     return I18n.t('root.music');
        if (name === 'images')    return I18n.t('root.pictures');
        if (name === 'documents') return I18n.t('root.documents');
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Public hooks used by js/smb.js to hand SMB playback back to the app so it
    // reuses next/prev, auto-play, recent & watched tracking.
    window.VlcApp = {
        play: playFromList, home: backToHome, openSettings: openSettings,
        // smb.js hands a playlist on a share over the same way.
        openPlaylist: openPlaylist, maxPlaylistBytes: MAX_PLAYLIST_BYTES,
        // …and marks the song playing on in the background in its lists.
        markNowPlaying: markNowPlaying,
        // server.js uses this to let the user choose when a LAN scan turns up
        // more than one transcode server.
        openPicker: openPicker
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();

})();
