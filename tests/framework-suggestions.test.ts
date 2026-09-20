import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SUGGESTIONS, suggestionRow } from '../src/framework/ui';
import { parseCustomId } from '../src/utils/custom-id';
import type { ComponentHandler } from '../src/types';

/**
 * Boutons de suggestion : chaque raccourci promis sur une erreur doit tomber
 * sur un gestionnaire réellement enregistré.
 *
 * L'entrée `event` fabriquait un `world:event:<owner>` alors qu'aucun
 * gestionnaire de namespace `world` n'existe : le bouton s'affichait et le clic
 * répondait « ce composant a expiré ». Le croisement table × gestionnaires est
 * le seul test qui attrape ce genre de promesse non tenue, et il vaut pour
 * toute entrée ajoutée plus tard.
 *
 * Les modules sont importés directement plutôt que via `loadComponents()` :
 * celui-ci charge en CommonJS (`require`), ce qui ne résout pas les `.ts` sous
 * Vitest. La règle d'appariement de `findHandler` est donc rejouée ici — elle
 * tient en une ligne et est vérifiée par le contrôle de non-vacuité ci-dessous.
 */

const BUTTONS_DIR = join(__dirname, '..', 'src', 'components', 'buttons');

const buttonHandlers: ComponentHandler[] = [];

beforeAll(async () => {
  const files = readdirSync(BUTTONS_DIR).filter((file) => file.endsWith('.ts'));
  for (const file of files) {
    const module = (await import(join(BUTTONS_DIR, file))) as {
      handler?: ComponentHandler;
      handlers?: ComponentHandler[];
    };
    if (module.handler) buttonHandlers.push(module.handler);
    if (Array.isArray(module.handlers)) buttonHandlers.push(...module.handlers);
  }
  // Délai explicite : ce crochet importe TOUT le graphe des services (7 à 9 s
  // sur un hôte chargé), soit à un souffle des 10 s par défaut de Vitest — et
  // le Dockerfile lance cette suite pendant le build de l'image.
}, 60_000);

/** Même règle que `findHandler` : namespace exact, action exacte ou `*`. */
function handlerFor(namespace: string, action: string): ComponentHandler | undefined {
  return buttonHandlers.find(
    (handler) =>
      handler.namespace === namespace &&
      (handler.actions.includes('*') || handler.actions.includes(action)),
  );
}

describe('table des suggestions', () => {
  it('croise des données réelles (auto-contrôle)', () => {
    // Sans cela, un chargement vide ferait passer toutes les assertions.
    expect(buttonHandlers.length).toBeGreaterThan(10);
    expect(Object.keys(SUGGESTIONS).length).toBeGreaterThan(5);
  });

  it('ne pointe que vers des gestionnaires existants', () => {
    const morts = Object.entries(SUGGESTIONS)
      .filter(([, suggestion]) => !handlerFor(suggestion.namespace, suggestion.action))
      .map(([command, suggestion]) => `${command} → ${suggestion.namespace}:${suggestion.action}`);
    expect(morts).toEqual([]);
  });

  it('ne propose plus de bouton « évènement » tant qu’aucun composant ne le sert', () => {
    expect(SUGGESTIONS.event).toBeUndefined();
    expect(suggestionRow('event', '123456789')).toBeUndefined();
  });

  it('ne rend rien pour une suggestion inconnue', () => {
    expect(suggestionRow('inexistant', '123456789')).toBeUndefined();
  });
});

describe('custom_id réellement produit', () => {
  it('est résolvable pour chaque suggestion', () => {
    for (const command of Object.keys(SUGGESTIONS)) {
      const rendered = suggestionRow(command, '123456789');
      expect(rendered, command).toBeDefined();
      // `toJSON()` est typé sur l'union des boutons ; seuls les boutons à
      // custom_id nous intéressent ici, d'où la lecture défensive du champ.
      const json = rendered?.components[0]?.toJSON() as { custom_id?: string } | undefined;
      const customId = json?.custom_id;
      expect(customId, command).toBeTypeOf('string');
      const parsed = parseCustomId(customId as string);
      expect(handlerFor(parsed.namespace, parsed.action), customId).toBeDefined();
    }
  });
});
