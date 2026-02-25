/**
 * @typedef {{
 *   session_id: string,
 *   pid?: number,
 *   status?: string,
 *   theme_color?: string,
 *   window_id?: string,
 *   tab_index?: number,
 *   dbus_window_path?: string,
 *   pty_path?: string,
 *   project_name?: string,
 *   timestamp?: string,
 *   cwd?: string
 * }} Session
 */

const Main = imports.ui.main;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const STATE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'claude-sessions']);
const DEFAULT_COLOR = '#cc241d';
const DOT_SIZE = 36;
const DOT_SPACING = 16;
const GRID_COLUMNS = 2;
const POLL_INTERVAL_SECONDS = 1;
const PULSE_INTERVAL_MS = 80;
const PULSE_MIN_OPACITY = 30;
const PULSE_MAX_OPACITY = 120;
const PULSE_STEP = 6;
const EDGE_OFFSET = 10;

/** @type {ClaudeSessionsExtension | null} */
let _instance = null;

class ClaudeSessionsExtension {
    /** @param {object} metadata */
    constructor(metadata) {
        /** @type {object} */
        this._metadata = metadata;
        /** @type {Record<string, Session>} */
        this._sessions = {};
        /** @type {string} */
        this._lastSnapshot = '';
        /** @type {string} */
        this._lastVisualKey = '';
        /** @type {number} */
        this._focusedXid = 0;
        /** @type {number} */
        this._focusedTabIndex = -1;
        /** @type {string | null} */
        this._focusedDbusPath = null;
        /** @type {number | null} */
        this._pollTimerId = null;
        /** @type {number | null} */
        this._pulseTimerId = null;
        /** @type {imports.gi.St.Bin[]} */
        this._pulsingDots = [];
        /** @type {1 | -1} */
        this._pulseDirection = 1;
        /** @type {number} */
        this._pulseOpacity = PULSE_MAX_OPACITY;
        /** @type {number} */
        this._focusSignalId = 0;
        /** @type {number} */
        this._monitorsChangedId = 0;
        /** @type {number} */
        this._allocationId = 0;
        /** @type {number[]} */
        this._dbusSubscriptionIds = [];
        /** @type {imports.gi.St.BoxLayout | null} */
        this._widget = null;
        /** @type {imports.gi.St.BoxLayout | null} */
        this._container = null;
        /** @type {imports.gi.St.Label | null} */
        this._tooltip = null;
    }

    /** @returns {void} */
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

    /** @returns {void} */
    disable() {
        this._stopPollTimer();
        this._stopPulseTimer();

        this._unsubscribeDbusSignals();

        if (this._focusSignalId) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._allocationId && this._widget) {
            this._widget.disconnect(this._allocationId);
            this._allocationId = 0;
        }
        this._hideTooltip();
        if (this._widget) {
            Main.layoutManager.removeChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
            this._container = null;
        }

        this._sessions = {};
        this._lastSnapshot = '';
        this._lastVisualKey = '';
        this._pulsingDots = [];
    }

    /** @returns {void} */
    _buildWidget() {
        this._widget = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: 'padding: 8px;',
        });

        this._container = new St.BoxLayout({
            vertical: true,
            style: `spacing: ${DOT_SPACING}px;`,
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

    /** @returns {void} */
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

    /** @returns {void} */
    _onFocusChanged() {
        let win = global.display.get_focus_window();
        let newXid = win ? win.get_xwindow() : 0;
        if (newXid !== this._focusedXid) {
            this._focusedXid = newXid;
            this._updateFocusedTab();
            this._updateWidget();
        }
    }

    /** @returns {void} */
    _updateFocusedTab() {
        this._focusedTabIndex = -1;
        this._focusedDbusPath = null;

        if (!this._focusedXid) return;

        // Find a session matching the focused window that has D-Bus tab info
        /** @type {string | null} */
        let dbusPath = null;
        for (let sid in this._sessions) {
            let s = this._sessions[sid];
            if (s.window_id && parseInt(s.window_id) === this._focusedXid
                && s.dbus_window_path) {
                dbusPath = s.dbus_window_path;
                break;
            }
        }
        if (!dbusPath) return;

        this._focusedDbusPath = dbusPath;
        try {
            let result = Gio.DBus.session.call_sync(
                'org.gnome.Terminal',
                dbusPath,
                'org.gtk.Actions',
                'Describe',
                new GLib.Variant('(s)', ['active-tab']),
                GLib.VariantType.new('((bgav))'),
                Gio.DBusCallFlags.NONE,
                100,
                null
            );
            // Result is ((enabled, signature, [<index>]))
            let inner = result.get_child_value(0);
            let values = inner.get_child_value(2);
            if (values.n_children() > 0) {
                this._focusedTabIndex = values.get_child_value(0).get_variant().get_int32();
            }
        } catch (e) {
            // D-Bus call failed — not Gnome Terminal or window closed
        }
    }

    /** @returns {void} */
    _ensureStateDir() {
        let dir = Gio.File.new_for_path(STATE_DIR);
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (e instanceof GLib.Error
                && !e.matches(/** @type {number} */ (/** @type {unknown} */ (Gio.IOErrorEnum)), Gio.IOErrorEnum.EXISTS)) {
                global.logError(`Claude Sessions: failed to create state dir: ${e.message}`);
            }
        }
    }

    /** @returns {void} */
    _subscribeDbusSignals() {
        this._unsubscribeDbusSignals();

        /** @type {Set<string>} */
        let paths = new Set();
        for (let sid in this._sessions) {
            let s = this._sessions[sid];
            if (s.dbus_window_path) paths.add(s.dbus_window_path);
        }

        for (let path of paths) {
            let subId = Gio.DBus.session.signal_subscribe(
                'org.gnome.Terminal',
                'org.gtk.Actions',
                'Changed',
                path,
                null,
                Gio.DBusSignalFlags.NONE,
                () => {
                    let prev = this._focusedTabIndex;
                    this._updateFocusedTab();
                    if (this._focusedTabIndex !== prev) {
                        this._updateWidget();
                    }
                }
            );
            this._dbusSubscriptionIds.push(subId);
        }
    }

    /** @returns {void} */
    _unsubscribeDbusSignals() {
        for (let subId of this._dbusSubscriptionIds) {
            Gio.DBus.session.signal_unsubscribe(subId);
        }
        this._dbusSubscriptionIds = [];
    }

    /** @returns {boolean} */
    _pollCheck() {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
    }

    /** @returns {void} */
    _startPollTimer() {
        if (this._pollTimerId) return;
        this._pollTimerId = /** @type {number} */ (/** @type {unknown} */ (Mainloop.timeout_add_seconds(POLL_INTERVAL_SECONDS, () => {
            return this._pollCheck();
        })));
    }

    /** @returns {void} */
    _stopPollTimer() {
        if (this._pollTimerId) {
            Mainloop.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }
    }

    /** @returns {void} */
    _refresh() {
        /** @type {Record<string, Session>} */
        let sessions = {};

        let dir = Gio.File.new_for_path(STATE_DIR);
        /** @type {imports.gi.Gio.FileEnumerator | undefined} */
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
            /** @type {imports.gi.Gio.FileInfo | null} */
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                let name = fileInfo.get_name();
                if (!name.endsWith('.json')) continue;

                let file = dir.get_child(name);
                try {
                    let [ok, contents] = file.load_contents(null);
                    if (ok) {
                        /** @type {Session} */
                        let session = JSON.parse(new TextDecoder().decode(contents));
                        if (session.pid && !GLib.file_test('/proc/' + session.pid, GLib.FileTest.EXISTS)) {
                            try { file.delete(null); } catch (e) { /* already gone */ }
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

        // Build a visual key that excludes timestamp — timestamp changes only
        // affect tooltips, not dot appearance.  Rebuilding the widget on every
        // timestamp update causes visible flicker and resets the pulse phase.
        let visualKey = JSON.stringify(sessions, (k, v) => k === 'timestamp' ? undefined : v);
        let needsRebuild = visualKey !== this._lastVisualKey;
        this._lastVisualKey = visualKey;

        this._sessions = sessions;
        this._updateFocusedTab();
        this._subscribeDbusSignals();
        if (needsRebuild) {
            this._updateWidget();
        }
    }

    /**
     * Look up the workspace index for a window XID.
     * @param {number} xid
     * @returns {number} workspace index, or Infinity if not found
     */
    _getWorkspaceForXid(xid) {
        if (!xid) return Infinity;
        let actors = global.get_window_actors();
        for (let i = 0; i < actors.length; i++) {
            let metaWin = actors[i].get_meta_window();
            if (metaWin && metaWin.get_xwindow() === xid) {
                let ws = metaWin.get_workspace();
                return ws ? ws.index() : Infinity;
            }
        }
        return Infinity;
    }

    /** @returns {Session[]} */
    _getSortedSessions() {
        let sessions = Object.values(this._sessions);

        // Build a workspace lookup for each session's window
        /** @type {Map<string, number>} */
        let wsCache = new Map();
        for (let i = 0; i < sessions.length; i++) {
            let s = sessions[i];
            let xid = s.window_id ? parseInt(s.window_id) : 0;
            if (xid && !wsCache.has(s.window_id)) {
                wsCache.set(s.window_id, this._getWorkspaceForXid(xid));
            }
        }

        sessions.sort((a, b) => {
            // Primary: workspace index
            let wsA = a.window_id && wsCache.has(a.window_id) ? wsCache.get(a.window_id) : Infinity;
            let wsB = b.window_id && wsCache.has(b.window_id) ? wsCache.get(b.window_id) : Infinity;
            if (wsA !== wsB) return wsA - wsB;

            // Secondary: window ID (groups tabs in the same terminal)
            let widA = a.window_id || '';
            let widB = b.window_id || '';
            if (widA !== widB) return widA.localeCompare(widB);

            // Tertiary: tab index
            let tabA = a.tab_index != null ? a.tab_index : -1;
            let tabB = b.tab_index != null ? b.tab_index : -1;
            if (tabA !== tabB) return tabA - tabB;

            // Fallback: session ID for stability
            return a.session_id.localeCompare(b.session_id);
        });
        return sessions;
    }

    /** @returns {void} */
    _updateWidget() {
        if (!this._container || !this._widget) return;

        let sessions = this._getSortedSessions();

        this._stopPulseTimer();
        this._pulsingDots = [];
        this._container.destroy_all_children();

        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }

        if (sessions.length === 0) {
            this._widget.hide();
            return;
        }

        this._widget.show();

        // Build rows of GRID_COLUMNS dots each
        /** @type {imports.gi.St.BoxLayout | null} */
        let currentRow = null;
        for (let i = 0; i < sessions.length; i++) {
            if (i % GRID_COLUMNS === 0) {
                currentRow = new St.BoxLayout({
                    vertical: false,
                    style: `spacing: ${DOT_SPACING}px;`,
                });
                this._container.add_child(currentRow);
            }

            let session = sessions[i];
            let color = session.theme_color || DEFAULT_COLOR;
            let isPermission = session.status === 'permission';
            let idleAge = session.status === 'idle' && session.timestamp
                ? (Date.now() - new Date(session.timestamp).getTime()) / 1000
                : Infinity;
            let isWaiting = isPermission || (session.status === 'idle' && idleAge > 3);
            let windowMatch = session.window_id && parseInt(session.window_id) === this._focusedXid;
            let isFocused = windowMatch
                && (session.tab_index == null
                    || session.tab_index === this._focusedTabIndex);

            let borderStyle = isPermission
                ? 'border: 3px solid #ffffff;'
                : 'border: 3px solid transparent;';

            let dot = new St.Bin({
                reactive: true,
                track_hover: true,
                style: `background-color: ${color};`
                     + `width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;`
                     + `border-radius: ${DOT_SIZE}px;`
                     + `box-shadow: 0 0 8px 4px ${color};`
                     + borderStyle,
                opacity: 200,
            });

            if (isFocused) {
                let innerSize = Math.round(DOT_SIZE * 0.4);
                dot.child = new St.Bin({
                    style: `background-color: #ffffff;`
                         + `width: ${innerSize}px; height: ${innerSize}px;`
                         + `border-radius: ${innerSize}px;`,
                });
            }

            if (!isWaiting) {
                this._pulsingDots.push(dot);
            }

            // Hover tooltip
            let icon = this._statusIcon(session.status);
            let tooltipText = `${icon} ${session.project_name || '?'}`;

            dot.connect('enter-event', () => {
                this._showTooltip(dot, tooltipText);
                return false;
            });
            dot.connect('leave-event', () => {
                this._hideTooltip();
                return false;
            });

            let sessionId = session.session_id;
            dot.connect('button-release-event', () => {
                this._focusSession(sessionId);
                return true;
            });

            /** @type {imports.gi.St.BoxLayout} */ (currentRow).add_child(dot);
        }

        if (this._pulsingDots.length > 0) {
            this._startPulseTimer();
        }
    }

    /**
     * @param {imports.gi.St.Bin} actor
     * @param {string} text
     * @returns {void}
     */
    _showTooltip(actor, text) {
        this._hideTooltip();

        this._tooltip = new St.Label({
            text: text,
            style: 'background-color: rgba(20, 20, 20, 0.9);'
                 + 'color: #e0e0e0; font-size: 14px;'
                 + 'padding: 4px 8px; border-radius: 4px;',
        });
        Main.layoutManager.addChrome(this._tooltip, {
            affectsInputRegion: false,
            affectsStruts: false,
        });

        // Position above the dot, centered horizontally
        let [actorX, actorY] = /** @type {[number, number]} */ (actor.get_transformed_position());
        let actorW = actor.get_width();
        // Force allocation so we can measure
        this._tooltip.get_allocation_box();
        let tipW = this._tooltip.get_width();
        let tipH = this._tooltip.get_height();

        this._tooltip.set_position(
            Math.round(actorX + actorW / 2 - tipW / 2),
            Math.round(actorY - tipH - 4)
        );
    }

    /** @returns {void} */
    _hideTooltip() {
        if (this._tooltip) {
            Main.layoutManager.removeChrome(this._tooltip);
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }

    /** @returns {void} */
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

    /** @returns {void} */
    _stopPulseTimer() {
        if (this._pulseTimerId) {
            Mainloop.source_remove(this._pulseTimerId);
            this._pulseTimerId = null;
        }
    }

    /**
     * @param {string} sessionId
     * @returns {void}
     */
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
            if (ok && stdinFd !== null && stdinFd !== -1) {
                let stdinStream = new Gio.UnixOutputStream({ fd: stdinFd, close_fd: true });
                stdinStream.write_all(/** @type {any} */ (new TextEncoder().encode(payload)), null);
                stdinStream.close(null);
            }
            if (pid !== null) {
                GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
                    GLib.spawn_close_pid(/** @type {number} */ (pid));
                });
            }
        } catch (e) {
            global.logError(`Claude Sessions: failed to focus session: ${e instanceof Error ? e.message : e}`);
        }
    }


    /**
     * @param {string} [status]
     * @returns {string}
     */
    _statusIcon(status) {
        if (status === 'permission') return '\u26a0\ufe0f';
        if (status === 'idle') return '\u23f8\ufe0f';
        return '';
    }
}

/**
 * @param {object} metadata
 * @returns {void}
 */
function init(metadata) {
    _instance = new ClaudeSessionsExtension(metadata);
}

/** @returns {void} */
function enable() {
    if (_instance) _instance.enable();
}

/** @returns {void} */
function disable() {
    if (_instance) _instance.disable();
}
