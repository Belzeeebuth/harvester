# =============================================================================
#  Harvester — image de production
#  Build multi-étapes : l'image finale ne contient ni sources TypeScript ni
#  dépendances de développement (~180 Mo au lieu de ~650 Mo).
# =============================================================================

# ---------- Étape 1 : dépendances de build ----------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---------- Étape 2 : compilation -------------------------------------------
FROM node:22-bookworm-slim AS build

# Les MÊMES polices que l'image finale (étape 4). `npm run test` dessine ici
# pour de vrai : sans police, `measureText` renvoie 0 et `fillText` ne pose
# aucun pixel, si bien que deux rendus qui ne diffèrent QUE par leur texte
# sortent identiques. Les tests qui en dépendent échouaient alors sur un
# environnement incomplet, pas sur une régression (render-postcard, « change
# avec la légende »), et ceux qui se gardent eux-mêmes — le repli emoji de
# render-crops, `fitFont` — ne s'exécutaient jamais là où ils comptent le plus.
# La couche est jetée avec l'étape : l'image finale ne grossit pas.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run test

# ---------- Étape 3 : dépendances de production seulement --------------------
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Étape 4 : image finale ------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `fonts-noto-color-emoji` : @napi-rs/canvas dessine déjà tous les indicateurs
# critiques en vectoriel, mais cette police permet d'afficher de vrais emoji
# dans les images si vous en ajoutez. `fonts-dejavu-core` fournit une police
# texte par défaut fiable. `curl` sert au HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Paris

# Point d'entrée choisi À L'EXÉCUTION : `index` (mono-process, défaut) ou
# `shard` (ShardingManager, src/shard.ts — un process `index.js` par shard).
# Une variable plutôt qu'une seconde image : le sharding est une décision
# d'exploitation, pas de build, et docker-compose.yml bascule dessus avec
# `profiles: [sharded]` sur la MÊME image. Le CMD plus bas la lit.
ENV HARVESTER_ENTRYPOINT=index

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
COPY assets ./assets

# Le process ne tourne jamais en root.
RUN useradd --system --create-home --uid 10001 harvester \
    && chown -R harvester:harvester /app
USER harvester

EXPOSE 3001

# Le healthcheck interroge /health, qui vérifie Discord ET PostgreSQL : un
# process vivant mais déconnecté est considéré malsain et sera redémarré.
# En mode `shard`, ce serveur est celui du shard 0 (chaque shard exécute
# `index.js`, donc `startHealthServer`) : la sonde reste valable telle quelle.
# Les autres shards visent le même port — limite documentée sur le service
# `bot-sharded` de docker-compose.yml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3001/health || exit 1

# Forme shell et non exec : `["node", "dist/index.js"]` ne substitue aucune
# variable, or le fichier lancé dépend de HARVESTER_ENTRYPOINT. `exec`
# remplace le shell par Node, qui reste donc PID 1 : SIGTERM lui arrive
# directement et l'arrêt propre de src/index.ts est intact — c'est ce qui rend
# `dumb-init` toujours inutile (Node gère SIGTERM correctement). Une valeur
# inconnue est refusée avec un message explicite plutôt que de laisser Node
# tourner en boucle de redémarrage sur un « Cannot find module ».
# `docker compose run --rm bot npm run db:migrate` remplace ce CMD : inchangé.
CMD ["sh", "-c", "case \"$HARVESTER_ENTRYPOINT\" in index|shard) exec node \"dist/$HARVESTER_ENTRYPOINT.js\" ;; *) echo \"HARVESTER_ENTRYPOINT doit valoir index ou shard, pas '$HARVESTER_ENTRYPOINT'\" >&2 ; exit 64 ;; esac"]
