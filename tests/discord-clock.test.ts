import { beforeEach, describe, expect, it } from 'vitest';
import {
  LATE_INTERACTION_MS,
  clockOffsetMs,
  observeInteraction,
  resetDiscordClock,
  toLocalClock,
} from '../src/utils/discord-clock';

/**
 * Horloge du serveur contre horloge de Discord.
 *
 * Cas réel du 2026-09-20 : hôte sans NTP joignable, horloge en retard de 116 s.
 * La pêche comparait l'instant du clic (daté par Discord) à `biteAt` (daté par
 * l'hôte) avec 3 s de tolérance : toutes les prises étaient « trop tard ». Et un
 * `/help` traité en 342 ms avait échoué (« L'application ne répond plus ») parce
 * que la passerelle l'avait livré avec plus de 3 s de retard, sans laisser de
 * trace dans les journaux.
 */

const DISCORD_T0 = 1_789_907_938_194;
/** L'hôte retarde de 116 s : son `Date.now()` vaut l'heure Discord moins 116 000. */
const SKEW = -116_000;

beforeEach(() => resetDiscordClock());

/** Une interaction créée à `created` (heure Discord), reçue `lag` ms plus tard. */
function receive(created: number, lag: number, monotonic: number, skew = SKEW) {
  return observeInteraction(created, created + lag + skew, monotonic);
}

describe('décalage d’horloge', () => {
  it("vaut zéro tant qu'aucune interaction n'a été vue", () => {
    expect(clockOffsetMs()).toBe(0);
    expect(toLocalClock(DISCORD_T0)).toBe(DISCORD_T0);
  });

  it('retient le minimum observé : le retard ne se confond pas avec le décalage', () => {
    receive(DISCORD_T0, 400, 0);
    receive(DISCORD_T0 + 10_000, 60, 10_000);
    const { offsetMs, lagMs } = receive(DISCORD_T0 + 20_000, 900, 20_000);
    expect(offsetMs).toBe(SKEW + 60);
    expect(lagMs).toBe(840);
  });

  it('ramène un instant Discord sur notre horloge', () => {
    receive(DISCORD_T0, 50, 0);
    // Le poisson mord 2 s après le lancer, daté par NOTRE horloge.
    const biteAtLocal = DISCORD_T0 + 50 + SKEW + 2_000;
    // Le joueur clique 300 ms après la touche, daté par Discord.
    const clickAtDiscord = DISCORD_T0 + 50 + 2_000 + 300;
    expect(toLocalClock(clickAtDiscord) - biteAtLocal).toBe(350);
    // Sans conversion, l'écart mesuré était de 116 s : toujours « trop tard ».
    expect(clickAtDiscord - biteAtLocal).toBeGreaterThan(100_000);
  });

  it('signale une interaction livrée trop tard pour être acquittée', () => {
    receive(DISCORD_T0, 80, 0);
    const { lagMs } = receive(DISCORD_T0 + 60_000, 3_900, 60_000);
    expect(lagMs).toBe(3_820);
    expect(lagMs).toBeGreaterThan(LATE_INTERACTION_MS);
    // Un retard isolé ne déplace pas l'estimation du décalage.
    expect(clockOffsetMs()).toBe(SKEW + 80);
  });

  it('oublie les mesures sorties de la fenêtre', () => {
    receive(DISCORD_T0, 20, 0);
    receive(DISCORD_T0 + 400_000, 150, 400_000);
    expect(clockOffsetMs()).toBe(SKEW + 150);
  });

  it("suit une horloge recalée vers l'avant dès trois mesures concordantes", () => {
    receive(DISCORD_T0, 50, 0);
    receive(DISCORD_T0 + 1_000, 70, 1_000);
    // NTP rétabli : l'hôte est maintenant à l'heure.
    receive(DISCORD_T0 + 2_000, 90, 2_000, 0);
    receive(DISCORD_T0 + 3_000, 60, 3_000, 0);
    expect(clockOffsetMs()).toBe(SKEW + 50);
    receive(DISCORD_T0 + 4_000, 110, 4_000, 0);
    expect(clockOffsetMs()).toBe(60);
  });

  it("suit aussitôt une horloge recalée vers l'arrière", () => {
    receive(DISCORD_T0, 50, 0, 0);
    receive(DISCORD_T0 + 1_000, 50, 1_000, -30_000);
    expect(clockOffsetMs()).toBe(-30_000 + 50);
  });
});
