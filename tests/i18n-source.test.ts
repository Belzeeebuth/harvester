import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fou contre le français résiduel dans l'interface.
 *
 * Le test de payload (`commandes Discord`) ne voit que les noms et descriptions
 * envoyés à Discord au déploiement. Or l'essentiel de ce que lit un joueur —
 * titres d'embeds, libellés de boutons, messages d'erreur — n'existe qu'à
 * l'exécution. C'est par là que « Ma ferme », « Aucune tâche » et « Rien de
 * particulier. La ferme tourne. » sont restés visibles alors que le payload
 * était déjà entièrement anglais.
 *
 * Ce test lit donc le SOURCE et inspecte chaque littéral de chaîne. Il ne
 * remplace pas le test de payload : les libellés d'aide sont construits
 * dynamiquement et n'apparaissent nulle part comme littéral, donc les deux
 * angles sont nécessaires.
 */

const UI_DIRS = [
  'src/commands',
  'src/components',
  'src/framework',
  'src/services',
  'src/game',
  'src/events',
  'src/jobs',
  'src/render',
  'src/utils',
  'src/serverkit',
];

/** Accents utilisés en français mais absents de l'anglais. */
const ACCENTS = /[àâäçéèêëîïôöùûüÿœÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒ]/;

/**
 * Mots exclusivement français. Les faux amis sont volontairement absents :
 * « son », « ton », « main », « or », « coin », « pain », « chat », « car »,
 * « plus », « part » et « sale » sont aussi des mots anglais et feraient
 * échouer le test sur des chaînes parfaitement traduites.
 */
const FRENCH_WORDS = new RegExp(
  String.raw`\b(?:` +
    [
      'le', 'la', 'les', 'une', 'des', 'du', 'aux', 'est', 'sont', 'pour', 'dans',
      'avec', 'par', 'pas', 'tout', 'tous', 'toute', 'toutes', 'votre', 'vos',
      'vous', 'nous', 'cette', 'ces', 'qui', 'que', 'mais', 'donc', 'sans',
      'sous', 'entre', 'vers', 'chez', 'encore', 'jamais', 'toujours', 'aucun',
      'aucune', 'chaque', 'autre', 'autres', 'trop', 'beaucoup', 'assez',
      'ferme', 'niveau', 'palier', 'parcelle', 'parcelles', 'objet', 'objets',
      'graine', 'graines', 'boutique', 'annonce', 'joueur', 'compte', 'solde',
      'avez', 'faut', 'manque', 'inconnu', 'inconnue', 'introuvable',
      'quotidien', 'saison', 'semaine', 'bonheur', 'recettes', 'gemmes',
    ].join('|') +
    String.raw`)\b`,
  'i',
);

/** Élision française : « n'a », « d'un », « l'inventaire », « qu'il ». */
const ELISION = /(?:^|[^\w'])(?:[ndljmcst]|qu)['’][a-zA-ZÀ-ÿ]/;

function looksFrench(text: string): boolean {
  // Le contenu des interpolations est du CODE, pas de la prose : une variable
  // nommée `ferme` ne doit pas faire échouer le test.
  const prose = text.replace(/\$\{[^}]*\}/g, ' ');
  return ACCENTS.test(prose) || ELISION.test(prose) || FRENCH_WORDS.test(prose);
}

/**
 * Retire les appels au logger avec leurs arguments.
 *
 * Les journaux restent en français, et c'est délibéré : ils s'adressent à
 * l'exploitant du bot, pas au joueur, comme les commentaires du dépôt. Les
 * inclure ici reviendrait à confondre « ce que lit un joueur » et « ce que lit
 * l'administrateur dans `docker compose logs` ».
 */
function stripLogCalls(source: string): string {
  const pattern = /\blog\.(?:trace|debug|info|warn|error|fatal)\s*\(/g;
  let out = source;
  for (;;) {
    pattern.lastIndex = 0;
    const match = pattern.exec(out);
    if (!match) return out;
    // avance jusqu'à la parenthèse fermante correspondante
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < out.length; i += 1) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out = out.slice(0, match.index) + ' '.repeat(i - match.index + 1) + out.slice(i + 1);
  }
}

/**
 * Neutralise commentaires et littéraux, puis rend les littéraux.
 * Écrit à la main car les commentaires de ce dépôt sont en français par choix :
 * les inclure noierait le signal sous des centaines de faux positifs.
 */
function stringLiterals(input: string): string[] {
  const source = stripLogCalls(input);
  const found: string[] = [];
  let i = 0;
  // Un `/` ouvre une expression régulière (et non une division) seulement après
  // l'un de ces caractères. Sans cette distinction, une regex contenant une
  // apostrophe — il y en a dans `escapeMarkdown` — ouvre une fausse chaîne et
  // avale le reste du fichier.
  const REGEX_ALLOWED_BEFORE = new Set('(,=:[!&|?{};+-*%<>~^\n'.split(''));
  let lastSignificant = '\n';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '/' && REGEX_ALLOWED_BEFORE.has(lastSignificant)) {
      i += 1;
      let inClass = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
        else if (source[i] === '\n') break;
        i += 1;
      }
      i += 1;
      while (i < source.length && /[dgimsuvy]/.test(source[i] ?? '')) i += 1;
      lastSignificant = '/';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      let buffer = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          buffer += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        buffer += source[i];
        i += 1;
      }
      i += 1;
      found.push(buffer);
      lastSignificant = quote;
      continue;
    }
    if (c === '`') {
      // Un gabarit peut contenir du code dans `${…}`, lui-même porteur d'autres
      // gabarits : `${x ? `a` : `b`}`. Un simple « jusqu'au prochain backtick »
      // se désynchronise et avale la suite du fichier — c'est ce qui masquait
      // « 🌾 Repas servi » et « **Palier ${tier}** » aux passes précédentes.
      i = readTemplate(source, i, found);
      lastSignificant = '`';
      continue;
    }
    if (!/\s/.test(c ?? '')) lastSignificant = c ?? '\n';
    else if (c === '\n') lastSignificant = '\n';
    i += 1;
  }
  return found;
}

/** Lit un gabarit à partir du backtick ouvrant ; renvoie l'index juste après. */
function readTemplate(source: string, start: number, found: string[]): number {
  let i = start + 1;
  let buffer = '';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      buffer += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '`') {
      found.push(buffer);
      return i + 1;
    }
    if (c === '$' && source[i + 1] === '{') {
      // On saute l'expression en suivant les accolades, en traversant
      // correctement les chaînes et gabarits imbriqués.
      buffer += '${}';
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const d = source[i];
        if (d === '{') depth += 1;
        else if (d === '}') depth -= 1;
        else if (d === "'" || d === '"') {
          const quote = d;
          i += 1;
          while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
        } else if (d === '`') {
          i = readTemplate(source, i, found) - 1;
        }
        i += 1;
      }
      continue;
    }
    buffer += c;
    i += 1;
  }
  found.push(buffer);
  return i;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Chaînes françaises légitimes. Chaque entrée est une décision, pas un
 * contournement — d'où la liste explicite plutôt qu'un motif large.
 */
const ALLOWED = new Set([
  // Le sélecteur de langue affiche chaque langue DANS sa propre langue.
  'Français',
  '🇫🇷 Français',
  // Nom de police : « Sans » est ici l'abréviation de « sans serif ».
  'DejaVu Sans',
]);

/** Clés internes : namespaces de custom_id, catégories, valeurs de choix. */
const IDENTIFIER = /^[a-z][a-z0-9_.:\-/]*$/;

describe('français résiduel dans l\'interface', () => {
  const files = UI_DIRS.flatMap((dir) => walkTs(dir));

  it('inspecte bien tout le code d\'interface', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('détecte effectivement le français (auto-contrôle)', () => {
    // Sans ce contrôle, un détecteur cassé rendrait le test vert en silence —
    // ce sont exactement ces trois chaînes qui étaient visibles en production.
    expect(looksFrench('Ma ferme')).toBe(true);
    expect(looksFrench('Rien de particulier. La ferme tourne.')).toBe(true);
    expect(looksFrench('Aucune tâche.')).toBe(true);
    expect(looksFrench("${target.displayName} n'a pas encore de ferme.")).toBe(true);
    // ... sans crier au loup sur de l'anglais correct.
    expect(looksFrench('Your farm is untouched.')).toBe(false);
    expect(looksFrench('Collect all (${ready.length})')).toBe(false);
    expect(looksFrench('${player.username}’s herd')).toBe(false);
  });

  it('ne laisse aucune chaîne française visible par le joueur', () => {
    const problems: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const literal of stringLiterals(source)) {
        if (literal.length < 4) continue;
        if (ALLOWED.has(literal)) continue;
        if (IDENTIFIER.test(literal)) continue;
        if (looksFrench(literal)) problems.push(`${file} : ${literal.slice(0, 90)}`);
      }
    }

    expect(problems).toEqual([]);
  });
});
