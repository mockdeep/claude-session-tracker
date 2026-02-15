const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;

const STATE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'claude-sessions']);
const DEFAULT_COLOR = '#cc241d';
const DOT_SIZE = 12;
const POLL_INTERVAL_SECONDS = 2;
const MENU_REFRESH_SECONDS = 30;

class ClaudeSessionsApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_tooltip('Claude Sessions');

        this._dotBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        this.actor.add(this._dotBox);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._sessions = {};
        this._pollTimerId = null;
        this._menuTimerId = null;
        this._lastMtimeMs = 0;

        this._ensureStateDir();
        this._refresh();
        this._startPollTimer();
    }

    _ensureStateDir() {
        let dir = Gio.File.new_for_path(STATE_DIR);
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                global.logError(`Claude Sessions: failed to create state dir: ${e.message}`);
            }
        }
    }

    _getDirMtime() {
        // Check directory mtime as a cheap signal that contents changed
        try {
            let dir = Gio.File.new_for_path(STATE_DIR);
            let info = dir.query_info('time::modified-usec,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            return info.get_attribute_uint64('time::modified') * 1000 +
                   Math.floor(info.get_attribute_uint32('time::modified-usec') / 1000);
        } catch (e) {
            return 0;
        }
    }

    _pollCheck() {
        let mtime = this._getDirMtime();
        if (mtime !== this._lastMtimeMs) {
            this._lastMtimeMs = mtime;
            this._refresh();
        }
        return GLib.SOURCE_CONTINUE;
    }

    _startPollTimer() {
        if (this._pollTimerId) return;
        this._pollTimerId = Mainloop.timeout_add_seconds(POLL_INTERVAL_SECONDS, () => {
            return this._pollCheck();
        });
    }

    _stopPollTimer() {
        if (this._pollTimerId) {
            Mainloop.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }
    }

    _refresh() {
        this._sessions = {};

        let dir = Gio.File.new_for_path(STATE_DIR);
        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (e) {
            this._updatePanel();
            return;
        }

        let fileInfo;
        while ((fileInfo = enumerator.next_file(null)) !== null) {
            let name = fileInfo.get_name();
            if (!name.endsWith('.json')) continue;

            let file = dir.get_child(name);
            try {
                let [ok, contents] = file.load_contents(null);
                if (ok) {
                    let session = JSON.parse(new TextDecoder().decode(contents));
                    this._sessions[session.session_id] = session;
                }
            } catch (e) {
                // skip malformed files
            }
        }

        this._updatePanel();
        this._rebuildMenu();
    }

    _getWaitingSessions() {
        let waiting = [];
        for (let id in this._sessions) {
            let s = this._sessions[id];
            if (s.status === 'idle' || s.status === 'permission') {
                waiting.push(s);
            }
        }
        // Permission first (more urgent), then by timestamp
        waiting.sort((a, b) => {
            if (a.status === 'permission' && b.status !== 'permission') return -1;
            if (b.status === 'permission' && a.status !== 'permission') return 1;
            return (a.timestamp || '').localeCompare(b.timestamp || '');
        });
        return waiting;
    }

    _updatePanel() {
        let waiting = this._getWaitingSessions();

        this._dotBox.destroy_all_children();

        if (waiting.length === 0) {
            this.actor.hide();
            this._stopMenuTimer();
            return;
        }

        this.actor.show();
        this._startMenuTimer();

        for (let session of waiting) {
            let color = session.theme_color || DEFAULT_COLOR;
            let isPermission = session.status === 'permission';

            let border = isPermission
                ? 'border: 2px solid #ffffff;'
                : 'border: 2px solid transparent;';

            let dot = new St.Bin({
                style: `background-color: ${color}; `
                     + `width: ${DOT_SIZE}px; height: ${DOT_SIZE}px; `
                     + `border-radius: ${DOT_SIZE}px; `
                     + border,
            });

            this._dotBox.add_child(dot);
        }
    }

    _formatElapsed(timestamp) {
        if (!timestamp) return '';
        let then = new Date(timestamp).getTime();
        let now = Date.now();
        let seconds = Math.floor((now - then) / 1000);

        if (seconds < 60) return `${seconds}s`;
        let minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        let hours = Math.floor(minutes / 60);
        let mins = minutes % 60;
        return `${hours}h${mins}m`;
    }

    _statusIcon(status) {
        if (status === 'permission') return '\u26a0\ufe0f'; // warning
        if (status === 'idle') return '\u23f8\ufe0f';        // pause
        return '';
    }

    _rebuildMenu() {
        this.menu.removeAll();

        let waiting = this._getWaitingSessions();
        if (waiting.length === 0) return;

        for (let session of waiting) {
            let elapsed = this._formatElapsed(session.timestamp);
            let icon = this._statusIcon(session.status);
            let label = `${icon} ${session.project_name}  (${session.status}, ${elapsed})`;

            let item = new PopupMenu.PopupMenuItem(label);
            let sessionId = session.session_id;
            item.connect('activate', () => {
                Util.spawnCommandLine(`bash -c 'echo "{\\"session_id\\":\\"${sessionId}\\"}" | claude-session-tracker focus'`);
            });
            this.menu.addMenuItem(item);
        }
    }

    _startMenuTimer() {
        if (this._menuTimerId) return;
        this._menuTimerId = Mainloop.timeout_add_seconds(MENU_REFRESH_SECONDS, () => {
            this._rebuildMenu();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopMenuTimer() {
        if (this._menuTimerId) {
            Mainloop.source_remove(this._menuTimerId);
            this._menuTimerId = null;
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._stopPollTimer();
        this._stopMenuTimer();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ClaudeSessionsApplet(metadata, orientation, panelHeight, instanceId);
}
