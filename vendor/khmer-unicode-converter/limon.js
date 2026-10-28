/**
 * Backwards-compatible `limon()` API from khmer-unicode-converter <= 0.0.8.
 *
 * Converts Khmer Unicode to the Limon legacy encoding, with the small
 * behavioral fixes the original JS package applied on top of the
 * KhmerConverter font data:
 *   - `,` is kept as-is (the font data would map it to `/`)
 *   - `៕` maps to `>` (the Limon layout position)
 *   - standalone `ឲ` behaves like `ឱ` (both render as `»`; the ligatures
 *     `ឲ្យ`/`ឱ្យ` both render as `[`)
 */
import { convertUnicodeToLegacy } from './index.js';
const PASSTHROUGH = {
    ',': ',',
    '៕': '>',
};
/**
 * Convert Khmer Unicode text to Limon encoding.
 * @param text Unicode text
 */
export function limon(text) {
    const normalized = text.replace(/ឲ(?!្យ)/g, 'ឱ');
    let out = '';
    let run = '';
    for (const ch of normalized) {
        const mapped = PASSTHROUGH[ch];
        if (mapped !== undefined) {
            out += convertUnicodeToLegacy(run, 'limon') + mapped;
            run = '';
        }
        else {
            run += ch;
        }
    }
    return out + convertUnicodeToLegacy(run, 'limon');
}
