import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localizeCommand } from '../i18n/commands';
import { moduleLogger } from '../utils/logger';
import type {
  ButtonHandler,
  Command,
  ComponentHandler,
  ContextMenuCommand,
  ModalHandler,
  SelectHandler,
} from '../types';

const log = moduleLogger('registry');

/**
 * Chargement dynamique des commandes, composants et menus contextuels.
 *
 * Convention : chaque fichier de `src/commands/**` exporte soit `command`
 * (une commande), soit `commands` (un tableau) ; idem pour `src/components/**`
 * avec `handler` / `handlers`. Ajouter une commande = déposer un fichier, aucun
 * registre central à mettre à jour, donc aucun conflit de fusion sur un
 * fichier partagé.
 *
 * Les modules sont chargés en CommonJS synchrone (`require`) : au démarrage,
 * c'est plus simple qu'un `await import()` en boucle, et cela permet de faire
 * échouer le démarrage immédiatement si un fichier est cassé — plutôt que de
 * découvrir le problème quand un joueur tape la commande.
 */

export interface Registry {
  commands: Map<string, Command>;
  contextMenus: Map<string, ContextMenuCommand>;
  buttons: ComponentHandler[];
  selects: ComponentHandler[];
  modals: ComponentHandler[];
}

const registry: Registry = {
  commands: new Map(),
  contextMenus: new Map(),
  buttons: [],
  selects: [],
  modals: [],
};

function walk(directory: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walk(fullPath));
    } else if (/\.(ts|js)$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.test\./.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

function loadModule(path: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as Record<string, unknown>;
}

export function loadCommands(directory = join(__dirname, '..', 'commands')): number {
  let count = 0;
  for (const file of walk(directory)) {
    const module = loadModule(file);
    const candidates: Command[] = [];

    if (module.command) candidates.push(module.command as Command);
    if (Array.isArray(module.commands)) candidates.push(...(module.commands as Command[]));

    for (const command of candidates) {
      if (!command?.data?.name) {
        log.warn({ file }, 'commande sans `data.name` ignorée');
        continue;
      }
      if (registry.commands.has(command.data.name)) {
        throw new Error(`Duplicate command: /${command.data.name} (${file})`);
      }
      // Textes français greffés ici, une fois : le déploiement et `/help` lisent
      // ensuite le même corps de commande.
      localizeCommand(command.data);
      registry.commands.set(command.data.name, command);
      count += 1;
    }

    if (module.contextMenu) {
      const menu = module.contextMenu as ContextMenuCommand;
      registry.contextMenus.set(menu.data.name, menu);
      count += 1;
    }
    if (Array.isArray(module.contextMenus)) {
      for (const menu of module.contextMenus as ContextMenuCommand[]) {
        registry.contextMenus.set(menu.data.name, menu);
        count += 1;
      }
    }
  }

  log.info({ commands: registry.commands.size, contextMenus: registry.contextMenus.size }, 'commandes chargées');
  return count;
}

export function loadComponents(directory = join(__dirname, '..', 'components')): number {
  let count = 0;
  for (const file of walk(directory)) {
    const module = loadModule(file);
    const kind = file.includes(`${'buttons'}`)
      ? 'buttons'
      : file.includes('selects')
        ? 'selects'
        : file.includes('modals')
          ? 'modals'
          : undefined;

    const candidates: ComponentHandler[] = [];
    if (module.handler) candidates.push(module.handler as ComponentHandler);
    if (Array.isArray(module.handlers)) candidates.push(...(module.handlers as ComponentHandler[]));

    for (const handler of candidates) {
      if (!handler?.namespace) {
        log.warn({ file }, 'gestionnaire sans namespace ignoré');
        continue;
      }
      switch (kind) {
        case 'buttons':
          registry.buttons.push(handler);
          break;
        case 'selects':
          registry.selects.push(handler);
          break;
        case 'modals':
          registry.modals.push(handler);
          break;
        default:
          log.warn({ file }, 'gestionnaire hors dossier buttons/selects/modals');
          continue;
      }
      count += 1;
    }
  }

  log.info(
    { buttons: registry.buttons.length, selects: registry.selects.length, modals: registry.modals.length },
    'components loaded',
  );
  return count;
}

export function getRegistry(): Registry {
  return registry;
}

export function getCommand(name: string): Command | undefined {
  return registry.commands.get(name);
}

export function getContextMenu(name: string): ContextMenuCommand | undefined {
  return registry.contextMenus.get(name);
}

/** Trouve le gestionnaire correspondant à un custom_id analysé. */
export function findHandler(
  kind: 'button' | 'select' | 'modal',
  namespace: string,
  action: string,
): ComponentHandler | undefined {
  const pool =
    kind === 'button' ? registry.buttons : kind === 'select' ? registry.selects : registry.modals;
  return pool.find(
    (handler) =>
      handler.namespace === namespace &&
      (handler.actions.includes('*') || handler.actions.includes(action)),
  );
}

/** Corps JSON de toutes les commandes, pour le déploiement Discord. */
export function commandPayloads() {
  return [
    ...[...registry.commands.values()].map((command) => command.data),
    ...[...registry.contextMenus.values()].map((menu) => menu.data),
  ];
}

/** Vide le registre (tests, rechargement à chaud). */
export function resetRegistry(): void {
  registry.commands.clear();
  registry.contextMenus.clear();
  registry.buttons.length = 0;
  registry.selects.length = 0;
  registry.modals.length = 0;
}

export type { ButtonHandler, ModalHandler, SelectHandler };
