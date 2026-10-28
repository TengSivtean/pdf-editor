/**
 * Legacy-encoded bytes -> visual-order Unicode (first stage of legacy->Unicode).
 *
 * Port of modules/unicodeProcess.py (Khmer Software Initiative, GPL-2.0-or-later).
 * The input is a cp1252 "byte string" (JS string, every code unit <= 0xFF).
 */
/**
 * Convert a legacy byte string to (visual-order) Unicode: greedy match of
 * multi-byte combinations first, then the per-byte table; bytes beyond the
 * table pass through unchanged.
 */
export function process(sin, data) {
    const { dict, table } = data;
    let sout = '';
    const listLength = table.length;
    let i = 0;
    const end = sin.length;
    while (i < end) {
        let matched = false;
        for (const [key, value] of dict) {
            if (key === sin.slice(i, i + key.length)) {
                sout += value;
                i += key.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            const n = sin.charCodeAt(i);
            if (n < listLength) {
                sout += table[n];
            }
            else {
                sout += sin[i];
            }
            i += 1;
        }
    }
    return sout;
}
