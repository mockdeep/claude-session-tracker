const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;

const STATE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'claude-sessions']);
const DEFAULT_COLOR = '#cc241d';
const DOT_SIZE = 12;
const POLL_INTERVAL_SECONDS = 2;
const PULSE_INTERVAL_MS = 80;
const PULSE_MIN_OPACITY = 100;
const PULSE_MAX_OPACITY = 255;
const PULSE_STEP = 8;

class ClaudeSessionsApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_tooltip('');

        this._dotBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        this.actor.add(this._dotBox);

        this._sessions = {};
        this._focusedXid = 0;
        this._pollTimerId = null;
        this._pulseTimerId = null;
        this._pulsingDots = [];
        this._pulseDirection = 1;
        this._pulseOpacity = PULSE_MAX_OPACITY;
        this._lastMtimeMs = 0;

        this._focusSignalId = global.display.connect('notify::focus-window', () => {
            this._onFocusChanged();
        });

        this._ensureStateDir();
        this._refresh();
        this._startPollTimer();
    }

    _onFocusChanged() {
        let win = global.display.get_focus_window();
        let newXid = win ? win.get_xwindow() : 0;
        if (newXid !== this._focusedXid) {
            this._focusedXid = newXid;
            this._updatePanel();
        }
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
    }

    _getSortedSessions() {
        let sessions = Object.values(this._sessions);
        // Permission first, then idle, then active — within each group by timestamp
        let statusOrder = { permission: 0, idle: 1, active: 2 };
        sessions.sort((a, b) => {
            let oa = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
            let ob = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
            if (oa !== ob) return oa - ob;
            return (a.timestamp || '').localeCompare(b.timestamp || '');
        });
        return sessions;
    }

    _updatePanel() {
        let sessions = this._getSortedSessions();

        this._stopPulseTimer();
        this._pulsingDots = [];
        this._dotBox.destroy_all_children();

        if (sessions.length === 0) {
            this.actor.hide();
            return;
        }

        this.actor.show();

        for (let session of sessions) {
            let color = session.theme_color || DEFAULT_COLOR;
            let isPermission = session.status === 'permission';
            let isWaiting = isPermission || session.status === 'idle';
            let isFocused = session.window_id && parseInt(session.window_id) === this._focusedXid;

            let border = isPermission
                ? 'border: 2px solid #ffffff;'
                : 'border: 2px solid transparent;';

            let dot = new St.Bin({
                style: `background-color: ${color}; `
                     + `width: ${DOT_SIZE}px; height: ${DOT_SIZE}px; `
                     + `border-radius: ${DOT_SIZE}px; `
                     + border,
                opacity: 255,
            });

            if (!isWaiting) {
                this._pulsingDots.push(dot);
            }

            let focusBar = new St.Bin({
                style: `background-color: ${isFocused ? '#ffffff' : 'transparent'}; `
                     + `width: ${DOT_SIZE}px; height: 2px; border-radius: 1px;`,
            });

            let container = new St.BoxLayout({
                vertical: true,
                reactive: true,
                track_hover: true,
                style: 'spacing: 2px;',
            });
            container.add_child(dot);
            container.add_child(focusBar);

            let sessionId = session.session_id;
            container.connect('button-release-event', () => {
                Util.spawnCommandLine(`bash -c 'echo "{\\"session_id\\":\\"${sessionId}\\"}" | claude-session-tracker focus'`);
                return true;
            });

            let elapsed = this._formatElapsed(session.timestamp);
            let icon = this._statusIcon(session.status);
            let tipText = `${icon} ${session.project_name}  (${session.status}, ${elapsed})`;

            container.connect('enter-event', () => {
                this.set_applet_tooltip(tipText);
                return false;
            });
            container.connect('leave-event', () => {
                this.set_applet_tooltip('');
                return false;
            });

            this._dotBox.add_child(container);
        }

        if (this._pulsingDots.length > 0) {
            this._startPulseTimer();
        }
    }

    _startPulseTimer() {
        if (this._pulseTimerId) return;
        this._pulseTimerId = Mainloop.timeout_add(PULSE_INTERVAL_MS, () => {
            this._pulseOpacity += PULSE_STEP * this._pulseDirection;
            if (this._pulseOpacity >= PULSE_MAX_OPACITY) {
                this._pulseOpacity = PULSE_MAX_OPACITY;
                this._pulseDirection = -1;
            } else if (this._pulseOpacity <= PULSE_MIN_OPACITY) {
                this._pulseOpacity = PULSE_MIN_OPACITY;
                this._pulseDirection = 1;
            }
            for (let dot of this._pulsingDots) {
                dot.opacity = this._pulseOpacity;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPulseTimer() {
        if (this._pulseTimerId) {
            Mainloop.source_remove(this._pulseTimerId);
            this._pulseTimerId = null;
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

    on_applet_removed_from_panel() {
        this._stopPollTimer();
        this._stopPulseTimer();
        if (this._focusSignalId) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = 0;
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ClaudeSessionsApplet(metadata, orientation, panelHeight, instanceId);
}
