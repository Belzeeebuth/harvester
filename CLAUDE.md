# Harvester : consignes pour Claude

Bot Discord de jeu de ferme (« Greenvale »), TypeScript + discord.js 14,
PostgreSQL (Drizzle) + Redis (BullMQ). Node 22 (`engines >=22.19.0`).
Le README et `docs/` font foi ; ce fichier ne garde que ce qu'il faut savoir
avant de toucher au code.

## Lire d'abord

- `docs/02-architecture.md` : arborescence, règle de dépendance, transactions.
- `docs/09-redaction.md` : la voix des textes joueurs (obligatoire avant d'écrire un texte).
- `docs/04-equilibrage.md` avant de toucher aux JSON de `src/config/gameplay/`.

## Vérifier un changement

```sh
npm ci
npm run typecheck
npm run lint
npm test            # vitest, rapide, sans infrastructure
npm run build
```

La CI (`.github/workflows/ci.yml`) rejoue tout ça, plus la couverture (seuil
dans `vitest.config.ts`), `npm audit --audit-level=high` et la suite
d'intégration contre un vrai Postgres et un vrai Redis. Elle tourne sur chaque
push : c'est elle qui fait foi. Sur une machine chargée, les tests de rendu
peuvent dépasser leur délai sans être cassés.

`npm run test:integration` lit `.env` et vise par défaut 127.0.0.1:5432 et
127.0.0.1:6379. Ne le lancer que dans un clone sans `.env`, avec un Postgres et
un Redis jetables (et Docker pour Testcontainers). Sur l'hôte de production,
jamais : ces ports sont ceux de la prod.

## Architecture en une phrase par couche

`commands`/`components` → `services` → `repositories` → `db`.
Une commande ne fait pas de SQL ; un service ne connaît pas discord.js ; un
repository ne connaît aucune règle de jeu. `src/game/` est pur : aucune E/S,
aucun import d'`env`, le temps est un paramètre. Pas de tick global : l'état des
cultures est dérivé à la lecture (`planted_at`/`ready_at`).

## Règles maison (vérifiées par le lint ou les tests)

- **Aucun littéral français** dans `src/{commands,components,framework,services,game,events,jobs,render,utils,serverkit}`
  (`tests/i18n-source.test.ts`). Les textes vivent dans
  `src/i18n/locales/{fr,en}/*.json`, avec parité fr/en des clés ET des `{params}`.
- **Toute nouvelle commande, option ou choix** a son texte français dans
  `src/i18n/locales/commands.fr.json` (`tests/commands-localization.test.ts`).
  Noms de commandes et d'options en anglais.
- **Pas de `process.env`** : passer par `env` (`src/config/env.ts`).
- **Pas de `interaction.reply`/`followUp` direct** : passer par le framework.
- **Pas de `Math.round`/`Math.ceil` sur de la monnaie** dans `services`/`game` : `src/game/money.ts`.
- **Voix des textes joueurs** (`tests/copy-style.test.ts`) : vouvoiement, pas
  de tiret long, séparateur ` · `, émojis = icônes seulement, gras sur la seule
  valeur cherchée, pas de « Bravo ! », « Voici », « avec succès ». Éviter les
  tournures en « (s) ».
- Commentaires et logs en français.
- Une exception aux règles du lint se justifie par un commentaire
  `eslint-disable-next-line` qui dit pourquoi.

## Pièges connus

- **Verrous** : `lockUserRow` est en `FOR NO KEY UPDATE`. Ne pas revenir à
  `FOR UPDATE` : tout INSERT vers une table à clé étrangère sur `users` fait par
  une autre connexion pendant la transaction attend le statement timeout (15 s).
  Pour la même raison, relire après validation plutôt que par le pool dans une
  transaction.
- **undici 8** : `fetch` doit venir du paquet (`import { Agent, fetch } from 'undici'`).
  Le `fetch` global de Node 22 embarque undici 6 et rejette un `Agent` v8
  (garde-fou : `tests/webhook-delivery.test.ts`).
- **BullMQ 6** : les tâches planifiées passent par `upsertJobScheduler`. Les
  anciens jobs répétables ne sont plus gérés.
- **Boutique** : le menu d'achat liste tous les articles affichés, verrouillés et
  épuisés compris (`shopChoices`, `framework/views.ts`), le refus se fait dans
  `assertPurchasable`. Ne pas re-filtrer sur le niveau.
- **`esbuild`** reste en devDependency explicite : sans lui, un verrou régénéré
  par Dependabot casse `npm ci`.
- **Échappements `\uXXXX`** dans les regex : les garder tels quels (certains
  outils d'écriture les convertissent en caractères bruts).

## Git et déploiement

- Messages de commit en français, préfixe conventionnel :
  `fix(boutique): ...`, `feat(i18n): ...`, `chore(deps): ...`.
- Travailler sur une branche `claude/...`. **Ne jamais pousser sur `main` sans
  accord explicite** : c'est la branche par défaut, et un changement sous
  `site/` y republie le site (`.github/workflows/pages.yml`).
- Le déploiement du bot (build Docker, `commands:deploy:prod`, `up -d bot`) se
  fait sur l'hôte, par la propriétaire. Une session distante s'arrête au push
  d'une branche avec une CI verte.
