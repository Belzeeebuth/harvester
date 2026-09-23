/**
 * Résolution d'une saisie libre vers une clé d'objet.
 *
 * Les options à autocomplétion (`/sell item`, `/buy item`, `/plant seed`)
 * envoient la CLÉ quand le joueur choisit une proposition, mais le texte brut
 * quand il tape un nom et valide sans choisir (« Blé », « wheat », « ble »).
 * On accepte donc la clé exacte, puis le nom dans l'une ou l'autre langue, sans
 * tenir compte de la casse ni des accents.
 */

/** Minuscules, sans accents ni espaces superflus. */
export function normalizeLookup(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface LookupCandidate {
  key: string;
  /** Noms affichés (toutes langues confondues). */
  names: readonly string[];
  /**
   * Noms secondaires, essayés seulement si aucun nom affiché ne correspond :
   * « blé » désigne la récolte avant la graine, mais trouve la graine dans `/buy`
   * où la récolte n'est pas proposée.
   */
  aliases?: readonly string[];
}

/**
 * Clé correspondant à la saisie, ou `undefined`. Ordre de priorité : clé
 * exacte, clé normalisée, nom exact normalisé, alias exact, puis nom unique
 * qui COMMENCE par la saisie (« carot » → carotte). Une saisie ambiguë ne résout rien :
 * mieux vaut un refus qu'une vente du mauvais objet.
 */
export function resolveLookup(raw: string, candidates: readonly LookupCandidate[]): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const exact = candidates.find((candidate) => candidate.key === trimmed);
  if (exact) return exact.key;

  const needle = normalizeLookup(trimmed);
  const byKey = candidates.find((candidate) => normalizeLookup(candidate.key) === needle);
  if (byKey) return byKey.key;

  const byName = candidates.find((candidate) =>
    candidate.names.some((name) => normalizeLookup(name) === needle),
  );
  if (byName) return byName.key;

  const byAlias = candidates.find((candidate) =>
    (candidate.aliases ?? []).some((alias) => normalizeLookup(alias) === needle),
  );
  if (byAlias) return byAlias.key;

  const prefixed = candidates.filter((candidate) =>
    candidate.names.some((name) => normalizeLookup(name).startsWith(needle)),
  );
  return prefixed.length === 1 ? prefixed[0]?.key : undefined;
}
