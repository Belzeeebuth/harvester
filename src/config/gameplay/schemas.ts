import { z } from 'zod';

/**
 * Schémas Zod des fichiers de configuration de gameplay.
 *
 * Tout est validé au démarrage ET à chaque `/admin reload-config`. Une config
 * invalide n'est jamais appliquée : on garde l'ancienne en mémoire et on
 * remonte l'erreur à l'administrateur. C'est ce qui permet d'éditer
 * l'équilibrage en production sans risquer de casser le bot.
 */

export const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const;
export const seasonNames = ['spring', 'summer', 'autumn', 'winter'] as const;
export const weatherNames = [
  'sunny',
  'cloudy',
  'rainy',
  'storm',
  'heatwave',
  'frost',
  'snow',
] as const;
export const itemCategories = [
  'seed',
  'harvest',
  'animal_product',
  'product',
  'tool',
  'consumable',
  'material',
  'cosmetic',
  'event',
  'fish',
  'ore',
] as const;
export const buildingCategories = ['livestock', 'production', 'storage', 'utility'] as const;
export const qualities = ['normal', 'silver', 'gold', 'iridium'] as const;
export const mutations = ['giant', 'rainbow', 'ancient'] as const;

/**
 * Variantes d'animaux, par ordre de rareté croissante — le même ordre que
 * l'énumération SQL `animal_variant`, ce qui permet à PostgreSQL de comparer
 * deux variantes (`GREATEST`) sans table de rang. Elles ne viennent QUE du jeu
 * (tirage à l'achat, hérédité à la reproduction) : aucune boutique n'en vend.
 */
export const animalVariants = ['normal', 'shiny', 'golden'] as const;
export type AnimalVariant = (typeof animalVariants)[number];

/**
 * Familles d'entrées de la collection du fermier (`/collection`). Chaque
 * famille a son propre univers : les cultures, les produits transformés et
 * d'élevage, les espèces, les poissons, les minerais, et les variantes
 * (une entrée par espèce × variante rare).
 */
export const discoveryKinds = ['crop', 'product', 'animal', 'fish', 'ore', 'variant'] as const;
export type DiscoveryKind = (typeof discoveryKinds)[number];

const key = z.string().min(1).max(48).regex(/^[a-z0-9_]+$/, 'clé en minuscules, chiffres et _');
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);
const ratio = z.number().min(0).max(1);

export const itemStackSchema = z.object({
  itemKey: key,
  quantity: positiveInt,
});
export type ItemStack = z.infer<typeof itemStackSchema>;

// ---------------------------------------------------------------------------
// Cultures
// ---------------------------------------------------------------------------
/**
 * Apparence d'une culture dans les images générées.
 *
 * `form` choisit la SILHOUETTE dessinée : c'est elle qui permet de reconnaître
 * ce qui pousse sans lire une infobulle. La palette donne les quatre teintes du
 * tracé. Les deux sont des données d'équilibrage comme les autres — on change
 * l'aspect d'une culture sans toucher au code.
 *
 * Sans ces champs, le rendu retombe sur une silhouette générique : la
 * configuration reste valide, l'image reste correcte, elle est juste moins
 * lisible.
 */
export const cropForms = [
  'stalk',   // céréale : touffe d'épis (blé)
  'tall',    // tige haute à tête (maïs, tournesol)
  'bush',    // buisson à fruits (tomate, poivron)
  'vine',    // treille (raisin, houblon, concombre)
  'ground',  // courge posée au sol (potiron, melon)
  'tree',    // arbuste (café, cacao, thé)
  'root',    // racine, épaule visible à maturité (carotte)
  'leafy',   // rosette de feuilles, sans fruit (laitue)
  'flower',  // hampe et corolle (lavande, safran)
] as const;
export type CropForm = (typeof cropForms)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'doit être une couleur hexadécimale #rrggbb');

export const cropPaletteSchema = z.object({
  leaf: hexColor,
  leafDark: hexColor,
  fruit: hexColor,
  fruitDark: hexColor,
});
export type CropPalette = z.infer<typeof cropPaletteSchema>;

export const cropSchema = z.object({
  key,
  name: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(64).optional(),
  emoji: z.string().min(1).max(32),
  rarity: z.enum(rarities).default('common'),
  seedPrice: nonNegativeInt,
  growthSeconds: positiveInt,
  baseYield: positiveInt,
  sellPrice: positiveInt,
  requiredLevel: z.number().int().min(1).max(120).default(1),
  seasons: z.array(z.enum(seasonNames)).min(1),
  qualityMultiplier: z.number().min(0.1).max(5).default(1),
  waterRequired: z.number().int().min(0).max(20).default(1),
  fertilityCost: z.number().int().min(0).max(50).default(3),
  xpReward: nonNegativeInt.default(1),
  regrowCycles: z.number().int().min(0).max(20).default(0),
  regrowSeconds: nonNegativeInt.default(0),
  mutationChance: z.number().min(0).max(1).default(0.01),
  form: z.enum(cropForms).default('bush'),
  palette: cropPaletteSchema.optional(),
  sprite: z.string().max(64).optional(),
  description: z.string().max(512).optional(),
  descriptionEn: z.string().max(512).optional(),
  sortOrder: nonNegativeInt.default(0),
  enabled: z.boolean().default(true),
});
export type CropConfig = z.infer<typeof cropSchema>;

// ---------------------------------------------------------------------------
// Animaux
// ---------------------------------------------------------------------------
/**
 * Apparence d'un animal dans les images générées — même principe que
 * `cropForms` : la SILHOUETTE dit l'espèce, la palette la colore. Sans ces
 * champs, le rendu retombe sur la silhouette générique (corps + tête + pattes),
 * qui reste correcte mais ne distingue pas une poule d'une vache.
 */
export const animalForms = [
  'fowl',       // volaille ronde : poule, canard, dinde
  'longneck',   // grand oiseau à long cou : autruche, oie, paon, cygne
  'smallfurry', // petit mammifère à oreilles : lapin, cochon d'Inde, hérisson
  'woolly',     // corps en nuage : mouton, alpaga, lama, yack
  'hoofed',     // corps en boîte sur quatre pattes, cornes optionnelles : vache, chèvre, cheval, cerf
  'swine',      // tonneau à groin : cochon, sanglier
  'insect',     // petit corps ailé : abeille, papillon, ver à soie
  'shelled',    // dôme : tortue, escargot
  'winged',     // corps + ailes + queue : dragonnet, phénix, griffon
] as const;
export type AnimalForm = (typeof animalForms)[number];

export const animalPaletteSchema = z.object({
  body: hexColor,
  bodyDark: hexColor,
  /** Bec, cornes, ailes, crête — la touche qui distingue l'espèce. */
  accent: hexColor,
  accentDark: hexColor,
});
export type AnimalPalette = z.infer<typeof animalPaletteSchema>;

export const animalSchema = z.object({
  key,
  name: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(64).optional(),
  emoji: z.string().min(1).max(32),
  rarity: z.enum(rarities).default('common'),
  price: nonNegativeInt,
  priceGems: nonNegativeInt.default(0),
  buildingKey: key,
  productItemKey: key,
  productQuantity: positiveInt.default(1),
  productionSeconds: positiveInt,
  feedItemKey: key,
  feedPerCycle: z.number().int().min(0).max(20).default(1),
  requiredLevel: z.number().int().min(1).max(120).default(1),
  lifespanDays: nonNegativeInt.default(0),
  breedable: z.boolean().default(true),
  breedingCooldownSeconds: nonNegativeInt.default(86_400),
  hungerRate: z.number().min(0).max(100).default(4),
  happinessRate: z.number().min(0).max(100).default(2),
  passiveBonus: z
    .object({
      cropYield: z.number().min(0).max(1).optional(),
      marketSellBonus: z.number().min(0).max(1).optional(),
      xpBonus: z.number().min(0).max(1).optional(),
      luck: z.number().min(0).max(1).optional(),
      breedingSpeed: z.number().min(0).max(2).optional(),
    })
    .default({}),
  eventOnly: z.boolean().default(false),
  form: z.enum(animalForms).optional(),
  palette: animalPaletteSchema.optional(),
  sprite: z.string().max(64).optional(),
  description: z.string().max(512).optional(),
  descriptionEn: z.string().max(512).optional(),
  sortOrder: nonNegativeInt.default(0),
  enabled: z.boolean().default(true),
});
export type AnimalConfig = z.infer<typeof animalSchema>;

// ---------------------------------------------------------------------------
// Objets
// ---------------------------------------------------------------------------
export const itemEffectSchema = z
  .object({
    type: z
      .enum([
        'fertilizer',
        'water_all',
        'xp_boost',
        'growth_boost',
        'luck',
        'pest_repel',
        'pest_cure',
        'energy',
        'streak_freeze',
        'quest_reroll',
        'watering',
        'harvest',
        'theme',
        'banner',
      ])
      .optional(),
    fertility: z.number().int().min(0).max(100).optional(),
    yieldBoost: z.number().min(0).max(5).optional(),
    qualityBoost: z.number().min(0).max(5).optional(),
    multiplier: z.number().min(0).max(20).optional(),
    durationSeconds: nonNegativeInt.optional(),
    bonus: z.number().min(0).max(5).optional(),
    amount: z.number().int().optional(),
    plots: positiveInt.optional(),
    flatYield: nonNegativeInt.optional(),
    costReduction: ratio.optional(),
    value: z.string().max(32).optional(),
  })
  .nullable()
  .optional();

export const itemSchema = z.object({
  key,
  name: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(64).optional(),
  emoji: z.string().min(1).max(32),
  category: z.enum(itemCategories),
  rarity: z.enum(rarities).default('common'),
  basePrice: nonNegativeInt.default(0),
  sellPrice: nonNegativeInt.default(0),
  priceGems: nonNegativeInt.default(0),
  stackable: z.boolean().default(true),
  maxStack: positiveInt.default(9999),
  tradable: z.boolean().default(true),
  sellable: z.boolean().default(true),
  marketTracked: z.boolean().default(false),
  effect: itemEffectSchema,
  requiredLevel: z.number().int().min(1).max(120).default(1),
  sourceKey: key.optional(),
  collectionKey: key.optional(),
  sprite: z.string().max(64).optional(),
  description: z.string().max(512).optional(),
  descriptionEn: z.string().max(512).optional(),
  sortOrder: nonNegativeInt.default(0),
  enabled: z.boolean().default(true),
  /** Pêche : saisons où la prise est possible ; absent/vide = toute l'année. */
  seasons: z.array(z.enum(seasonNames)).optional(),
  /** Pêche : moment de la journée requis. */
  timeOfDay: z.enum(['day', 'night', 'any']).optional(),
  /** Mine : profondeur minimale à laquelle le minerai peut apparaître. */
  minDepth: positiveInt.optional(),
});
export type ItemConfig = z.infer<typeof itemSchema>;

// ---------------------------------------------------------------------------
// Recettes
// ---------------------------------------------------------------------------
export const recipeSchema = z.object({
  key,
  name: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(64).optional(),
  emoji: z.string().min(1).max(32),
  buildingKey: key,
  outputItemKey: key,
  outputQuantity: positiveInt.default(1),
  ingredients: z.array(itemStackSchema).min(1).max(6),
  durationSeconds: positiveInt,
  requiredLevel: z.number().int().min(1).max(120).default(1),
  xpReward: nonNegativeInt.default(1),
  category: z.string().min(1).max(32).default('general'),
  sortOrder: nonNegativeInt.default(0),
  enabled: z.boolean().default(true),
});
export type RecipeConfig = z.infer<typeof recipeSchema>;

// ---------------------------------------------------------------------------
// Bâtiments
// ---------------------------------------------------------------------------
export const buildingTierSchema = z.object({
  tier: positiveInt,
  requiredLevel: z.number().int().min(1).max(120),
  costCoins: nonNegativeInt,
  costItems: z.array(itemStackSchema).default([]),
  capacity: nonNegativeInt.default(0),
  slots: nonNegativeInt.default(0),
  speedMultiplier: z.number().min(0.1).max(10).default(1),
  effect: z
    .object({
      energyMax: positiveInt.optional(),
      autoWaterRatio: ratio.optional(),
      seedRecoveryChance: ratio.optional(),
      seasonImmunity: z.boolean().optional(),
      weatherDamageReduction: ratio.optional(),
    })
    .optional(),
});
export type BuildingTier = z.infer<typeof buildingTierSchema>;

export const buildingSchema = z
  .object({
    key,
    name: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(64).optional(),
    emoji: z.string().min(1).max(32),
    category: z.enum(buildingCategories),
    maxTier: z.number().int().min(1).max(10),
    tiers: z.array(buildingTierSchema).min(1),
    requiredLevel: z.number().int().min(1).max(120).default(1),
    unlocksRecipes: z.array(key).default([]),
    sprite: z.string().max(64).optional(),
    description: z.string().max(512).optional(),
    descriptionEn: z.string().max(512).optional(),
    sortOrder: nonNegativeInt.default(0),
    enabled: z.boolean().default(true),
  })
  .refine((building) => building.tiers.length === building.maxTier, {
    message: 'le nombre de paliers doit être égal à maxTier',
  })
  .refine(
    (building) => building.tiers.every((tier, index) => tier.tier === index + 1),
    { message: 'les paliers doivent être numérotés 1..maxTier dans l\'ordre' },
  );
export type BuildingConfig = z.infer<typeof buildingSchema>;

// ---------------------------------------------------------------------------
// Quêtes / succès / événements
// ---------------------------------------------------------------------------
export const questObjectives = [
  'harvest_crop',
  'harvest_any',
  'harvest_category',
  'plant_seed',
  'water_plot',
  'fertilize_plot',
  'treat_pest',
  'collect_animal',
  'feed_animal',
  'pet_animal',
  'craft_item',
  'sell_item',
  'sell_value',
  'earn_coins',
  'spend_coins',
  'buy_plot',
  'reach_level',
  'deliver_items',
  'visit_farm',
  'help_farmer',
  'auction_sale',
  'login_streak',
  /** Première obtention d'une entrée de collection (culture, produit, espèce, variante…). */
  'discover_entry',
] as const;

export const objectiveTargetSchema = z
  .object({
    cropKey: key.optional(),
    itemKey: key.optional(),
    animalKey: key.optional(),
    recipeKey: key.optional(),
    recipeCategory: z.string().max(32).optional(),
    category: z.enum(itemCategories).optional(),
    rarity: z.enum(rarities).optional(),
    /** `discover_entry` : restreint le succès à une famille de la collection. */
    kind: z.enum(discoveryKinds).optional(),
  })
  .default({});
export type ObjectiveTarget = z.infer<typeof objectiveTargetSchema>;

export const questSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  type: z.enum(['daily', 'weekly', 'story', 'contract']),
  title: z.string().min(1).max(128),
  titleEn: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(512),
  descriptionEn: z.string().min(1).max(512).optional(),
  objectiveType: z.enum(questObjectives),
  objectiveTarget: objectiveTargetSchema,
  requiredAmount: positiveInt,
  rewardCoins: nonNegativeInt.default(0),
  rewardGems: nonNegativeInt.default(0),
  rewardXp: nonNegativeInt.default(0),
  rewardPassXp: nonNegativeInt.default(0),
  rewardItems: z.array(itemStackSchema).default([]),
  requiredLevel: z.number().int().min(1).max(120).default(1),
  chainKey: z.string().max(48).optional(),
  chainStep: positiveInt.optional(),
  weight: positiveInt.default(10),
  enabled: z.boolean().default(true),
});
export type QuestConfig = z.infer<typeof questSchema>;

export const achievementSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(128),
  nameEn: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(512),
  descriptionEn: z.string().min(1).max(512).optional(),
  category: z.string().min(1).max(32).default('general'),
  icon: z.string().min(1).max(32).default('🏆'),
  tier: z.number().int().min(1).max(5).default(1),
  conditionType: z.enum(questObjectives),
  conditionTarget: objectiveTargetSchema,
  conditionAmount: positiveInt,
  rewardCoins: nonNegativeInt.default(0),
  rewardGems: nonNegativeInt.default(0),
  rewardItems: z.array(itemStackSchema).default([]),
  rewardTitle: z.string().max(64).optional(),
  rewardTitleEn: z.string().max(64).optional(),
  rewardBadge: z.string().max(64).optional(),
  rewardXp: nonNegativeInt.default(0),
  hidden: z.boolean().default(false),
  sortOrder: nonNegativeInt.default(0),
  enabled: z.boolean().default(true),
});
export type AchievementConfig = z.infer<typeof achievementSchema>;

export const eventRewardSchema = z.object({
  coins: nonNegativeInt.optional(),
  gems: nonNegativeInt.optional(),
  xp: nonNegativeInt.optional(),
  items: z.array(itemStackSchema).optional(),
  title: z.string().max(64).optional(),
  animalKey: key.optional(),
});

export const eventSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(128),
  nameEn: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(1024),
  descriptionEn: z.string().min(1).max(1024).optional(),
  type: z.enum(['seasonal', 'weekend', 'community', 'disaster', 'anniversary']).default('seasonal'),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  recurringCron: z.string().max(64).optional(),
  /**
   * Durée d'une occurrence, en heures. Obligatoire avec `recurringCron` :
   * le cron dit QUAND l'évènement commence, jamais combien de temps il dure,
   * et sans durée la fenêtre ne peut pas être calculée (voir game/events.ts).
   */
  durationHours: z.number().positive().max(24 * 90).optional(),
  banner: z.string().max(96).optional(),
  currencyItemKey: key.optional(),
  modifiers: z
    .object({
      xpMultiplier: z.number().min(0).max(10).optional(),
      growthMultiplier: z.number().min(0).max(10).optional(),
      globalPriceMultiplier: z.number().min(0).max(10).optional(),
      mutationMultiplier: z.number().min(0).max(10).optional(),
      qualityBonus: z.number().min(0).max(5).optional(),
      waterMultiplier: z.number().min(0).max(10).optional(),
      dailyRewardMultiplier: z.number().min(0).max(10).optional(),
      tokenPerHarvest: nonNegativeInt.optional(),
      tokenPerCraft: nonNegativeInt.optional(),
      fragmentDropChance: ratio.optional(),
      forcedWeather: z.enum(weatherNames).optional(),
      cropPriceMultipliers: z.record(z.string(), z.number().min(0).max(20)).optional(),
      categoryPriceMultipliers: z.record(z.string(), z.number().min(0).max(20)).optional(),
    })
    .default({}),
  rewardTiers: z
    .array(z.object({ points: positiveInt, rewards: eventRewardSchema }))
    .default([]),
  shopItems: z
    .array(
      z.object({
        itemKey: key,
        price: positiveInt,
        currencyItemKey: key.optional(),
        stock: positiveInt.default(10),
      }),
    )
    .default([]),
  enabled: z.boolean().default(true),
})
  .refine((event) => !event.recurringCron || event.durationHours !== undefined, {
    // Sans durée, `getActiveEvents` ne saurait pas quand refermer la fenêtre :
    // l'évènement resterait invisible, comme avant ce garde-fou.
    message: 'durationHours est obligatoire quand recurringCron est défini',
    path: ['durationHours'],
  });
export type EventConfig = z.infer<typeof eventSchema>;

export const seasonPassSchema = z.object({
  id: z.string().min(1).max(48),
  seasonKey: z.string().min(1).max(48),
  name: z.string().min(1).max(128),
  nameEn: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).optional(),
  descriptionEn: z.string().max(1024).optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  maxTier: positiveInt,
  xpPerTier: positiveInt,
  active: z.boolean().default(false),
  tiers: z
    .array(
      z.object({
        tier: positiveInt,
        free: eventRewardSchema,
        premium: eventRewardSchema,
      }),
    )
    .min(1),
});
export type SeasonPassConfig = z.infer<typeof seasonPassSchema>;

// ---------------------------------------------------------------------------
// Équilibrage
// ---------------------------------------------------------------------------
export const balanceSchema = z.object({
  progression: z.object({
    maxLevel: z.number().int().min(2).max(120),
    xpCurve: z.object({
      base: z.number().positive(),
      exponent: z.number().min(1).max(3),
      linear: z.number().min(0),
    }),
    levelRewardCoins: z.object({
      base: nonNegativeInt,
      perLevel: nonNegativeInt,
      exponent: z.number().min(1).max(3),
    }),
    milestoneLevels: z.array(positiveInt),
    milestoneGems: nonNegativeInt,
    weeklyXpResetDay: z.number().int().min(1).max(7),
  }),
  prestige: z.object({
    requiredLevel: positiveInt,
    pointsPerPrestige: z.object({ base: nonNegativeInt, perLevelOverMax: nonNegativeInt }),
    multiplierPerPrestige: z.number().min(0).max(2),
    maxPrestige: z.number().int().min(1).max(20),
    keeps: z.object({
      plots: ratio,
      buildings: z.boolean(),
      animals: z.boolean(),
      inventoryCategories: z.array(z.enum(itemCategories)),
      coinsPercent: ratio,
      gems: z.boolean(),
    }),
    startingCoinsAfterPrestige: nonNegativeInt,
  }),
  plots: z.object({
    startingUnlocked: positiveInt,
    maxPlots: z.number().int().min(1).max(64),
    baseCost: positiveInt,
    costGrowth: z.number().min(1).max(3),
    costRounding: positiveInt,
    gridSteps: z
      .array(
        z.object({
          plots: positiveInt,
          width: z.number().int().min(1).max(8),
          height: z.number().int().min(1).max(8),
        }),
      )
      .min(1),
  }),
  fertility: z.object({
    start: z.number().int().min(0).max(100),
    min: z.number().int().min(0).max(100),
    max: z.number().int().min(0).max(100),
    fallowRecoveryPerHour: z.number().min(0).max(100),
    lowThreshold: z.number().int().min(0).max(100),
    yieldPenaltyAtZero: ratio,
    yieldBonusAtMax: z.number().min(0).max(2),
  }),
  water: z.object({
    penaltyPerMissedWatering: ratio,
    maxPenalty: ratio,
    graceMinutes: nonNegativeInt,
    helpBonusPerHelper: z.number().min(0).max(1),
    maxHelpBonus: z.number().min(0).max(1),
  }),
  weeds: z.object({
    growthPerHour: z.number().min(0).max(100),
    penaltyThreshold: z.number().int().min(0).max(100),
    yieldPenaltyAtMax: ratio,
    weedsPerClear: positiveInt,
  }),
  pests: z.object({
    baseDailyChancePerPlot: ratio,
    deadlineHours: positiveInt,
    yieldLossIfIgnored: ratio,
    witherIfIgnoredChance: ratio,
    treatEnergyCost: nonNegativeInt,
  }),
  quality: z.object({
    weights: z.object({
      normal: z.number().positive(),
      silver: z.number().positive(),
      gold: z.number().positive(),
      iridium: z.number().positive(),
    }),
    multipliers: z.object({
      normal: z.number().positive(),
      silver: z.number().positive(),
      gold: z.number().positive(),
      iridium: z.number().positive(),
    }),
    fertilityInfluence: z.number().min(0).max(5),
    levelInfluence: z.number().min(0).max(1),
    maxLuckBonus: z.number().min(0).max(5),
  }),
  mutations: z.record(
    z.enum(mutations),
    z.object({
      weight: z.number().positive(),
      yieldMultiplier: z.number().positive(),
      priceMultiplier: z.number().positive(),
    }),
  ),
  seasons: z.object({
    lengthDays: positiveInt,
    order: z.array(z.enum(seasonNames)).length(4),
    inSeasonYieldBonus: z.number().min(0).max(3),
    offSeasonYieldPenalty: ratio,
    offSeasonGrowthPenalty: ratio,
    winterExtraPenalty: ratio,
  }),
  weather: z.object({
    table: z
      .array(
        z.object({
          weather: z.enum(weatherNames),
          emoji: z.string().min(1).max(16),
          label: z.string().min(1).max(48),
          labelEn: z.string().min(1).max(48).optional(),
          weights: z.object({
            spring: z.number().min(0),
            summer: z.number().min(0),
            autumn: z.number().min(0),
            winter: z.number().min(0),
          }),
          yieldModifier: z.number().positive(),
          growthModifier: z.number().positive(),
          freeWatering: z.boolean(),
          damageChance: ratio,
          pestChance: ratio,
          description: z.string().min(1).max(256),
          descriptionEn: z.string().min(1).max(256).optional(),
        }),
      )
      .min(1),
    heatwaveWaterMultiplier: z.number().min(1).max(10),
  }),
  market: z.object({
    updateMinutes: positiveInt,
    volatility: z.number().min(0).max(1),
    priceFloorPct: z.number().min(0).max(1),
    priceCeilPct: z.number().min(1).max(10),
    demandSmoothing: ratio,
    demandDecay: ratio,
    referenceVolumeBase: positiveInt,
    referenceVolumeRarityDivisor: z.record(z.enum(rarities), z.number().positive()),
    featuredCount: nonNegativeInt,
    featuredBonus: z.number().min(0).max(2),
    historyRetentionDays: positiveInt,
    historyPointsForChart: positiveInt,
  }),
  shop: z.object({
    dailySlots: positiveInt,
    rotationHourUtc: z.number().int().min(0).max(23),
    discountChance: ratio,
    discountRange: z.tuple([nonNegativeInt, nonNegativeInt]),
    stockRange: z.tuple([positiveInt, positiveInt]),
    featuredCount: nonNegativeInt,
  }),
  blackMarket: z.object({
    /** Niveau requis pour tout article, quel que soit le niveau propre de l'objet. */
    minLevel: positiveInt,
    slots: positiveInt,
    /** Applié au `sellPrice` de l'objet : c'est un prix d'achat, pas une référence de vente. */
    priceMultiplier: z.number().min(1),
    stockRange: z.tuple([positiveInt, positiveInt]),
  }),
  auction: z.object({
    commissionRate: ratio,
    listingFeeRate: ratio,
    minListingFee: nonNegativeInt,
    durationsHours: z.array(positiveInt).min(1),
    defaultDurationHours: positiveInt,
    maxActiveListings: positiveInt,
    minPricePctOfMarket: z.number().min(0).max(10),
    maxPricePctOfMarket: z.number().min(0).max(100),
    minBidIncrementPct: z.number().min(0).max(1),
    antiSnipeExtensionMinutes: nonNegativeInt,
    maxActiveOrders: positiveInt,
    orderDurationHours: positiveInt,
  }),
  trade: z.object({
    expiryMinutes: positiveInt,
    maxItemsPerSide: positiveInt,
    maxCoinsPerSide: positiveInt,
    minLevel: positiveInt,
    taxRate: ratio,
  }),
  bank: z.object({
    tiers: z
      .array(
        z.object({
          tier: positiveInt,
          requiredLevel: positiveInt,
          capacity: positiveInt,
          interestRate: z.number().min(0).max(1),
          interestCap: nonNegativeInt,
          upgradeCost: nonNegativeInt,
        }),
      )
      .min(1),
    theftProtection: z.boolean(),
    withdrawFeeRate: ratio,
  }),
  energy: z.object({
    enabled: z.boolean(),
    startingMax: positiveInt,
    regenPerMinute: z.number().positive(),
    costs: z.record(z.string(), nonNegativeInt),
    refillGemCost: nonNegativeInt,
  }),
  fishing: z.object({
    unlockLevel: positiveInt,
    /** Fenêtre pendant laquelle ferrer, en millisecondes. */
    windowMs: positiveInt,
    /** Délai avant la touche, tiré uniformément dans cet intervalle (ms). */
    biteDelayMsRange: z.tuple([nonNegativeInt, positiveInt]),
    /** Poids par rareté pour le tirage de l'espèce (mêmes clés que `rarities`). */
    rarityWeights: z.record(z.enum(rarities), nonNegativeInt),
  }),
  mining: z.object({
    unlockLevel: positiveInt,
    maxDepth: positiveInt,
    /** Niveaux de joueur nécessaires pour débloquer une profondeur supplémentaire. */
    levelsPerDepth: positiveInt,
    /** Probabilité de descendre d'un palier à chaque extraction réussie. */
    advanceChance: ratio,
    /** Poids par rareté pour le tirage du minerai (mêmes clés que `rarities`). */
    rarityWeights: z.record(z.enum(rarities), nonNegativeInt),
  }),
  api: z.object({
    enabled: z.boolean(),
    maxKeysPerUser: positiveInt,
    rateLimitPerMinute: positiveInt,
    maxWebhooksPerUser: positiveInt,
    webhookTimeoutMs: positiveInt,
    webhookMaxFailures: positiveInt,
  }),
  daily: z.object({
    baseCoins: nonNegativeInt,
    coinsPerStreakDay: nonNegativeInt,
    maxStreakBonusCoins: nonNegativeInt,
    baseXp: nonNegativeInt,
    xpPerStreakDay: nonNegativeInt,
    gemsEveryNDays: positiveInt,
    gemsAmount: nonNegativeInt,
    itemRewardChance: ratio,
    streakGraceHours: positiveInt,
  }),
  quests: z.object({
    dailyCount: positiveInt,
    weeklyCount: positiveInt,
    rerollCostCoins: nonNegativeInt,
    rerollCostGrowth: z.number().min(1).max(10),
    maxRerollsPerDay: nonNegativeInt,
    contractCount: positiveInt,
    contractRefreshHours: positiveInt,
    storyChainKey: z.string().min(1).max(48),
    rewardLevelScale: z.number().min(0).max(2).default(0.12),
    amountLevelScale: z.number().min(0).max(2).default(0.05),
  }),
  seasonPass: z.object({
    maxTier: positiveInt,
    xpPerTier: positiveInt,
    premiumSource: z.string().max(32),
    premiumVotesRequired: nonNegativeInt,
  }),
  coop: z.object({
    creationCostCoins: nonNegativeInt,
    creationMinLevel: positiveInt,
    baseMemberLimit: positiveInt,
    memberLimitPerLevel: nonNegativeInt,
    xpPerLevel: z.object({ base: positiveInt, exponent: z.number().min(1).max(3) }),
    maxLevel: positiveInt,
    contributionXpRatio: z.number().min(0).max(1),
    weeklyObjectiveCount: positiveInt,
    dailyObjectiveCount: positiveInt,
    bonusesPerLevel: z.object({
      growthSpeed: z.number().min(0).max(1),
      sellBonus: z.number().min(0).max(1),
      xpBonus: z.number().min(0).max(1),
      qualityBonus: z.number().min(0).max(1),
    }),
    treasuryWithdrawRoles: z.array(z.enum(['owner', 'officer', 'member'])),
    leaveCooldownHours: nonNegativeInt,
  }),
  social: z.object({
    visitRewardCoins: nonNegativeInt,
    visitRewardXp: nonNegativeInt,
    helpRewardCoins: nonNegativeInt,
    helpRewardXp: nonNegativeInt,
    maxHelpsPerDay: positiveInt,
    referralRewardCoins: nonNegativeInt,
    referralRewardGems: nonNegativeInt,
    referralQualifyLevel: positiveInt,
    referredStartBonusCoins: nonNegativeInt,
  }),
  vote: z.object({
    rewardGems: nonNegativeInt,
    weekendMultiplier: z.number().min(1).max(10),
    streakBonusGems: nonNegativeInt,
    maxStreakBonusGems: nonNegativeInt,
    rewardCoins: nonNegativeInt,
    cooldownHours: positiveInt,
  }),
  animals: z.object({
    hungerProductionThreshold: z.number().int().min(0).max(100),
    happinessProductionThreshold: z.number().int().min(0).max(100),
    sickHealthThreshold: z.number().int().min(0).max(100),
    starvationHoursBeforeSickness: positiveInt,
    starvationHoursBeforeDeath: positiveInt,
    petCooldownSeconds: nonNegativeInt,
    petHappinessGain: z.number().int().min(0).max(100),
    feedHungerGain: z.number().int().min(0).max(100),
    vetCostBase: nonNegativeInt,
    vetCostPerLevel: nonNegativeInt,
    breedingCostCoins: nonNegativeInt,
    breedingSuccessChance: ratio,
    breedingQualityInheritance: z.number().min(0).max(2),
    maxPendingProduction: positiveInt,
    hungerYieldPenalty: ratio,
    happinessQualityBonus: z.number().min(0).max(2),
    sellPriceRatio: ratio,
    /**
     * Variantes shiny / dorée (`game/animals.ts`). Les chances sont des
     * probabilités par bête achetée ou née, pondérées par la rareté de
     * l'espèce ; les effets restent modestes pour que l'économie reste
     * fermée (voir le commentaire de `balance.json`).
     */
    variants: z.object({
      shinyChance: ratio,
      goldenChance: ratio,
      rarityWeights: z.record(z.enum(rarities), z.number().min(0).max(10)),
      inheritanceChance: ratio,
      doubleInheritanceChance: ratio,
      shinyQualityBoost: ratio,
      goldenProductMultiplier: z.number().min(1).max(5),
      goldenSellMultiplier: z.number().min(1).max(10),
    }),
  }),
  economy: z.object({
    startingCoins: nonNegativeInt,
    startingGems: nonNegativeInt,
    salesTaxRate: ratio,
    salesTaxFreeLevel: positiveInt,
    giftTaxRate: ratio,
    giftMinLevel: positiveInt,
    giftDailyLimit: nonNegativeInt,
    sellDirectPenalty: ratio,
    inflationAlertDailyGrowth: z.number().min(0).max(10),
    suspicionThresholds: z.object({
      warn: positiveInt,
      review: positiveInt,
      autoBan: positiveInt,
    }),
    /**
     * Rétention du journal comptable par soldes d'ouverture
     * (`services/ledger.service.ts`). Le jour est borné à 28 pour exister
     * dans tous les mois ; la rétention est un nombre de mois calendaires,
     * à garder au-dessus de la fenêtre de `/history` (90 jours).
     */
    ledger: z.object({
      checkpointDay: z.number().int().min(1).max(28),
      retentionMonths: z.number().int().min(4).max(120),
    }),
  }),
  cooldowns: z.record(z.string(), nonNegativeInt),
  rateLimit: z.object({
    commandsPerMinute: positiveInt,
    commandsPerHour: positiveInt,
    interactionsPerMinute: positiveInt,
    penaltySeconds: positiveInt,
  }),
  render: z.object({
    farm: z.object({
      tileSize: positiveInt,
      padding: nonNegativeInt,
      headerHeight: nonNegativeInt,
      maxWidth: positiveInt,
    }),
    profile: z.object({ width: positiveInt, height: positiveInt }),
    chart: z.object({ width: positiveInt, height: positiveInt }),
    leaderboard: z.object({ width: positiveInt, height: positiveInt }),
    fishing: z.object({ width: positiveInt, height: positiveInt }),
    mining: z.object({ width: positiveInt, height: positiveInt }),
    /** Basse-cour de `/animals` : la hauteur est fixe, les enclos se partagent l'espace. */
    animals: z.object({ width: positiveInt, height: positiveInt }),
    /**
     * Carte postale de `/postcard` : format fixe, paysage. La scène de la
     * ferme s'y adapte (grille 3×3 ou 8×8), pas l'inverse — une image faite
     * pour être partagée doit avoir toujours les mêmes proportions.
     */
    postcard: z.object({ width: positiveInt, height: positiveInt }),
    quality: z.number().min(0.1).max(1),
  }),
  notifications: z.object({
    cropReadyEnabled: z.boolean(),
    animalHungryThreshold: z.number().int().min(0).max(100),
    batchWindowMinutes: positiveInt,
    maxPerUserPerDay: positiveInt,
    dispatchRatePerSecond: positiveInt,
  }),
  /** Alertes de prix (`/alert`) : plafond par joueur et durée de vie d'une alerte. */
  alerts: z.object({
    maxPerUser: positiveInt,
    durationDays: positiveInt,
  }),
  /**
   * Almanach (`/almanac`) : prix de la prévision météo du lendemain,
   * `priceCoins + pricePerLevel × niveau`. Deux entiers et non un barème par
   * palier : le prix doit suivre le revenu du joueur sans jamais créer de
   * marche où la prévision deviendrait soudain rentable.
   */
  almanac: z.object({
    priceCoins: nonNegativeInt,
    pricePerLevel: nonNegativeInt,
  }),
});
export type Balance = z.infer<typeof balanceSchema>;
