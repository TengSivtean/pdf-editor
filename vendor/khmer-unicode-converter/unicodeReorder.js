/**
 * Khmer visual-order to logical-order reordering (legacy -> Unicode direction).
 *
 * Port of modules/unicodeReorder.py (Khmer Software Initiative, GPL-2.0-or-later).
 * Takes an unordered (visual, legacy-style) Khmer Unicode string and produces
 * an organized string following the rule:
 *   baseCharacter [+ [Robat/Shifter] + [Coeng*] + [Shifter] + [Vowel] + [Sign]]
 */
export const BASE = 1;
export const VOWEL = 2;
export const SHIFTER = 4; // muusikatoan or triisap
export const COENG = 8;
export const SIGN = 16;
export const LEFT = 32; // vowel appears on left side of base
export const WITHE = 64; // vowel can be combined with SRA-E
export const WITHU = 128; // vowel can be combined with SRA-U
export const POSRAA = 256; // can be under PO SraA
export const MUUS = 512; // shifter placed on specific character
export const TRII = 1024; // shifter placed on specific character
export const ROBAT = 2048; // is robat character
const RO = 'រ';
const PO = 'ព';
const SRAAA = 'ា';
const SRAE = 'េ';
const SRAOE = 'ើ';
const SRAOO = 'ោ';
const SRAYA = 'ឿ';
const SRAIE = 'ៀ';
const SRAAU = 'ៅ';
const SRAII = 'ី';
const SRAU = 'ុ';
const TRIISAP = '៊';
const MUUSIKATOAN = '៉';
const SAMYOKSANNYA = '័';
const NYO = 'ញ';
const ZWSP = '​';
// possible combinations for sra E
const sraEcombining = {
    [SRAII]: SRAOE,
    [SRAYA]: SRAYA,
    [SRAIE]: SRAIE,
    [SRAAA]: SRAOO,
    [SRAAU]: SRAAU,
};
// Khmer character classification, indexed by codepoint - 0x1780
const KHMERCHAR = [
    BASE, // ក 0x1780
    BASE, // ខ
    BASE, // គ
    BASE, // ឃ
    BASE, // ង
    BASE, // ច
    BASE, // ឆ
    BASE, // ជ
    BASE, // ឈ
    BASE + MUUS, // ញ
    BASE, // ដ
    BASE, // ឋ
    BASE, // ឌ
    BASE, // ឍ
    BASE, // ណ
    BASE + POSRAA, // ត
    BASE, // ថ 0x1790
    BASE, // ទ
    BASE, // ធ
    BASE + POSRAA, // ន
    BASE + MUUS, // ប
    BASE, // ផ
    BASE, // ព
    BASE + POSRAA, // ភ
    BASE, // ម
    BASE + POSRAA, // យ
    BASE + POSRAA, // រ
    BASE + POSRAA, // ល
    BASE + POSRAA, // វ
    BASE, //
    BASE, //
    BASE + TRII, // ស
    BASE + TRII, // ហ 0x17A0
    BASE, // ឡ
    BASE + TRII, // អ
    BASE, //
    BASE, // អា
    BASE, // ឥ
    BASE, // ឦ
    BASE, // ឧ
    BASE, //
    BASE, // ឩ
    BASE, // ឪ
    BASE, // ឫ
    BASE, // ឬ
    BASE, // ឭ
    BASE, // ឮ
    BASE, // ឯ
    BASE, // 0x17B0
    BASE, //
    BASE, // ឲ
    BASE, //
    0,
    0, //
    VOWEL + WITHE + WITHU, // ា
    VOWEL + WITHU, // ិ
    VOWEL + WITHE + WITHU, // ី
    VOWEL + WITHU, // ឹ
    VOWEL + WITHU, // ឺ
    VOWEL, // ុ
    VOWEL, // ូ
    VOWEL, // ួ
    VOWEL + WITHU, // ើ
    VOWEL + WITHE, // ឿ
    VOWEL + WITHE, // ៀ 0x17C0
    VOWEL + LEFT, // េ
    VOWEL + LEFT, // ែ
    VOWEL + LEFT, // ៃ
    VOWEL, // ោ
    VOWEL + WITHE, // ៅ
    SIGN + WITHU, // ំ
    SIGN, // ះ
    SIGN, // ៈ
    SHIFTER, // ៉
    SHIFTER, // ៊
    SIGN, // ់
    ROBAT, // ៌
    SIGN, // ៍
    SIGN, //
    SIGN, // ៏
    SIGN + WITHU, // ័ 0x17D0
    SIGN, //
    COENG, // ្
    SIGN, //
];
/** Classification bitmask for a single Khmer character, or 0. */
export function khmerType(uniChar) {
    if (typeof uniChar !== 'string' || uniChar.length !== 1) {
        throw new TypeError(`only accept one character, but ${String(uniChar).length} chars found.`);
    }
    const ch = uniChar.charCodeAt(0) - 0x1780;
    if (ch >= 0 && ch < KHMERCHAR.length)
        return KHMERCHAR[ch];
    return 0;
}
/**
 * Reorder a visual-based (legacy-style) Khmer cluster string into
 * rule-based logical order.
 */
export function reorder(sin) {
    let result = '';
    const sinLimit = sin.length - 1;
    let i = -1;
    while (i < sinLimit) {
        // flush cluster
        let baseChar = '';
        let robat = '';
        let shifter1 = '';
        let shifter2 = '';
        let coeng1 = '';
        let coeng2 = '';
        let vowel = '';
        let poSraA = false;
        let sign = '';
        let keep = '';
        while (i < sinLimit) {
            i += 1;
            const cur = sin[i];
            const sinType = khmerType(cur);
            if (sinType & BASE) {
                if (baseChar !== '') {
                    // second baseChar -> end of cluster
                    i -= 1;
                    break;
                }
                baseChar = cur;
                keep = '';
                continue;
            }
            else if (sinType & ROBAT) {
                if (robat !== '') {
                    i -= 1;
                    break;
                }
                robat = cur;
                keep = '';
                continue;
            }
            else if (sinType & SHIFTER) {
                if (shifter1 !== '') {
                    i -= 1;
                    break;
                }
                shifter1 = cur;
                keep = '';
                continue;
            }
            else if (sinType & SIGN) {
                if (sign !== '') {
                    i -= 1;
                    break;
                }
                sign = cur;
                keep = '';
                continue;
            }
            else if (sinType & COENG) {
                if (i === sinLimit) {
                    coeng1 = cur;
                    break;
                }
                // coeng RO (with a base present) belongs to the next cluster
                if (sin[i + 1] === RO && baseChar !== '') {
                    i -= 1;
                    break;
                }
                if (coeng1 === '') {
                    coeng1 = sin.slice(i, i + 2);
                    i += 1;
                    keep = '';
                }
                else if (coeng1[1] === RO) {
                    // coeng1 is coeng RO: the cluster can have two coengs
                    coeng2 = sin.slice(i, i + 2);
                    i += 1;
                    keep = '';
                }
                else {
                    i -= 1;
                    break;
                }
            }
            else if (sinType & VOWEL) {
                if (vowel === '') {
                    // sra E/EI/AI with a base present belongs to the next cluster
                    if (sinType & LEFT && baseChar !== '') {
                        i -= 1;
                        break;
                    }
                    vowel = cur;
                    keep = '';
                }
                else if (baseChar === PO && !poSraA && (cur === SRAAA || vowel === SRAAA)) {
                    poSraA = true;
                    if (vowel === SRAAA) {
                        vowel = cur;
                        keep = '';
                    }
                }
                else {
                    if (vowel === SRAE && sinType & WITHE) {
                        // eliminate leading sra E, use the combined vowel
                        vowel = sraEcombining[cur];
                        keep = '';
                    }
                    else if ((vowel === SRAU && sinType & WITHU) ||
                        (khmerType(vowel) & WITHU && cur === SRAU)) {
                        // sra U + sra I (or vice versa): keep the I-type vowel,
                        // replace sra U by the appropriate shifter
                        if (!(khmerType(vowel) & WITHU)) {
                            vowel = cur;
                        }
                        if (baseChar !== '' && khmerType(baseChar) & TRII) {
                            shifter1 = TRIISAP;
                        }
                        else {
                            shifter1 = MUUSIKATOAN;
                        }
                    }
                    else if (vowel === SRAE && cur === SRAU) {
                        if (baseChar !== '' && khmerType(baseChar) & TRII) {
                            shifter1 = TRIISAP;
                        }
                        else {
                            shifter1 = MUUSIKATOAN;
                        }
                    }
                    else {
                        // vowels can't combine -> end of cluster
                        i -= 1;
                        break;
                    }
                }
            }
            else {
                // other than khmer -> end of cluster
                if (cur === ZWSP) {
                    // don't break the cluster on zwsp; move it to the cluster end
                    keep = ZWSP;
                }
                else {
                    keep = cur;
                    break;
                }
            }
        }
        // end of cluster scan
        // samyoksannya + sraU --> muusikatoan + samyoksannya
        if (vowel === SRAU && sign !== '' && khmerType(sign) & WITHU) {
            if (sign === SAMYOKSANNYA) {
                vowel = '';
                shifter1 = MUUSIKATOAN;
            }
        }
        // shifter moves to shifter2 depending on the coeng consonant
        if (shifter1 !== '' && coeng1.length === 2) {
            if (khmerType(coeng1[1]) & TRII) {
                shifter2 = TRIISAP;
                shifter1 = '';
            }
            else if (khmerType(coeng1[1]) & MUUS) {
                shifter2 = MUUSIKATOAN;
                shifter1 = '';
            }
        }
        // PO + sraA -> NYO; needs the whole cluster, so decided here.
        // coeng2 has priority (when coeng2 exists, coeng1 is always coeng RO)
        const underPoSraA = coeng2 !== '' ? coeng2 : coeng1;
        if (underPoSraA.length === 2) {
            const allowed = khmerType(underPoSraA[1]) & POSRAA;
            if ((poSraA && !allowed && vowel !== '') || (baseChar === PO && vowel === SRAAA && !allowed)) {
                baseChar = NYO;
                if (vowel === SRAAA && !poSraA) {
                    vowel = '';
                }
            }
        }
        // PO + sraA + sraE: recombine to sraOO when not turned into NYO
        if (poSraA && vowel === SRAE) {
            vowel = SRAOO;
        }
        // with two coengs, coeng1 is always coeng RO: emit it after coeng2
        result += baseChar + robat + shifter1 + coeng2 + coeng1 + shifter2 + vowel + sign + keep;
    }
    return result;
}
