# Rédaction des textes joueurs

Tout ce qu'un joueur lit vit dans `src/i18n/locales/{fr,en}` (et, pour le contenu
de jeu, dans `src/config/gameplay/*.json`). Ce guide fixe la voix de ces textes.
`tests/copy-style.test.ts` en vérifie la partie mécanique.

## La voix

Le panneau d'affichage d'un village agricole, tenu par quelqu'un qui cultive :
court, concret, un peu sec, bienveillant sans être enjoué. Le fait d'abord, puis
une seule étape utile quand il y en a une, et c'est tout. Le texte ne vend rien,
ne félicite pas pour rien, n'explique pas l'écran que le joueur a sous les yeux.
Un trait d'humour pince-sans-rire est bienvenu dans les textes d'ambiance
(descriptions, cartes postales, almanach), jamais dans une erreur ni une
confirmation.

## Règles

1. **Pas de tiret long** (cadratin, demi-cadratin). Deux-points quand il
   introduit une valeur ou une consigne, point quand il ouvre une seconde phrase,
   virgule sinon. Listes de commandes : `` `/cmd` : ce que ça fait `` en français,
   `` `/cmd`: what it does `` en anglais.
2. **Séparateur en ligne : ` · `** (point médian) entre deux faits courts. Jamais
   de `•` en pleine ligne ; en début de ligne, c'est une vraie puce.
3. **Émojis : des icônes, pas des décorations.** Icône d'objet ou de culture,
   monnaie 🪙 💎, verrou 🔒, avertissement ⚠️, et l'unique icône en tête d'un
   titre d'embed. Pas de ✅ 🎉 🚀 devant un fait, pas d'émoji aux deux bouts, une
   seule icône en début de ligne. Les jeux de marqueurs d'état (✅ / 🔒 / ⚠️ dans
   une même liste) restent.
4. **Gras : la valeur que le joueur cherche**, rien d'autre. Jamais une phrase
   entière, jamais plus de deux passages en gras par texte.
5. **Pas de remplissage** : « Bravo ! », « Félicitations », « Bonne chance,
   fermier », « aventure », « Votre objectif est simple », « Voici », « N'hésitez
   pas », « Veuillez », « avec succès ». Une phrase qui n'est que cela disparaît.
6. **Point d'exclamation : un seul, et seulement pour un évènement rare**
   (mutation, prise légendaire, montée de niveau). Erreurs, confirmations et
   conseils prennent un point.
7. **Ne pas expliquer l'interface** (« utilisez le menu ci-dessous »), sauf pour
   apprendre une commande que le joueur peut ignorer.
8. **Phrases de 18 mots au plus.** Deux phrases courtes valent mieux qu'une longue.
9. **Pluriels « (s) »** : les éviter par une tournure gratuite
   (« Parcelles nettoyées : {count} »). Il n'y a PAS de gestion des pluriels dans
   la couche i18n : ne pas en inventer.
10. **Erreur + indice** : l'erreur dit ce qui ne va pas en une phrase, l'indice
    (`*_hint`) donne la seule étape suivante, souvent une commande.
11. Français : vouvoiement, apostrophes droites, espace avant `: ; ? !`, tournures
    neutres quand elles ne coûtent rien (« Un doute ? » plutôt que « Perdu ? »).
    L'anglais est écrit nativement, pas calqué sur le français.

## Vocabulaire

| Notion | fr | en | À ne pas écrire |
|---|---|---|---|
| Unité de terre cultivable | parcelle | plot | champ, terrain, field, land (tolérés dans l'ambiance : cartes postales, almanach) |
| Monnaie courante | pièces | coins | argent, money (sauf « argent réel » / « real money ») |
| Monnaie rare | gemmes | gems | |
| Fonction bancaire | banque | bank | coffre, vault, compte bancaire |
| La personne, en mécanique | joueur | player | |
| La personne, en ambiance | fermier | farmer | |
| Groupe de joueurs | coopérative | co-op | |

## Contraintes techniques

- Les clés et les `{paramètres}` sont identiques en fr et en en (test de parité).
- Boutons, titres, libellés et tout espace de noms `render*` (texte dessiné sur
  une image, largeur fixe) ne s'allongent pas.
- Certains fragments sont collés par le code (espace de tête, deux-points de
  fin) : chercher la clé dans `src/` avant de déplacer une ponctuation.

## Commandes slash

Les commandes sont déclarées en anglais dans le code (texte par défaut exigé par
Discord). Leur version française vit dans `src/i18n/locales/commands.fr.json`,
une table plate `chemin → texte` :

| Chemin | Texte |
|---|---|
| `shop#description` | description de `/shop` |
| `shop/category#description` | description de son option `category` |
| `shop/category#choice:daily` | nom affiché du choix `daily` |

`src/i18n/commands.ts` greffe ces textes sur le corps envoyé à Discord
(`description_localizations`, `name_localizations`), et `/help` les reprend pour
les joueurs à qui le bot parle français. Les NOMS de commandes et d'options
restent anglais : les textes du jeu citent partout `/plant`, `/sell`.

- Description de commande : un infinitif ou un groupe nominal court (« Semer des
  graines sur vos parcelles »), jamais « Permet de… ». Option : ce qu'il faut
  saisir (« La graine à planter »). 100 caractères au plus, pas de point final.
- Un choix qui correspond à un libellé du jeu reprend ce libellé mot pour mot.
- `tests/commands-localization.test.ts` échoue si une commande, une option ou un
  choix n'a pas son texte français, ou si une entrée ne correspond plus à rien.
  Après un changement : `npm run commands:deploy` pour que Discord le voie.
