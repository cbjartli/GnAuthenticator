/* Decode otpauth:// URIs from a QR code image file using the `zbarimg`
 * command-line tool (part of the zbar package). This keeps the extension
 * free of native/binary GI dependencies for QR decoding.
 */
'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Decode the first QR code found in an image file and return its raw text
 * content (expected to be an otpauth:// URI).
 * @param {string} filePath - absolute path to a PNG/JPEG screenshot or QR image
 * @returns {Promise<string>}
 */
export function decodeQrFromFile(filePath) {
    return new Promise((resolve, reject) => {
        let argv;
        try {
            argv = ['zbarimg', '--quiet', '--raw', filePath];
            const [, pid, stdinFd, stdoutFd, stderrFd] = GLib.spawn_async_with_pipes(
                null, argv, null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            GLib.close(stdinFd);

            const stdoutStream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: stdoutFd, close_fd: true }),
            });
            const stderrStream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: stderrFd, close_fd: true }),
            });

            let out = '';
            let err = '';

            const readAll = (stream) => {
                let result = '';
                let line;
                for (;;) {
                    [line] = stream.read_line_utf8(null);
                    if (line === null)
                        break;
                    result += `${line}\n`;
                }
                return result;
            };

            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (_pid, status) => {
                out = readAll(stdoutStream);
                err = readAll(stderrStream);
                GLib.spawn_close_pid(pid);

                if (status !== 0) {
                    reject(new Error(err.trim() || 'zbarimg failed to detect a QR code in the image'));
                    return;
                }
                const text = out.trim();
                if (!text) {
                    reject(new Error('No QR code found in the image'));
                    return;
                }
                resolve(text);
            });
        } catch (e) {
            if (e instanceof GLib.SpawnError && e.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
                reject(new Error('zbarimg is not installed (package "zbar"); use manual entry or an otpauth:// URI instead'));
                return;
            }
            reject(e);
        }
    });
}
