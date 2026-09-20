/**
 * Texte « fantaisie » : lettres latines remplacées par leurs sosies Unicode.
 *
 * Sert aux noms de salons, de rôles et de catégories posés par `/serverkit`.
 * Un salon textuel Discord n'accepte ni majuscule ni espace (l'espace devient
 * un tiret) ; les alphabets mathématiques (U+1D400…) échappent aux deux règles
 * parce qu'ils n'ont ni casse ni équivalent ASCII aux yeux de Discord. C'est
 * tout le principe des générateurs « fancy text ».
 *
 * Deux contraintes ont dicté la forme de ce module :
 *  - ces alphabets n'ont AUCUNE lettre accentuée. `fancy()` retire donc les
 *    diacritiques avant de substituer — « règlement » devient 𝐫𝐞𝐠𝐥𝐞𝐦𝐞𝐧𝐭 — plutôt
 *    que de laisser un « è » ordinaire au milieu d'un mot en gras ;
 *  - il faut pouvoir REVENIR au texte brut (`unfancy`, `slugify`) : c'est ainsi
 *    que le constructeur reconnaît un salon déjà posé, quelle que soit la
 *    police choisie la fois précédente.
 */

export const FANCY_FONTS = [
  'bold',
  'sans',
  'italic',
  'script',
  'gothic',
  'double',
  'mono',
  'smallcaps',
  'wide',
  'plain',
] as const;

export type FancyFont = (typeof FANCY_FONTS)[number];

interface Alphabet {
  /** Point de code de « A », ou table de 26 glyphes. */
  upper: number | string[];
  lower: number | string[];
  /** Point de code de « 0 » ; absent = chiffres laissés tels quels. */
  digit?: number;
  /** Trous de la plage Unicode : la lettre existe ailleurs, à un autre code. */
  exceptions?: Record<string, string>;
}

// `q` et `x` n'ont pas de petite capitale : ǫ est le sosie d'usage, x reste x.
const SMALL_CAPS = [...'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'];

const ALPHABETS: Record<Exclude<FancyFont, 'plain'>, Alphabet> = {
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  sans: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  italic: { upper: 0x1d63c, lower: 0x1d656, digit: 0x1d7ec },
  script: { upper: 0x1d4d0, lower: 0x1d4ea, digit: 0x1d7ce },
  gothic: { upper: 0x1d56c, lower: 0x1d586, digit: 0x1d7ce },
  double: {
    upper: 0x1d538,
    lower: 0x1d552,
    digit: 0x1d7d8,
    // Ces sept capitales ajourées préexistaient au bloc mathématique.
    exceptions: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
  },
  mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
  smallcaps: { upper: SMALL_CAPS, lower: SMALL_CAPS },
  wide: { upper: 0xff21, lower: 0xff41, digit: 0xff10 },
};

const LIGATURES: Record<string, string> = { œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE', ß: 'ss' };

const SMALL_CAPS_REVERSE = new Map<string, string>(
  SMALL_CAPS.map((glyph, index) => [glyph, String.fromCharCode(0x61 + index)] as const).filter(
    ([glyph, letter]) => glyph !== letter,
  ),
);

/**
 * Retire les diacritiques d'un texte latin. Seule la plage U+0300–U+036F est
 * visée : `\p{M}` emporterait aussi U+FE0F, le sélecteur qui donne aux emoji
 * leur rendu en couleur — 🛠️ redeviendrait un pictogramme monochrome.
 */
export function stripDiacritics(text: string): string {
  return text
    .replace(/[œŒæÆß]/g, (char) => LIGATURES[char] ?? char)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
}

function glyph(table: number | string[], offset: number): string {
  return typeof table === 'number' ? String.fromCodePoint(table + offset) : (table[offset] ?? '');
}

/** Transpose les lettres et chiffres ASCII de `text` dans la police demandée. */
export function fancy(text: string, font: FancyFont): string {
  if (font === 'plain') return text;
  const alphabet = ALPHABETS[font];

  let out = '';
  for (const char of stripDiacritics(text)) {
    const exception = alphabet.exceptions?.[char];
    const code = char.charCodeAt(0);
    if (exception) out += exception;
    else if (code >= 0x41 && code <= 0x5a) out += glyph(alphabet.upper, code - 0x41);
    else if (code >= 0x61 && code <= 0x7a) out += glyph(alphabet.lower, code - 0x61);
    else if (code >= 0x30 && code <= 0x39 && alphabet.digit !== undefined) {
      out += String.fromCodePoint(alphabet.digit + code - 0x30);
    } else out += char;
  }
  return out;
}

/**
 * Chemin inverse de `fancy()`, toutes polices confondues, en minuscules.
 *
 * NFKC ramène à l'ASCII tout ce qui est « compatibilité » : alphabets
 * mathématiques, pleine chasse, capitales ajourées. Les petites capitales sont
 * de vraies lettres (alphabet phonétique) qu'aucune normalisation ne touche :
 * elles passent par leur table, et AVANT le retrait des diacritiques — ǫ se
 * décompose en « o » + ogonek et reviendrait « o » au lieu de « q ».
 */
export function unfancy(text: string): string {
  let out = '';
  for (const char of text.normalize('NFKC')) out += SMALL_CAPS_REVERSE.get(char) ?? char;
  return stripDiacritics(out).toLowerCase();
}

/**
 * Empreinte d'un nom : ses seules lettres et chiffres, sans décor ni police.
 * `🛠️・𝐩𝐚𝐭𝐜𝐡・𝐧𝐨𝐭𝐞𝐬`, `「🛠️」ᴘᴀᴛᴄʜ・ɴᴏᴛᴇꜱ` et `patch-notes` ont la même.
 */
export function slugify(text: string): string {
  return unfancy(text).replace(/[^a-z0-9]/g, '');
}
