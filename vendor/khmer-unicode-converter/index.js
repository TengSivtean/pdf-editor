/**
 * khmerconverter — convert Khmer text between legacy font encodings
 * (ABC, Limon, Baidok, Khek, FK, Kaoh Kong, Rasmei, ...) and Khmer Unicode.
 *
 * TypeScript port of the Khmer Software Initiative KhmerConverter
 * (www.khmeros.info, GPL-2.0-or-later). Runtime-agnostic: works in Node
 * and browsers.
 */
import { byteStringToBytes, bytesToByteString, decodeCp1252, encodeCp1252, toCp1252Bytes, } from './cp1252.js';
import { getLegacyData, getUnicodeData } from './fontData.js';
import { converter } from './legacyConverter.js';
import { reorder as reorderLogicalToVisual } from './legacyReorder.js';
import { process as processLegacy } from './unicodeProcess.js';
import { reorder as reorderVisualToLogical } from './unicodeReorder.js';
export const DEFAULT_FONT = 'abc-zwsp';
/**
 * Convert legacy-encoded Khmer text to Khmer Unicode (logical order).
 *
 * @param input legacy text: raw bytes, or a string of cp1252-decoded display text
 * @param font  font type, name, or alias identifying the legacy encoding (default 'abc-zwsp')
 */
export function convertLegacyToUnicode(input, font = DEFAULT_FONT, options = {}) {
    const bytes = typeof input === 'string'
        ? encodeCp1252(input)
        : toCp1252Bytes(input, options.encoding ?? 'cp1252');
    const visual = processLegacy(bytesToByteString(bytes), getLegacyData(font));
    return reorderVisualToLogical(visual);
}
/**
 * Convert Khmer Unicode text to a legacy encoding, returned as raw cp1252
 * bytes (for writing files a legacy application can read).
 */
export function convertUnicodeToLegacyBytes(input, font = DEFAULT_FONT) {
    const visual = reorderLogicalToVisual(input);
    return byteStringToBytes(converter(visual, getUnicodeData(font)));
}
/**
 * Convert Khmer Unicode text to a legacy encoding, returned as a
 * cp1252-decoded display string (for pasting into a legacy-font application).
 */
export function convertUnicodeToLegacy(input, font = DEFAULT_FONT) {
    return decodeCp1252(convertUnicodeToLegacyBytes(input, font));
}
export { decodeCp1252, encodeCp1252, canDecode } from './cp1252.js';
export { FontNotFoundError, beautify, defaultFont, isConvertible, listEncodings, listFontNames, listFontNamesForType, listFontTypes, typeForFontName, } from './fontData.js';
export { reorder as reorderVisualToLogical } from './unicodeReorder.js';
export { reorder as reorderLogicalToVisual, MARK } from './legacyReorder.js';
export { limon } from './limon.js';
