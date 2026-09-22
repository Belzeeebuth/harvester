# 02 — Architecture technique

> Comment le bot est construit, et pourquoi ainsi. Le *quoi* est dans
> [01 — Cahier des charges](./01-cahier-des-charges.md). Le schéma de données a
> son propre document, [03 — Base de données](./03-base-de-donnees.md) ; ce qui
> est dit ici de la base n'en est que le résumé nécessaire. Chaque nom de
> fichier, de fonction, de clé de tâche et de métrique cité ci-dessous existe
> dans `src/` au moment de la relecture.

---

## 1. Pile technique et arbitrages

| Composant | Choix | Version installée |
|---|---|---|
| Exécution | Node.js (`engines: >=22.19`) | 22 LTS |
| Langage | TypeScript `strict` + `noUncheckedIndexedAccess` | 5.9 |
| Discord | discord.js | 14.27 |
| Base | PostgreSQL | 16 |
| Cache / verrous / files | Redis | 7 |
| ORM | **Drizzle ORM** + `node-postgres` (`pg` 8.22) | 0.45 |
| Files planifiées | BullMQ (repli minuteur) | 5.81 |
| Client Redis | ioredis | 5.11 |
| Validation | Zod | 4.4 |
| Journalisation | Pino | 10.3 |
| Images | `@napi-rs/canvas` | 1.0 |
| Dates | Luxon | 3.7 |
| HTTP sortant (webhooks) | undici | 6 |
| Tests | Vitest + Testcontainers | 4.1 / 12.0 |
| Lint | ESLint + typescript-eslint | 10 / 8 |

### 1.1 Drizzle plutôt que Prisma — décision

Les deux ont été considérés sérieusement. Drizzle l'emporte sur quatre points
concrets pour *ce* projet :

1. **`SELECT … FOR UPDATE` de première classe.** `.for('update')` est natif. Prisma
   n'expose pas le verrouillage de ligne hors `$queryRaw`. Comme *toute* opération
   économique de ce bot en dépend, le point est décisif.
2. **Pas de génération de code, pas de moteur binaire.** Le projet compile et
   s'exécute hors ligne : `tsc --noEmit`, `vitest`, `render:preview`,
   `render:matrix` et `balance:report` fonctionnent **sans base de données ni
   téléchargement** (`src/scripts/offline-env.ts` pose les variables
   obligatoires). Avec Prisma, `prisma generate` est un préalable à toute
   vérification de type.
3. **Image Docker plus légère** : pas de moteur de requête natif à embarquer
   (~50 Mo de moins).
4. **SQL lisible.** Les requêtes complexes (agrégats de classement, `@>` sur JSONB,
   `LEFT JOIN LATERAL` des checkpoints, `DISTINCT ON`) s'écrivent en SQL balisé et
   typé, sans se battre contre un langage de requête intermédiaire.

Ce que Prisma aurait apporté et qu'on assume perdre : Prisma Studio (compensé par
`drizzle-kit studio`) et un moteur de migration plus opiniâtre (compensé par un
runner maison, § 6.3).

### 1.2 Pousse calculée à la lecture — décision fondamentale

**Aucun tick global n'existe.** À la plantation on écrit `planted_at` et `ready_at`
(calculé une fois, avec les modificateurs actifs). L'état d'une culture est
**dérivé** au moment où on la lit :

```ts
// src/game/growth.ts (extrait)
const elapsed  = now - plantedAt;
const total    = readyAt - plantedAt;
const progress = Math.min(1, Math.max(0, elapsed / total));
// stades : withered → ready (progress ≥ 1) → planted (< 0,25) → sprouting (< 0,5)
//          → growing (< 0,8) → maturing
```

Pourquoi c'est le bon choix, chiffres à l'appui :

| | Tick global | Calcul à la lecture |
|---|---|---|
| Écritures pour 50 000 joueurs × 50 parcelles, tick à la minute | **2 500 000 UPDATE/min** | **0** |
| Écritures réelles | à chaque tick | uniquement lors d'une action du joueur |
| Coût d'un joueur inactif | identique à un joueur actif | **nul** |
| Dérive si le bot est arrêté 2 h | les cultures ne poussent pas — il faut un rattrapage | aucune, `now - planted_at` est toujours exact |
| Plusieurs *shards* | doivent se coordonner pour ne pas ticker deux fois | aucune coordination nécessaire, la lecture est pure |
| Testabilité | il faut simuler le temps | il suffit de passer un `now` en paramètre |

Le même principe s'applique aux **jauges des animaux** (`projectAnimal`,
`src/game/animals.ts`, depuis `stats_updated_at`), à l'**énergie**
(`src/game/energy.ts`, `energy + minutes × regen`), à la **fertilité et aux
mauvaises herbes** (`src/game/plot.ts`, depuis `last_harvest_at` et
`last_weeded_at`). Le corollaire est que **le temps est un paramètre explicite**
partout dans `src/game/**` : aucune fonction n'appelle `Date.now()` elle-même.
C'est ce qui rend les tests déterministes.

Les jobs planifiés ne « font pas pousser » : ils gèrent uniquement des **événements
discrets** que la dérivation ne peut pas produire (apparition de nuisibles, dégâts,
flétrissement, maladie et mort, mise à jour du marché, intérêts, notifications) et
des agrégats (instantanés, classements, checkpoints). Leur granularité peut être
grossière sans que le joueur le perçoive (§ 6).

### 1.3 Graphiques en canvas maison plutôt que `chartjs-node-canvas`

`chartjs-node-canvas` embarque Chart.js et une couche d'adaptation supplémentaire
au-dessus de canvas, pour un besoin réel très étroit : **une** courbe de prix avec
grille, repères min/max et étiquettes. La tracer directement
(`src/render/chart.ts`, 335 lignes texte alternatif compris) supprime deux
dépendances lourdes, garantit la cohérence visuelle avec les autres images (même
palette, mêmes polices, mêmes coins arrondis, briques de `canvas.ts`) et évite les
problèmes connus d'adaptation de version entre Chart.js et le backend canvas.

### 1.4 Registre Prometheus maison plutôt que `prom-client`

Trois types de métriques (compteur, jauge, histogramme) et un rendu texte ne
justifient ni une dépendance ni son registre global implicite.
`src/http/metrics.ts` implémente le format d'exposition 0.0.4, testable sans
réseau (`tests/metrics.test.ts`), avec une règle que `prom-client` ne fait pas
respecter : **toute étiquette provient d'un ensemble fermé** (§ 8).

---

## 2. Arborescence et rôle de chaque module

Générée depuis le disque (`find src -maxdepth 2`). Une ligne par module.

```
harvester/
├── src/
│   ├── index.ts                 Point d'entrée d'un process : config → DB → registre → client → Discord → jobs → pool de rendu → HTTP ; arrêt propre
│   ├── shard.ts                 ShardingManager (un process index.js par shard), pour > 2 500 serveurs
│   ├── client.ts                Client discord.js : intent Guilds seul, caches réduits, garde contre SHARD_COUNT/SHARDS invalides
│   │
│   ├── config/
│   │   ├── env.ts               Schéma Zod de l'environnement — échec au démarrage si invalide
│   │   ├── index.ts             Chargement, validation croisée, dérivation graines/récoltes, variante par langue, rechargement à chaud
│   │   └── gameplay/            10 JSON : crops (41), animals (24), items (150), recipes (49), buildings (18),
│   │       └── schemas.ts         quests (52), achievements (34), events (6), season-pass (1), balance — et leurs schémas Zod
│   │
│   ├── db/
│   │   ├── client.ts            Pool pg (TLS vérifié), withTransaction(), lockUserRow(), lockUserRows() (identifiants triés), pingDatabase()
│   │   ├── redis.ts             3 connexions (main, subscriber, queue), key() préfixée, cache JSON générique
│   │   └── schema/              14 fichiers Drizzle, 58 tables : core · farming · mining · economy · ledger · progression
│   │                            · social · collection · pets · integrations · system · config · enums · index
│   │
│   ├── game/                    ⚠ MOTEUR PUR — aucune E/S, aucun import d'env, le temps est un paramètre
│   │   ├── xp.ts                Courbe d'XP et récompenses de palier
│   │   ├── growth.ts            Stade d'une culture dérivé des horodatages
│   │   ├── harvest.ts           Rendement, qualité et mutation d'une récolte (RNG seedée)
│   │   ├── quality.ts           Modèle à exposants de la qualité
│   │   ├── plot.ts              Fertilité, herbes, tirage et conséquences des nuisibles, dégâts météo
│   │   ├── grid.ts              Géométrie de la grille (slotToCoords, gridSizeFor) et coût des parcelles
│   │   ├── modifiers.ts         Agrégat immuable des bonus d'une ferme (bâtiments, coop, prestige, boosts)
│   │   ├── money.ts             Arithmétique monétaire : assertMoney, scaleMoney (plancher), feeOf (plafond)
│   │   ├── market.ts            Mise à jour des prix par pression offre/demande
│   │   ├── world.ts             Saisons et météo globales (tirage seedé)
│   │   ├── animals.ts           Projection des jauges, production, variantes shiny/dorée
│   │   ├── energy.ts            Énergie régénérée à la lecture
│   │   ├── prestige.ts          Éligibilité et plan de renaissance (prévisualisable)
│   │   ├── coop.ts              Niveau, plafond de membres (50), bonus, gabarits d'objectifs
│   │   ├── fishing.ts           Espèce qui mord et notation du ferrage
│   │   ├── mining.ts            Profondeur maximale par formule, tirage du minerai
│   │   ├── pets.ts              Catalogue des 8 compagnons cosmétiques
│   │   ├── alerts.ts            Condition de déclenchement et bornes de seuil des alertes de prix
│   │   ├── almanac.ts           Prix et prévision exacte de la météo de demain
│   │   ├── collection.ts        Univers d'une famille confronté aux découvertes
│   │   ├── events.ts            Fenêtre courante d'un évènement récurrent (cron + durée, en UTC)
│   │   └── rng.ts               mulberry32 seedé : dailyRng (date + WORLD_SEED), liveRng
│   │
│   ├── repositories/            Accès aux données. SQL uniquement, aucune règle de jeu.
│   │   └── player · farm · inventory · economy · ledger · animal · progression · social · trade
│   │       · mining · pet · api · webhook · alert · almanac · collection · account · system
│   │
│   ├── services/                Orchestration : règles + transactions + effets de bord. Ne connaît pas discord.js.
│   │   ├── player.service.ts    ensurePlayer (création par /start), grantXp, énergie, modificateurs, profil, bannissement
│   │   ├── farm.service.ts      Squelette de transaction de référence (§ 4) : planter, arroser, récolter, fertiliser, désherber, traiter, parcelles, entraide
│   │   ├── inventory.service.ts Capacité d'entrepôt et porte d'entrée unique addItems (découvertes sous savepoint)
│   │   ├── economy.service.ts   pay/charge (grand livre), taxes, banque, dons, auditLedger, suspicion, tableau de bord
│   │   ├── ledger.service.ts    Soldes d'ouverture mensuels et purge bornée du journal (fonctions pures = spécification)
│   │   ├── market.service.ts    Marché, boutique du jour, marché noir, vente/achat, évaluation des alertes en fin de mise à jour
│   │   ├── animal.service.ts    Cheptel : achat (variantes), nourrir, collecter, caresser, soigner, vendre, reproduire
│   │   ├── craft.service.ts     Recettes, files de production, bâtiments (construction, amélioration)
│   │   ├── progression.service.ts Quêtes (4 journalières, 3 hebdo, 3 contrats, histoire), succès, passe, /daily
│   │   ├── tracker.service.ts   Suivi transverse d'une action : quêtes, succès, passe, objectifs de coop, statistiques
│   │   ├── coop.service.ts      Coopératives, trésorerie, objectifs hebdomadaires et quotidiens
│   │   ├── trade.service.ts     Hôtel des ventes, enchères, ordres permanents, échanges P2P
│   │   ├── misc.service.ts      Classements et instantanés, prestige, visites/entraide, parrainage, votes, /admin, maintenance
│   │   ├── consumable.service.ts Boosts temporaires (Redis), objets consommables, répulsif, cosmétiques
│   │   ├── modifier-cache.ts    Cache Redis des modificateurs de ferme, invalidé par bâtiments/boosts/élevage
│   │   ├── world.service.ts     État du monde : saison, météo du jour, évènements actifs (fenêtre calculée), multiplicateurs
│   │   ├── fishing.service.ts   cast/resolveHook (état de ferrage en Redis)
│   │   ├── mining.service.ts    dig/getStatus (table mine_progress)
│   │   ├── pet.service.ts       Déblocage automatique par niveau, équipement
│   │   ├── alert.service.ts     Alertes de prix : création, liste, suppression par préfixe, évaluation
│   │   ├── almanac.service.ts   Prévision payante, mémorisation Redis avec repli sur le journal
│   │   ├── history.service.ts   /history : familles de types, fenêtres, pagination, libellés
│   │   ├── collection.service.ts Enregistrement des découvertes, vue de collection
│   │   ├── reminder.service.ts  Rappels en salon : filtrage, regroupement, plafond de mentions (pur), configuration serveur
│   │   ├── account.service.ts   RGPD : export JSON borné, blocages et suppression logique en une transaction
│   │   ├── api.service.ts       Clés d'API hachées SHA-256, authentification des requêtes
│   │   ├── webhook.service.ts   Abonnements, filtre anti-SSRF, file webhook_events, livraison signée HMAC
│   │   └── cluster.ts           Pub/sub Redis inter-shards : maintenance, rechargement de configuration
│   │
│   ├── commands/                25 fichiers, 74 commandes + 2 menus contextuels. Parse, appelle un service, rend une vue. Jamais de SQL.
│   ├── components/              buttons/ (6 fichiers) · selects/ (2) · modals/ (1) — chargés dynamiquement, le dossier fixe le type
│   ├── events/
│   │   ├── interaction-create.ts Point d'entrée unique des interactions : pipeline § 3
│   │   ├── guild.ts             guildCreate/guildDelete → guild_settings
│   │   └── error-reporter.ts    Salon d'erreurs privé, dédoublonnage 5 min, 10 rapports par fenêtre, filet des exceptions non capturées
│   │
│   ├── framework/
│   │   ├── registry.ts          Chargeur dynamique (commands/, components/) ; findHandler(kind, namespace, action)
│   │   ├── interaction.ts       buildContext (maintenance, joueur, ECO_BAN_READONLY), safeReply, replyEphemeral, followUpEphemeral, classifyError, replyError
│   │   ├── ui.ts                Fabriques d'embeds, boutons, menus, pagination, modals de quantité et de texte
│   │   ├── views.ts             Vues partagées commande ⇄ composant (farmView, animalsView… — source unique de vérité)
│   │   └── cooldown.ts          Cooldowns (`SET NX PX`, balance.cooldowns prime) et limitation de débit (INCR + EXPIRE)
│   │
│   ├── render/                  Voir § 5.2
│   │   ├── index.ts             Façade : cache Redis, budget, repli, texte alternatif ; renderXImage()
│   │   ├── dispatch.ts          Table « nom de rendu → fonction », partagée thread principal / workers (RenderInputs)
│   │   ├── pool.ts              Pool de worker_threads borné, seuil dur de mise à mort, jauges
│   │   ├── worker.ts            Worker persistant : polices chargées une fois, PNG transféré (pas cloné)
│   │   ├── canvas.ts            Briques : palette, THEME_PALETTES, polices, pilules, dégradés, avatar, encodage
│   │   ├── sprites.ts           Silhouettes et palettes procédurales (cultures, animaux, badges, météo, monnaies, compagnons) ; sprite() optionnel
│   │   ├── scenery.ts           Décor partagé ferme/basse-cour : ciel, herbe, voile météo, bâtiments, palettes de saison
│   │   ├── farm.ts · profile.ts · chart.ts · leaderboard.ts · fishing.ts · mining.ts · animals.ts · postcard.ts
│   │   │                        Un rendu = renderX() + describeX() (texte alternatif pur)
│   │   ├── alt-text.ts          clampAltText (1 024), joinSentences, listSome
│   │   └── brand.ts             Avatar et bannière du bot (npm run brand)
│   │
│   ├── jobs/
│   │   ├── definitions.ts       Les 17 tâches (§ 6.1) : clé, cron UTC, description, run()
│   │   ├── scheduler.ts         BullMQ (jobs répétables dédupliqués) ou minuteurs ; registre scheduled_tasks ; runJobNow()
│   │   └── notifications.ts     Worker de MP (4/s) et de rappels en salon, sur chaque shard, réservation claimed_by
│   │
│   ├── http/
│   │   ├── health.ts            Serveur node:http sans framework : /health, /healthz, /ready, /metrics (jeton optionnel), aiguillage /api/
│   │   ├── metrics.ts           Registre Prometheus maison, étiquettes bornées (§ 8)
│   │   └── api.ts               GET /api/v1/me, /api/v1/me/coop (clé), POST /api/v1/topgg (secret)
│   │
│   ├── i18n/
│   │   ├── index.ts             translate/translatorFor, normalizeLocale, fusion des fragments, reloadCatalogs
│   │   └── locales/             fr.json · en.json + fr/*.json et en/*.json (10 fragments par fonctionnalité)
│   │
│   ├── utils/                   custom-id (buildCustomId, parseCustomId, assertOwner) · lock (withUserLock, claimOnce) · errors (GameError, gameError)
│   │                            · format · time (cycles journaliers/hebdomadaires) · logger (Pino, redaction) · uuid (v7)
│   ├── types/index.ts           Contrats du framework : Command, ComponentHandler, CommandContext — seul point de contact discord.js ⇄ jeu
│   └── scripts/                 migrate · seed · deploy-commands · balance-report · render-preview · render-matrix · generate-brand · offline-env
│
├── drizzle/                     0000_init.sql (généré) · 0001 à 0015 (écrits à la main) — 16 fichiers, voir 03 § 6
├── tests/                       23 fichiers, 494 tests sans infrastructure · integration/ : 11 fichiers, 38 tests (base réelle, Testcontainers)
├── ops/grafana/                 Tableau de bord importable et configuration de scrape
├── assets/                      brand/ (avatar, bannières) · sprites/ fonts/ banners/ vides, remplaçables à chaud
└── docs/                        01 à 08
```

### Règle de dépendance, stricte et vérifiable

```
commands ──► services ──► repositories ──► db
components ─┘     │
                  ▼
                game/ (pur)          render/ (pur, sauf la façade index.ts : cache Redis + pool)
```

- Une **commande** ne fait jamais de SQL. Elle parse, appelle un service, rend une vue.
- Un **service** ne connaît pas discord.js. Il reçoit des identifiants et des
  valeurs, renvoie des objets simples ou lève une `GameError` typée.
- Un **repository** ne connaît aucune règle de jeu. Il lit et écrit, point.
- **`src/game/**` n'importe rien** hors de lui-même et des types de
  `../config/gameplay/schemas` (lecture seule). C'est ce qui permet de le tester
  sans base, sans Redis, sans Discord.
- **`src/types/index.ts` est le seul endroit** où les types discord.js rencontrent
  ceux du jeu : une migration de bibliothèque ou un second transport (l'API HTTP
  en est un) restent localisés.
- Une règle ESLint maison (`eslint.config.js`) impose que les réponses aux
  interactions passent par le framework, et interdit `Math.round`/`Math.ceil` sur
  de la monnaie.

---

## 3. Flux d'une interaction

`src/events/interaction-create.ts` est le **point d'entrée unique**. L'ordre des
étapes compte, et il est celui du code :

```
      Discord Gateway
            │
            ▼
  events/interaction-create.ts
            │
            ├─ isAutocomplete ──► handleAutocomplete : contexte allégé, jamais de création de compte,
            │                     locale du joueur, réponse vide en cas d'erreur
            │
            ├─ recordInteraction()
            ├─ 1. LIMITATION DE DÉBIT  checkGlobalRate : 30 commandes/min, 600/h (Redis INCR+EXPIRE)
            │
            ├─ isChatInputCommand ──► handleCommand
            │     2. getCommand(name)            gestionnaire du registre
            │        dmAllowed === false ?       refus hors serveur
            │        deferBeforeContext ?        deferReply AVANT le contexte (/start crée le compte ici)
            │     4. buildContext                mode maintenance (sauf BOT_OWNER_IDS) → ensurePlayer
            │                                    (createIfMissing seulement pour /start ; touchUser en tâche de fond)
            │                                    → invité si requiresAccount === false → ECO_BAN_READONLY sinon assertNotEcoBanned
            │        adminOnly ?                 refus si !player.isAdmin
            │     5. COOLDOWN                    cooldownSecondsFor(bucket) — balance.cooldowns PRIME sur la commande ; checkAndSet
            │     6. VERROU                      withUserLock(player.id, `cmd:<nom>`)
            │     7. command.execute(interaction, context)
            │
            ├─ isButton / isStringSelectMenu / isModalSubmit ──► handleComponent(kind)
            │     parseCustomId → findHandler(kind, namespace, action) ; inconnu → « composant expiré »
            │     3. assertOwner sauf checkOwner === false
            │     4. buildContext (requiresAccount du gestionnaire) ; adminOnly
            │     6. withUserLock(player.id, handler.lockKey ?? `<namespace>:<action>`)
            │     7. handler.execute(interaction, parsed, context)
            │
            └─ isUserContextMenuCommand / isMessageContextMenuCommand ──► handleContextMenu
                  buildContext → menu.execute
```

**Réponses.** Trois aides de `src/framework/interaction.ts`, et pas d'appel direct à
`interaction.reply()` dans les commandes déférées :

- `safeReply` choisit `editReply` (déféré), `followUp` (déjà répondu) ou `reply`,
  et avale une interaction expirée (10062) en `debug` ;
- `replyEphemeral` garantit l'éphémère **même après un `deferReply()` public** :
  `editReply` ignore le drapeau, donc la réponse différée est supprimée et un
  `followUp` éphémère envoyé — c'est ce qui a corrigé les erreurs affichées à tout
  le salon (constat F-14) ;
- `followUpEphemeral` ajoute un message éphémère **sans toucher** à la vue
  différée d'un composant (`deferUpdate()`), à la différence de `replyEphemeral`.

**Erreurs.** `classifyError` distingue `MaintenanceError`, `NotOwnerError`,
`LockBusyError`, `GameError` (message traduit + indice + bouton de commande
suggérée) et tout le reste (`internal`, journalisé et remonté). `replyError`
répond en éphémère et renvoie un `ErrorReport` ; sur une commande, une
`GameError` **libère le cooldown** posé avant l'exécution (l'action n'a rien
fait), `recordError(kind, code)` alimente `harvester_errors_total`, et
`report: true` déclenche `reportIncident` vers `DISCORD_ERROR_CHANNEL_ID`. Un
`finally` mesure la durée quel que soit le dénouement
(`observeCommandDuration`, `observeComponentDuration`), avec une étiquette
bornée par le registre.

**Bannissement économique.** `ECO_BAN_READONLY` (`interaction.ts`) liste les
commandes de lecture qu'un joueur banni garde : `help`, `profile`, `stats`,
`settings`, `lang`, `crops`, `encyclopedia`, `recipes`, `item`, `leaderboard`,
`season`, `weather`, `tutorial`, `achievements`, `history`, `almanac`,
`collection`, `account`. Tout composant est une action : il est refusé.

**Point clé** : `framework/views.ts` est appelé **aussi bien** par la commande
`/farm` que par le bouton « rafraîchir ». Une vue n'existe qu'une fois. C'est ce
qui garantit qu'un bouton ne peut pas dériver de la commande qu'il prolonge.

---

## 4. Transactions et intégrité économique

Toute opération qui touche un solde suit le **même squelette en 7 étapes**,
documenté dans `src/services/farm.service.ts` (`plant`) et respecté partout :

```ts
// 1. Lecture hors transaction : configuration, calculs préparatoires, échec tôt
const crop = config.crops.get(input.cropKey);
if (!crop) throw gameError('item_unknown', …);

// 2-7 dans une seule transaction
return withTransaction(async (tx) => {
  // 2. VERROUS, dans un ordre déterministe (identifiants triés → pas d'interblocage)
  await lockUserRow(tx, player.id);
  const locked = await farmRepo.lockPlotsBySlots(tx, player.farmId, targetSlots);

  // 3. VALIDATION SOUS VERROU — on revalide tout : entre 1 et 2, l'état a pu changer
  if (locked.length === 0) throw gameError('plot_not_found', …);

  // 4. CONSOMMATION (graines, énergie — ou economyService.charge() pour un débit)
  await inventoryService.consume(player.id, seedKey, quantity, tx, player.locale);
  await consumeEnergy(player.id, 'plant', tx, …);

  // 5. PRODUCTION (écriture du résultat)
  await farmRepo.insertPlantedCrop(…, tx);
  await farmRepo.updatePlot(…, tx);

  // 6. SUIVI (quêtes, succès, passe, statistiques) — dans la MÊME transaction
  const tracking = await trackAction(context, 'plant_seed', quantity, target, tx);

  // 7. COMMIT implicite. En cas d'exception : rollback total.
});
```

Trois invariants en découlent :

1. **Le grand livre est complet.** `economyRepo.credit/debit` écrit une ligne
   `transactions` (montant signé + `balance_after`) dans la même transaction que la
   modification du solde. Il n'existe que deux chemins qui posent un solde sans
   passer par là — la création de compte et le prestige — et tous deux appellent
   `recordDirectBalanceLedger`, qui journalise la **variation** du solde (négative
   au prestige) et jamais le solde lui-même.
2. **Aucun solde négatif.** Ceinture *et* bretelles : validation applicative sous
   verrou, plus `CHECK (coins >= 0)` en base.
3. **Vérification périodique, et journal purgeable.** Le job `economy:snapshot`
   (chaque heure) appelle `auditLedger` → `findLedgerMismatches` (joueurs vus
   depuis 7 jours, 100 lignes au plus) et la vue `ledger_integrity` fait la même
   comparaison à la demande. Depuis la migration 0015 l'invariant n'est plus
   « somme depuis l'origine » mais :

   ```
   solde = ouverture(dernier checkpoint) + Σ transactions.amount WHERE id > transactions_through
   ```

   Le job mensuel `ledger:checkpoint` fige ce solde d'ouverture par joueur et
   par monnaie, **dérivé du journal** et contrôlé sous `lockUserRow` ; la purge
   nocturne (`maintenance:cleanup`) n'efface que des écritures couvertes par un
   checkpoint de plus de 12 mois, jamais pour un joueur en écart, et doit
   s'annoncer par `SET LOCAL harvester.ledger_purge = 'on'` pour franchir le
   *trigger* `reject_ledger_mutation`. Les ensembles lus par l'audit et
   supprimés par la purge sont disjoints : la vérification reste juste pendant
   la purge. Un écart est un bug ou une triche : il est journalisé
   (`audit_logs`, `ledger_mismatch`), compté dans `economy_snapshots` et exposé
   par `harvester_economy_ledger_mismatches`. Détail :
   [03 § 1.5](./03-base-de-donnees.md#15-rétention-du-journal-comptable--soldes-douverture).

**Interblocages.** Les opérations à deux joueurs (échange, don, achat HDV)
verrouillent via `lockUserRows(tx, ids)` qui **trie les identifiants** avant de
verrouiller. Deux transactions symétriques prennent donc les verrous dans le même
ordre : l'interblocage est structurellement impossible. Le job de checkpoint suit
la même règle (lots de 100 joueurs par identifiant croissant).

**Arrondis.** `scaleMoney` arrondit les gains vers le bas, `feeOf` les frais vers
le haut (`src/game/money.ts`) : l'erreur d'arrondi penche toujours du côté de
l'économie, et une règle ESLint interdit `Math.round` sur une valeur monétaire.

---

## 5. Cache, verrous, files Redis et rendu

### 5.1 Redis

Trois connexions distinctes (`src/db/redis.ts`), parce que `ioredis` bascule une
connexion en mode souscription exclusif et que BullMQ exige
`maxRetriesPerRequest: null` :

| Connexion | Usage |
|---|---|
| `main` | cache, cooldowns, verrous, boosts temporaires, modificateurs de ferme, état de ferrage, cache de rendu, fenêtres de rappel |
| `subscriber` | pub/sub inter-*shards* `harvester:cluster` (maintenance, rechargement de configuration — `services/cluster.ts`) |
| `queue` | file BullMQ `jobs` (préfixe `REDIS_PREFIX`, sans deux-points dans le nom : BullMQ le refuse) |

Toutes les clés passent par `key(...)` et portent le préfixe `REDIS_PREFIX`
(`harvester` par défaut) : plusieurs environnements peuvent partager un Redis.

**Verrou anti-double-clic** (`src/utils/lock.ts`) :
`SET harvester:lock:<action>:<user> <jeton> PX 30000 NX`. Le détenteur seul peut
relâcher — libération en **Lua** qui compare le jeton, parce qu'un `DEL`
inconditionnel supprimait le verrou d'une seconde exécution quand la première
dépassait le TTL (constat F-04). Le TTL de 30 s n'est qu'un filet en cas de
crash ; `command.execute()` tourne dans le verrou et englobe le rendu, dont le
seuil dur vaut 20 s. Repli mémoire si Redis est injoignable.

**Idempotence** : `claimOnce(token)` (`SET harvester:once:<token> NX EX 900`) pour
les livraisons répétées (webhook de vote top.gg) ; `releaseOnce` rend la marque
sur le chemin d'erreur, sinon la récompense serait perdue pour toute la fenêtre.

**Cooldowns** (`src/framework/cooldown.ts`) : `SET harvester:cd:<bucket>:<user> … PX NX`
puis `PTTL` pour le message d'attente. La table `balance.cooldowns` **prime** sur
la valeur codée dans la commande (l'ordre inverse la rendait morte), donc
modifiable à chaud. **Limitation de débit** : `INCR` + `EXPIRE` sur
`harvester:rate:cmd:m:<user>` (30/min) et `cmd:h` (600/h), le même
`consumeRate()` servant l'API publique par clé.

**Fenêtre de rappel** : `SET harvester:reminders:window:<salon> NX PX` — un
message par salon et par lot, partagé entre *shards*.

### 5.2 Couche de rendu

Huit rendus, un contrat partagé et trois garanties.

**Contrat.** `src/render/dispatch.ts` porte la table `RenderInputs`
(`farm`, `profile`, `chart`, `leaderboard`, `fishing`, `mining`, `animals`,
`postcard`) et `renderInline(kind, input)`. Ajouter un rendu sans le traiter est
une erreur de compilation (`never` exhaustif). Les entrées sont des objets simples
clonables par `postMessage` : ce sont les vues construites par les services, pas
des lignes de base.

**Pool de workers** (`src/render/pool.ts`, `worker.ts`). `@napi-rs/canvas`
dessine de façon synchrone : sur le thread principal, une ferme 8×8 immobilisait
l'event loop 200 à 800 ms — donc aussi les battements de cœur de la passerelle
Discord. `RENDER_WORKERS` threads persistants (2 par défaut, 0 à 8) chargent une
fois configuration, traductions et polices, puis traitent les demandes en série
et **transfèrent** le PNG (pas de clonage). La file est bornée à
`max(4, workers × 6)` : sous saturation on refuse (`RenderQueueFullError`) et
la commande répond en texte, plutôt que d'accumuler des images que plus personne
n'attend. Le budget `RENDER_TIMEOUT_MS` (4 s) est une attente côté appelant : le
worker termine son image, qui alimente le cache pour l'affichage suivant ; seul un
rendu bloqué au-delà du seuil dur `max(4 × budget, 20 s)` est **terminé**, worker
compris, puis remplacé. Si le pool ne peut pas démarrer (`RENDER_WORKERS=0`,
worker introuvable), la façade dessine en ligne — jamais après une saturation,
ce qui reviendrait à bloquer le thread principal au pire moment. Les workers
sont `unref` au repos et démarrés au boot (`warmRenderPool`) ; les jauges
`harvester_render_workers/busy/queued` les exposent.

**Cache** (`src/render/index.ts`). Clé `harvester:render:<kind>:<sha1(état)>`
(16 caractères hexadécimaux), valeur **binaire** (`getBuffer`, pas de base64),
TTL `RENDER_CACHE_TTL` = 120 s, pas de cache au-delà de 2 Mo. Le hash porte sur
**l'état rendu** et non sur l'identifiant : pour la ferme, la grille, chaque
parcelle (stade, échéance arrondie à la minute, fertilité par tranche de 5,
nuisible, besoin d'eau), météo, saison, niveau, pièces par tranche de 100,
compagnon ; pour la basse-cour, les pastilles **telles que l'image les décide**
et non les jauges brutes ; pour la carte postale, le jour du cachet dans le
fuseau du fermier. La **locale fait partie de l'état** : les libellés sont
dessinés dans l'image.

**Texte alternatif.** Chaque rendu expose une fonction pure `describeX()`
(`describeFarm`, `describeProfile`, `describeChart`, `describeLeaderboard`,
`describeFishing`, `describeMining`, `describeAnimals`, `describePostcard`) qui
produit la `description` de la pièce jointe Discord — ≤ 1 024 caractères
(`clampAltText`, `src/render/alt-text.ts`), fr/en, recalculée à chaque affichage
y compris quand le PNG vient du cache. `tests/render-alt-text.test.ts` les couvre.

**Dessin.** `sprites.ts` porte les silhouettes et palettes **procédurales**
(neuf formes de culture, formes d'animaux, marque de variante, badges, météo,
monnaies, compagnons) et tente d'abord un PNG de `assets/sprites/<catégorie>/`
s'il existe ; `scenery.ts` sort le décor commun à la ferme et à la basse-cour
(ciel, herbe, voile météo, palettes de saison, bâtiments) ; `canvas.ts` fournit
les briques (polices, `THEME_PALETTES`, pilules, dégradés, avatar Discord).
`render:matrix` couvre 26 cas limites et `tests/render-contrast.test.ts` tient
la palette au contraste WCAG. Pipeline détaillé en [05](./05-pipeline-assets.md).

---

## 6. Planification

### 6.1 Les 17 tâches — `src/jobs/definitions.ts`

Clé exacte, cron (UTC), ce que fait `run()`, et ce qui protège l'exécution.

| Clé | Cron | Rôle | Verrou / partage |
|---|---|---|---|
| `market:update` | `0 * * * *` (horaire) | `updateMarket()` : recalcule les prix selon offre/demande, puis évalue les alertes de prix | une écriture par objet et par heure |
| `shop:rotate` | `5 0 * * *` | `rotateShop()` + `rotateBlackMarket()` : boutique du jour et marché noir | tirage déterministe (`dailyRng`, `WORLD_SEED`) |
| `world:weather` | `0 0 * * *` | `ensureSeasonCalendar()` puis `getWorldState()` : météo du jour, saison courante | `weather.day` UNIQUE, tirage seedé identique sur tous les shards |
| `farm:pests` | `0 */2 * * *` | 500 parcelles candidates : apparition de nuisibles (météo, répulsif, herbes), dégâts météo atténués par la serre, notification `crop_withering` | `dedupe_key` par parcelle et par jour ; réductions mémorisées par joueur et par ferme |
| `farm:pest-consequences` | `30 */2 * * *` | 300 parcelles dont l'échéance est passée : pénalité de rendement, flétrissement éventuel, nuisible effacé | — |
| `farm:wither` | `15 * * * *` | `witherOverdueCrops` : 500 cultures laissées trop longtemps | — |
| `animals:decay` | `0 */3 * * *` | 500 bêtes non matérialisées depuis 3 h : `projectAnimal`, maladie, mort, notifications `animal_hungry` / `animal_sick` | `dedupe_key` par bête (et par jour pour la faim) |
| `crops:ready-notify` | `*/10 * * * *` | 300 cultures prêtes : notification `crop_ready` et évènement webhook `crop_ready` | `dedupe_key` (joueur, parcelle, `ready_at`) |
| `auctions:expire` | `*/5 * * * *` | `closeExpiredListings(50)`, `expireTrades(50)`, `matchStandingOrders(50)`, `expireStandingOrders(100)` | transactions par annonce ; ordres verrouillés `FOR UPDATE` |
| `webhooks:dispatch` | `* * * * *` | `dispatchPending(100)` : livraison en tentative unique, désactivation après 10 échecs | file `webhook_events` |
| `quests:expire` | `10 0 * * *` | `expireQuests` : quêtes du cycle écoulé | — |
| `coop:objectives` | `*/15 * * * *` | `distributeObjectiveRewards(20)` : récompenses des objectifs de coopérative atteints | — |
| `bank:interest` | `0 3 * * *` | 500 comptes dus depuis 24 h, une transaction par compte ; les comptes trop petits pour un intérêt non nul sont écartés par le SQL et leur échéance avancée | `applyInterest` sous transaction |
| `economy:snapshot` | `30 * * * *` (horaire) | `captureEconomySnapshot` (fenêtre 1 h), `auditLedger(100)`, `countSuspiciousUsers`, `recordSnapshotHealth` | — |
| `ledger:checkpoint` | `0 5 1 * *` (mensuel) | `checkpointLedger` : soldes d'ouverture des deux monnaies pour les joueurs vivants sans checkpoint sur la période | lots de 100 sous `lockUserRow` par identifiant croissant, `ON CONFLICT DO NOTHING`, arrêt après 3 lots en échec consécutifs |
| `leaderboard:weekly` | `0 0 * * 1` (lundi) | `snapshotLeaderboards` (4 types, portée `global`), puis `weeklyReset` de la progression et des coopératives | — |
| `maintenance:cleanup` | `0 4 * * *` | purge de l'historique de prix (30 j), des stocks de boutique (7 j), des piles vides, des verrous et cooldowns mémoire, puis `purgeLedger` en dernier | purge du journal sous `SET LOCAL harvester.ledger_purge`, 5 000 lignes par `DELETE`, 200 000 lignes et 2 000 couples par nuit |

Chaque job est **idempotent** : le relancer deux fois ne double jamais un effet.
`runJobNow('<clé>')` (`scheduler.ts`) déclenche n'importe lequel à la main ;
`/admin market-update` le fait pour le marché. Chaque exécution est inscrite dans
`scheduled_tasks` (dernière exécution, durée, `last_error`, prochaine exécution
estimée depuis le cron), ce que `/admin stats` affiche.

### 6.2 Déduplication entre *shards*

Avec `QUEUES_ENABLED=true` (`src/jobs/scheduler.ts`) :

- chaque tâche est un *repeatable job* BullMQ avec `jobId = clé`, `attempts: 3`,
  recul exponentiel de 30 s, dans la file `jobs` (préfixe `REDIS_PREFIX`), traitée
  par un `Worker` de concurrence 2 par process ;
- **un seul process réenregistre** les tâches répétables : verrou
  `harvester:scheduler:register` (`SET NX EX 60`, jamais relâché, il expire) ;
  le gagnant purge les anciens jobs répétables — sinon un cron modifié dans le
  code laisserait l'ancien programmé indéfiniment — et recrée les 17 ;
- peu importe combien de *shards* démarrent : BullMQ dédoublonne, la tâche
  s'exécute **une seule fois**.

Le repli minuteur (`QUEUES_ENABLED=false`) approxime chaque cron par un intervalle
(`CRON_INTERVALS`) et **ne connaît pas** les crons journaliers, hebdomadaires ni
mensuels hors `ledger:checkpoint` : `leaderboard:weekly` tournerait chaque jour.
Il convient au développement mono-processus et est explicitement déconseillé en
production.

Le **worker de notifications** (`src/jobs/notifications.ts`) est à part : il
tourne sur **chaque** *shard* hors BullMQ, un tick par seconde, et se coordonne
par la base — réservation `claimed_at` / `claimed_by` en
`FOR UPDATE SKIP LOCKED`, préférences relues au moment de l'envoi, plafond de
12 par joueur et par jour, MP fermés (50007) qui désactivent l'option, rappels
en salon groupés derrière la fenêtre Redis du salon.

### 6.3 Migrations

`src/scripts/migrate.ts` est un runner maison volontairement strict :

- il applique les fichiers `drizzle/*.sql` dans l'ordre, chacun dans **sa** transaction ;
- il enregistre le **hash SHA-256** de chaque fichier appliqué ;
- il **refuse de démarrer** si un fichier déjà appliqué a été modifié — c'est la
  garantie qu'un environnement ne dérive pas silencieusement d'un autre.

`0000_init.sql` est généré par `drizzle-kit` ; `0001` à `0015` sont écrits à la
main et, depuis `0011`, rejouables. Contenu fichier par fichier, tables, index et
contraintes : [03 § 6](./03-base-de-donnees.md#6-migrations-et-seed).

---

## 7. Montée en charge

**Jusqu'à ~2 500 serveurs** : un seul processus suffit. Les intents sont réduits à
`Guilds` (aucun `GuildMembers`, aucun `MessageContent` : rien à demander à Discord,
donc pas de vérification d'intent privilégié), et les caches discord.js sont
limités (`src/client.ts`) : messages, présences, réactions, stickers, évènements
planifiés, règles d'automodération et fils à zéro ; membres à 1 (le bot
lui-même) ; utilisateurs à 200 avec balayage horaire. Le bot tient dans ~120 Mo
par *shard*.

**Au-delà** : `npm run start:sharded` (ou l'image Docker avec
`HARVESTER_ENTRYPOINT=shard`, profil compose `sharded`) lance `ShardingManager`
(`src/shard.ts`) : un process `index.js` par *shard*, `totalShards` depuis
`SHARDING_TOTAL` (`auto` = nombre recommandé par Discord), `respawn: true`,
lancement espacé de 5,5 s. Comme aucun état de jeu ne vit en mémoire — tout est en
PostgreSQL et Redis — un *shard* est interchangeable et redémarrable sans
conséquence. Les jobs restent dédupliqués par BullMQ, les notifications par
`claimed_by`, et les ordres d'administration (`/admin maintenance`,
`/admin reload-config`) sont diffusés à tous les process par le canal pub/sub
`harvester:cluster`. `SHARDS` et `SHARD_COUNT` appartiennent au protocole interne
de discord.js (posés par le gestionnaire, lus par `new Client()`) : ne jamais les
utiliser pour configurer, `client.ts` neutralise une valeur invalide héritée.

**Limites connues du mode shardé**, documentées dans
[06 — dette technique](./06-roadmap.md#dette-technique-à-traiter-en-priorité) et
[08 § 3](./08-exploitation.md#3-shard-qui-ne-revient-pas) :

- chaque *shard* exécute `startHealthServer` sur le **même** `HTTP_PORT` ; le
  *shard* 0 sert `/health`, les suivants échouent au `listen` (`EADDRINUSE`) et
  sont relancés en boucle. Tant que `src/index.ts` ne réserve pas le serveur HTTP
  au *shard* 0, le profil `sharded` n'est sûr qu'avec `SHARDING_TOTAL=1` ;
- `SCHEDULER_ENABLED` est hérité par **tous** les *shards* (le gestionnaire copie
  son environnement dans chaque enfant) : le commentaire de `shard.ts` qui
  réserve l'ordonnanceur au *shard* 0 n'est pas implémenté. Ce n'est pas bloquant
  grâce à BullMQ, mais il ne faut pas forcer la variable à `false` ;
- le pool PostgreSQL est dimensionné **par shard** : garder
  `DATABASE_POOL_MAX × shards < max_connections` (200 dans le compose) ; le
  service `bot-sharded` est limité à 2 Go.

**Points de contention identifiés et traités** : la ligne `users` du joueur (verrou
court, transactions de quelques millisecondes) ; la table `market_prices` (une
seule écriture par heure, par le job) ; l'inventaire (unicité sur
`(user, item, quality, mutation)` + `onConflictDoUpdate`, donc pas de course) ;
`transactions` (append-only, purge par petits lots sans verrou long) ; le
rendu (déporté, borné, mis en cache).

---

## 8. Erreurs, sécurité, observabilité

**Erreurs.** `GameError` (`src/utils/errors.ts`, fabrique `gameError(code, …)`)
porte un code de l'union `GameErrorCode`, un message ou une clé i18n, un indice
et une commande suggérée ; c'est une erreur **attendue**, jamais remontée comme
incident. Toute autre exception est capturée par `replyError`, journalisée avec
son contexte (utilisateur, commande ou `custom_id`, serveur) et postée dans
`DISCORD_ERROR_CHANNEL_ID` par `events/error-reporter.ts` — dédoublonnée par
signature sur 5 minutes, 10 rapports par fenêtre au plus, pour qu'un bug massif ne
déclenche pas un *rate limit* Discord. Le joueur reçoit un message générique —
jamais une trace de pile. Une exception non capturée déclenche l'arrêt propre
(`registerProcessHandlers`, `onFatal`) : un process qui survit à une exception
inattendue peut porter une transaction déchirée.

**Sécurité.**
- Aucun secret dans le code ; `.env` validé par Zod au démarrage (`config/env.ts`),
  **échec immédiat** si un champ manque ou est malformé ; `WORLD_SEED` est un
  secret d'instance (avec la valeur par défaut, tout lecteur du dépôt calcule le
  marché noir de demain).
- Toute entrée utilisateur est validée : bornes sur les options numériques,
  longueurs maximales, listes blanches d'énumérations, légende de carte postale
  nettoyée, mentions restreintes (`allowedMentions`) sur tout message public.
- `assertOwner` sur chaque composant ; verrou par action.
- Requêtes exclusivement paramétrées (aucun `sql.raw` avec une valeur utilisateur ;
  le JSONB dynamique passe par un paramètre lié `::jsonb`).
- TLS PostgreSQL **vérifié** par défaut (`DATABASE_SSL_CA` pour une autorité
  privée ; `DATABASE_SSL_INSECURE` annoncé bruyamment).
- Webhooks sortants : filtre anti-SSRF avec adresse résolue **épinglée** (fenêtre
  de *DNS rebinding* fermée, F-09), secret HMAC, désactivation après 10 échecs.
- `/metrics` protégeable par `HTTP_METRICS_TOKEN` (comparaison à temps constant),
  parce qu'il partage son port avec l'API publique.
- Clés d'API hachées SHA-256, jamais stockées en clair.
- L'image Docker tourne en utilisateur non privilégié (uid 10001) et n'embarque
  que `dist/`, `drizzle/` et `assets/`.

**Observabilité.** Pino en JSON structuré (`service`, `shard`, `mod`, secrets
masqués par `redact`). Serveur HTTP sans framework (`src/http/health.ts`) :

| Route | Rôle |
|---|---|
| `GET /health`, `/healthz` | 200 si Discord **et** PostgreSQL répondent, 503 sinon (Redis rapporté, non bloquant) — ce qu'interroge le `HEALTHCHECK` Docker |
| `GET /ready` | 200 dès que le registre de commandes est chargé |
| `GET /metrics` | format Prometheus, jeton optionnel |
| `/api/v1/*` | API publique et webhook top.gg ([07](./07-api-publique.md)) |

`/metrics` combine deux sources. Les compteurs simples de `health.ts` :
`harvester_uptime_seconds`, `harvester_commands_total`,
`harvester_command_errors_total`, `harvester_interactions_total`,
`harvester_guilds`, `harvester_ws_ping_ms`, `harvester_config_items`, et
l'économie lue dans le **dernier instantané horaire** (jamais recalculée à la
volée) : `harvester_economy_total_coins`, `_total_bank_coins`, `_total_gems`,
`_coins_created`, `_coins_destroyed`, `_faucet_sink_ratio`,
`_ledger_mismatches`, `_suspicious_users`, `_total_users`,
`_snapshot_age_seconds`. Et le registre de `metrics.ts` :
`harvester_errors_total{code,kind}`, `harvester_command_duration_seconds{command}`
et `harvester_component_duration_seconds{namespace}` (seaux 0,05 → 10 s, dont
2,5 et 5 qui encadrent le budget de 3 s de Discord), `harvester_render_workers`,
`harvester_render_busy`, `harvester_render_queued`. La cardinalité est **bornée à
la source** : `code` doit appartenir à `KNOWN_ERROR_CODES` (un `Record` que le
compilateur force à suivre l'union `GameErrorCode` + codes du pipeline),
`command` au registre, `namespace` aux composants enregistrés ; toute autre valeur
devient `other`, et un plafond de 256 séries par métrique sert de filet. Le
tableau Grafana `ops/grafana/harvester-dashboard.json` lit tout cela ; les
symptômes et remèdes sont dans [08 — Exploitation](./08-exploitation.md).
