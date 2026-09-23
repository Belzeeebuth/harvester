/**
 * Échéance des intérêts bancaires (job `bank:interest`, quotidien à 03:00 UTC).
 *
 * Un compte est éligible si son dernier versement date d'un JOUR UTC antérieur
 * à celui de l'exécution, et non plus « il y a au moins 24 h ». L'ancien seuil
 * était calculé au début du job alors que `last_interest_at` était horodaté un
 * peu plus tard, pendant la boucle : le lendemain, à quelques secondes près, le
 * versement de la veille tombait APRÈS la borne et le compte sautait un jour.
 * Résultat : des intérêts versés un jour sur deux environ.
 *
 * Avec la borne au début du jour UTC, la gigue du planificateur (quelques
 * secondes, voire minutes) n'a plus d'effet, et relancer le job le même jour
 * ne verse rien deux fois.
 *
 * Choix assumé : un jour manqué (job en panne, hôte arrêté) n'est PAS rattrapé.
 * Le versement suivant paie un seul jour, comme avant.
 */

/** Début (00:00 UTC) du jour de `now` : un versement antérieur rend le compte éligible. */
export function interestCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Même règle que le filtre SQL, pour les tests et les diagnostics. */
export function isInterestDue(lastInterestAt: Date, now: Date): boolean {
  return lastInterestAt.getTime() < interestCutoff(now).getTime();
}
