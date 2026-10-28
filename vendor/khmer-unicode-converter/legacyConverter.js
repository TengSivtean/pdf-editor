/**
 * Visual-order Unicode -> legacy bytes (second stage of Unicode->legacy).
 *
 * Port of modules/legacyConverter.py (Khmer Software Initiative, GPL-2.0-or-later).
 * The output is a cp1252 "byte string" (JS string, every code unit <= 0xFF).
 */
/**
 * Convert a reordered (visual-order) Unicode string to a legacy byte string.
 * Longest dictionary match wins, then the codepoint table; ASCII passes
 * through; unknown codepoints are dropped.
 */
export function converter(sin, data) {
    const { dicts, table } = data;
    let sout = '';
    const listLength = table.length;
    let i = 0;
    const end = sin.length;
    while (i < end) {
        let matched = false;
        for (let j = dicts.length - 1; j >= 0; j--) {
            const bucket = dicts[j];
            if (bucket === null)
                continue;
            const replacement = bucket.get(sin.slice(i, i + j + 1));
            if (replacement !== undefined) {
                sout += replacement;
                i += j + 1;
                matched = true;
                break;
            }
        }
        if (!matched) {
            const c = sin.charCodeAt(i);
            const n = c - 0x1780;
            if (n >= 0 && n < listLength) {
                sout += table[n];
            }
            else if (c < 0x7f) {
                // keep ascii characters
                sout += sin[i];
            }
            i += 1;
        }
    }
    return sout;
}
