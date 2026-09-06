/* Base32 (RFC 4648) decode/encode helpers, used for TOTP secrets. */
'use strict';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32 string (case-insensitive, padding/spaces tolerant) into a
 * byte array (Uint8Array). Throws on invalid characters.
 */
export function base32Decode(input) {
    const clean = input.toUpperCase().replace(/[\s=]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];

    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1)
            throw new Error(`Invalid base32 character: ${ch}`);

        value = (value << 5) | idx;
        bits += 5;

        if (bits >= 8) {
            bits -= 8;
            bytes.push((value >> bits) & 0xff);
        }
    }

    return new Uint8Array(bytes);
}

/** Encode a byte array into a base32 string (no padding). */
export function base32Encode(bytes) {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            bits -= 5;
            output += ALPHABET[(value >> bits) & 31];
        }
    }

    if (bits > 0)
        output += ALPHABET[(value << (5 - bits)) & 31];

    return output;
}
