/* GNAuthenticator — GNOME Shell extension.
 * Top-panel indicator + popup overlay that lists all registered TOTP
 * accounts with live-updating codes; clicking an entry copies its current
 * code to the clipboard.
 */
'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Store from './lib/store.js';
import * as Totp from './lib/totp.js';
import { base32Decode } from './lib/base32.js';

const KEYBINDING_NAME = 'toggle-overlay';

/** A single account row: name/issuer, live code, and a countdown bar. */
const AccountItem = GObject.registerClass(
class AccountItem extends PopupMenu.PopupBaseMenuItem {
    _init(account, onActivate) {
        super._init({ style_class: 'gnauth-item' });
        this._account = account;
        this._onActivateCb = onActivate;

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'gnauth-item-text',
        });
        this._titleLabel = new St.Label({
            text: account.issuer ? `${account.issuer}` : account.label,
            style_class: 'gnauth-item-title',
        });
        this._subtitleLabel = new St.Label({
            text: account.issuer ? account.label : '',
            style_class: 'gnauth-item-subtitle',
            visible: !!account.issuer,
        });
        textBox.add_child(this._titleLabel);
        if (account.issuer)
            textBox.add_child(this._subtitleLabel);

        this._codeLabel = new St.Label({
            text: '------',
            style_class: 'gnauth-item-code',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._progress = new St.Widget({
            style_class: 'gnauth-progress-track',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressFill = new St.Widget({ style_class: 'gnauth-progress-fill' });
        this._progress.add_child(this._progressFill);

        this.add_child(textBox);
        this.add_child(this._codeLabel);
        this.add_child(this._progress);

        this.connect('activate', () => this._onActivateCb(this._account, this._lastCode));
    }

    /** Recompute and display the current code + countdown for this account. */
    update() {
        const secret = Store.getSecret(this._account.id);
        if (!secret) {
            this._codeLabel.set_text('??????');
            return;
        }
        const keyBytes = base32Decode(secret);
        const code = Totp.totp(keyBytes, {
            digits: this._account.digits,
            algorithm: this._account.algorithm,
            period: this._account.period,
        });
        this._lastCode = code;
        this._codeLabel.set_text(code.match(/.{1,3}/g).join(' '));

        const remaining = Totp.secondsRemaining(this._account.period);
        const fraction = remaining / this._account.period;
        this._progress.width = 36;
        this._progressFill.width = Math.max(2, Math.round(36 * fraction));
        if (fraction <= 0.2)
            this._progressFill.add_style_class_name('gnauth-progress-fill-warn');
        else
            this._progressFill.remove_style_class_name('gnauth-progress-fill-warn');
    }

    setVisibleForQuery(query) {
        if (!query) {
            this.actor ? (this.actor.visible = true) : (this.visible = true);
            return;
        }
        const haystack = `${this._account.issuer} ${this._account.label}`.toLowerCase();
        const match = haystack.includes(query.toLowerCase());
        this.visible = match;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'GNAuthenticator');
        this._extensionObject = extensionObject;
        this._settings = extensionObject.getSettings();

        const icon = new St.Icon({
            icon_name: 'dialog-password-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(icon);

        this._items = [];
        this._tickId = null;
        this._clearClipboardId = null;

        // A small separate context menu for right-click, in line with the
        // conventional panel-icon UX (left click = primary action/overlay,
        // right click = a menu with "Settings" etc. — as seen on system tray
        // icons and other GNOME Shell extensions).
        this._contextMenu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
        this._contextMenu.addAction(_('Settings'), () => this._extensionObject.openPreferences());
        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();
        Main.panel.menuManager.addMenu(this._contextMenu);

        // The base PanelMenu.Button click gesture toggles the menu for any
        // mouse button. Replace it with our own gesture so a right-click
        // opens the context menu above instead of the accounts overlay.
        this._clickGesture.set_enabled(false);
        this._rightClickGesture = new Clutter.ClickGesture();
        this._rightClickGesture.set_recognize_on_press(true);
        this._rightClickGesture.connect('recognize', gesture => {
            if (gesture.get_button() === Clutter.BUTTON_SECONDARY)
                this._contextMenu.toggle();
            else
                this.menu.toggle();
        });
        this.add_action(this._rightClickGesture);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._onOpen();
            else
                this._onClose();
        });

        // PopupMenu.open() refuses to open an empty menu (see popupMenu.js),
        // and content is normally (re)built from the 'open-state-changed'
        // handler above — which never fires if the menu starts out empty.
        // Build it once up front so the very first click can actually open it.
        this._buildMenu();
    }

    _onOpen() {
        this._buildMenu();
        this._tick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onClose() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
    }

    _buildMenu() {
        this.menu.removeAll();
        this._items = [];

        const accounts = Store.listAccounts();

        if (accounts.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                _('No accounts yet — add one from Extension Settings'),
                { reactive: false, can_focus: false }
            );
            this.menu.addMenuItem(empty);
            return;
        }

        if (accounts.length > 5) {
            const searchItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'gnauth-search-item',
            });
            const entry = new St.Entry({
                hint_text: _('Search accounts…'),
                x_expand: true,
                can_focus: true,
            });
            entry.clutter_text.connect('text-changed', () => {
                const query = entry.get_text();
                for (const item of this._items)
                    item.setVisibleForQuery(query);
            });
            searchItem.add_child(entry);
            this.menu.addMenuItem(searchItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        for (const account of accounts) {
            const item = new AccountItem(account, (acct, code) => this._onCopy(acct, code));
            this.menu.addMenuItem(item);
            this._items.push(item);
        }
    }

    _tick() {
        for (const item of this._items)
            item.update();
    }

    _onCopy(account, code) {
        if (!code)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, code.replace(/\s/g, ''));
        Main.notify(_('GNAuthenticator'), _('Copied code for %s').format(account.issuer || account.label));

        const clearSeconds = this._settings.get_int('clear-clipboard-seconds');
        if (this._clearClipboardId) {
            GLib.source_remove(this._clearClipboardId);
            this._clearClipboardId = null;
        }
        if (clearSeconds > 0) {
            this._clearClipboardId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, clearSeconds, () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
                this._clearClipboardId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        this.menu.close();
    }

    destroy() {
        this._onClose();
        if (this._clearClipboardId) {
            GLib.source_remove(this._clearClipboardId);
            this._clearClipboardId = null;
        }
        if (this._contextMenu) {
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
        super.destroy();
    }
});

export default class GnAuthentictorExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings = this.getSettings();
        Main.wm.addKeybinding(
            KEYBINDING_NAME,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator.menu.toggle()
        );
    }

    disable() {
        Main.wm.removeKeybinding(KEYBINDING_NAME);
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
