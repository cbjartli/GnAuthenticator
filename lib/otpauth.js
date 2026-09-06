/* Parsing helpers for otpauth:// URIs (Key URI Format used by Google
 * Authenticator and most other TOTP apps/exporters).
 * Format: otpauth://totp/LABEL?secret=BASE32&issuer=ISSUER&digits=6&period=30&algorithm=SHA1
 */
'use strict';

/**
 * Parse an otpauth:// URI into account fields + base32 secret.
 * Throws on malformed input or unsupported type (only 'totp' is supported).
 * @returns {{ meta: object, secretBase32: string }}
 */
export function parseOtpauthUri(uriString) {
    const uri = GLib_uri_parse(uriString);
    if (uri.scheme !== 'otpauth')
        throw new Error('Not an otpauth:// URI');
    if (uri.type !== 'totp')
        throw new Error(`Unsupported otpauth type: ${uri.type} (only 'totp' is supported)`);

    const params = uri.params;
    const secretBase32 = params.get('secret');
    if (!secretBase32)
        throw new Error('otpauth URI is missing the "secret" parameter');

    let label = decodeURIComponent(uri.label ?? '');
    let issuer = params.get('issuer') ?? '';

    // Label may be "Issuer:account" per spec; the prefix (if present) is only
    // ever used as a fallback issuer — the account label itself should always
    // have it stripped off for display.
    if (label.includes(':')) {
        const idx = label.indexOf(':');
        const prefix = label.slice(0, idx).trim();
        label = label.slice(idx + 1).trim();
        if (!issuer)
            issuer = prefix;
    }

    const digits = params.has('digits') ? parseInt(params.get('digits'), 10) : 6;
    const period = params.has('period') ? parseInt(params.get('period'), 10) : 30;
    const algorithm = (params.get('algorithm') ?? 'SHA1').toUpperCase();

    return {
        meta: { label, issuer, digits, algorithm, period },
        secretBase32,
    };
}

/** Minimal otpauth:// URI parser (avoids pulling in GLib.Uri for portability across GJS versions). */
function GLib_uri_parse(uriString) {
    const match = /^otpauth:\/\/([^/]+)\/([^?]*)(?:\?(.*))?$/.exec(uriString.trim());
    if (!match)
        throw new Error('Malformed otpauth:// URI');

    const [, type, rawLabel, query] = match;
    const params = new Map();
    if (query) {
        for (const pair of query.split('&')) {
            if (!pair)
                continue;
            const [k, v] = pair.split('=');
            params.set(decodeURIComponent(k), decodeURIComponent(v ?? ''));
        }
    }

    return { scheme: 'otpauth', type, label: rawLabel, params };
}
