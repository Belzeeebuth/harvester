import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Règles de rédaction des textes joueurs (voir `docs/09-redaction.md`).
 *
 * Deux tics trahissaient un texte généré et reviennent vite si rien ne les
 * arrête : le tiret long qui colle deux idées, et la puce « • » utilisée comme
 * séparateur en pleine ligne. Les deux sont remplacés par ce qu'une personne
 * taperait : deux-points, point, virgule, ou « · » entre deux faits courts.
 */

const LOCALES = join(__dirname, '../src/i18n/locales');
const GAMEPLAY = join(__dirname, '../src/config/gameplay');

/** Tirets demi-cadratin, cadratin et barre horizontale. */
const LONG_DASH = /[\u2012-\u2015]/u;
/** Une puce en pleine ligne ; en début de ligne, c'est une vraie liste. */
const INLINE_BULLET = /\S \u2022 /u;

function strings(node: unknown, path = ''): Array<[path: string, text: string]> {
  if (typeof node === 'string') return [[path, node]];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, child]) =>
    // Les clés `$…` sont des commentaires de fichier, jamais affichés.
    key.startsWith('$') ? [] : strings(child, path ? `${path}.${key}` : key),
  );
}

function catalogues(): Array<[file: string, content: unknown]> {
  const files = ['fr.json', 'en.json'];
  for (const locale of ['fr', 'en']) {
    for (const name of readdirSync(join(LOCALES, locale))) files.push(`${locale}/${name}`);
  }
  return files.map((file) => [file, JSON.parse(readFileSync(join(LOCALES, file), 'utf8')) as unknown]);
}

describe('rédaction des textes joueurs', () => {
  it('aucun tiret long dans les catalogues de langue', () => {
    const offenders = catalogues().flatMap(([file, content]) =>
      strings(content)
        .filter(([, text]) => LONG_DASH.test(text))
        .map(([path]) => `${file}:${path}`),
    );
    expect(offenders).toEqual([]);
  });

  it('aucune puce utilisée comme séparateur en pleine ligne', () => {
    const offenders = catalogues().flatMap(([file, content]) =>
      strings(content)
        .filter(([, text]) => INLINE_BULLET.test(text))
        .map(([path]) => `${file}:${path}`),
    );
    expect(offenders).toEqual([]);
  });

  it('aucun tiret long dans les noms et descriptions du contenu de jeu', () => {
    const offenders = readdirSync(GAMEPLAY)
      .filter((name) => name.endsWith('.json') && name !== 'balance.json')
      .flatMap((name) =>
        strings(JSON.parse(readFileSync(join(GAMEPLAY, name), 'utf8')) as unknown)
          .filter(([, text]) => LONG_DASH.test(text))
          .map(([path]) => `${name}:${path}`),
      );
    expect(offenders).toEqual([]);
  });
});
