/* RFC 6238 TOTP (and RFC 4226 HOTP) implementation using GLib's HMAC. */
'use strict';

import GLib from 'gi://GLib';

const CHECKSUM_TYPES = {
    SHA1: GLib.ChecksumType.SHA1,
    SHA256: GLib.ChecksumType.SHA256,
    SHA512: GLib.ChecksumType.SHA512,
};

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

function intToBytes(num) {
    // 8-byte big-endian counter, as required by HOTP.
    const bytes = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
        bytes[i] = num & 0xff;
        num = Math.floor(num / 256);
    }
    return bytes;
}

/**
 * Compute an HOTP code for the given key bytes and counter.
 * @param {Uint8Array} keyBytes - decoded shared secret
 * @param {number} counter - moving factor (e.g. time step for TOTP)
 * @param {number} digits - number of output digits (usually 6 or 8)
 * @param {string} algorithm - one of 'SHA1', 'SHA256', 'SHA512'
 * @returns {string} zero-padded numeric code
 */
export function hotp(keyBytes, counter, digits = 6, algorithm = 'SHA1') {
    const checksumType = CHECKSUM_TYPES[algorithm] ?? CHECKSUM_TYPES.SHA1;
    const msgBytes = intToBytes(counter);
    const hex = GLib.compute_hmac_for_data(checksumType, keyBytes, msgBytes);
    const hmacBytes = hexToBytes(hex);

    const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
    const binCode =
        ((hmacBytes[offset] & 0x7f) << 24) |
        ((hmacBytes[offset + 1] & 0xff) << 16) |
        ((hmacBytes[offset + 2] & 0xff) << 8) |
        (hmacBytes[offset + 3] & 0xff);

    const code = (binCode % Math.pow(10, digits)).toString();
    return code.padStart(digits, '0');
}

/**
 * Compute the current TOTP code.
 * @param {Uint8Array} keyBytes - decoded shared secret
 * @param {object} [opts]
 * @param {number} [opts.digits=6]
 * @param {string} [opts.algorithm='SHA1']
 * @param {number} [opts.period=30] - seconds per time step
 * @param {number} [opts.timestamp] - unix seconds, defaults to now
 */
export function totp(keyBytes, { digits = 6, algorithm = 'SHA1', period = 30, timestamp } = {}) {
    const now = timestamp ?? Math.floor(GLib.get_real_time() / 1000000);
    const counter = Math.floor(now / period);
    return hotp(keyBytes, counter, digits, algorithm);
}

/** Seconds remaining in the current time step (0 < n <= period). */
export function secondsRemaining(period = 30, timestamp) {
    const now = timestamp ?? Math.floor(GLib.get_real_time() / 1000000);
    return period - (now % period);
}
