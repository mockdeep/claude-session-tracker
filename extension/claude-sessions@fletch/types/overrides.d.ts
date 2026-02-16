// Type overrides for gaps in @ci-types/cjs

// LayoutManager inherits signal methods from GObject but the types don't expose them
declare namespace imports.ui.layout {
    interface LayoutManager {
        connect(signal: string, callback: (...args: any[]) => void): number;
        disconnect(id: number): void;
    }
}

// Additional known gaps handled via inline casts in extension.js:
// - Mainloop.timeout_add_seconds returns void in types but actually returns a timer ID (number)
// - GLib.Error.matches() first arg is a Quark (number) but Gio.IOErrorEnum is typed as an enum
// - Gio.OutputStream.write_all() expects number[] but GJS accepts Uint8Array at runtime
// - Clutter.Actor.get_transformed_position() can return nulls but is safe when actor is allocated
