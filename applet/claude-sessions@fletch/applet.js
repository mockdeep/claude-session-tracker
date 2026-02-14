const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;

const STATE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'claude-sessions']);

class ClaudeSessionsApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_icon_symbolic_name('utilities-terminal-symbolic');
        this.set_applet_tooltip('Claude Sessions');

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._sessions = {};
        this._debounceId = null;
        this._timerId = null;
        this._monitor = null;

        this._setupMonitor();
        this._refresh();
    }

    _setupMonitor() {
        let dir = Gio.File.new_for_path(STATE_DIR);

        // Ensure the directory exists
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                global.logError(`Claude Sessions: failed to create state dir: ${e.message}`);
                return;
            }
        }

        this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._debounceRefresh());
    }

    _debounceRefresh() {
        if (this._debounceId) {
            Mainloop.source_remove(this._debounceId);
        }
        this._debounceId = Mainloop.timeout_add(250, () => {
            this._debounceId = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
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
            this._updateVisibility();
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

        this._updateVisibility();
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

    _updateVisibility() {
        let waiting = this._getWaitingSessions();
        let count = waiting.length;

        if (count === 0) {
            this.actor.hide();
            this._stopTimer();
        } else {
            this.actor.show();
            this.set_applet_label(count.toString());
            this._startTimer();
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
            let windowId = session.window_id;
            item.connect('activate', () => {
                if (windowId) {
                    // wmctrl -i -a switches to the window's workspace and activates it
                    let hexId = '0x' + parseInt(windowId, 10).toString(16).padStart(8, '0');
                    Util.spawnCommandLine(`wmctrl -i -a ${hexId}`);
                }
            });
            this.menu.addMenuItem(item);
        }
    }

    _startTimer() {
        if (this._timerId) return;
        this._timerId = Mainloop.timeout_add_seconds(30, () => {
            this._rebuildMenu();
            this._updateVisibility();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            Mainloop.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._stopTimer();
        if (this._debounceId) {
            Mainloop.source_remove(this._debounceId);
            this._debounceId = null;
        }
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ClaudeSessionsApplet(metadata, orientation, panelHeight, instanceId);
}
