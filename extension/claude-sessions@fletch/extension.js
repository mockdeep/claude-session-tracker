const Main = imports.ui.main;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const STATE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'claude-sessions']);
const DEFAULT_COLOR = '#cc241d';
const DOT_SIZE = 12;
const POLL_INTERVAL_SECONDS = 1;
const PULSE_INTERVAL_MS = 80;
const PULSE_MIN_OPACITY = 100;
const PULSE_MAX_OPACITY = 255;
const PULSE_STEP = 8;
const EDGE_OFFSET = 10;

let _instance = null;

class ClaudeSessionsExtension {
    constructor(metadata) {
        this._metadata = metadata;
        this._sessions = {};
        this._lastSnapshot = '';
        this._focusedXid = 0;
        this._pollTimerId = null;
        this._pulseTimerId = null;
        this._pulsingDots = [];
        this._pulseDirection = 1;
        this._pulseOpacity = PULSE_MAX_OPACITY;
        this._focusSignalId = 0;
        this._monitorsChangedId = 0;
        this._allocationId = 0;
        this._widget = null;
        this._container = null;
    }

    enable() {
        this._buildWidget();
        this._ensureStateDir();

        this._focusSignalId = global.display.connect('notify::focus-window', () => {
            this._onFocusChanged();
        });
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._positionWidget();
        });

        this._refresh();
        this._startPollTimer();
    }

    disable() {
        this._stopPollTimer();
        this._stopPulseTimer();

        if (this._focusSignalId) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._allocationId) {
            this._widget.disconnect(this._allocationId);
            this._allocationId = 0;
        }
        if (this._widget) {
            Main.layoutManager.removeChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
            this._container = null;
        }

        this._sessions = {};
        this._lastSnapshot = '';
        this._pulsingDots = [];
    }

    _buildWidget() {
        this._widget = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: 'background-color: rgba(30, 30, 30, 0.85);'
                 + 'border-radius: 8px;'
                 + 'padding: 6px 8px;',
        });

        this._container = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 4px;',
        });
        this._widget.add_child(this._container);

        Main.layoutManager.addChrome(this._widget, {
            affectsInputRegion: true,
            affectsStruts: false,
        });

        this._widget.hide();

        this._allocationId = this._widget.connect('allocation-changed', () => {
            this._positionWidget();
        });
    }

    _positionWidget() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._widget) return;

        let width = this._widget.get_width();
        let height = this._widget.get_height();

        // Account for bottom panel height
        let panelHeight = 0;
        try {
            let panels = Main.panelManager.panels;
            if (panels) {
                for (let panel of panels) {
                    if (panel && panel.monitorIndex === monitor.index
                        && panel.panelPosition === 1) {
                        panelHeight = panel.actor.get_height();
                    }
                }
            }
        } catch (e) {
            // fall back to no offset
        }

        this._widget.set_position(
            monitor.x + monitor.width - width - EDGE_OFFSET,
            monitor.y + monitor.height - height - EDGE_OFFSET - panelHeight
        );
    }

    _onFocusChanged() {
        let win = global.display.get_focus_window();
        let newXid = win ? win.get_xwindow() : 0;
        if (newXid !== this._focusedXid) {
            this._focusedXid = newXid;
            this._updateWidget();
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

    _pollCheck() {
        this._refresh();
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
        let sessions = {};

        let dir = Gio.File.new_for_path(STATE_DIR);
        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (e) {
            // directory gone or unreadable
        }

        if (enumerator) {
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                let name = fileInfo.get_name();
                if (!name.endsWith('.json')) continue;

                let file = dir.get_child(name);
                try {
                    let [ok, contents] = file.load_contents(null);
                    if (ok) {
                        let session = JSON.parse(new TextDecoder().decode(contents));
                        if (session.pid && !GLib.file_test('/proc/' + session.pid, GLib.FileTest.EXISTS)) {
                            file.delete(null);
                            continue;
                        }
                        sessions[session.session_id] = session;
                    }
                } catch (e) {
                    // skip malformed files
                }
            }
        }

        let snapshot = JSON.stringify(sessions);
        if (snapshot === this._lastSnapshot) return;

        this._lastSnapshot = snapshot;
        this._sessions = sessions;
        this._updateWidget();
    }

    _getSortedSessions() {
        let sessions = Object.values(this._sessions);
        let statusOrder = { permission: 0, idle: 1, active: 2 };
        sessions.sort((a, b) => {
            let oa = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
            let ob = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
            if (oa !== ob) return oa - ob;
            return (a.timestamp || '').localeCompare(b.timestamp || '');
        });
        return sessions;
    }

    _updateWidget() {
        if (!this._container) return;

        let sessions = this._getSortedSessions();

        this._stopPulseTimer();
        this._pulsingDots = [];
        this._container.destroy_all_children();

        if (sessions.length === 0) {
            this._widget.hide();
            return;
        }

        this._widget.show();

        for (let session of sessions) {
            let color = session.theme_color || DEFAULT_COLOR;
            let isPermission = session.status === 'permission';
            let isWaiting = isPermission || session.status === 'idle';
            let isFocused = session.window_id && parseInt(session.window_id) === this._focusedXid;

            let border = isPermission
                ? 'border: 2px solid #ffffff;'
                : 'border: 2px solid transparent;';

            let dot = new St.Bin({
                style: `background-color: ${color};`
                     + `width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;`
                     + `border-radius: ${DOT_SIZE}px;`
                     + border,
                opacity: 255,
            });

            if (!isWaiting) {
                this._pulsingDots.push(dot);
            }

            let icon = this._statusIcon(session.status);
            let elapsed = this._formatElapsed(session.timestamp);
            let labelText = `${icon} ${session.project_name || '?'}  ${elapsed}`.trim();

            let label = new St.Label({
                text: labelText,
                style: 'color: #e0e0e0; font-size: 11px; margin-left: 6px;',
                y_align: imports.gi.Clutter.ActorAlign.CENTER,
            });

            let focusBg = isFocused ? 'rgba(255, 255, 255, 0.15)' : 'transparent';
            let row = new St.BoxLayout({
                vertical: false,
                reactive: true,
                track_hover: true,
                style: `spacing: 0px; padding: 3px 6px;`
                     + `border-radius: 4px;`
                     + `background-color: ${focusBg};`,
            });
            row.add_child(dot);
            row.add_child(label);

            row.connect('style-changed', () => {
                if (row.hover) {
                    row.set_style(row.get_style().replace(
                        /background-color:[^;]+/,
                        'background-color: rgba(255, 255, 255, 0.1)'
                    ));
                }
            });
            row.connect('enter-event', () => {
                if (!isFocused) {
                    row.style = `spacing: 0px; padding: 3px 6px;`
                              + `border-radius: 4px;`
                              + `background-color: rgba(255, 255, 255, 0.1);`;
                }
                return false;
            });
            row.connect('leave-event', () => {
                row.style = `spacing: 0px; padding: 3px 6px;`
                          + `border-radius: 4px;`
                          + `background-color: ${focusBg};`;
                return false;
            });

            let sessionId = session.session_id;
            row.connect('button-release-event', () => {
                this._focusSession(sessionId);
                return true;
            });

            this._container.add_child(row);
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

    _focusSession(sessionId) {
        try {
            let payload = JSON.stringify({ session_id: sessionId });
            let [ok, pid, stdinFd] = GLib.spawn_async_with_pipes(
                null,
                ['claude-session-tracker', 'focus'],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            if (ok && stdinFd !== -1) {
                let stdinStream = new Gio.UnixOutputStream({ fd: stdinFd, close_fd: true });
                stdinStream.write_all(payload, null);
                stdinStream.close(null);
            }
            GLib.spawn_close_pid(pid);
        } catch (e) {
            global.logError(`Claude Sessions: failed to focus session: ${e.message}`);
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
        if (status === 'permission') return '\u26a0\ufe0f';
        if (status === 'idle') return '\u23f8\ufe0f';
        return '';
    }
}

function init(metadata) {
    _instance = new ClaudeSessionsExtension(metadata);
}

function enable() {
    if (_instance) _instance.enable();
}

function disable() {
    if (_instance) _instance.disable();
}
