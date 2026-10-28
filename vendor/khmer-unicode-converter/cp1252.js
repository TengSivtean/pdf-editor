/**
 * Windows-1252 (cp1252) codec.
 *
 * Legacy Khmer fonts are byte encodings; the Python original treated all
 * legacy text as cp1252. Internally this port represents legacy text as
 * "byte strings": JS strings whose every code unit is <= 0xFF, mirroring
 * Python 2 `str`. Uint8Array appears only at the API boundary.
 *
 * We do not use TextDecoder('windows-1252'): the WHATWG codec maps the five
 * undefined bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) to C1 controls but
 * TextEncoder cannot encode cp1252 at all, and Python's strict codec errors
 * on them. Like the Python original we never decode those bytes through the
 * codec path, so identity mapping keeps round-trips lossless.
 */
export const ENCODINGS = ['cp1252', 'utf-8', 'latin1', 'iso-8859-1'];
// Unicode equivalents for bytes 0x80-0x9F; identity elsewhere.
const HIGH = [
    0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
const DECODE_TABLE = [];
const ENCODE_MAP = new Map();
for (let b = 0; b < 0x100; b++) {
    const cp = b >= 0x80 && b <= 0x9f ? HIGH[b - 0x80] : b;
    DECODE_TABLE.push(cp);
    ENCODE_MAP.set(cp, b);
}
/** cp1252 bytes -> Unicode string. Undefined bytes map to identity U+00NN. */
export function decodeCp1252(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(DECODE_TABLE[bytes[i]]);
    }
    return out;
}
/** Unicode string -> cp1252 bytes; unmappable characters are dropped (Python 'ignore'). */
export function encodeCp1252(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
        const b = ENCODE_MAP.get(text.charCodeAt(i));
        if (b !== undefined)
            out.push(b);
    }
    return Uint8Array.from(out);
}
/** Byte string (all code units <= 0xFF) -> Uint8Array. */
export function byteStringToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0xff)
            throw new RangeError(`not a byte string: code unit 0x${c.toString(16)} at ${i}`);
        out[i] = c;
    }
    return out;
}
export function bytesToByteString(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++)
        out += String.fromCharCode(bytes[i]);
    return out;
}
/**
 * Equivalent of FontData.changeEncoding: normalize input in any supported
 * encoding to cp1252 bytes before the legacy->unicode pipeline.
 * latin1/iso-8859-1 bytes are reinterpreted (decode latin1, encode cp1252,
 * dropping unmappables, as Python's 'ignore' did).
 */
export function toCp1252Bytes(input, encoding) {
    switch (encoding) {
        case 'cp1252':
            return input;
        case 'latin1':
        case 'iso-8859-1': {
            // latin1 decode is identity byte->codepoint
            let s = '';
            for (let i = 0; i < input.length; i++)
                s += String.fromCharCode(input[i]);
            return encodeCp1252(s);
        }
        case 'utf-8':
            return encodeCp1252(new TextDecoder('utf-8').decode(input));
        default:
            throw new TypeError(`unknown encoding: ${encoding}`);
    }
}
export function canDecode(encoding) {
    return ENCODINGS.includes(encoding.toLowerCase());
}
