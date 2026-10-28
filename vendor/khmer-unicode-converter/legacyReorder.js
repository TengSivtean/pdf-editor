/**
 * Khmer logical-order to visual-order reordering (Unicode -> legacy direction).
 *
 * Port of modules/legacyReorder.py (Khmer Software Initiative, GPL-2.0-or-later).
 * Segments logical Khmer Unicode into clusters via an ICU-style state machine,
 * then reassembles each cluster in visual (legacy) order. The MARK character
 * (U+17EA, unassigned in Unicode) is inserted to flag glyphs that need an
 * alternate raised/lowered position; font maps consume it during conversion.
 */
const SRAAA = 'ា';
const SRAE = 'េ';
const SRAOE = 'ើ';
const SRAOO = 'ោ';
const SRAYA = 'ឿ';
const SRAIE = 'ៀ';
const SRAAU = 'ៅ';
const SRAII = 'ី';
const TRIISAP = '៊';
const MUUSIKATOAN = '៉';
const SAMYOKSANNYA = '័';
const LA = 'ឡ';
const NYO = 'ញ';
const BA = 'ប';
const YO = 'យ';
const SA = 'ស';
const COENG = '្';
const CORO = COENG + 'រ';
const CONYO = COENG + NYO;
export const MARK = '\u17EA';
// TODO(upstream): the original left the dotted circle replacement empty
export const DOTCIRCLE = '';
// second part of each split vowel (the first part is always SRA-E)
const sraEcombining = {
    [SRAOE]: SRAII,
    [SRAYA]: SRAYA,
    [SRAIE]: SRAIE,
    [SRAOO]: SRAAA,
    [SRAAU]: SRAAU,
};
const CC_RESERVED = 0;
const CC_CONSONANT = 1; // consonant of type 1 or independent vowel
const CC_CONSONANT2 = 2; // consonant of type 2
const CC_CONSONANT3 = 3; // consonant of type 3
const CC_ZERO_WIDTH_NJ_MARK = 4; // zero width non-joiner (0x200C)
const CC_CONSONANT_SHIFTER = 5;
const CC_ROBAT = 6;
const CC_COENG = 7;
const CC_DEPENDENT_VOWEL = 8;
const CC_SIGN_ABOVE = 9;
const CC_SIGN_AFTER = 10;
const CC_ZERO_WIDTH_J_MARK = 11; // zero width joiner
const CF_CLASS_MASK = 0x0000ffff;
const CF_CONSONANT = 0x01000000;
const CF_SPLIT_VOWEL = 0x02000000;
const CF_DOTTED_CIRCLE = 0x04000000;
const CF_COENG = 0x08000000;
const CF_SHIFTER = 0x10000000;
const CF_ABOVE_VOWEL = 0x20000000;
const CF_POS_BEFORE = 0x00080000;
const CF_POS_BELOW = 0x00040000;
const CF_POS_ABOVE = 0x00020000;
const CF_POS_AFTER = 0x00010000;
const _xx = CC_RESERVED;
const _sa = CC_SIGN_ABOVE | CF_DOTTED_CIRCLE | CF_POS_ABOVE;
const _sp = CC_SIGN_AFTER | CF_DOTTED_CIRCLE | CF_POS_AFTER;
const _c1 = CC_CONSONANT | CF_CONSONANT;
const _c2 = CC_CONSONANT2 | CF_CONSONANT;
const _c3 = CC_CONSONANT3 | CF_CONSONANT;
const _rb = CC_ROBAT | CF_POS_ABOVE | CF_DOTTED_CIRCLE;
const _cs = CC_CONSONANT_SHIFTER | CF_DOTTED_CIRCLE | CF_SHIFTER;
const _dl = CC_DEPENDENT_VOWEL | CF_POS_BEFORE | CF_DOTTED_CIRCLE;
const _db = CC_DEPENDENT_VOWEL | CF_POS_BELOW | CF_DOTTED_CIRCLE;
const _da = CC_DEPENDENT_VOWEL | CF_POS_ABOVE | CF_DOTTED_CIRCLE | CF_ABOVE_VOWEL;
const _dr = CC_DEPENDENT_VOWEL | CF_POS_AFTER | CF_DOTTED_CIRCLE;
const _co = CC_COENG | CF_COENG | CF_DOTTED_CIRCLE;
// split vowels
const _va = _da | CF_SPLIT_VOWEL;
const _vr = _dr | CF_SPLIT_VOWEL;
// character classes for U+1780 - U+17DF
const khmerCharClasses = [
    _c1, _c1, _c1, _c3, _c1, _c1, _c1, _c1, _c3, _c1, _c1, _c1, _c1, _c3, _c1, _c1, // 1780-178F
    _c1, _c1, _c1, _c1, _c3, _c1, _c1, _c1, _c1, _c3, _c2, _c1, _c1, _c1, _c3, _c3, // 1790-179F
    _c1, _c3, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, _c1, // 17A0-17AF
    _c1, _c1, _c1, _c1, _dr, _dr, _dr, _da, _da, _da, _da, _db, _db, _db, _va, _vr, // 17B0-17BF
    _vr, _dl, _dl, _dl, _vr, _vr, _sa, _sp, _sp, _cs, _cs, _sa, _rb, _sa, _sa, _sa, // 17C0-17CF
    _sa, _sa, _co, _sa, _xx, _xx, _xx, _xx, _xx, _xx, _xx, _xx, _xx, _sa, _xx, _xx, // 17D0-17DF
];
// state machine: khmerStateTable[state][charClass] -> next state, < 0 ends the cluster
const khmerStateTable = [
    // xx  c1  c2  c3 zwnj cs  rb  co  dv  sa  sp zwj
    [1, 2, 2, 2, 1, 1, 1, 6, 1, 1, 1, 2], //  0 - ground state
    [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1], //  1 - exit state (or sign to the right of the syllable)
    [-1, -1, -1, -1, 3, 4, 5, 6, 16, 17, 1, -1], //  2 - base consonant
    [-1, -1, -1, -1, -1, 4, -1, -1, 16, -1, -1, -1], //  3 - first ZWNJ before a register shifter
    [-1, -1, -1, -1, 15, -1, -1, 6, 16, 17, 1, 14], //  4 - first register shifter
    [-1, -1, -1, -1, -1, -1, -1, -1, 20, -1, 1, -1], //  5 - robat
    [-1, 7, 8, 9, -1, -1, -1, -1, -1, -1, -1, -1], //  6 - first coeng
    [-1, -1, -1, -1, 12, 13, -1, 10, 16, 17, 1, 14], //  7 - first consonant of type 1 after coeng
    [-1, -1, -1, -1, 12, 13, -1, -1, 16, 17, 1, 14], //  8 - first consonant of type 2 after coeng
    [-1, -1, -1, -1, 12, 13, -1, 10, 16, 17, 1, 14], //  9 - first consonant of type 3 after coeng
    [-1, 11, 11, 11, -1, -1, -1, -1, -1, -1, -1, -1], // 10 - second coeng (no register shifter before)
    [-1, -1, -1, -1, 15, -1, -1, -1, 16, 17, 1, 14], // 11 - second coeng consonant, no register shifter before
    [-1, -1, -1, -1, -1, 13, -1, -1, 16, -1, -1, -1], // 12 - second ZWNJ before a register shifter
    [-1, -1, -1, -1, 15, -1, -1, -1, 16, 17, 1, 14], // 13 - second register shifter
    [-1, -1, -1, -1, -1, -1, -1, -1, 16, -1, -1, -1], // 14 - ZWJ before vowel
    [-1, -1, -1, -1, -1, -1, -1, -1, 16, -1, -1, -1], // 15 - ZWNJ before vowel
    [-1, -1, -1, -1, -1, -1, -1, -1, -1, 17, 1, 18], // 16 - dependent vowel
    [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 18], // 17 - sign above
    [-1, -1, -1, -1, -1, -1, -1, 19, -1, -1, -1, -1], // 18 - ZWJ after vowel
    [-1, 1, -1, 1, -1, -1, -1, -1, -1, -1, -1, -1], // 19 - third coeng
    [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, -1], // 20 - dependent vowel after a robat
];
/** Flagged character class of a single Khmer character, or 0. */
export function getCharClass(uniChar) {
    if (typeof uniChar !== 'string' || uniChar.length !== 1) {
        throw new TypeError(`only accept one character, but ${String(uniChar).length} chars found.`);
    }
    const ch = uniChar.charCodeAt(0) - 0x1780;
    if (ch >= 0 && ch < khmerCharClasses.length)
        return khmerCharClasses[ch];
    return 0;
}
/**
 * Reorder a logical-order Khmer Unicode string into visual-based
 * (legacy-style) cluster order.
 */
export function reorder(sin) {
    let cursor = 0;
    let state = 0;
    const charCount = sin.length;
    let result = '';
    while (cursor < charCount) {
        let reserved = '';
        let signAbove = '';
        let signAfter = '';
        let base = '';
        let robat = '';
        let shifter = '';
        let vowelBefore = '';
        let vowelBelow = '';
        let vowelAbove = '';
        let vowelAfter = '';
        let coeng = false;
        let cluster = '';
        let coeng1 = '';
        let coeng2 = '';
        let shifterAfterCoeng = false;
        while (cursor < charCount) {
            const curChar = sin[cursor];
            const kChar = getCharClass(curChar);
            const charClass = kChar & CF_CLASS_MASK;
            state = khmerStateTable[state][charClass];
            if (state < 0)
                break;
            // collect cluster variables
            if (kChar === _xx) {
                reserved = curChar;
            }
            else if (kChar === _sa) {
                signAbove = curChar;
            }
            else if (kChar === _sp) {
                signAfter = curChar;
            }
            else if (kChar === _c1 || kChar === _c2 || kChar === _c3) {
                if (coeng) {
                    if (coeng1 === '') {
                        coeng1 = COENG + curChar;
                    }
                    else {
                        coeng2 = COENG + curChar;
                    }
                    coeng = false;
                }
                else {
                    base = curChar;
                }
            }
            else if (kChar === _rb) {
                robat = curChar;
            }
            else if (kChar === _cs) {
                if (coeng1 !== '')
                    shifterAfterCoeng = true;
                shifter = curChar;
            }
            else if (kChar === _dl) {
                vowelBefore = curChar;
            }
            else if (kChar === _db) {
                vowelBelow = curChar;
            }
            else if (kChar === _da) {
                vowelAbove = curChar;
            }
            else if (kChar === _dr) {
                vowelAfter = curChar;
            }
            else if (kChar === _co) {
                coeng = true;
            }
            else if (kChar === _va) {
                // split vowel: first part before the base, second part above
                vowelBefore = SRAE;
                vowelAbove = sraEcombining[curChar];
            }
            else if (kChar === _vr) {
                // split vowel: first part before the base, second part after
                vowelBefore = SRAE;
                vowelAfter = sraEcombining[curChar];
            }
            cursor += 1;
        }
        // end of cluster scan
        // determine if a vowel needs the alternate (marked) position
        if (coeng1 !== '' && vowelBelow !== '') {
            vowelBelow = MARK + vowelBelow;
        }
        else if ((base === LA || base === NYO) && vowelBelow !== '') {
            vowelBelow = MARK + vowelBelow;
        }
        else if (coeng1 !== '' && vowelBefore !== '' && vowelAfter !== '') {
            vowelAfter = MARK + vowelAfter;
        }
        // coeng RO is rendered on the left side
        let coengBefore = '';
        if (coeng1 === CORO) {
            coengBefore = coeng1;
            coeng1 = '';
        }
        else if (coeng2 === CORO) {
            coengBefore = MARK + coeng2;
            coeng2 = '';
        }
        if (coeng1 !== '' || coeng2 !== '') {
            // NYO changes form when it carries a coeng
            if (base === NYO) {
                base = MARK + base;
                // coeng NYO under NYO must be marked
                if (coeng1 === CONYO) {
                    coeng1 = MARK + coeng1;
                }
            }
            if (coeng1 !== '' && coeng2 !== '') {
                coeng2 = MARK + coeng2;
            }
        }
        // shifter interaction with the base character
        if (base !== '' && shifter !== '') {
            // special case: BA with triisap keeps the shifter, marks the vowel
            if (vowelAbove !== '' && base === BA && shifter === TRIISAP) {
                vowelAbove = MARK + vowelAbove;
            }
            else if (vowelAbove !== '') {
                shifter = MARK + shifter;
            }
            else if (signAbove === SAMYOKSANNYA && shifter === MUUSIKATOAN) {
                shifter = MARK + shifter;
            }
            else if (signAbove !== '' && vowelAfter !== '') {
                shifter = MARK + shifter;
            }
            else if (signAbove !== '') {
                signAbove = MARK + signAbove;
            }
            // another mark when a coeng competes with an above vowel/sign
            if (coeng1 !== '' && (vowelAbove !== '' || signAbove !== '')) {
                shifter = MARK + shifter;
            }
            if (base === LA || base === NYO) {
                shifter = MARK + shifter;
            }
        }
        // incomplete coeng
        if (coeng && coeng1 === '') {
            coeng1 = COENG;
        }
        else if (coeng && coeng2 === '') {
            coeng2 = MARK + COENG;
        }
        // standalone sign or vowel gets a dotted circle base
        if (base === '' &&
            (vowelBefore !== '' ||
                coengBefore !== '' ||
                robat !== '' ||
                shifter !== '' ||
                coeng1 !== '' ||
                coeng2 !== '' ||
                vowelAfter !== '' ||
                vowelBelow !== '' ||
                vowelAbove !== '' ||
                signAbove !== '' ||
                signAfter !== '')) {
            base = DOTCIRCLE;
        }
        // shifter position: before or after the coeng
        let shifter1 = '';
        let shifter2 = '';
        if (shifterAfterCoeng) {
            shifter2 = shifter;
        }
        else {
            shifter1 = shifter;
        }
        // BA and sra A/AU always stay adjacent
        let specialCaseBA = false;
        if (base === BA &&
            (vowelAfter === SRAAA ||
                vowelAfter === SRAAU ||
                vowelAfter === MARK + SRAAA ||
                vowelAfter === MARK + SRAAU)) {
            vowelAfter = vowelAfter[vowelAfter.length - 1];
            specialCaseBA = true;
            if (coeng1 !== '' && [BA, YO, SA].includes(coeng1[coeng1.length - 1])) {
                specialCaseBA = false;
            }
        }
        // cluster formation
        if (specialCaseBA) {
            cluster =
                vowelBefore + coengBefore + base + vowelAfter + robat + shifter1 +
                    coeng1 + coeng2 + shifter2 + vowelBelow + vowelAbove + signAbove + signAfter;
        }
        else {
            cluster =
                vowelBefore + coengBefore + base + robat + shifter1 + coeng1 + coeng2 +
                    shifter2 + vowelBelow + vowelAbove + vowelAfter + signAbove + signAfter;
        }
        result += cluster + reserved;
        state = 0;
    }
    return result;
}
