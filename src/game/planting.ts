/**
 * Nombre de parcelles traitées par une action groupée (planter, fertiliser).
 *
 * Ces actions étaient « tout ou rien » : le menu de plantation visait toutes
 * les parcelles libres puis exigeait autant de graines d'un coup. Avec 5
 * graines pour 9 parcelles, le joueur recevait « Il vous faut 9× » et ne
 * plantait rien. On traite désormais autant de parcelles que le stock le
 * permet ; le refus n'arrive que si le stock est vide.
 *
 * @param free      parcelles candidates (libres, ou à fertiliser)
 * @param owned     unités possédées de la ressource consommée (1 par parcelle)
 * @param requested plafond demandé par le joueur ; absent = autant que possible
 */
export function batchCount(free: number, owned: number, requested?: number): number {
  const cap = requested === undefined ? free : Math.max(1, Math.floor(requested));
  return Math.max(0, Math.min(free, owned, cap));
}
