# 04 — Équilibrage

> Toutes les tables chiffrées de ce document sont **produites par le code**, pas
> rédigées à la main : `npm run balance:report` les régénère depuis
> `src/config/gameplay/`. Modifier un JSON et relancer la commande suffit à voir
> l'impact. Le script lit `.env` (les quatre variables obligatoires suffisent, il
> n'ouvre aucune connexion) ; les tables de contenu qui n'y figurent pas encore
> (consommables, poissons, minerais, silhouettes) sont dérivées des mêmes JSON
> avec les mêmes formules, et verrouillées par les tests de `tests/content-*.test.ts`.

---

## 1. Méthode

Trois objectifs, dans cet ordre de priorité :

1. **Aucun mur.** Le rapport temps/gain ne doit jamais s'effondrer entre deux
   niveaux. La courbe d'XP est sous-quadratique (`exposant 1,45`) et les cultures
   déblocables croissent en profit horaire *plus vite* que la courbe d'XP.
2. **Aucune exploitation évidente.** Aucune boucle ne doit produire des pièces sans
   consommer de temps ou de ressource. Vérifié par tests automatisés (§ 7.2 et § 9).
3. **La progression est un choix, pas une obligation.** À chaque palier, plusieurs
   stratégies (cultures rapides à faible marge, cultures longues à forte marge,
   élevage, transformation, pêche, mine) doivent rester dans un facteur ~2 l'une
   de l'autre.

L'unité de comparaison est le **profit par parcelle et par heure** :

```
profit/h = (prix de vente × rendement × (1 + cycles de repousse) − prix de graine)
           / (durée de pousse + cycles × durée de repousse) × 3 600
```

C'est la formule exacte de `src/scripts/balance-report.ts` : une culture qui
repousse amortit sa graine sur la durée **totale** (premier cycle + repousses),
et le ROI est le rapport entre la valeur brute de toutes ses récoltes et la
graine. C'est la seule métrique qui permette de comparer du blé (5 min) et un
arbre-monde (36 h).

---

## 2. Cultures — 41 espèces

Durée = durée totale d'occupation de la parcelle ; entre parenthèses, le nombre
de récoltes d'une même graine pour les cultures qui repoussent. Saisons :
Pr = printemps, Été, Aut = automne, Hiv = hiver.

| Culture | Niv | Rareté | Saisons | Graine | Rdt | Vente | Durée | Profit | Profit/h | ROI |
|---|--:|---|---|--:|--:|--:|--:|--:|--:|--:|
| 🌾 Blé | 1 | commun | Pr · Été · Aut | 10 | 3 | 6 | 5 min | 8 | 96 | 1,8× |
| 🥕 Carotte | 1 | commun | Pr · Aut | 14 | 3 | 9 | 8 min | 13 | 98 | 1,9× |
| 🧅 Oignon | 1 | commun | Pr · Aut · Hiv | 16 | 4 | 8 | 10 min | 16 | 96 | 2,0× |
| 🥔 Pomme de terre | 2 | commun | Pr · Aut · Hiv | 20 | 4 | 10 | 12 min | 20 | 100 | 2,0× |
| 🥬 Laitue | 2 | commun | Pr · Été | 26 | 4 | 13 | 15 min | 26 | 104 | 2,0× |
| 🌽 Maïs | 3 | commun | Été · Aut | 40 | 6 | 15 | 25 min | 50 | 120 | 2,3× |
| 🧄 Ail | 4 | commun | Aut · Hiv | 45 | 5 | 17 | 20 min | 40 | 120 | 1,9× |
| 🍅 Tomate | 5 | peu commun | Été | 55 | 5 | 22 | 1,5 h (4 récoltes) | 385 | 257 | 8,0× |
| 🥒 Concombre | 5 | peu commun | Été | 60 | 6 | 26 | 35 min | 96 | 165 | 2,6× |
| 🍓 Fraise | 6 | peu commun | Pr · Été | 70 | 4 | 32 | 1,5 h (3 récoltes) | 314 | 209 | 5,5× |
| 🫛 Petits pois | 6 | peu commun | Pr | 65 | 4 | 22 | 55 min (3 récoltes) | 199 | 217 | 4,1× |
| 🍆 Aubergine | 7 | peu commun | Été · Aut | 85 | 6 | 34 | 45 min | 119 | 159 | 2,4× |
| 🥦 Brocoli | 7 | peu commun | Aut · Hiv | 100 | 6 | 42 | 1,0 h | 152 | 152 | 2,5× |
| 🫑 Poivron | 8 | peu commun | Été | 95 | 6 | 36 | 50 min | 121 | 145 | 2,3× |
| 🌶️ Piment | 9 | peu commun | Été · Aut | 110 | 4 | 32 | 1,9 h (4 récoltes) | 402 | 210 | 4,7× |
| 🍈 Melon | 10 | rare | Été | 160 | 5 | 90 | 1,5 h | 290 | 193 | 2,8× |
| 🌻 Tournesol | 11 | rare | Été · Aut | 180 | 6 | 85 | 1,8 h | 330 | 189 | 2,8× |
| 🍠 Patate douce | 11 | rare | Aut | 170 | 6 | 70 | 1,3 h | 250 | 200 | 2,5× |
| 🍉 Pastèque | 12 | rare | Été | 220 | 5 | 130 | 2,0 h | 430 | 215 | 3,0× |
| 🫐 Myrtille | 13 | rare | Pr · Été | 250 | 5 | 70 | 3,9 h (4 récoltes) | 1 150 | 294 | 5,6× |
| 🎃 Citrouille | 13 | rare | Aut | 260 | 6 | 135 | 2,5 h | 550 | 220 | 3,1× |
| 🌿 Houblon | 14 | rare | Été · Aut | 240 | 6 | 65 | 5,0 h (5 récoltes) | 1 710 | 342 | 8,1× |
| 🍇 Raisin | 15 | rare | Aut | 300 | 8 | 90 | 7,5 h (4 récoltes) | 2 580 | 344 | 9,6× |
| 🥝 Kiwi | 16 | rare | Aut · Hiv | 340 | 7 | 190 | 3,8 h | 990 | 264 | 3,9× |
| 🍵 Thé | 17 | épique | Pr · Été | 460 | 8 | 130 | 8,8 h (4 récoltes) | 3 700 | 423 | 9,0× |
| ☕ Café | 18 | épique | Pr · Été | 520 | 8 | 145 | 10,0 h (4 récoltes) | 4 120 | 412 | 8,9× |
| 🌹 Rose | 19 | épique | Pr · Été | 600 | 8 | 135 | 6,3 h (3 récoltes) | 2 640 | 422 | 5,4× |
| 🍫 Cacao | 20 | épique | Été | 700 | 9 | 360 | 5,0 h | 2 540 | 508 | 4,6× |
| 🪻 Lavande | 21 | épique | Pr · Été | 780 | 10 | 300 | 4,5 h | 2 220 | 493 | 3,8× |
| 🫒 Olive | 22 | épique | Aut | 850 | 9 | 480 | 6,5 h | 3 470 | 534 | 5,1× |
| 🌼 Vanille | 23 | épique | Été | 900 | 8 | 520 | 6,0 h | 3 260 | 543 | 4,6× |
| 🍊 Mandarine | 25 | épique | Aut · Hiv | 1 000 | 6 | 400 | 10,5 h (3 récoltes) | 6 200 | 590 | 7,2× |
| 🫚 Ginseng | 28 | légendaire | Aut · Hiv | 1 600 | 8 | 1 050 | 8,0 h | 6 800 | 850 | 5,3× |
| 🌸 Sakura | 30 | légendaire | Pr | 2 000 | 8 | 1 300 | 9,0 h | 8 400 | 933 | 5,2× |
| 🍄 Truffe | 32 | légendaire | Aut · Hiv | 2 400 | 7 | 1 750 | 10,0 h | 9 850 | 985 | 5,1× |
| 🌺 Safran | 36 | légendaire | Aut | 3 200 | 8 | 2 400 | 12,0 h | 16 000 | 1 333 | 6,0× |
| 🎍 Bambou | 39 | légendaire | Pr · Été | 4 000 | 6 | 1 300 | 19,0 h (5 récoltes) | 35 000 | 1 842 | 9,8× |
| 🐉 Fruit du dragon | 42 | mythique | Été | 6 000 | 9 | 5 200 | 18,0 h | 40 800 | 2 267 | 7,8× |
| ❄️ Rose des glaces | 45 | mythique | Hiv | 7 000 | 9 | 6 600 | 20,0 h | 52 400 | 2 620 | 8,5× |
| ✨ Lotus étoilé | 48 | mythique | toutes | 9 000 | 10 | 8 200 | 1,0 j | 73 000 | 3 042 | 9,1× |
| 🌳 Arbre-monde | 55 | mythique | toutes | 15 000 | 12 | 12 500 | 1,5 j | 135 000 | 3 750 | 10,0× |

**Lectures importantes**

- **Le profit horaire est monotone croissant** pour la série à récolte unique :
  citrouille 220 → kiwi 264 → cacao 508 → olive 534 → vanille 543 →
  ginseng 850 → sakura 933 → truffe 985 → safran 1 333 → fruit du dragon 2 267 →
  rose des glaces 2 620 → lotus 3 042 → arbre-monde 3 750 🪙/h. Un joueur qui
  débloque une culture y gagne toujours. La moyenne du dernier tiers des
  espèces (par niveau) vaut **10,5×** celle du premier tiers ; le test exige
  au moins 5×.
- **Douze cultures repoussent** (tomate, fraise, petits pois, piment, myrtille,
  houblon, raisin, thé, café, rose, mandarine, bambou) et affichent un ROI très
  supérieur — 4× à 10× contre 2× à 3× — parce qu'une seule graine produit
  plusieurs récoltes. C'est le compromis explicite : elles coûtent cher,
  immobilisent la parcelle longtemps, et récompensent la planification. Chaque
  saison en compte au moins une (petits pois au printemps, tomate en été,
  raisin en automne, mandarine en hiver), règle tenue par
  `tests/content-crops.test.ts`.
- **L'hiver se joue à tout niveau.** Avant l'extension, rien ne poussait en
  hiver entre la pomme de terre (niv. 2) et le ginseng (niv. 28). Il compte
  désormais onze cultures : oignon (1), pomme de terre (2), ail (4), brocoli (7),
  kiwi (16), mandarine (25), ginseng (28), truffe (32), rose des glaces (45),
  lotus étoilé (48) et arbre-monde (55). Le printemps (16 espèces) a gagné une
  rare (myrtille) et une légendaire (sakura), l'automne (22) un épique (olive) ;
  l'été reste la saison la plus fournie (24).
- **La rareté annonce un palier de niveau strict** : commun 1–4, peu commun 5–9,
  rare 10–16, épique 17–25, légendaire 28–39, mythique 42–55. Un joueur qui
  lit « rare » sait où il en est.
- **Jamais plus de sept niveaux sans déblocage** : le plus grand écart est
  48 → 55 (lotus → arbre-monde). Deux cultures d'un même niveau ont toujours
  des durées différentes (tournesol 1,8 h et patate douce 1,3 h au niveau 11,
  brocoli 1 h et aubergine 45 min au niveau 7), pour que le choix ne soit jamais
  indifférent.
- Les cultures rapides gardent leur usage : ROI faible mais **cycle court**, donc
  idéales pour un joueur qui se connecte souvent, et incontournables pour les
  quêtes de quantité.
- **Aucune culture n'est dominée** : chacune est soit la meilleure de son palier
  de niveau, soit la meilleure de son horizon temporel, soit un ingrédient de
  recette — depuis le lot C3, **chacune des 41 cultures entre dans au moins une
  recette**.
- Les listes triées par `sortOrder` suivent le niveau requis : citrouille
  (niv. 13, `sortOrder` 140) précède houblon (niv. 14, `sortOrder` 150) depuis
  la revue finale — l'extension C1 avait laissé l'inversion.
- **Toutes les graines sont en vente permanente**, stock illimité, au prix
  `seedPrice` et au niveau de la culture. Seules les cinq premières l'étaient ;
  les autres ne passaient que par la rotation du jour (un jour sur dix environ,
  stock partagé par le serveur) et débloquer une culture ne servait presque à
  rien. La rotation du jour ne tire plus de graines, et `seedStockMultiplier`,
  jamais lu, a été retiré. `/shop` montre les graines du niveau du joueur et les
  trois suivantes.
- **Sac de départ de saison** : 10 et 5 graines des deux cultures de saison de
  niveau 1 (`src/game/starter-kit.ts`). En hiver, seul l'oignon l'est : la
  seconde sorte est la pomme de terre (niv. 2, atteint en deux récoltes).
- **Arrosoirs** : bois 3 parcelles par action, cuivre (niv. 8) 6, doré (niv. 18)
  toute la ferme. Le bois en arrosait une : neuf clics pour la ferme de départ.

L'apparence est aussi une donnée d'équilibrage : chaque culture déclare une
**silhouette** (`form`) parmi neuf et une **palette** de quatre couleurs, lues
par le rendu procédural — voir [05 § Silhouettes](./05-pipeline-assets.md).

---

## 3. Animaux — 24 espèces

Prix en pièces, sauf les deux mythiques vendus en gemmes (une gemme est comptée
250 🪙 pour l'amortissement, convention du rapport). ‡ = récompense d'événement
uniquement (`eventOnly`), jamais en boutique. Le « net/h » est calculé
**nourriture déduite** (prix d'achat de l'aliment × ration par cycle).

| Animal | Niv | Rareté | Bâtiment | Prix | Produit | Cycle | Net/h | Amorti |
|---|--:|---|---|--:|---|--:|--:|--:|
| 🐔 Poule | 2 | commun | Poulailler | 400 | 2× Œuf | 45 min | 48 | 8,3 h |
| 🪿 Oie | 3 | commun | Poulailler | 500 | 2× Duvet d'oie | 1,0 h | 52 | 9,6 h |
| 🦆 Canard | 4 | commun | Poulailler | 580 | 2× Œuf de canard | 1,3 h | 58 | 10,1 h |
| 🐰 Lapin | 5 | commun | Enclos | 770 | 2× Angora | 1,5 h | 64 | 12,0 h |
| 🐹 Cochon d'Inde | 6 | commun | Enclos | 720 | 2× Poil soyeux | 1,0 h | 58 | 12,4 h |
| 🐑 Mouton | 8 | peu commun | Enclos | 1 400 | 3× Laine | 3,0 h | 101 | 13,9 h |
| 🦃 Dinde | 9 | peu commun | Poulailler | 1 300 | 2× Plume de dinde | 2,5 h | 90 | 14,5 h |
| 🐐 Chèvre | 10 | peu commun | Étable | 1 550 | 3× Lait de chèvre | 3,5 h | 103 | 15,0 h |
| 🫏 Âne | 11 | peu commun | Étable | 1 450 | 2× Lait d'ânesse | 3,0 h | 91 | 16,0 h |
| 🐄 Vache | 12 | peu commun | Étable | 2 100 | 3× Lait | 4,0 h | 132 | 15,9 h |
| 🐝 Abeille | 13 | peu commun | Rucher | 1 750 | 2× Miel | 2,5 h | 96 | 18,2 h |
| 🐖 Cochon | 15 | rare | Étable | 3 000 | 1× Truffe sauvage | 6,0 h | 177 | 17,0 h |
| 🐛 Ver à soie | 16 | rare | Rucher | 3 350 | 3× Cocon de soie | 4,0 h | 192 | 17,5 h |
| 🐢 Tortue | 17 | rare | Enclos | 3 500 | 1× Écaille de tortue | 8,0 h | 197 | 17,8 h |
| 🦙 Alpaga | 20 | rare | Enclos | 6 000 | 2× Laine fine | 6,0 h | 287 | 20,9 h |
| 🦬 Yack | 22 | épique | Étable | 7 200 | 2× Laine de yack | 8,0 h | 340 | 21,2 h |
| 🪶 Autruche | 25 | épique | Enclos | 8 000 | 1× Œuf géant | 8,0 h | 365 | 21,9 h |
| 🦌 Cerf | 28 | épique | Enclos | 8 500 | 1× Bois de cerf | 12,0 h | 377 | 22,6 h |
| 🐴 Cheval | 30 | épique | Étable | 9 500 | 1× Crin de cheval | 10,0 h | 412 | 23,1 h |
| 🦢 Cygne | 33 | légendaire | Enclos | 11 200 | 1× Plume de cygne | 12,0 h | 477 | 23,5 h |
| 🦚 Paon | 35 | légendaire | Enclos | 12 800 | 1× Plume de paon | 12,0 h | 535 | 23,9 h |
| 🐲 Dragonnet | 40 | mythique | Antre | 250 💎 (≈ 62 500) ‡ | 1× Écaille de dragon | 8,0 h | 1 735 | 36,0 h |
| 🦄 Licorne | 40 | légendaire | Antre | 24 000 | 1× Crin de licorne | 12,0 h | 740 | 32,4 h |
| 🔥 Phénix | 45 | mythique | Antre | 300 💎 (≈ 75 000) | 1× Cendre de phénix | 8,0 h | 1 985 | 37,8 h |

Le **temps d'amortissement croît volontairement** avec le niveau (8,3 h pour la
poule → 37,8 h pour le phénix, entre 5 h et 48 h pour toutes les espèces —
`tests/content-animals.test.ts`) : un animal de haut niveau est un
investissement, pas un achat impulsif. Il reste toujours amortissable en moins
de deux jours de jeu — au-delà, l'achat cesserait d'être attractif.

L'élevage est moins rentable à l'heure que la culture équivalente, ce qui est
assumé : il demande beaucoup moins d'attention (un cycle de vache, c'est une
action toutes les 4 h contre 48 actions de blé), et il produit les **ingrédients
de transformation** que la culture seule ne fournit pas — chacun des 24 produits
animaux a désormais au moins un débouché en recette.

Règles du catalogue, toutes testées :

- **Une seule monnaie par espèce, les gemmes réservées au mythique.** Le
  dragonnet (250 💎) n'existe qu'en récompense d'événement ; le phénix
  (300 💎) est achetable hors événement — c'est le débouché premium de l'Antre,
  et la seule chose que les gemmes achètent en dehors du cosmétique. La licorne
  (24 000 🪙, légendaire) loge aussi à l'Antre, en pièces.
- **Un produit propre, de même rareté, suivi par le marché** : l'écaille de
  dragon (14 000 🪙) et la cendre de phénix (16 000 🪙) sont mythiques comme
  leurs bêtes, l'œuf est commun comme la poule.
- **Jamais débloqué avant son bâtiment** (poulailler 2, enclos 5, étable 10,
  rucher 13, Antre 40) et au moins deux espèces par rareté.
- **Bonus passifs ≤ 10 %** : un animal ne remplace jamais une parcelle.
- Aucun aliment nouveau : la liste des fournitures du magasin est codée dans
  `market.service.ts`, un aliment supplémentaire serait invendable. Le ver à
  soie et la tortue mangent du foin.

### 3.1 Variantes — shiny et dorée

Une bête qui **entre dans le jeu** (achat, naissance) tire une variante ; elle
est immuable ensuite. Tout vient de `balance.animals.variants` et de
`rollVariant`/`inheritVariant` dans `src/game/animals.ts` :

| Paramètre | Valeur | Rôle |
|---|--:|---|
| `shinyChance` | 2 % | par bête achetée ou née, × poids de rareté |
| `goldenChance` | 0,2 % | idem ; tirée **avant** la shiny, pour qu'un tirage shiny réussi ne mange jamais l'issue la plus rare |
| `rarityWeights` | 1 · 1,25 · 1,5 · 2 · 2,5 · 3 | commun → mythique ; un joueur achète dix poules pour un dragonnet, à chance égale la poule shiny serait banale et le dragonnet shiny introuvable |
| plafond | 50 % | un poids mal réglé ne peut pas rendre la variante majoritaire |
| `inheritanceChance` | 35 % | un parent shiny transmet |
| `doubleInheritanceChance` | 60 % | deux parents shiny |
| dorée | jamais héritée, jamais née | elle se **trouve**, elle ne s'élève pas — c'est le graal |

Effets, volontairement modestes pour une économie fermée :

| Variante | Effet | Espérance |
|---|---|---|
| ✨ shiny | les produits sortent en qualité **argent** (×1,35) une collecte sur deux (`shinyQualityBoost` 0,5) — jamais or ni iridium, réservés aux cultures et à la pêche | ≈ +17,5 % de valeur produite |
| 🌟 dorée | production ×2 par cycle (`goldenProductMultiplier`, les cycles restant plafonnés par `maxPendingProduction` = 5) et revente ×3 (`goldenSellMultiplier`) | 3 × 0,6 = **1,8×** le prix d'achat |

La revente ×3 est le seul endroit où une variante touche directement aux
pièces. Sur 0,2 % des bêtes (0,6 % pour un mythique), acheter-revendre en
boucle reste une perte nette d'environ **40 % par bête** — le puits de la
revente à 60 % n'est pas contourné. `tests/variants.test.ts` vérifie la
distribution sur 10 000 tirages à graine fixe et cette espérance négative.

---

## 4. Transformation — 49 recettes

Marge cible : **2,0× à 2,2×** la valeur des ingrédients (borne testée :
1,2× à 2,4×). Ingrédients et produit sont comptés au **prix de vente** ; le
gain/h rapporte la valeur ajoutée à la durée d'occupation d'un slot.

| Recette | Niv | Atelier | Ingrédients | Produit | Marge | Durée | Gain/h |
|---|--:|---|--:|--:|--:|--:|--:|
| 🌾 Farine | 4 | Moulin | 18 | 38 | 2,11× | 5 min | 240 |
| 💩 Compost | 5 | Atelier | 36 | 60 | 1,67× | 20 min | 72 |
| 🍞 Pain | 6 | Moulin | 98 | 200 | 2,04× | 10 min | 612 |
| 🥖 Pain à l'ail | 8 | Moulin | 234 | 490 | 2,09× | 15 min | 1 024 |
| 🥣 Soupe de légumes | 9 | Confiturerie | 64 | 140 | 2,19× | 15 min | 304 |
| 🧴 Ketchup | 9 | Confiturerie | 88 | 185 | 2,10× | 20 min | 291 |
| 🛏️ Couette en duvet | 9 | Atelier | 342 | 710 | 2,08× | 30 min | 736 |
| 🌶️ Sauce piquante | 10 | Confiturerie | 144 | 300 | 2,08× | 25 min | 374 |
| 🍲 Velouté de petits pois | 10 | Confiturerie | 240 | 500 | 2,08× | 25 min | 624 |
| 🧶 Laine filée | 10 | Atelier | 330 | 690 | 2,09× | 30 min | 720 |
| 🥘 Soupe de la moisson | 11 | Confiturerie | 178 | 370 | 2,08× | 20 min | 576 |
| 🧃 Nectar de melon | 12 | Confiturerie | 270 | 560 | 2,07× | 35 min | 497 |
| 🧀 Fromage de chèvre | 12 | Fromagerie | 260 | 545 | 2,10× | 35 min | 489 |
| 🧀 Fromage | 12 | Fromagerie | 380 | 790 | 2,08× | 40 min | 615 |
| 🍓 Confiture de fraises | 13 | Confiturerie | 290 | 610 | 2,10× | 30 min | 640 |
| 🧈 Beurre | 14 | Fromagerie | 570 | 1 180 | 2,07× | 1,0 h | 610 |
| 🫐 Confiture de myrtilles | 14 | Confiturerie | 480 | 1 000 | 2,08× | 40 min | 780 |
| 🍨 Yaourt à la fraise | 15 | Fromagerie | 476 | 990 | 2,08× | 50 min | 617 |
| 🍷 Vin | 15 | Brasserie | 540 | 1 180 | 2,19× | 4,0 h | 160 |
| 🍺 Bière | 16 | Brasserie | 337 | 700 | 2,08× | 2,0 h | 182 |
| 🧃 Jus de raisin | 16 | Confiturerie | 360 | 740 | 2,06× | 40 min | 570 |
| 🍇 Confiture de raisin | 17 | Confiturerie | 580 | 1 200 | 2,07× | 45 min | 827 |
| 🍦 Glace au kiwi | 17 | Fromagerie | 950 | 1 980 | 2,08× | 1,0 h | 1 030 |
| 🎀 Soie | 17 | Atelier | 1 300 | 2 700 | 2,08× | 1,5 h | 933 |
| 🫙 Huile de tournesol | 18 | Presse à huile | 340 | 700 | 2,06× | 1,0 h | 360 |
| 🍯 Hydromel | 19 | Brasserie | 650 | 1 350 | 2,08× | 3,0 h | 233 |
| 🫧 Savon rose au lait d'ânesse | 19 | Presse à huile | 1 405 | 2 920 | 2,08× | 1,5 h | 1 010 |
| ☕ Café torréfié | 20 | Fumoir | 435 | 900 | 2,07× | 1,0 h | 465 |
| 🪡 Tissu fin | 22 | Atelier | 2 700 | 5 600 | 2,07× | 1,5 h | 1 933 |
| 🧼 Savon de lavande | 22 | Presse à huile | 1 600 | 3 300 | 2,06× | 2,0 h | 850 |
| 🏺 Huile d'olive | 22 | Presse à huile | 1 920 | 4 000 | 2,08× | 1,5 h | 1 387 |
| 🧀 Fromage fumé | 23 | Fumoir | 1 580 | 3 280 | 2,08× | 1,5 h | 1 133 |
| 🧥 Feutre de yack | 23 | Atelier | 4 180 | 8 700 | 2,08× | 2,0 h | 2 260 |
| 🍫 Chocolat | 25 | Confiserie | 1 270 | 2 630 | 2,07× | 2,0 h | 680 |
| 🍖 Truffe fumée | 25 | Fumoir | 1 800 | 3 700 | 2,06× | 2,0 h | 950 |
| 🥫 Chutney de mandarine | 25 | Confiturerie | 1 826 | 3 800 | 2,08× | 1,0 h | 1 974 |
| 🍰 Gâteau | 26 | Confiserie | 1 322 | 2 740 | 2,07× | 1,5 h | 945 |
| 🥧 Tarte à la citrouille | 26 | Confiserie | 1 391 | 2 880 | 2,07× | 1,8 h | 851 |
| 🍬 Praline de vanille | 28 | Confiserie | 6 300 | 13 000 | 2,06× | 4,0 h | 1 675 |
| 🔪 Couteau en bois de cerf | 29 | Atelier | 6 340 | 13 200 | 2,08× | 3,0 h | 2 287 |
| ⚗️ Élixir de ginseng | 30 | Atelier | 2 230 | 4 600 | 2,06× | 4,0 h | 593 |
| 🍡 Mochi au sakura | 30 | Confiserie | 2 844 | 5 900 | 2,07× | 2,0 h | 1 528 |
| 🫗 Huile de truffe | 32 | Presse à huile | 3 150 | 6 500 | 2,06× | 3,0 h | 1 117 |
| ⚙️ Lingot de mithril | 34 | Atelier | 1 840 | 3 900 | 2,12× | 4,0 h | 515 |
| 🧪 Essence de safran | 36 | Presse à huile | 7 900 | 16 300 | 2,06× | 6,0 h | 1 400 |
| 🍶 Liqueur de bambou | 39 | Brasserie | 5 460 | 11 350 | 2,08× | 8,0 h | 736 |
| 🖼️ Tapisserie de licorne | 41 | Atelier | 32 300 | 67 000 | 2,07× | 12,0 h | 2 892 |
| 🧫 Potion de dragon | 42 | Atelier | 18 600 | 38 400 | 2,06× | 8,0 h | 2 475 |
| 🪔 Encens de phénix | 46 | Fumoir | 31 800 | 66 000 | 2,08× | 12,0 h | 2 850 |

**Le cas du compost, ou pourquoi le plafond de marge est testé.** Le compost est
la seule recette sous 2× (1,67×), et c'est délibéré : ses ingrédients sont des
**mauvaises herbes gratuites**, récupérées en désherbant. Une marge normale en
ferait un robinet monétaire pur — de la valeur créée à partir de rien. Le test
automatisé sur le plafond de marge a détecté exactement ce cas
(`fertilizer_basic` sortait à 2,50×) ; le prix de vente a été ramené de 45 à
30 🪙. C'est un exemple concret de l'utilité d'un équilibrage testé en CI plutôt
que relu.

**Les seize recettes du lot C3** (pain à l'ail, couette en duvet, velouté de
petits pois, soupe de la moisson, confiture de myrtilles, glace au kiwi, soie,
savon rose au lait d'ânesse, huile d'olive, feutre de yack, chutney de
mandarine, couteau en bois de cerf, mochi au sakura, liqueur de bambou,
tapisserie de licorne, encens de phénix) tiennent toutes la marge cible
(2,06× à 2,09×). Elles donnent un débouché à chacune des 14 cultures et à
chacun des 11 produits animaux ajoutés en même temps.

**Puits de fin de partie.** La potion de dragon n'est plus l'objet artisanal le
plus cher : la tapisserie de licorne (67 000 🪙) et l'encens de phénix
(66 000 🪙) la dépassent. Ces deux recettes durent 12 h et consomment des
produits légendaires et mythiques (crin de licorne, plume de cygne, cendre de
phénix, rose des glaces) : ce sont les puits des produits de l'Antre, sans
lesquels ces bêtes n'auraient d'autre débouché que le marché.

Le **gain/h décroît pour les recettes longues** (vin : 160 🪙/h, bière :
182 🪙/h), ce qui est correct : elles n'occupent pas l'attention du joueur,
seulement un slot. La bonne stratégie est de lancer une production longue
**avant** de se déconnecter.

Règles tenues par `tests/content-recipes.test.ts` : jamais débloquée avant son
bâtiment ni avant ses ingrédients, au moins trois recettes par atelier (Moulin 3,
Atelier 11, Confiturerie 11, Fromagerie 5, Brasserie 4, Presse à huile 6,
Fumoir 4, Confiserie 5), jamais plus de cinq niveaux sans nouvelle recette,
durées entre 5 min et 12 h. Contrainte structurelle : `buildings.json` doit
lister chaque recette dans `unlocksRecipes` de son atelier — `validateReferences`
refuse le démarrage sinon.

### 4.1 Consommables — 17

| Objet | Rareté | Niv | Achat | Revente | Effet |
|---|---|--:|--:|--:|---|
| 💩 Engrais simple | commun | 1 | 120 | 30 | fertilité +15, rendement +10 % |
| 🧪 Engrais de qualité | peu commun | 8 | 380 | 140 | fertilité +25, rendement +5 %, qualité +15 % |
| ✨ Engrais suprême | rare | 18 | 950 | 350 | fertilité +40, rendement +25 %, qualité +25 % |
| 🌟 Engrais mythique | légendaire | 30 | 2 400 | 800 | fertilité +60, rendement +40 %, qualité +40 % |
| 🚿 Arrosoir magique | peu commun | 1 | 600 | 200 | arrose toutes les parcelles |
| 📜 Parchemin d'expérience | peu commun | 1 | 800 | 260 | XP ×1,5 pendant 1,0 h |
| 🧴 Potion de croissance | rare | 10 | 1 200 | 380 | pousse ×2 pendant 30 min |
| ⏳ Sablier du fermier | épique | 24 | 4 000 | 1 300 | pousse ×2 pendant 2,0 h |
| 🎟️ Ticket de chance | peu commun | 1 | 500 | 160 | chance +15 % pendant 1,0 h |
| 🍀 Trèfle à quatre feuilles | rare | 15 | 1 800 | 600 | chance +20 % pendant 4,0 h |
| 🪤 Appât répulsif | commun | 1 | 200 | 70 | répulsif pendant 12,0 h |
| 🧿 Charme d'épouvantail | peu commun | 8 | 600 | 200 | répulsif pendant 3,0 j |
| 🧯 Traitement bio | commun | 1 | 150 | 50 | soigne une parcelle infestée |
| 🧃 Jus d'énergie | commun | 1 | 300 | 100 | énergie +50 |
| ⚡ Élixir d'énergie | peu commun | 12 | 800 | 260 | énergie +150 |
| 🧊 Gel de série | rare | 1 | — | — | gèle la série quotidienne (récompense, non vendu) |
| 🔄 Jeton de relance | peu commun | 1 | — | — | relance gratuite d'une quête (récompense, non vendu) |

Règle testée, « **plus fort = plus cher** » à effet égal : engrais 120 / 380 /
950 / 2 400 🪙 pour +15 / +25 / +40 / +60 de fertilité ; énergie 300 🪙 pour
+50 contre 800 pour +150 ; chance 500 🪙 pour +15 % × 1 h contre 1 800 pour
+20 % × 4 h ; croissance 1 200 🪙 pour ×2 × 30 min contre 4 000 pour ×2 × 2 h ;
répulsif 200 🪙 pour 12 h contre 600 pour 3 jours. Chaque consommable se revend
toujours moins cher qu'il ne s'achète, et ne déclare que des effets que
`consumable.service.ts` sait interpréter.

### 4.2 Pêche — 17 poissons

Étang débloqué au niveau 18 (`balance.fishing.unlockLevel`). Une prise est
filtrée par niveau, saison et moment de la journée, puis tirée par rareté
(`rarityWeights` 1000 / 400 / 120 / 30 / 6 / 1).

| Poisson | Rareté | Niv | Saisons | Moment | Vente |
|---|---|--:|---|---|--:|
| 👢 Vieille botte (`fish_old_boot`) | commun | 18 | toutes | jour et nuit | 2 |
| 🐟 Perche (`fish_perch`) | commun | 18 | toutes | jour | 45 |
| 🐟 Carpe (`fish_carp`) | commun | 18 | toutes | jour et nuit | 40 |
| 🐠 Truite (`fish_trout`) | peu commun | 19 | Pr · Aut | jour | 95 |
| 🐍 Anguille (`fish_eel`) | peu commun | 20 | toutes | nuit | 120 |
| 🐟 Silure (`fish_catfish`) | peu commun | 21 | Été · Aut | nuit | 110 |
| 🐠 Brochet (`fish_pike`) | rare | 23 | Aut · Hiv | jour et nuit | 240 |
| 🐟 Achigan (`fish_black_bass`) | rare | 24 | Pr · Été | jour | 250 |
| 🐟 Saumon (`fish_salmon`) | rare | 25 | Aut | jour | 280 |
| 🐠 Omble chevalier (`fish_arctic_char`) | rare | 27 | Hiv | jour | 300 |
| 🦈 Esturgeon (`fish_sturgeon`) | épique | 29 | Hiv | nuit | 650 |
| 🐡 Crapet-soleil (`fish_sunfish`) | épique | 31 | Été | jour | 700 |
| 🐡 Poisson-lune (`fish_moonfish`) | épique | 33 | Pr | nuit | 720 |
| 🦈 Espadon (`fish_swordfish`) | légendaire | 36 | Été | jour et nuit | 1 600 |
| 🦈 Cœlacanthe (`fish_coelacanth`) | légendaire | 38 | Hiv | nuit | 1 800 |
| 🐠 Carpe koï dorée (`fish_golden_koi`) | mythique | 42 | toutes | nuit | 4 200 |
| 🐠 Carpe de cristal (`fish_crystal_carp`) | mythique | 46 | Aut | jour | 4 800 |

Règles testées : quelque chose mord dès le niveau
18 de jour comme de nuit en toute saison, chaque créneau saison × moment a une
prise rare ou mieux en fin de partie, chaque saison a une espèce qui lui est
propre, la valeur croît avec la rareté.

### 4.3 Mine — 16 minerais

Mine débloquée au niveau 22 ; profondeur maximale 20 galeries, plafonnée par le
niveau (`levelsPerDepth` = 2 : une galerie tous les deux niveaux), 20 % de
chance d'avancer à chaque coup de pioche (`advanceChance`).

| Minerai | Rareté | Niv | Galerie min. | Vente |
|---|---|--:|--:|--:|
| 🪨 Cuivre brut | commun | 22 | 1 | 25 |
| 🪨 Étain brut | commun | 22 | 2 | 32 |
| 🪨 Fer brut | commun | 22 | 3 | 45 |
| 🪨 Argent brut | peu commun | 24 | 5 | 90 |
| 💎 Quartz | rare | 28 | 6 | 220 |
| 💎 Améthyste | peu commun | 25 | 7 | 130 |
| 🪨 Or brut | peu commun | 26 | 8 | 160 |
| 🪨 Platine brut | rare | 30 | 10 | 320 |
| 🪨 Mithril | rare | 32 | 11 | 380 |
| 💎 Rubis brut | épique | 35 | 13 | 700 |
| 💎 Émeraude | épique | 37 | 14 | 800 |
| 💎 Saphir brut | épique | 36 | 15 | 750 |
| 🪨 Adamant | légendaire | 40 | 17 | 1 600 |
| 💎 Diamant brut | légendaire | 44 | 18 | 2 200 |
| 🪨 Fer stellaire | légendaire | 42 | 19 | 1 900 |
| 💎 Gemme prismatique | mythique | 48 | 20 | 6 000 |

Règles testées : quelque chose sort dès la première galerie, jamais plus de
trois galeries sans nouveau filon, la valeur croît avec la rareté. Le mithril
alimente le lingot de mithril (Atelier, niv. 34).

---

## 5. Progression

### 5.1 Courbe d'XP — `⌊60 · n^1,45 + 40 · n⌋`

| Niveau | XP requis | XP cumulée | Récompense 🪙 | Gemmes 💎 |
|--:|--:|--:|--:|--:|
| 1 | 100 | 0 | 430 | 0 |
| 5 | 818 | 1 365 | 1 595 | 5 |
| 10 | 2 091 | 7 871 | 3 450 | 5 |
| 15 | 3 644 | 21 332 | 5 563 | 5 |
| 20 | 5 420 | 43 021 | 7 863 | 5 |
| 25 | 7 385 | 73 978 | 10 312 | 5 |
| 30 | 9 517 | 115 102 | 12 887 | 5 |
| 35 | 11 800 | 167 195 | 15 573 | 5 |
| 40 | 14 222 | 230 986 | 18 357 | 5 |
| 45 | 16 773 | 307 146 | 21 229 | 5 |
| 50 | 19 444 | 396 304 | 24 182 | 5 |
| 55 | 22 229 | 499 050 | 27 210 | 5 |
| 60 | — | **615 942** | 30 308 | 5 |

L'exposant 1,45 est le paramètre central. À 1,5 (le réflexe habituel), le niveau 60
coûterait ~40 % d'XP en plus et la fin de partie deviendrait pénible ; à 1,3, la
progression s'effondrerait en deux semaines. Le rapport `xpToNext(n+1)/xpToNext(n)`
reste **sous 1,10 dès le niveau 10** : aucun niveau n'est perçu comme un mur.

Les gemmes sont versées **uniquement** aux paliers multiples de 5, 5 à la fois, soit
60 gemmes pour atteindre le niveau 60 — plus les quêtes, succès, votes et événements.
Aucune source payante n'existe.

### 5.2 Coût des parcelles — `800 × 1,155^n`

| Parcelle | Coût | Cumulé | Grille |
|--:|--:|--:|---|
| 9 | 0 | 0 | 3×3 (départ) |
| 10 | 800 | 800 | 4×3 |
| 15 | 1 640 | 7 080 | 4×4 |
| 20 | 3 380 | 20 010 | 5×4 |
| 25 | 6 950 | 46 600 | 5×5 |
| 30 | 14 280 | 101 230 | 6×5 |
| 35 | 29 350 | 213 530 | 6×6 |
| 40 | 60 330 | 444 390 | 7×6 |
| 45 | 124 010 | 918 890 | 7×7 |
| 50 | 254 900 | 1 894 220 | 8×7 |
| 55 | 523 940 | 3 898 990 | 8×7 |
| 60 | 1 076 930 | 8 019 710 | 8×8 |
| 64 | 1 916 540 | **14 276 110** | 8×8 |

La colonne « Grille » est celle qui **contient** la parcelle, pas le dernier
palier atteint : la dixième parcelle ouvre déjà la grille 4×3. C'est la
correction F-02 de l'audit — `gridSizeFor` retenait le palier inférieur, et
jusqu'à six parcelles payées restaient invisibles sur l'image de la ferme.

C'est **le** puits monétaire principal. La croissance à 1,155 est calibrée pour que
le coût de la parcelle suivante représente toujours environ **une à deux heures de
production** au niveau où le joueur se trouve — assez pour être un objectif, jamais
assez pour être un mur. Le total de 14,3 M 🪙 est atteignable, mais représente
l'essentiel de la partie longue avant prestige.

### 5.3 Prestige

Débloqué au niveau 60. Conserve 50 % des parcelles, tous les bâtiments, les gemmes,
5 % des pièces (plancher 5 000 🪙), les cosmétiques, outils et objets d'événement,
les succès et la coopérative. Bonus **+15 % par rang, 20 rangs maximum** (soit
×4 cumulé au rang 20).

Le prestige est rentable dès le premier rang : rejouer la courbe avec +15 % de gains
et 50 % des parcelles déjà acquises prend nettement moins de temps que la première
montée. C'est ce qui en fait un choix et non une punition.

### 5.4 Collection et succès

`/collection` confronte l'**univers** de chaque famille (41 cultures, 72 produits
— 48 transformés et 24 animaux —, 24 espèces, 17 poissons, 16 minerais, et les
variantes rares `<espèce>:<variante>`) aux découvertes du joueur. Six succès
`discover_entry` s'y adossent (`achievements.json`, catégorie progression) :

| Succès | Condition | Récompense |
|---|---|---|
| Curieux | 10 entrées | 500 🪙, 100 XP |
| Fouineur | 25 entrées | 2 000 🪙, 250 XP |
| Collectionneur | 50 entrées | 8 000 🪙, 3 💎, 600 XP |
| Encyclopédiste | 100 entrées | 30 000 🪙, 8 💎, titre |
| Herbier complet | les 41 cultures | 40 000 🪙, 10 💎, titre « Botaniste » |
| Ça brille | première variante rare | 1 500 🪙, 2 💎, badge |

Le total de 41 est gardé par test contre `crops.json` : ajouter une culture sans
relever le seuil fait échouer `npm test`.

---

## 6. Qualité et coopératives

### 6.1 Distribution de qualité

Poids de base `normal 1000 / argent 180 / or 55 / iridium 8`, modulés par le score
(fertilité × 0,6 + niveau × 0,004 + bonus, plafonné à +0,6) selon un modèle à
exposants — `argent ∝ score`, `or ∝ score²`, `iridium ∝ score³`.

| Scénario | Normal | Argent | Or | Iridium |
|---|--:|--:|--:|--:|
| Débutant (blé, sol 70, niv. 1) | 78,0 % | 15,7 % | 5,4 % | 0,88 % |
| Optimisé (blé, sol 100, niv. 30, engrais) | 57,6 % | 22,6 % | 15,0 % | 4,75 % |
| Fin de partie (lotus, sol 100, niv. 55, chance) | 29,7 % | 22,7 % | 29,4 % | **18,14 %** |

Le modèle cubique fait que l'iridium est **multiplié par 20** entre le débutant et
le joueur optimisé, alors que l'argent n'est multiplié que par 1,4. Autrement dit :
investir dans la fertilité et les engrais ne fait pas gagner « un peu plus souvent »,
ça change la nature du butin. Avec un multiplicateur de prix de ×3, l'iridium à 18 %
ajoute environ +36 % de valeur moyenne à une récolte de fin de partie.

### 6.2 Bonus de coopérative

| Niveau | XP requis | Membres | Pousse | Vente | XP |
|--:|--:|--:|--:|--:|--:|
| 1 | 5 000 | 10 | +0,4 % | +0,3 % | +0,4 % |
| 6 | 87 904 | 20 | +2,4 % | +1,8 % | +2,4 % |
| 11 | 231 845 | 30 | +4,4 % | +3,3 % | +4,4 % |
| 16 | 422 242 | 40 | +6,4 % | +4,8 % | +6,4 % |
| 21 | 652 410 | 50 | +8,4 % | +6,3 % | +8,4 % |
| 26 | 918 179 | 50 | +10,4 % | +7,8 % | +10,4 % |

Les bonus sont volontairement **modestes** (10 % maximum). L'intérêt d'une
coopérative doit rester social — objectifs collectifs, trésorerie, entraide — et non
mécaniquement obligatoire. Un joueur solo ne doit jamais être hors-jeu ; à +10 %, il
est légèrement moins efficace, pas exclu.

---

## 7. Puits monétaires et vérification anti-exploitation

### 7.1 Ce qui retire des pièces de l'économie

| Puits | Montant |
|---|---|
| Taxe de vente | **3 %** de chaque vente (exonéré sous le niveau 5) |
| Décote de vente directe | **15 %** sous le prix du marché |
| Commission hôtel des ventes | **5 %** du prix de vente |
| Frais de mise en vente | **2 %**, minimum 25 🪙, **non remboursables** |
| Taxe sur les dons | **5 %**, plafond 50 000 🪙/jour |
| Taxe sur les échanges | **2 %** des pièces échangées |
| Parcelles | 14 276 110 🪙 au total |
| Bâtiments | plusieurs millions cumulés sur tous les paliers |
| Graines, nourriture, vétérinaire | coût récurrent proportionnel à la production |
| Relance de quête | 500 🪙, doublant à chaque relance du jour |
| Création de coopérative | 25 000 🪙 |
| **Almanach** (§ 8.2) | `150 + 12 × niveau` 🪙 par prévision : 162 au niveau 1, 390 au niveau 20, 870 au niveau 60 |
| Marché noir | prix = `sellPrice × 6` (`balance.blackMarket.priceMultiplier`), 3 emplacements, 1 à 2 unités, niveau 30 |

La décote de 15 % à la vente directe est ce qui rend l'hôtel des ventes utile : y
vendre coûte 7 % de frais au total contre 15 % de décote, donc le joueur patient est
récompensé — mais paie quand même.

### 7.2 Les exploitations recherchées, et pourquoi elles ne fonctionnent pas

| Exploitation | Pourquoi elle échoue |
|---|---|
| **Acheter en boutique, revendre au marché** | Le prix d'achat est toujours supérieur au prix de vente diminué de la décote et de la taxe. Vérifié par test sur **tous** les objets vendables. |
| **Aller-retour boutique du jour ↔ marché** | Même contrainte, remise maximale incluse. |
| **Faire tourner le compost** | Marge ramenée à 1,67× parce que l'entrée est gratuite (§ 4). |
| **Acheter-revendre des animaux jusqu'à la dorée** | Revente à 60 % ; une dorée (0,2 % × poids ≤ 3) revend à 180 % : espérance ≈ −40 % par bête (§ 3.1). |
| **Relancer une récolte jusqu'à l'iridium** | Le tirage n'est pas rejouable : la parcelle est verrouillée (`SELECT … FOR UPDATE`) et deux `/harvest` simultanés n'en produisent qu'un (test d'intégration `harvest-concurrency`). |
| **Blanchir via les dons** | Taxe de 5 % + plafond quotidien de 50 000 🪙 + niveau minimum 5. |
| **Contourner la limite « 1 par joueur » de la boutique** | `shop_purchases` cumule les achats par (joueur, article) ; la limite se lisait autrefois sur un seul achat (audit, migration 0011). |
| **Manipuler un prix de marché** | Plancher 55 % / plafond 180 % **durs**, plus décroissance de volume. Une alerte de prix (§ 8.1) ne crée ni ne détruit rien : elle envoie un message. |
| **Doubler une action par double-clic** | Verrou Redis par `(joueur, action)` avec jeton propriétaire (TTL 30 s, libération Lua) + revalidation d'état sous `FOR UPDATE`. |
| **Multi-comptes en parrainage** | Récompenses versées à des **paliers de progression du filleul**, pas à l'inscription ; *trigger* SQL anti-boucle. |
| **Créer des pièces par arrondi** | `scaleMoney` arrondit vers le bas, `feeOf` vers le haut : l'erreur d'arrondi va toujours à l'économie. Cinq chemins de gain qui utilisaient `Math.round` ont été ramenés à `scaleMoney` (audit F-11). |
| **Deviner le marché noir de demain** | La graine du monde vient de `WORLD_SEED` (secret d'instance), plus d'une constante du dépôt (audit F-07). |

Une limite connue reste ouverte : le plafond quotidien des dons est lu **hors**
transaction, avant le verrou de ligne ; deux dons simultanés peuvent le franchir
ensemble. Le scénario d'intégration `gift-cap-concurrent` vérifie que chaque
solde reste égal à son journal, et un `it.todo` nomme la correction attendue
(relire le plafond sous `lockUserRow`).

### 7.3 Détection en exploitation

Le job `economy:snapshot` capture toutes les heures (à la minute 30) la masse
monétaire, les flux par type et les écarts du grand livre. Un **score de
suspicion** par joueur agrège les anomalies (gains anormaux, fréquence d'action
impossible, écart de grand livre) avec trois seuils : **50** avertissement
journalisé, **120** revue manuelle, **250** bannissement économique automatique
(7 jours). Une croissance de la masse monétaire supérieure à **8 % par jour**
(`inflationAlertDailyGrowth`) est signalée par `/admin stats`. Les mêmes valeurs
sont exposées en métriques Prometheus (`harvester_economy_*`) et lues par le
tableau Grafana — le carnet d'incidents est dans
[08 — Exploitation](./08-exploitation.md).

---

## 8. Alertes, almanach, rétention

### 8.1 Alertes de prix — `balance.alerts`

| Paramètre | Valeur |
|---|--:|
| `maxPerUser` | 5 alertes actives par joueur |
| `durationDays` | 14 jours de validité |

Une alerte prévient quand `market_prices.current_price` (hors qualité, hors bonus
d'événement — la seule valeur que bornent `priceFloorPct`/`priceCeilPct`) atteint
un seuil. Le seuil doit être **atteignable** : il est accepté dans
`[⌊base × 0,55⌋, ⌈base × 1,8⌉]`, exactement les bornes dures de `updatePrice`,
sinon la commande le refuse en affichant les bornes. L'égalité déclenche dans les
deux sens (le marché saute d'un entier à l'autre une fois par heure, un
« strictement supérieur » raterait le pic visé). C'est le pendant **vendeur** des
ordres permanents : là où `/order` achète, `/alert` ne fait qu'envoyer un message
privé (gardé par `settings.notify_market`) et un webhook `price_alert` — aucune
contrepartie en objets, donc aucun puits d'objets ouvert.

### 8.2 Almanach — `balance.almanac`

| Paramètre | Valeur |
|---|--:|
| `priceCoins` | 150 |
| `pricePerLevel` | 12 |

Prix d'une prévision : `150 + 12 × niveau` (`almanacPrice`, arrondi de
`scaleMoney`). Le niveau est la meilleure approximation du revenu horaire : au
niveau 20, 390 🪙 restent en dessous d'**une** parcelle-heure de cacao (508 🪙/h)
alors qu'une ferme de ce niveau en cultive des dizaines — la prévision est un
achat de confort, jamais un investissement qui se rembourse mécaniquement. Au
niveau 1, 162 🪙 valent vingt blés : cher pour un débutant, ce qui est voulu
(l'information n'a de valeur qu'avec des parcelles à protéger).
`tests/almanac.test.ts` verrouille ce contrat contre `crops.json`.

La prévision est **exacte** (même tirage que celui que le job de minuit UTC
fera) : une prévision approximative serait un produit trompeur. Elle vise le jour
UTC suivant quel que soit le fuseau du joueur, et reste lisible jusqu'au plus
tardif du minuit local et du minuit UTC.

### 8.3 Rétention du journal — `economy.ledger`

| Paramètre | Valeur | Rôle |
|---|--:|---|
| `checkpointDay` | 1 | jour UTC qui **étiquette** une période comptable (1 à 28, pour exister en février) |
| `retentionMonths` | 12 | âge minimal des écritures purgées (4 à 120 ; ≥ 4 pour couvrir la fenêtre de 90 jours de `/history`) |

Le cron de `ledger:checkpoint` reste codé sur le 1er à 05:00 UTC : changer
`checkpointDay` sans changer le cron ne déplace que l'étiquette des périodes.
Mécanisme complet en [03 § 1.5](./03-base-de-donnees.md#15-rétention-du-journal-comptable--soldes-douverture).

---

## 9. Régénérer ces tables

```bash
npm run balance:report            # affiche tout le rapport
npm run balance:report > out.txt  # ou le capture
```

Le script lit exclusivement `src/config/gameplay/` : il n'y a aucune valeur en dur.
Toute modification de l'équilibrage se voit immédiatement, et les tests suivants
échouent si un changement casse un invariant :

| Fichier | Tests | Ce qu'il garde |
|---|--:|---|
| `tests/config-and-balance.test.ts` | 43 | rentabilité et monotonie du profit horaire, plafond de marge, absence d'arbitrage boutique/marché, amortissement des animaux, durée de montée au niveau 60, déblocages par niveau, parité fr/en |
| `tests/content-crops.test.ts` | 8 | emoji et `sortOrder` uniques, rareté ↔ paliers, repousse cohérente, couverture par saison, une repousseuse par saison, ≤ 7 niveaux sans déblocage, (niveau, durée) unique |
| `tests/content-animals.test.ts` | 9 | silhouette et palette, toutes les formes utilisées, ≥ 2 espèces par rareté, bâtiment avant espèce, une seule monnaie, produit propre suivi par le marché, amortissement croissant, bonus passifs ≤ 10 % |
| `tests/content-recipes.test.ts` | 25 | recettes (bâtiment, ingrédients accessibles, ≥ 3 par atelier, ≤ 5 niveaux sans recette, durées), consommables (« plus fort = plus cher »), poissons et minerais (couverture, valeur croissante) |
| `tests/variants.test.ts` | 17 | distribution des variantes, hérédité, effets, espérance négative de l'achat-revente |
| `tests/almanac.test.ts` | 19 | jour visé, prix, prévision exacte, échéance, conseils |
| `tests/alerts.test.ts` | 17 | bornes, déclenchement, identifiants courts, tri |
| `tests/ledger-checkpoint.test.ts` | 18 | périodes, coupure, ouverture, écart, borne de purge |
