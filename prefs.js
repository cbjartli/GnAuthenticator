/* GNAuthenticator preferences window: manage accounts and app settings. */
'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Store from './lib/store.js';
import * as Otpauth from './lib/otpauth.js';
import * as Qr from './lib/qr.js';
import * as GoogleMigration from './lib/googleMigration.js';
import { base32Decode } from './lib/base32.js';

/**
 * Parse either a single-account `otpauth://` URI or a Google Authenticator
 * batch-export `otpauth-migration://offline?data=...` URI into a uniform
 * batch shape, so callers don't need to care which one they got.
 * @returns {{ accounts: Array<{meta: object, secretBase32: string}>, total: number, skippedHotp: number, skippedUnsupportedAlgorithm: number }}
 */
function parseAnyOtpUri(uriText) {
    if (GoogleMigration.isMigrationUri(uriText))
        return GoogleMigration.parseMigrationUri(uriText);

    const { meta, secretBase32 } = Otpauth.parseOtpauthUri(uriText);
    return { accounts: [{ meta, secretBase32 }], total: 1, skippedHotp: 0, skippedUnsupportedAlgorithm: 0 };
}

/** Dialog for adding a new account via manual entry, otpauth:// URI, or a QR code image file. */
const AddAccountDialog = GObject.registerClass(
class AddAccountDialog extends Adw.Window {
    _init(parentWindow, onAdded) {
        super._init({
            modal: true,
            transient_for: parentWindow,
            // Deliberately no default_width/height: leaving these unset lets
            // GTK size the window to the natural (unscrolled) size of its
            // content. Adw.ViewStack is size-homogeneous by default, so the
            // window sizes to fit the *tallest* tab (currently "Manual") and
            // won't need to scroll or resize when switching tabs.
            title: _('Add Account'),
        });
        this._onAdded = onAdded;

        const toolbarView = new Adw.ToolbarView();
        this.set_content(toolbarView);
        const header = new Adw.HeaderBar();
        toolbarView.add_top_bar(header);

        this._stack = new Adw.ViewStack({ vexpand: true });
        const switcher = new Adw.ViewSwitcher({
            stack: this._stack,
            policy: Adw.ViewSwitcherPolicy.WIDE,
        });
        header.set_title_widget(switcher);

        this._stack.add_titled(this._buildManualPage(), 'manual', _('Manual'));
        this._stack.add_titled(this._buildUriPage(), 'uri', _('otpauth:// URI'));
        this._stack.add_titled(this._buildQrPage(), 'qr', _('QR Image'));

        toolbarView.set_content(this._stack);
    }

    _buildManualPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Account Details'),
            description: _('Enter the shared secret provided by the service (usually shown as text under its QR code).'),
        });
        page.add(group);

        this._issuerRow = new Adw.EntryRow({ title: _('Service (issuer)') });
        this._labelRow = new Adw.EntryRow({ title: _('Account / username') });
        this._secretRow = new Adw.EntryRow({ title: _('Secret key (base32)') });
        this._digitsRow = new Adw.SpinRow({
            title: _('Digits'),
            adjustment: new Gtk.Adjustment({ lower: 6, upper: 8, step_increment: 1, value: 6 }),
        });
        this._periodRow = new Adw.SpinRow({
            title: _('Period (seconds)'),
            adjustment: new Gtk.Adjustment({ lower: 15, upper: 120, step_increment: 5, value: 30 }),
        });
        this._algoRow = new Adw.ComboRow({
            title: _('Algorithm'),
            model: Gtk.StringList.new(['SHA1', 'SHA256', 'SHA512']),
        });

        group.add(this._issuerRow);
        group.add(this._labelRow);
        group.add(this._secretRow);
        group.add(this._digitsRow);
        group.add(this._periodRow);
        group.add(this._algoRow);

        const addButton = new Gtk.Button({
            label: _('Add Account'),
            css_classes: ['suggested-action'],
            halign: Gtk.Align.END,
            margin_top: 12,
        });
        addButton.connect('clicked', () => this._submitManual());
        group.add(addButton);

        return page;
    }

    _submitManual() {
        const label = this._labelRow.get_text().trim();
        const issuer = this._issuerRow.get_text().trim();
        const secretBase32 = this._secretRow.get_text().trim().replace(/\s/g, '');
        const digits = this._digitsRow.get_value();
        const period = this._periodRow.get_value();
        const algorithm = ['SHA1', 'SHA256', 'SHA512'][this._algoRow.get_selected()];

        if (!label || !secretBase32) {
            this._showError(_('Account and secret key are required.'));
            return;
        }
        try {
            base32Decode(secretBase32); // validate
        } catch (e) {
            this._showError(_('Secret key is not valid base32.'));
            return;
        }

        const meta = Store.addAccount({ label, issuer, digits, algorithm, period }, secretBase32);
        this._onAdded(meta);
        this.close();
    }

    _buildUriPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('otpauth:// URI'),
            description: _('Paste a full otpauth://totp/... URI (e.g. exported from another authenticator app), or a Google Authenticator batch export URI (otpauth-migration://offline?data=...) to import multiple accounts at once.'),
        });
        page.add(group);

        this._uriRow = new Adw.EntryRow({ title: _('URI') });
        group.add(this._uriRow);

        const button = new Gtk.Button({
            label: _('Add Account(s)'),
            css_classes: ['suggested-action'],
            halign: Gtk.Align.END,
            margin_top: 12,
        });
        button.connect('clicked', () => {
            try {
                const batch = parseAnyOtpUri(this._uriRow.get_text().trim());
                this._importBatch(batch);
            } catch (e) {
                this._showError(e.message);
            }
        });
        group.add(button);

        return page;
    }

    _buildQrPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('QR Code Image'),
            description: _('Pick one or more image files (screenshots or exported PNGs) containing otpauth QR codes — including Google Authenticator\'s "Export accounts" batch QR codes (select all of them at once if it split your accounts across several). Requires the "zbar" package.'),
        });
        page.add(group);

        const pickButton = new Gtk.Button({
            label: _('Choose Image(s)…'),
            halign: Gtk.Align.START,
        });
        group.add(pickButton);

        pickButton.connect('clicked', () => {
            const chooser = new Gtk.FileDialog({ title: _('Select QR Code Image(s)') });
            chooser.open_multiple(this, null, (dlg, res) => {
                let files;
                try {
                    const model = dlg.open_multiple_finish(res);
                    files = [];
                    for (let i = 0; i < model.get_n_items(); i++)
                        files.push(model.get_item(i));
                } catch (e) {
                    return; // cancelled
                }
                if (files.length === 0)
                    return;

                Promise.all(files.map(file => Qr.decodeQrFromFile(file.get_path())))
                    .then(uriTexts => {
                        // Merge every scanned QR code's accounts into one batch —
                        // this transparently supports Google Authenticator
                        // splitting a large export across multiple QR codes,
                        // since we don't need their batch bookkeeping fields,
                        // just the union of all otp_parameters entries.
                        const merged = { accounts: [], total: 0, skippedHotp: 0, skippedUnsupportedAlgorithm: 0 };
                        for (const uriText of uriTexts) {
                            const batch = parseAnyOtpUri(uriText);
                            merged.accounts.push(...batch.accounts);
                            merged.total += batch.total;
                            merged.skippedHotp += batch.skippedHotp;
                            merged.skippedUnsupportedAlgorithm += batch.skippedUnsupportedAlgorithm;
                        }
                        this._importBatch(merged);
                    })
                    .catch(e => this._showError(e.message));
            });
        });

        return page;
    }

    /** Add every account in a parsed batch (single or multi-account), then report a summary and close. */
    _importBatch({ accounts, total, skippedHotp, skippedUnsupportedAlgorithm }) {
        if (accounts.length === 0 && total === 0) {
            this._showError(_('No accounts found in that URI.'));
            return;
        }

        let lastAdded = null;
        for (const { meta, secretBase32 } of accounts)
            lastAdded = Store.addAccount(meta, secretBase32);

        this._onAdded(lastAdded);

        const skippedParts = [];
        if (skippedHotp > 0)
            skippedParts.push(_('%d event-based (HOTP) account(s) — not supported').format(skippedHotp));
        if (skippedUnsupportedAlgorithm > 0)
            skippedParts.push(_('%d account(s) using an unsupported algorithm (MD5)').format(skippedUnsupportedAlgorithm));

        if (accounts.length > 1 || skippedParts.length > 0) {
            const lines = [_('Added %d account(s).').format(accounts.length)];
            if (skippedParts.length > 0)
                lines.push(_('Skipped: %s.').format(skippedParts.join(', ')));
            this._showInfo(lines.join(' '));
        }

        this.close();
    }

    _showInfo(message) {
        const dialog = new Adw.AlertDialog({ heading: _('Import Complete'), body: message });
        dialog.add_response('ok', _('OK'));
        dialog.present(this);
    }

    _showError(message) {
        const dialog = new Adw.AlertDialog({ heading: _('Error'), body: message });
        dialog.add_response('ok', _('OK'));
        dialog.present(this);
    }
});

const AccountsPage = GObject.registerClass(
class AccountsPage extends Adw.PreferencesPage {
    _init() {
        super._init({ title: _('Accounts'), icon_name: 'dialog-password-symbolic' });

        this._group = new Adw.PreferencesGroup({ title: _('Registered Accounts') });
        this.add(this._group);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['flat'],
        });
        addButton.connect('clicked', () => this._openAddDialog());
        this._group.set_header_suffix(addButton);

        this._refresh();
    }

    _openAddDialog() {
        const root = this.get_root();
        const dialog = new AddAccountDialog(root, () => this._refresh());
        dialog.present();
    }

    _refresh() {
        for (const row of [...this._rows ?? []])
            this._group.remove(row);

        const accounts = Store.listAccounts();
        this._rows = [];

        accounts.forEach(account => {
            const row = new Adw.ActionRow({
                title: account.issuer ? `${account.issuer}` : account.label,
                subtitle: account.issuer ? account.label : `${account.digits} digits · ${account.period}s`,
            });

            const handle = new Gtk.Image({
                icon_name: 'list-drag-handle-symbolic',
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
            });
            handle.set_cursor(Gdk.Cursor.new_from_name('grab', null));

            const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
            dragSource.connect('prepare', () => {
                const value = new GObject.Value();
                value.init(GObject.TYPE_STRING);
                value.set_string(account.id);
                return Gdk.ContentProvider.new_for_value(value);
            });
            dragSource.connect('drag-begin', (source, drag) => {
                row.add_css_class('gnauth-dragging');
                source.set_icon(Gtk.WidgetPaintable.new(row), 0, 0);
            });
            dragSource.connect('drag-end', () => row.remove_css_class('gnauth-dragging'));
            handle.add_controller(dragSource);

            const dropTarget = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
            dropTarget.set_gtypes([GObject.TYPE_STRING]);
            dropTarget.connect('enter', () => {
                row.add_css_class('gnauth-drop-target');
                return Gdk.DragAction.MOVE;
            });
            dropTarget.connect('leave', () => row.remove_css_class('gnauth-drop-target'));
            dropTarget.connect('drop', (_target, draggedId, _x, y) => {
                row.remove_css_class('gnauth-drop-target');
                if (draggedId === account.id)
                    return false;
                const before = y < row.get_height() / 2;
                this._reorderByDrag(draggedId, account.id, before);
                return true;
            });
            row.add_controller(dropTarget);

            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat', 'error'],
                valign: Gtk.Align.CENTER,
            });
            removeButton.connect('clicked', () => this._confirmRemove(account));

            row.add_prefix(handle);
            row.add_suffix(removeButton);

            this._group.add(row);
            this._rows.push(row);
        });
    }

    /** Move `draggedId` to just before (or after) `targetId` in the account order. */
    _reorderByDrag(draggedId, targetId, before) {
        const accounts = Store.listAccounts();
        const ids = accounts.map(a => a.id).filter(id => id !== draggedId);
        const targetIdx = ids.indexOf(targetId);
        const insertIdx = before ? targetIdx : targetIdx + 1;
        ids.splice(insertIdx, 0, draggedId);
        Store.reorderAccounts(ids);
        this._refresh();
    }

    _confirmRemove(account) {
        const dialog = new Adw.AlertDialog({
            heading: _('Remove Account?'),
            body: _('This will permanently delete the stored secret for "%s".').format(account.issuer || account.label),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('remove', _('Remove'));
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'remove') {
                Store.removeAccount(account.id);
                this._refresh();
            }
        });
        dialog.present(this.get_root());
    }
});

/** Small modal dialog that captures a single key combination for a keybinding, GNOME Settings-style. */
const ShortcutCaptureDialog = GObject.registerClass(
class ShortcutCaptureDialog extends Adw.Window {
    _init(parentWindow, onCaptured) {
        super._init({
            modal: true,
            transient_for: parentWindow,
            title: _('Set Shortcut'),
            default_width: 380,
        });
        this._onCaptured = onCaptured;

        const toolbarView = new Adw.ToolbarView();
        this.set_content(toolbarView);
        toolbarView.add_top_bar(new Adw.HeaderBar({ show_title: true }));

        const label = new Gtk.Label({
            label: _('Enter a new shortcut, or press Escape to cancel'),
            margin_top: 36,
            margin_bottom: 36,
            margin_start: 24,
            margin_end: 24,
            wrap: true,
        });
        toolbarView.set_content(label);

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            // Only the modifiers relevant to accelerators, matching how GNOME
            // Settings' own shortcut editor filters the raw event state.
            const mods = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && mods === 0) {
                this.close();
                return true;
            }

            if (!Gtk.accelerator_valid(keyval, mods))
                return true; // bare modifier press (e.g. Shift) — keep listening

            const accel = Gtk.accelerator_name(keyval, mods);
            this._onCaptured(accel);
            this.close();
            return true;
        });
        this.add_controller(keyController);
    }
});

const GeneralPage = GObject.registerClass(
class GeneralPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({ title: _('General'), icon_name: 'preferences-system-symbolic' });
        this._settings = settings;

        const group = new Adw.PreferencesGroup({ title: _('Behavior') });
        this.add(group);

        const clearRow = new Adw.SpinRow({
            title: _('Clear clipboard after (seconds)'),
            subtitle: _('0 disables auto-clear'),
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 120, step_increment: 5, value: settings.get_int('clear-clipboard-seconds') }),
        });
        clearRow.connect('notify::value', () => {
            settings.set_int('clear-clipboard-seconds', clearRow.get_value());
        });
        group.add(clearRow);

        const shortcutGroup = new Adw.PreferencesGroup({ title: _('Keyboard Shortcut') });
        this.add(shortcutGroup);

        this._shortcutRow = new Adw.ActionRow({
            title: _('Toggle overlay'),
            subtitle: _('Opens or closes the account list from anywhere'),
        });

        this._shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this._shortcutRow.add_suffix(this._shortcutLabel);

        const setButton = new Gtk.Button({
            label: _('Set Shortcut…'),
            valign: Gtk.Align.CENTER,
        });
        setButton.connect('clicked', () => this._captureShortcut());
        this._shortcutRow.add_suffix(setButton);

        this._clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Disable shortcut'),
        });
        this._clearButton.connect('clicked', () => this._settings.set_strv('toggle-overlay', []));
        this._shortcutRow.add_suffix(this._clearButton);

        shortcutGroup.add(this._shortcutRow);

        this._settings.connect('changed::toggle-overlay', () => this._syncShortcutDisplay());
        this._syncShortcutDisplay();
    }

    _syncShortcutDisplay() {
        const bindings = this._settings.get_strv('toggle-overlay');
        this._shortcutLabel.accelerator = bindings[0] ?? '';
        this._clearButton.sensitive = bindings.length > 0;
    }

    _captureShortcut() {
        const dialog = new ShortcutCaptureDialog(this.get_root(), accel => {
            this._settings.set_strv('toggle-overlay', [accel]);
        });
        dialog.present();
    }
});

export default class GnAuthenticatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const cssProvider = new Gtk.CssProvider();
        cssProvider.load_from_string(`
            .gnauth-dragging { opacity: 0.5; }
            .gnauth-drop-target { box-shadow: inset 0 2px 0 0 @accent_color, inset 0 -2px 0 0 @accent_color; }
        `);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const settings = this.getSettings();
        const accountsPage = new AccountsPage();
        window.add(accountsPage);
        window.add(new GeneralPage(settings));
        window.set_default_size(560, 640);

        // The panel indicator's "+" button can't pass arguments directly to
        // this separately-spawned prefs process (OpenExtensionPrefs only
        // supports a "modal" option), so it sets this flag instead and we
        // pick it up here to jump straight to the add-account dialog.
        if (settings.get_boolean('request-add-account')) {
            settings.set_boolean('request-add-account', false);
            window.set_visible_page(accountsPage);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                accountsPage._openAddDialog();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
