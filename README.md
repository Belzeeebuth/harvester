<div align="center">

<img src="assets/brand/harvester-avatar.png" alt="Harvester" width="132">

# 🌾 Harvester

**Jeu de ferme persistant pour Discord — prêt pour la production.**

41 cultures · 24 animaux · 49 recettes · 18 bâtiments · 17 poissons · 16 minerais
74 commandes + 2 menus contextuels · 58 tables PostgreSQL · images générées et décrites
économie fermée, auditée et purgeable · 494 tests · CI

</div>

---

## Sommaire

1. [Ce que c'est](#1-ce-que-cest)
2. [Prérequis](#2-prérequis)
3. [Installation en 10 minutes](#3-installation-en-10-minutes)
4. [Créer l'application Discord](#4-créer-lapplication-discord)
5. [Configuration](#5-configuration)
6. [Déploiement avec Docker](#6-déploiement-avec-docker)
7. [Déploiement sans Docker (PM2 / systemd)](#7-déploiement-sans-docker-pm2--systemd)
8. [Commandes](#8-commandes)
9. [Exploitation au quotidien](#9-exploitation-au-quotidien)
10. [Développement](#10-développement)
11. [Dépannage](#11-dépannage)
12. [Documentation](#12-documentation)

---

## 1. Ce que c'est

Un jeu de gestion de ferme joué entièrement dans Discord. Chaque joueur possède
**une ferme globale liée à son compte Discord** — elle le suit sur tous les serveurs.
La boucle est classique et éprouvée : semer, entretenir, récolter, transformer,
vendre, réinvestir, monter de niveau, débloquer.

Les partis pris qui structurent tout le reste :

- **Aucun pay-to-win.** Les gemmes ne s'achètent pas. Aucun point d'entrée n'existe
  dans le code pour en vendre.
- **Sessions de 2 à 5 minutes.** Toute action utile tient en une commande.
- **Économie fermée et vérifiée.** Chaque mouvement de pièces écrit une ligne de
  grand livre dans la même transaction SQL ; l'invariant est contrôlé toutes les
  heures, et le journal se purge sans jamais le perdre grâce à des soldes
  d'ouverture mensuels.
- **Pas de tick global.** La pousse est calculée à la lecture depuis les
  horodatages. Un joueur inactif ne coûte rien. Voir
  [02 § 1.2](./docs/02-architecture.md#12-pousse-calculée-à-la-lecture--décision-fondamentale).
- **Accessible.** Chaque image porte un texte alternatif lu par les lecteurs
  d'écran ; la palette est tenue au contraste WCAG par un test ; un mode texte
  intégral existe.
- **Le joueur reste maître de ses données.** `/account export` et
  `/account delete`, sans passer par un administrateur.

---

## 2. Prérequis

| Outil | Version | Note |
|---|---|---|
| Node.js | **20 LTS ou plus** | `node --version` |
| npm | 10+ | fourni avec Node 20 |
| PostgreSQL | **16** | ou le service Docker fourni |
| Redis | **7** | ou le service Docker fourni |
| Docker + Compose | récent | *optionnel mais recommandé* ; requis par `npm run test:integration` |

Sous Linux hors Docker, `@napi-rs/canvas` est un binaire précompilé et n'exige
aucune bibliothèque système. Pour que les emoji s'affichent correctement dans les
images, installez une police couleur :

```bash
sudo apt install fonts-noto-color-emoji fonts-dejavu-core
```

L'image Docker le fait déjà.

---

## 3. Installation en 10 minutes

```bash
# 1. Récupérer le projet et installer
git clone <votre-dépôt> harvester && cd harvester
npm install

# 2. Configurer
cp .env.example .env
$EDITOR .env          # au minimum : DISCORD_TOKEN, DISCORD_CLIENT_ID, BOT_OWNER_IDS, WORLD_SEED

# 3. Lancer PostgreSQL et Redis
docker compose up -d db redis

# 4. Créer le schéma et charger la configuration de jeu
npm run db:migrate
npm run db:seed

# 5. Publier les commandes slash
npm run commands:deploy

# 6. Démarrer
npm run dev           # développement, rechargement à chaud
```

Le bot est en ligne. Tapez `/start` dans un serveur où il est invité.

> **Vérification sans rien installer.** `npm run render:preview` et
> `npm run render:matrix` fonctionnent **sans base ni Redis ni token** (voir
> `src/scripts/offline-env.ts`) : ils écrivent respectivement six et vingt-six
> PNG dans `out/`. `npm run balance:report` imprime toutes les tables
> d'équilibrage ; il lit `.env` (les quatre variables obligatoires suffisent, il
> n'ouvre aucune connexion). C'est le moyen le plus rapide de voir ce que le
> projet produit.

---

## 4. Créer l'application Discord

1. Ouvrez le [portail développeur Discord](https://discord.com/developers/applications)
   → **New Application**.
2. Onglet **Bot** → **Reset Token** → copiez le jeton dans `DISCORD_TOKEN`.
   *Ce jeton ne s'affiche qu'une fois.*
3. Onglet **General Information** → copiez l'**Application ID** dans
   `DISCORD_CLIENT_ID`.
4. **Aucun intent privilégié n'est nécessaire.** Harvester n'utilise que l'intent
   `Guilds` : il ne lit aucun message et n'énumère aucun membre. Laissez *Message
   Content Intent* et *Server Members Intent* **désactivés**.
5. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot` et `applications.commands`
   - Permissions : `Send Messages`, `Embed Links`, `Attach Files`,
     `Use External Emojis`, `Read Message History`
6. Ouvrez l'URL générée et invitez le bot sur votre serveur.

Pour récupérer votre identifiant Discord (`BOT_OWNER_IDS`) : activez le mode
développeur (*Paramètres → Avancés*), puis clic droit sur votre nom → *Copier
l'identifiant*.

Pour les **votes top.gg** (facultatif) : sur la page du bot, onglet *Webhooks*,
renseignez `https://<votre domaine>/api/v1/topgg` et un secret, recopié dans
`TOPGG_WEBHOOK_SECRET` (voir [07 § 6](./docs/07-api-publique.md#6-webhook-entrant--votes-topgg)).

### Site public et pages légales

`site/` contient un site statique — présentation, politique de confidentialité,
conditions d'utilisation — publié sur GitHub Pages par
`.github/workflows/pages.yml` à chaque poussée sur la branche par défaut. Ni
build ni dépendance : le dossier part tel quel.

Ces deux pages ne sont pas décoratives. Discord **exige** une URL de politique
de confidentialité et une URL de conditions d'utilisation pour vérifier une
application, ce qui devient obligatoire au-delà de 100 serveurs, et une fiche
top.gg attend une page de présentation. Renseignez-les dans le portail
développeur, onglet *General Information*.

Trois choses à faire avant la mise en ligne :

1. remplacer `VOTRE_APPLICATION_ID` dans `site/index.html` par l'identifiant de
   votre application (le bouton « Ajouter à mon serveur » en dépend) ;
2. activer *Settings → Pages → Source: GitHub Actions* dans le dépôt ;
3. relire le § 1 de `site/confidentialite.html` et le § 8 : ils désignent
   l'administrateur de l'instance comme responsable du traitement et renvoient
   aux tickets du dépôt. Si vous exploitez une instance publique, mettez-y un
   contact réel.

Les captures de `site/images/` sont copiées depuis `out/fr/` ; régénérez-les
avec `npm run render:preview` puis recopiez-les si le rendu change.

---

## 5. Configuration

### 5.1 Variables d'environnement

Le fichier `.env` est validé par **Zod au démarrage** (`src/config/env.ts`) : une
variable manquante ou malformée fait échouer le lancement immédiatement, avec le
nom du champ fautif. `.env.example` est intégralement commenté ; voici l'ensemble.

**Obligatoires**

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Jeton du bot (≥ 50 caractères) |
| `DISCORD_CLIENT_ID` | Identifiant de l'application |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/harvester` |
| `REDIS_URL` | `redis://host:6379` |
| `BOT_OWNER_IDS` | Identifiants autorisés à `/admin` et `/serverkit`, séparés par des virgules |

**Secrets et sécurité**

| Variable | Défaut | Rôle |
|---|---|---|
| `WORLD_SEED` | `harvest` | **Secret d'instance.** Météo, rotation de la boutique et marché noir en dérivent ; avec la valeur par défaut, tout lecteur du dépôt calcule le marché noir de demain. `openssl rand -hex 32`, la même valeur sur tous les shards, et ne plus en changer (cela redistribuerait météo et stocks). |
| `HTTP_METRICS_TOKEN` | — | Jeton `Authorization: Bearer` exigé sur `GET /metrics`. **À renseigner dès que `/api/v1` est exposé** : même port, et `/metrics` publie la masse monétaire et les écarts comptables. |
| `DATABASE_SSL` | `false` | TLS vers PostgreSQL, certificat **vérifié** |
| `DATABASE_SSL_CA` | — | Chemin d'un `.pem` (PaaS à autorité privée) |
| `DATABASE_SSL_INSECURE` | `false` | Désactive la vérification du certificat : chiffre sans authentifier. Le démarrage l'annonce bruyamment. |
| `DATABASE_POOL_MAX` | `12` | Connexions par process — garder `pool × shards < max_connections` (200 dans le compose) |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | `30000` | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | Toute requête plus longue est annulée |
| `REDIS_PREFIX` | `harvester` | Préfixe de toutes les clés Redis et de la file BullMQ |

**Recommandées**

| Variable | Défaut | Rôle |
|---|---|---|
| `DISCORD_DEV_GUILD_ID` | — | Publie les commandes sur **un** serveur : propagation **instantanée** au lieu d'une heure. Indispensable en développement, à retirer en production. |
| `DISCORD_ERROR_CHANNEL_ID` | — | Salon privé recevant les erreurs (dédoublonnées, 10 par 5 min) |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | — | Salon des annonces `/admin announce` |
| `NODE_ENV` | `development` | `production` en exploitation |
| `LOG_LEVEL` | `info` | `debug` pour diagnostiquer |
| `LOG_PRETTY` | `false` | `true` en développement (sortie lisible) |
| `HTTP_PORT` | `3001` | `/health`, `/ready`, `/metrics`, `/api/v1/*` ; `0` désactive le serveur |

**Réglages de jeu modifiables sans redéploiement**

| Variable | Défaut | Rôle |
|---|---|---|
| `SEASON_LENGTH_DAYS` | `14` | Durée d'une saison en jours réels |
| `GLOBAL_GROWTH_MULTIPLIER` | `1.0` | `> 1` accélère la pousse (événements) |
| `GLOBAL_ECONOMY_MULTIPLIER` | `1.0` | Multiplie tous les gains — levier d'urgence contre l'inflation |
| `ENERGY_SYSTEM_ENABLED` | `true` | Système d'énergie ; `false` pour un rythme libre |
| `MARKET_UPDATE_MINUTES` | `60` | Fréquence de recalcul des prix |
| `MAINTENANCE_MODE` | `false` | Bloque le jeu sauf `/admin` au démarrage (basculable à chaud) |
| `MAINTENANCE_MESSAGE` | — | Texte ajouté au message générique déjà traduit |

**Rendu d'images**

| Variable | Défaut | Rôle |
|---|---|---|
| `RENDER_ENABLED` | `true` | `false` bascule tout en embeds texte |
| `RENDER_CACHE_TTL` | `120` | Durée du cache d'images (s) |
| `RENDER_TIMEOUT_MS` | `4000` | Budget de rendu avant repli texte |
| `RENDER_WORKERS` | `2` | Threads de dessin (0 à 8). `0` = rendu sur le thread principal, qui bloque alors l'event loop |
| `ASSETS_DIR` | `./assets` | Sprites et polices optionnels |

**Files, sharding et image Docker**

| Variable | Défaut | Rôle |
|---|---|---|
| `QUEUES_ENABLED` | `true` | BullMQ ; `false` = minuteurs (mono-processus **uniquement**, crons journaliers approximés) |
| `SCHEDULER_ENABLED` | `true` | Un process au moins doit la garder à `true` ; hérité par tous les shards |
| `SHARDING_TOTAL` | `auto` | Nombre de shards. **Ne jamais nommer cette variable `SHARD_COUNT` ni `SHARDS`** : ces noms appartiennent au protocole interne de discord.js (`SHARDS` est posé par le `ShardingManager` et seulement lu par le bot). |
| `SHARDING_LIST` | `auto` | Liste de shards de ce process |
| `HARVESTER_ENTRYPOINT` | `index` | Variable de l'**image Docker** (pas du `.env`) : `index` = mono-process, `shard` = `ShardingManager`. Le profil compose `sharded` la pose ; toute autre valeur est refusée au démarrage du conteneur. |

**Intégrations et tests**

| Variable | Rôle |
|---|---|
| `TOPGG_WEBHOOK_SECRET` | Secret du webhook de vote top.gg ; vide = route `POST /api/v1/topgg` fermée (`503`) |
| `TOPGG_VOTE_URL` | Lien affiché par `/vote` |
| `TOPGG_TOKEN` | Réservé : seulement masqué dans les journaux, aucune requête sortante vers top.gg n'existe aujourd'hui |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `REDIS_PORT` | Lus par `docker-compose.yml` et par la suite d'intégration, pas par le bot. `POSTGRES_PASSWORD` **sans valeur de repli** : un `.env` incomplet fait échouer `docker compose up` plutôt que de poser un mot de passe par défaut. |
| `TEST_DATABASE_URL`, `TEST_DATABASE_HOST`, `TEST_REDIS_URL`, `TEST_REDIS_PREFIX` | Suite d'intégration uniquement (§ 10) |

### 5.2 Équilibrage — les 10 fichiers JSON

Tout le gameplay vit dans `src/config/gameplay/` :

| Fichier | Contenu |
|---|---|
| `crops.json` | 41 cultures, chacune avec sa silhouette et sa palette |
| `animals.json` | 24 espèces, chacune avec sa silhouette et sa palette |
| `items.json` | 150 objets explicites (232 avec les graines et récoltes dérivées) : 48 produits, 24 produits animaux, 17 consommables, 17 poissons, 16 minerais, 13 matériaux, 6 outils, 5 cosmétiques, 4 objets d'événement |
| `recipes.json` | 49 recettes |
| `buildings.json` | 18 bâtiments (5 d'élevage, 8 ateliers, entrepôt, maison, puits, grainerie, serre) |
| `balance.json` | Tous les nombres : XP, prestige, parcelles, fertilité, qualité, mutations, marché, marché noir, taxes, cooldowns, variantes d'animaux, alertes, almanach, rétention du journal, rendu… |
| `quests.json` | 52 quêtes (24 journalières, 8 hebdomadaires, 12 d'histoire, 8 contrats) |
| `achievements.json` | 34 succès, dont 6 de collection |
| `events.json` | 6 événements |
| `season-pass.json` | 1 passe de 30 paliers |

Le contenu est **bilingue** : chaque entrée porte `name`/`description` en français
et `nameEn`/`descriptionEn` en anglais. Le chargeur dérive une variante complète de
la configuration par langue, si bien que `getConfig(locale)` renvoie des entrées dont
`name` est déjà traduit — aucun des points d'affichage n'a à s'en occuper. Un
test échoue si une entrée n'a pas sa traduction. Les traductions d'interface
vivent dans `src/i18n/locales/{fr,en}.json` plus un **fragment par
fonctionnalité** (`locales/fr/history.json`, `alerts.json`, `collection.json`…),
fusionnés au chargement.

Ils sont validés par Zod **avec vérification croisée** : une recette référençant un
ingrédient inexistant, un animal exigeant un bâtiment absent, une quête ciblant une
culture inconnue ou un atelier qui ne liste pas une de ses recettes dans
`unlocksRecipes` empêchent le démarrage, avec un message précis.

**Rechargement à chaud** : `/admin reload-config`, propagé à tous les shards. Si la
nouvelle configuration est invalide, elle est **rejetée** et l'ancienne reste
active — un JSON mal formé ne peut pas mettre le bot à terre.

Après toute modification, exécutez `npm run balance:report` pour voir l'impact
chiffré, et `npm test` pour vérifier qu'aucun invariant d'équilibrage ni de
contenu n'est cassé. **Après un ajout de contenu** (culture, animal, recette,
objet), relancez `npm run db:seed` : les tables `*_config` portent les clés
étrangères de l'inventaire et du cheptel, sans seed les nouveautés sont
inachetables. Aucune migration n'est nécessaire.

---

## 6. Déploiement avec Docker

```bash
# Configurer
cp .env.example .env && $EDITOR .env

# Infrastructure
docker compose up -d db redis

# Schéma et données de configuration.
# Noter le suffixe `:prod` : l'image finale ne contient ni `tsx` (devDependency)
# ni les sources TypeScript, uniquement `dist/`. Les variantes sans suffixe sont
# réservées au développement.
docker compose run --rm bot npm run db:migrate:prod
docker compose run --rm bot npm run db:seed:prod
docker compose run --rm bot npm run commands:deploy:prod

# Tout démarrer
docker compose up -d

# Suivre
docker compose logs -f bot
```

L'image est construite en **quatre étapes** : dépendances, compilation (`tsc` **et**
`npm test` — une image ne se construit pas si les tests échouent), dépendances de
production seules, image finale. Résultat : ~180 Mo, sans sources TypeScript ni
outillage de développement, exécutée par un utilisateur non privilégié (uid 10001).
Le `.dockerignore` limite le contexte à ce que le `Dockerfile` copie : `src/`,
`tests/` (l'étape de build lance `npm test`), `drizzle/`, `assets/` et la
configuration TypeScript/Vitest — ni `node_modules`, ni `.git`, ni `dist/`, ni
`.env*`, ni `docs/`, ni la CI.

Le `HEALTHCHECK` interroge `/health`, qui vérifie **Discord et PostgreSQL** : un
processus vivant mais déconnecté est déclaré malsain et redémarré.

Les sprites sont montés en lecture seule depuis `./assets` : les remplacer ne
nécessite **pas** de reconstruire l'image.

### Mise à jour

```bash
git pull
docker compose build bot
docker compose run --rm bot npm run db:migrate:prod   # si une migration est arrivée
docker compose run --rm bot npm run db:seed:prod      # si du contenu est arrivé
docker compose run --rm bot npm run commands:deploy:prod   # si une commande est arrivée
docker compose up -d bot
```

### Profil shardé

Au-delà de 2 500 serveurs, Discord impose le sharding. Le service `bot-sharded`
(profil `sharded`) lance la **même image** avec `HARVESTER_ENTRYPOINT=shard` —
un process `index.js` par shard, piloté par `src/shard.ts` :

```bash
docker compose stop bot                                       # jamais les deux : même jeton, même port
docker compose --profile sharded up -d db redis bot-sharded   # nommer les services : `bot` n'a pas de profil et démarrerait sinon
```

Mémoire portée à 2 Go, `depends_on` redéclaré (jamais hérité par `extends`).
**Limite connue** : chaque shard ouvre `HTTP_PORT` ; tant que `src/index.ts` ne
réserve pas le serveur HTTP au shard 0, ce profil n'est sûr qu'avec
`SHARDING_TOTAL=1`. Procédure complète, vérifications et retour arrière :
[08 § 11](./docs/08-exploitation.md#11-bascule-en-mode-shardé).

---

## 7. Déploiement sans Docker (PM2 / systemd)

```bash
npm ci --omit=dev        # dépendances de production
npm run build            # compile vers dist/ et copie config + traductions
npm run db:migrate:prod
npm run db:seed:prod
npm run commands:deploy:prod
```

### PM2

```bash
npm install -g pm2
pm2 start dist/index.js --name harvester --time
pm2 save && pm2 startup
```

Au-delà de 2 500 serveurs, utilisez `dist/shard.js` (`npm run start:sharded`),
avec la même limite sur `HTTP_PORT` qu'en Docker :

```bash
pm2 start dist/shard.js --name harvester-shards --time
```

### systemd

```ini
# /etc/systemd/system/harvester.service
[Unit]
Description=Harvester
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=harvester
WorkingDirectory=/opt/harvester
EnvironmentFile=/opt/harvester/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now harvester
journalctl -u harvester -f
```

> **Un seul processus doit exécuter les tâches planifiées.** Si vous lancez
> plusieurs instances sans *sharding*, laissez `QUEUES_ENABLED=true` (BullMQ
> dédoublonne) ou mettez `SCHEDULER_ENABLED=false` sur toutes sauf une.

---

## 8. Commandes

74 commandes slash (`src/commands/`, 25 fichiers, chargés dynamiquement) et deux
menus contextuels. Les noms et options sont ceux publiés à Discord ; les
descriptions Discord sont en anglais, le rôle est traduit ici. **(image)** =
réponse illustrée avec texte alternatif, repli texte automatique ;
**(éphémère)** = visible du seul joueur.

### Démarrage et compte

| Commande | Rôle |
|---|---|
| `/start [code]` | Créer sa ferme ; code de parrainage optionnel |
| `/tutorial` | Guide interactif pas à pas |
| `/help [category]` | Aide interactive |
| `/lang [language]` | Changer la langue de l'interface (français / anglais) |
| `/profile [user]` | Carte de profil **(image)** — bannière selon le prestige, anneau selon le niveau |
| `/stats [user]` | Statistiques détaillées |
| `/settings [dm-notifications] [language] [privacy] [timezone] [compact-mode] [channel-reminders]` | Préférences : notifications MP, langue, confidentialité, fuseau, mode texte intégral, rappels dans le salon du serveur |
| `/account export\|delete` | **RGPD** — `export` : fichier JSON de tout ce que le bot conserve (1 fois par heure) ; `delete` : suppression du compte après confirmation (bouton valable 15 min), refusée tant qu'il reste des annonces actives, des échanges en cours ou la direction d'une coopérative |
| `/apikey create\|list\|revoke` | Clés personnelles pour l'API publique en lecture |
| `/webhook create\|list\|delete\|test` | Webhooks sortants signés (récolte prête, enchère remportée, alerte de prix) |

### Ferme

| Commande | Rôle |
|---|---|
| `/farm [user]` | Vue de la ferme **(image)** |
| `/plant <seed> [plot] [quantity]` | Semer |
| `/harvest [plot]` | Récolter une parcelle ou tout ce qui est prêt |
| `/water [plot]` | Arroser |
| `/fertilize <fertilizer> [plot]` | Fertiliser |
| `/weed [plot]` | Désherber (et récupérer de quoi composter) |
| `/treat <plot>` | Traiter une parcelle infestée |
| `/plots` | État détaillé des parcelles et du sol |
| `/buy-plot` | Débloquer la parcelle suivante |
| `/crops [rarity] [season]` | Encyclopédie des cultures |
| `/fish` | Pêcher à l'étang, minijeu de timing **(image)** — niveau 18 |
| `/mine` | Miner un peu plus profond **(image)** — niveau 22 |

### Élevage

| Commande | Rôle |
|---|---|
| `/animals` | La basse-cour, enclos par enclos **(image)** — au plus 24 bêtes visibles, pastilles seulement si une action est possible, variantes ✨ shiny / 🌟 dorée signalées |
| `/buy-animal <species> [quantity]` | Acheter (1 à 10) — annonce une variante rare et les succès de collection |
| `/feed [animal]` | Nourrir un animal ou tous |
| `/collect [animal]` | Collecter les produits |
| `/heal <animal>` | Soins vétérinaires |
| `/pet <animal>` | Caresser : plus heureux, plus productif |
| `/breed <parent1> <parent2>` | Reproduction (deux parents shiny transmettent plus souvent) |
| `/sell-animal <animal>` | Vendre (60 % du prix, selon la santé ; ×3 pour une dorée) |

### Économie

| Commande | Rôle |
|---|---|
| `/shop [category]` | Boutique du village, stock quotidien |
| `/buy <item> [quantity]` | Acheter |
| `/sell <item> [quantity]` | Vendre au village (`quantity` = nombre ou `all`) |
| `/market [category]` | Cours et tendances |
| `/market-history <item>` | Graphique de prix **(image)** |
| `/alert create\|list\|delete` | **Alertes de prix** : un MP quand le marché passe au-dessus ou en dessous d'un seuil — 5 alertes, 14 jours, seuil borné aux limites réelles du marché ; `delete` accepte les 8 premiers caractères de l'identifiant **(éphémère)** |
| `/history [type] [days] [page]` | **« Où sont passées mes pièces ? »** — le journal du joueur par famille (ventes, achats, récompenses, enchères, échanges, banque, coopérative, taxes, autre), sur 1/7/30/90 jours, 10 lignes par page, entrées/sorties/net en tête, contrepartie nommée **(éphémère)** |
| `/balance [user]` | Monnaies |
| `/bank balance\|deposit\|withdraw\|upgrade` | Banque |
| `/gift <user> <amount>` | Don (taxé 5 %, plafond quotidien) |
| `/auction list\|sell\|buy\|my-listings\|cancel` | Hôtel des ventes |
| `/order create\|list\|cancel` | Ordres d'achat permanents sur l'hôtel des ventes |
| `/trade <user>` | Échange direct sécurisé |
| `/black-market` | Marché noir tournant, stock très limité, niveau 30 |

### Inventaire et transformation

| Commande | Rôle |
|---|---|
| `/inventory [category] [page]` | Inventaire paginé |
| `/item <name>` | Fiche détaillée |
| `/use <item> [quantity]` | Consommer |
| `/discard <item> <quantity>` | Jeter |
| `/craft <recipe> [quantity]` | Lancer une production |
| `/recipes [category]` | Recettes, par atelier |
| `/production` | Productions en cours et collecte |
| `/buildings [build]` | Vos bâtiments ; construire ou améliorer |

### Progression

| Commande | Rôle |
|---|---|
| `/quests [type]` | Quêtes en cours |
| `/reroll-quest <quest>` | Relance payante d'une quête journalière |
| `/achievements [category]` | Succès |
| `/collection [kind] [page]` | **La collection du fermier** : cultures, produits, animaux, poissons, minerais, variantes — progression par famille, entrées inconnues masquées « ??? », six succès dédiés |
| `/companion list\|equip\|unequip` | Compagnons cosmétiques, débloqués par niveau |
| `/pass` | Passe saisonnier |
| `/daily` | Récompense quotidienne et série |
| `/vote` | Récompense de vote top.gg |
| `/prestige` | Renaissance (niveau 60) |

### Social

| Commande | Rôle |
|---|---|
| `/coop create\|join\|leave\|info\|members\|invite\|kick\|promote\|treasury\|contribute\|objectives` | Coopératives |
| `/leaderboard [type] [scope]` | Classements **(image)** |
| `/visit <user>` | Visiter une ferme |
| `/assist <user>` | Aider (gain mutuel) |
| `/referral` | Votre code et vos filleuls |
| `/postcard [caption]` | **Carte postale** de votre ferme, publiée dans le salon **(image)** — légende de 60 caractères, un envoi toutes les 10 minutes |

### Monde

| Commande | Rôle |
|---|---|
| `/weather` | Météo du jour et effets |
| `/season` | Saison en cours |
| `/event` | Événement actif |
| `/almanac` | **Almanach** : aujourd'hui gratuit, la prévision exacte de demain contre `150 + 12 × niveau` 🪙 **(éphémère)** |
| `/encyclopedia <term>` | Recherche universelle |

### Administration

| Commande | Qui | Rôle |
|---|---|---|
| `/server reminders\|status` | Membres avec la permission **Gérer le serveur** (revérifiée à l'exécution), serveur uniquement | `reminders channel:#salon [every:1..1440]` regroupe les rappels des joueurs du serveur qui ont activé `/settings channel-reminders:true` en **un** message par lot ; `reminders off:true` arrête ; `status` affiche la configuration. Le bot vérifie ses permissions sur le salon avant d'enregistrer. |
| `/admin give\|take` | `BOT_OWNER_IDS` | Ajuster les ressources d'un joueur (écriture compensatoire au journal, motif journalisé) |
| `/admin reset <user> <reason>` | `BOT_OWNER_IDS` | Réinitialiser un joueur |
| `/admin eco-ban <user> <duration> <reason>` | `BOT_OWNER_IDS` | Bannissement économique |
| `/admin maintenance <enabled> [message]` | `BOT_OWNER_IDS` | Mode maintenance, propagé à tous les shards |
| `/admin announce` | `BOT_OWNER_IDS` | Annonce globale (modal) |
| `/admin reload-config` | `BOT_OWNER_IDS` | Recharger le gameplay à chaud |
| `/admin stats` | `BOT_OWNER_IDS` | Tableau de bord : économie, inflation, jobs |
| `/admin lookup <user>` | `BOT_OWNER_IDS` | Journal d'audit d'un joueur |
| `/admin market-update` | `BOT_OWNER_IDS` | Forcer une mise à jour du marché (et l'évaluation des alertes) |
| `/serverkit styles` | `BOT_OWNER_IDS` **uniquement** (le drapeau `is_admin` ne suffit pas), serveur uniquement | Galerie des 10 polices Unicode et des 5 cadres disponibles pour les noms |
| `/serverkit preview [server] [language] [font] [frame]` | idem | Plan complet du serveur, à blanc : ➕ à créer, ✅ déjà en place |
| `/serverkit build [server] [scope] [existing] [community] [language] [font] [frame]` | idem | Bâtit le serveur communautaire : 23 rôles, 7 catégories, 43 salons, permissions, réglages, panneaux. Confirmation par bouton, rapport final, écrit dans `audit_logs` |
| `/serverkit wipe scope:kit\|all [server_name] [server]` | idem | Supprime ce que le kit a posé (`kit`) ou tout le serveur (`all`, nom du serveur exigé). Confirmation par bouton |

### Menus contextuels

Clic droit sur un membre → **View farm** · **Propose a trade**.

---

## 9. Exploitation au quotidien

Le carnet d'incidents — par symptôme, avec les requêtes et commandes exactes —
est dans [08 — Exploitation](./docs/08-exploitation.md). Ce qui suit est la
routine.

### Points de contrôle HTTP

| Route | Rôle |
|---|---|
| `GET /health` (ou `/healthz`) | Discord **et** PostgreSQL (Redis rapporté mais non bloquant) — utilisé par Docker |
| `GET /ready` | Prêt à recevoir du trafic (commandes chargées) |
| `GET /metrics` | Prometheus : compteurs, erreurs **par code**, latences par commande, pool de rendu, économie — jeton `HTTP_METRICS_TOKEN` si renseigné |
| `GET /api/v1/*` | API publique en lecture, à clé — voir [07 — API publique](./docs/07-api-publique.md) |
| `POST /api/v1/topgg` | Webhook de vote top.gg (secret `TOPGG_WEBHOOK_SECRET`) |

### Métriques et tableau de bord

`ops/grafana/harvester-dashboard.json` est un tableau Grafana importable
(`uid` `harvester-observability`, variables *datasource* et *instance*) :
interactions/s, `harvester_errors_total{code,kind}`, p50/p95/p99 de
`harvester_command_duration_seconds{command}` avec la ligne des 3 s de Discord
(seaux 0,05 → 10 s, dont 2,5 et 5), `harvester_component_duration_seconds{namespace}`,
`harvester_render_workers/busy/queued`, masse monétaire, ratio faucet/sink
(seuil à 1), écarts de journal, joueurs suspects. Les étiquettes sont bornées à
la source (codes d'erreur de `GameErrorCode`, noms de commandes du registre,
namespaces enregistrés ; tout le reste sous `other`). Import et configuration
de scrape : [ops/grafana/README.md](./ops/grafana/README.md).

### Sauvegardes

```bash
# Sauvegarde
docker compose exec -T db pg_dump -U harvester harvester | gzip > backup-$(date +%F).sql.gz

# Restauration
gunzip -c backup-2026-07-26.sql.gz | docker compose exec -T db psql -U harvester harvester
```

Redis ne contient que du cache, des cooldowns, des verrous et des files : sa
perte est sans conséquence sur les données de jeu. **PostgreSQL est la seule
source de vérité à sauvegarder.**

### Surveiller l'économie

```sql
-- Écarts entre solde et grand livre. La vue filtre déjà : elle doit être VIDE.
SELECT * FROM ledger_integrity;

-- Masse monétaire et flux, heure par heure
SELECT captured_at, total_coins, coins_created, coins_destroyed, ledger_mismatches, suspicious_users
FROM economy_snapshots ORDER BY captured_at DESC LIMIT 24;
```

`/admin stats` donne la même chose depuis Discord. Le job `economy:snapshot`
(chaque heure) vérifie le grand livre des joueurs actifs et journalise tout
écart (`audit_logs`, `ledger_mismatch`) ; le taux d'inflation quotidien est
comparé à 8 % (`economy.inflationAlertDailyGrowth`). Depuis Prometheus :
`harvester_economy_ledger_mismatches`, `harvester_economy_faucet_sink_ratio`.

### Journal comptable : soldes d'ouverture et purge

`transactions` est immuable mais **purgeable** : le 1er de chaque mois
(`ledger:checkpoint`, 05:00 UTC) fige par joueur un solde d'ouverture, et chaque
nuit (`maintenance:cleanup`, 04:00 UTC) supprime les écritures couvertes par un
checkpoint plus vieux que `economy.ledger.retentionMonths` (12 mois) — jamais
sans checkpoint, jamais pour un joueur en écart. La première purge s'étale sur
plusieurs nuits (200 000 lignes par nuit). Détails :
[03 § 1.5](./docs/03-base-de-donnees.md#15-rétention-du-journal-comptable--soldes-douverture),
suivi : [08 § 12](./docs/08-exploitation.md#12-journal-comptable--première-purge-et-surveillance).

### Mode maintenance

```
/admin maintenance enabled:true message:Migration en cours, retour dans 10 minutes
```

Toutes les commandes de jeu répondent alors par un message d'attente ; `/admin`
reste accessible. L'ordre est diffusé à tous les shards par Redis.

### Rappels dans un salon

Beaucoup de joueurs ferment leurs MP. Un gestionnaire du serveur peut désigner
un salon (`/server reminders channel:#rappels every:10`) ; chaque joueur qui
veut y être mentionné active `/settings channel-reminders:true`. Un message par
salon et par tranche de `every` minutes, 20 joueurs au plus par message, aucune
mention hors de cette liste ; salon supprimé ou permissions retirées → retour
automatique aux MP.

### Serveur communautaire clé en main

`/serverkit build` pose, sur le serveur où la commande est tapée, tout le
serveur communautaire de Harvester : rôles d'équipe, distinctions, rangs et
rôles de notification, catégories, salons textuels, forums, annonces, vocaux,
salons d'équipe cachés, permissions, réglages (salon système, salon AFK,
`@everyone` privé du droit de mentionner tout le monde), mode Communauté, et les panneaux d'accueil (bienvenue,
règlement, rôles en libre-service par boutons, guide, FAQ, mémo d'équipe).

- **Aucun tiret.** Discord remplace l'espace d'un salon textuel par `-` ; le kit
  soude les mots par `・` et écrit les noms en police Unicode « fancy »
  (`👋・𝐛𝐢𝐞𝐧𝐯𝐞𝐧𝐮𝐞`, `「👋」ᴡᴇʟᴄᴏᴍᴇ`…). `/serverkit styles` montre les 10 polices
  et les 5 cadres ; la palette des rôles est celle de `render/brand.ts`.
- **Prérequis.** Le rôle du bot doit avoir **Administrateur** le temps du
  chantier (poser des surcharges de permissions exige de détenir chaque droit
  accordé) et être placé en haut de la liste des rôles. Le droit peut être
  retiré ensuite : les salons gardent une surcharge propre au bot.
- **Cible.** Avec `DISCORD_DEV_GUILD_ID`, les commandes n'existent que sur le
  serveur de développement : `/serverkit` n'apparaîtrait pas sur le serveur neuf
  à bâtir. Invitez-y le bot, puis lancez la commande depuis le serveur de
  développement avec `server:<identifiant du serveur>`.
- **Rejouable.** Un salon est reconnu par l'empreinte de son libellé, pas par
  son nom exact : relancer avec une autre police, un autre cadre ou une autre
  langue retrouve l'existant. `existing:keep` (défaut) n'y touche pas,
  `existing:sync` le renomme, le range et refait ses droits. Discord limite à
  deux renommages par salon et par dix minutes : un troisième changement de
  style dans ce délai est consigné « timeout » et aboutit seul un peu plus tard.
- **Mode Communauté.** Le règlement et le salon des nouvelles de Discord sont
  posés d'abord, le mode activé, puis le reste : annonces, forums et scène sont
  de vrais salons du bon type dès le premier passage. Si Discord refuse
  l'activation, le kit se replie sur des salons ordinaires et le dit dans son
  rapport.
- **Contenu.** Structure dans `src/serverkit/blueprint.ts`, textes dans
  `src/i18n/locales/{fr,en}/serverkit.json` ; `/serverkit build scope:panels`
  met les panneaux à jour en place après une retouche.
- Les **dossiers de serveurs** sont propres au client de chaque membre : aucune
  API ne permet à un bot d'en créer.

### RGPD

`/account export` produit un JSON éphémère (profil, réglages, ferme, inventaire,
animaux, bâtiments, banque, progression, coopérative, clés d'API par préfixe,
webhooks sans secret, 500 dernières écritures ; sections tronquées au-delà de
8 Mo) ; `/account delete` anonymise le compte en une transaction et conserve le
journal comptable. Les deux laissent une trace dans `audit_logs`
(`account_export`, `account_delete`). Ce qui est effacé et ce qui reste :
[03 § 1.4](./docs/03-base-de-donnees.md#14-suppression-logique).

### Accessibilité

Chaque image (ferme, profil, marché, classement, étang, mine, basse-cour, carte
postale) est jointe avec une `description` de 1 024 caractères au plus, dans la
langue du joueur, lue par les lecteurs d'écran : compteurs, prochaine récolte,
parcelles à traiter, variantes rares… `/settings compact-mode:true` supprime les
images pour ceux qui préfèrent le texte. La palette est tenue au contraste WCAG
(4,5:1 texte courant, 3:1 grands chiffres) par `tests/render-contrast.test.ts`.

---

## 10. Développement

```bash
npm run dev              # rechargement à chaud (tsx watch)
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint (règles standard + règles maison, voir ci-dessous) ; lint:fix corrige ce qui peut l'être
npm test                 # 494 tests en 23 fichiers — aucune infrastructure requise
npm run test:coverage    # couverture (seuil 70 % sur src/game/**, src/utils/**, src/config/index.ts)
npm run test:integration # 38 tests en 11 fichiers contre un vrai PostgreSQL (voir ci-dessous)
npm run test:watch       # mode veille
npm run db:studio        # explorateur de base Drizzle
npm run balance:report   # tables d'équilibrage (lit .env, n'ouvre aucune connexion)
npm run render:preview   # écrit 6 PNG dans out/fr/ (ferme, profil, marché, classement, basse-cour, carte postale)
npm run render:preview:en # les mêmes en anglais, dans out/en/
npm run render:matrix    # 26 cas limites dans out/matrix/ : grilles 3×3, 8×8 et entre paliers, météos, mutations, prestiges, marché, étang ×4 saisons, mine
npm run brand            # régénère l'avatar et la bannière du bot
npm run commands:clear   # retire les commandes publiées
```

**ESLint** : `eslint.config.js` (flat config, `@eslint/js` + `typescript-eslint`
avec information de types) porte, en plus des règles standard, des règles maison
qui encodent les invariants du projet — pas de `Math.round`/`Math.ceil` sur de la
monnaie (`src/game/money.ts` arrondit dans le bon sens), `allowOverflow: true`
justifié par un commentaire, réponses aux interactions via le framework — et
refuse les directives `eslint-disable` inutilisées. `npm run lint` fait partie du
job `verify` de la CI.

### Intégration continue

`.github/workflows/ci.yml`, sur chaque `push` et `pull_request`, deux jobs en
parallèle, **aucun secret requis** (les jetons Discord sont des valeurs de
remplacement posées par `tests/setup-env.ts` et `tests/integration/env.ts`) :

| Job | Étapes | Délai |
|---|---|---|
| `verify` | `npm ci`, `typecheck`, `lint`, `test`, `test:coverage` (seuil 70 % de `vitest.config.ts`), `build`, `npm audit --audit-level=high` (**bloquant** : les vulnérabilités modérées d'un outil de développement ne gèlent pas les fusions, Dependabot les remonte) | 15 min |
| `integration` | services `postgres:16-alpine` et `redis:7-alpine` (variables `POSTGRES_*`/`REDIS_PORT`, les mêmes que `.env.example`), puis `npm run test:integration` — les fichiers Testcontainers utilisent le démon Docker du runner | 25 min |

Un seul run par branche : un nouveau push annule celui en cours (groupe
`head_ref || ref_name`, pour qu'un push et la PR qu'il alimente ne tournent pas
deux fois). `.github/dependabot.yml` ouvre chaque lundi 07:00 (Europe/Paris) une
PR groupée pour les mineures et correctifs npm, une PR par majeure, et une PR
groupée pour les actions GitHub.

### Tests d'intégration

`npm test` ne touche NI base NI Redis : c'est ce qui permet de l'exécuter dans
l'étape de build Docker. Mais une partie des bugs du projet ne vit pas dans la
logique de jeu — elle vit dans le comportement du moteur : sémantique de
`RETURNING`, portée d'un `UPDATE … FROM`, invariant `SUM(transactions) = coins`,
remboursement d'une mise détrônée, révision d'un échange. Aucune relecture ne
les voit. `npm run test:integration` les cible, en deux mécaniques :

- **Base partagée** (`tests/integration/global-setup.ts`) : la suite crée sa
  PROPRE base (`<POSTGRES_DB>_test`, `TEST_DATABASE_URL` pour pointer
  ailleurs), y applique toutes les migrations avec le runner du projet, puis la
  peuple des tables de configuration. Elle refuse de démarrer si le nom de base
  ne contient pas « test » — elle fait un `TRUNCATE` entre chaque test.
  Fichiers : `auction`, `ledger`, `ledger-retention`, `notifications`, `prestige`.
- **Piles hermétiques** (`tests/integration/stack.ts`, Testcontainers) : chaque
  fichier démarre ses propres conteneurs PostgreSQL 16 et Redis 7, pose
  `DATABASE_URL`/`REDIS_URL` **avant** tout import de `src/**` (l'environnement
  est figé au premier import de `src/config/env.ts` — d'où des imports
  dynamiques après `startIsolatedStack()`), attend le **second** « ready » de
  PostgreSQL (l'image lance un serveur temporaire pour créer la base), joue
  `migrate()` puis `seed()`, et à l'arrêt ferme les connexions **puis** les
  conteneurs. Un helper `gameErrorCodeOf()` exige un code de `GameError`
  précis plutôt qu'un rejet quelconque. Fichiers : `harvest-concurrency` (deux
  `/harvest` simultanés n'en produisent qu'un — `SELECT … FOR UPDATE`),
  `standing-order-cancel`, `auction-double-refund`, `trade-revision`,
  `gift-cap-concurrent` (un `it.todo` nomme la correction attendue : le
  plafond de dons se lit hors verrou), `warehouse-capacity`. Il ne leur faut
  qu'un démon Docker.

Effet de bord utile : chaque exécution est une répétition générale des migrations
en attente, sur une base vierge.

### Organisation du code

```
src/
├── commands/      26 fichiers. Parse les options, appelle un service, rend une vue. Jamais de SQL.
├── components/    buttons/ selects/ modals/ — chargés dynamiquement par nom de dossier
├── services/      Règles + transactions. Ne connaît pas discord.js.
├── repositories/  SQL uniquement. Ne connaît aucune règle de jeu.
├── game/          Moteur PUR : aucune E/S, entièrement testable
├── render/        Génération d'images canvas (pool de workers, alt-text, scenery partagé)
├── jobs/          17 tâches planifiées (definitions.ts), ordonnanceur BullMQ, worker de notifications
├── http/          /health, /metrics (registre Prometheus maison), /api/v1
├── i18n/          fr.json, en.json + fragments fr/*.json, en/*.json
├── serverkit/     /serverkit : plan du serveur communautaire, noms sans tiret, constructeur, panneaux
└── framework/     Registre, pipeline d'interaction, vues partagées, cooldowns
```

La règle de dépendance est stricte :
`commands → services → repositories → db`, et `game/` n'importe rien d'autre que
lui-même. C'est ce qui permet aux tests rapides de tourner **sans base de
données** ; `tests/integration/` est le seul endroit qui en démarre une,
volontairement séparé (`npm run test:integration`).

### Ajouter une culture

1. Ajoutez une entrée dans `src/config/gameplay/crops.json` avec sa `form` (neuf
   silhouettes) et sa `palette` (les graines et récoltes correspondantes sont
   **dérivées automatiquement** — pas d'objets à créer à la main).
2. Donnez-lui un débouché dans `recipes.json` et listez la recette dans
   `unlocksRecipes` de son atelier (`buildings.json`).
3. `npm run balance:report` pour vérifier le profit horaire par rapport aux voisines.
4. `npm test` — les invariants d'équilibrage et de contenu sont testés (rareté ↔
   palier de niveau, ≤ 7 niveaux sans déblocage, une repousseuse par saison, emoji
   unique…). Le succès « Herbier complet » compte les cultures : relevez son seuil.
5. `npm run db:seed` pour propager dans `crops_config`.
6. Optionnel : déposez `assets/sprites/crops/<clé>_1.png` à `_5.png`.

Même chemin pour un animal (`animals.json` : `form`, `palette`, produit propre
dans `items.json`, bâtiment existant) — aucun aliment nouveau, la liste des
fournitures est codée dans `market.service.ts`.

Aucune ligne de code à écrire.

---

## 11. Dépannage

| Symptôme | Cause et solution |
|---|---|
| **Les commandes n'apparaissent pas** (ou pas `/history`, `/alert`, `/almanac`, `/collection`, `/postcard`, `/server`, `/account` après une mise à jour) | Les commandes globales mettent jusqu'à 1 h à se propager, et une nouvelle commande n'existe pour Discord qu'après `npm run commands:deploy`. Définissez `DISCORD_DEV_GUILD_ID` et relancez : la publication par serveur est instantanée. Vérifiez aussi que le scope `applications.commands` était bien coché à l'invitation. |
| **Les nouvelles cultures, bêtes ou recettes sont invisibles ou inachetables** | `npm run db:seed` n'a pas été relancé : les tables `*_config` portent les clés étrangères. |
| **`Invalid environment` / `Configuration invalide` au démarrage** | Zod indique le champ fautif et pourquoi. Comparez avec `.env.example`. |
| **`ECONNREFUSED` PostgreSQL/Redis** | Services non démarrés (`docker compose up -d db redis`) ou `DATABASE_URL`/`REDIS_URL` pointant vers `localhost` depuis un conteneur — utilisez `db` et `redis`. |
| **`tsx: not found`** | Vous avez lancé un script de développement dans l'image de production. Celle-ci ne contient que `dist/` : utilisez les variantes `db:migrate:prod`, `db:seed:prod`, `commands:deploy:prod`. |
| **`failed to bind host port`** | Un autre service occupe déjà 6379 ou 5432 sur l'hôte. Changez le port publié dans `.env` (`REDIS_PORT=6380`, `POSTGRES_PORT=5433`). Le bot passe par le réseau Docker interne et n'est pas concerné. |
| **`relation "users" does not exist`** | `npm run db:migrate` n'a pas été exécuté. |
| **Le migrateur refuse de démarrer** | Un fichier `.sql` déjà appliqué a été modifié : le hash ne correspond plus. C'est intentionnel. Restaurez le fichier et créez une **nouvelle** migration — [08 § 8](./docs/08-exploitation.md#8-migration-à-rejouer). |
| **`EADDRINUSE` en boucle en profil shardé** | Chaque shard ouvre `HTTP_PORT` : limite connue, `SHARDING_TOTAL=1` avec ce profil — [08 § 3](./docs/08-exploitation.md#3-shard-qui-ne-revient-pas). |
| **Emoji en carrés dans les images** | Police couleur absente : `apt install fonts-noto-color-emoji`. Les indicateurs critiques (prêt, arrosage, nuisibles, météo, monnaies) sont dessinés en vectoriel et ne sont **jamais** affectés. |
| **Images non générées** | Budget `RENDER_TIMEOUT_MS` dépassé, file de rendu saturée ou pool indisponible : le bot bascule silencieusement en embed texte. `LOG_LEVEL=debug` et `harvester_render_*` sur `/metrics` — [08 § 5](./docs/08-exploitation.md#5-file-de-rendu-saturée). |
| **`balance:report` refuse de démarrer** | Il lit `.env` : les quatre variables obligatoires suffisent (aucune connexion n'est ouverte). |
| **Tâches exécutées deux fois** | Plusieurs processus avec `QUEUES_ENABLED=false`. Passez à `true` (BullMQ dédoublonne) ou `SCHEDULER_ENABLED=false` partout sauf sur une instance. |
| **Un joueur ne reçoit plus ses rappels** | Ses MP sont fermés (Discord 50007) : le bot a passé `dm-notifications` à `false` et ne le réactive jamais lui-même — `/settings dm-notifications:true`, ou les rappels en salon (§ 9). |
| **Les votes top.gg ne créditent pas** | `TOPGG_WEBHOOK_SECRET` vide, ou le chemin `/api/v1/topgg` n'est pas exposé par le proxy — [08 § 7](./docs/08-exploitation.md#7-topgg-qui-ne-crédite-pas). |
| **`Unknown interaction`** | Traitement dépassant 3 s sans `defer`. Le framework `defer` systématiquement (`deferBeforeContext` pour les commandes qui créent le compte) ; si cela survient, c'est une commande ajoutée hors du pipeline. |

---

## 12. Documentation

| Document | Contenu |
|---|---|
| [01 — Cahier des charges](./docs/01-cahier-des-charges.md) | Périmètre fonctionnel, décision ferme globale, règles de jeu |
| [02 — Architecture](./docs/02-architecture.md) | Pile, arborescence commentée, flux d'interaction, transactions, montée en charge |
| [03 — Base de données](./docs/03-base-de-donnees.md) | 58 tables, stratégie de clés, verrouillage, immuabilité et rétention du journal, index, migrations |
| [04 — Équilibrage](./docs/04-equilibrage.md) | Toutes les tables chiffrées (cultures, animaux, variantes, recettes, consommables, poissons, minerais, progression, alertes, almanach) et leur justification |
| [05 — Pipeline d'assets](./docs/05-pipeline-assets.md) | Silhouettes et palettes, conventions de nommage, formats, texte alternatif, cache, prévisualisation |
| [06 — Roadmap](./docs/06-roadmap.md) | Ce qui est livré (v2.1 → v2.8, v3.2) et ce qui a été retenu, extensions à venir, dette technique |
| [07 — API publique](./docs/07-api-publique.md) | Authentification, endpoints, webhooks sortants (`crop_ready`, `auction_won`, `price_alert`), webhook entrant top.gg |
| [08 — Exploitation](./docs/08-exploitation.md) | Carnet d'incidents par symptôme, bascule en mode shardé, suivi du journal comptable |
| [ops/grafana](./ops/grafana/README.md) | Tableau Grafana importable et configuration de scrape Prometheus |

---

<div align="center">
<sub>Bon jeu. 🌱</sub>
</div>
