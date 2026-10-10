import { defineConfig } from 'vitest/config';

/**
 * Les tests couvrent `src/game/**` (logique pure), `src/utils/**` et la
 * validation de la configuration. Ils ne nécessitent NI base de données NI
 * Redis NI token Discord : c'est le bénéfice direct de la séparation
 * commandes → services → repositories, la logique de jeu ne dépend d'aucune I/O.
 */
export default defineConfig({
  test: {
    // Renseigne les variables obligatoires avant que src/config/env.ts ne les
    // valide : les tests chargent le registre sans infrastructure réelle.
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Les tests d'intégration ont leur propre configuration : ils exigent une
    // base PostgreSQL — ou un démon Docker — ce que `npm test` ne doit jamais
    // supposer. Les mélanger ici leur ferait hériter des faux placeholders de
    // `setup-env.ts`. Suite dédiée : `npm run test:integration`.
    exclude: ['**/node_modules/**', 'tests/integration/**'],
    globals: false,
    // `docker compose build` lance cette suite sur l'hôte de production, qui
    // fait tourner d'autres services : les tests de rendu (canvas) et ceux qui
    // importent tout le graphe y passent de 1 à 7 s. Les 5 s par défaut de
    // vitest faisaient échouer le build pour des dépassements, sans aucune
    // assertion fausse ; un vrai blocage reste attrapé.
    testTimeout: 20_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/game/**', 'src/utils/**', 'src/config/index.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
  },
});
