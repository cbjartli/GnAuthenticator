/* Import support for Google Authenticator's "Export accounts" QR/URI format.
 *
 * Google Authenticator's batch export encodes every selected account into a
 * single protobuf message (`MigrationPayload`, reverse-engineered — Google
 * has never published this schema, but it is stable and well documented by
 * several independent open-source projects, e.g. Aegis and
 * google-authenticator-exporter), base64-encodes it, and embeds it as the
 * `data` query parameter of a `otpauth-migration://offline?data=...` URI
 * (this is what the QR code Google Authenticator shows on "Export accounts"
 * actually contains).
 *
 * Schema (proto3):
 *   message MigrationPayload {
 *     message OtpParameters {
 *       bytes secret = 1;
 *       string name = 2;
 *       string issuer = 3;
 *       Algorithm algorithm = 4;  // 1=SHA1 2=SHA256 3=SHA512 4=MD5
 *       DigitCount digits = 5;    // 1=6 digits, 2=8 digits
 *       OtpType type = 6;         // 1=HOTP, 2=TOTP
 *       int64 counter = 7;
 *     }
 *     repeated OtpParameters otp_parameters = 1;
 *     int32 version = 2;
 *     int32 batch_size = 3;
 *     int32 batch_index = 4;
 *     int32 batch_id = 5;
 *   }
 *
 * We only need a tiny read-only subset of the protobuf wire format (varints
 * and length-delimited fields), so this implements just enough of it by
 * hand rather than pulling in a full protobuf library/codegen toolchain.
 */
'use strict';

import GLib from 'gi://GLib';

import { base32Encode } from './base32.js';

const ALGORITHM_BY_CODE = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const DIGITS_BY_CODE = { 0: 6, 1: 6, 2: 8 };
const TYPE_BY_CODE = { 1: 'hotp', 2: 'totp' };

/** Minimal protobuf wire-format reader (varints + length-delimited fields only). */
class ProtoReader {
    constructor(bytes) {
        this._bytes = bytes;
        this._pos = 0;
    }

    get atEnd() {
        return this._pos >= this._bytes.length;
    }

    _readByte() {
        if (this._pos >= this._bytes.length)
            throw new Error('Unexpected end of protobuf data');
        return this._bytes[this._pos++];
    }

    readVarint() {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = this._readByte();
            result += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0)
                break;
            shift += 7;
            if (shift > 63)
                throw new Error('Protobuf varint too long');
        }
        return result;
    }

    readBytes(length) {
        if (this._pos + length > this._bytes.length)
            throw new Error('Unexpected end of protobuf data');
        const slice = this._bytes.slice(this._pos, this._pos + length);
        this._pos += length;
        return slice;
    }

    readLengthDelimited() {
        return this.readBytes(this.readVarint());
    }
}

/**
 * Decode one flat protobuf message into a Map of field number -> array of
 * raw values (varints as numbers, wire-type-2 fields as Uint8Array). Only
 * wire types 0 (varint) and 2 (length-delimited) are supported, which is all
 * this schema uses; fixed 32/64-bit fields are read-but-skipped defensively
 * in case of unexpected input.
 */
function decodeMessage(bytes) {
    const reader = new ProtoReader(bytes);
    const fields = new Map();

    while (!reader.atEnd) {
        const tag = reader.readVarint();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;

        let value;
        switch (wireType) {
        case 0: // varint
            value = reader.readVarint();
            break;
        case 2: // length-delimited (bytes/string/embedded message)
            value = reader.readLengthDelimited();
            break;
        case 1: // 64-bit fixed
            value = reader.readBytes(8);
            break;
        case 5: // 32-bit fixed
            value = reader.readBytes(4);
            break;
        default:
            throw new Error(`Unsupported protobuf wire type: ${wireType}`);
        }

        if (!fields.has(fieldNumber))
            fields.set(fieldNumber, []);
        fields.get(fieldNumber).push(value);
    }

    return fields;
}

function utf8(bytes) {
    return new TextDecoder().decode(bytes);
}

/** Decode a single OtpParameters submessage into our internal account shape. */
function decodeOtpParameters(bytes) {
    const fields = decodeMessage(bytes);

    const secretBytes = fields.get(1)?.[0];
    if (!secretBytes || !(secretBytes instanceof Uint8Array))
        throw new Error('Export entry is missing its secret');

    const name = fields.has(2) ? utf8(fields.get(2)[0]) : '';
    let issuer = fields.has(3) ? utf8(fields.get(3)[0]) : '';
    const algorithmCode = fields.has(4) ? fields.get(4)[0] : 1;
    const digitsCode = fields.has(5) ? fields.get(5)[0] : 1;
    const typeCode = fields.has(6) ? fields.get(6)[0] : 2;

    let label = name;
    // Google Authenticator itself sometimes only fills "name" as
    // "Issuer:account", leaving the separate issuer field empty.
    if (!issuer && label.includes(':')) {
        const idx = label.indexOf(':');
        issuer = label.slice(0, idx).trim();
        label = label.slice(idx + 1).trim();
    }

    return {
        label: label || issuer || 'Imported account',
        issuer,
        algorithm: ALGORITHM_BY_CODE[algorithmCode] ?? 'SHA1',
        digits: DIGITS_BY_CODE[digitsCode] ?? 6,
        // The migration format has no per-account period field; Google
        // Authenticator itself always uses the standard 30s TOTP step.
        period: 30,
        type: TYPE_BY_CODE[typeCode] ?? 'totp',
        secretBase32: base32Encode(secretBytes),
    };
}

/**
 * Decode a full `MigrationPayload` protobuf byte string into importable
 * accounts. Only TOTP entries with a supported HMAC algorithm are returned;
 * everything else is counted so the caller can inform the user.
 * @returns {{ accounts: Array<{meta: object, secretBase32: string}>, total: number, skippedHotp: number, skippedUnsupportedAlgorithm: number }}
 */
export function parseMigrationPayload(bytes) {
    const fields = decodeMessage(bytes);
    const entries = fields.get(1) ?? [];

    const accounts = [];
    let skippedHotp = 0;
    let skippedUnsupportedAlgorithm = 0;

    for (const entryBytes of entries) {
        const parsed = decodeOtpParameters(entryBytes);

        if (parsed.type !== 'totp') {
            skippedHotp++;
            continue;
        }
        if (parsed.algorithm === 'MD5') {
            skippedUnsupportedAlgorithm++;
            continue;
        }

        const { type: _type, secretBase32, ...meta } = parsed;
        accounts.push({ meta, secretBase32 });
    }

    return { accounts, total: entries.length, skippedHotp, skippedUnsupportedAlgorithm };
}

/**
 * Parse a Google Authenticator export URI
 * (`otpauth-migration://offline?data=BASE64PROTOBUF`) as produced by its
 * "Export accounts" QR code, into a batch of importable accounts.
 */
export function parseMigrationUri(uriString) {
    const trimmed = uriString.trim();
    const match = /^otpauth-migration:\/\/offline\/?(?:\?(.*))?$/.exec(trimmed);
    if (!match)
        throw new Error('Not a Google Authenticator export (otpauth-migration://) URI');

    const query = match[1] ?? '';
    let dataParam = null;
    for (const pair of query.split('&')) {
        if (!pair)
            continue;
        const [k, v] = pair.split('=');
        if (decodeURIComponent(k) === 'data') {
            dataParam = decodeURIComponent(v ?? '');
            break;
        }
    }
    if (!dataParam)
        throw new Error('Export URI is missing its "data" parameter');

    let bytes;
    try {
        bytes = GLib.base64_decode(dataParam);
    } catch (e) {
        throw new Error('Export URI\'s "data" parameter is not valid base64');
    }

    return parseMigrationPayload(bytes);
}

/** True if the given string looks like a Google Authenticator export URI (vs. a plain otpauth:// URI). */
export function isMigrationUri(uriString) {
    return /^otpauth-migration:\/\//.test(uriString.trim());
}
