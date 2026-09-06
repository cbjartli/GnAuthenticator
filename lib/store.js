/* Account metadata + secret storage.
 *
 * Non-secret metadata (id, label, issuer, digits, algorithm, period, order)
 * lives in a small JSON file under the extension's user data directory.
 * The actual TOTP shared secret is stored in the user's keyring via
 * libsecret, keyed by account id, and is never written to disk in plain
 * text ourselves.
 */
'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.gnauthenticator.Account',
    Secret.SchemaFlags.NONE,
    { 'account-id': Secret.SchemaAttributeType.STRING }
);

function dataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnauthenticator']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function metadataFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([dataDir(), 'accounts.json']));
}

function loadMetadata() {
    const file = metadataFile();
    try {
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return [];
        const text = new TextDecoder().decode(contents);
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

function saveMetadata(list) {
    const file = metadataFile();
    const text = JSON.stringify(list, null, 2);
    file.replace_contents(
        new TextEncoder().encode(text),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
    );
}

function genId() {
    return GLib.uuid_string_random();
}

/**
 * @typedef {object} AccountMeta
 * @property {string} id
 * @property {string} label - account/username, e.g. "alice@example.com"
 * @property {string} issuer - service name, e.g. "GitHub"
 * @property {number} digits
 * @property {string} algorithm - SHA1|SHA256|SHA512
 * @property {number} period - seconds
 */

/** List account metadata in the user's configured display order. */
export function listAccounts() {
    return loadMetadata();
}

/**
 * Add a new account. Stores `secretBase32` in the keyring and metadata on
 * disk. Returns the created account's metadata (including generated id).
 */
export function addAccount({ label, issuer = '', digits = 6, algorithm = 'SHA1', period = 30 }, secretBase32) {
    const id = genId();
    const meta = { id, label, issuer, digits, algorithm, period };

    Secret.password_store_sync(
        SCHEMA,
        { 'account-id': id },
        Secret.COLLECTION_DEFAULT,
        `GNAuthenticator: ${issuer ? `${issuer} (${label})` : label}`,
        secretBase32,
        null
    );

    const list = loadMetadata();
    list.push(meta);
    saveMetadata(list);
    return meta;
}

/** Update mutable metadata fields (label/issuer/digits/algorithm/period) for an existing account. */
export function updateAccount(id, patch) {
    const list = loadMetadata();
    const idx = list.findIndex(a => a.id === id);
    if (idx === -1)
        throw new Error(`Unknown account id: ${id}`);
    list[idx] = { ...list[idx], ...patch, id };
    saveMetadata(list);
    return list[idx];
}

/** Remove an account's metadata and its secret from the keyring. */
export function removeAccount(id) {
    const list = loadMetadata().filter(a => a.id !== id);
    saveMetadata(list);
    Secret.password_clear_sync(SCHEMA, { 'account-id': id }, null);
}

/** Persist a manual display order (array of account ids). Unknown/missing ids are appended/ignored gracefully. */
export function reorderAccounts(orderedIds) {
    const list = loadMetadata();
    const byId = new Map(list.map(a => [a.id, a]));
    const reordered = [];
    for (const id of orderedIds) {
        if (byId.has(id)) {
            reordered.push(byId.get(id));
            byId.delete(id);
        }
    }
    // Append any accounts not mentioned (e.g. newly added) at the end.
    reordered.push(...byId.values());
    saveMetadata(reordered);
}

/** Fetch the base32 secret for an account id from the keyring. Returns null if not found. */
export function getSecret(id) {
    return Secret.password_lookup_sync(SCHEMA, { 'account-id': id }, null);
}
