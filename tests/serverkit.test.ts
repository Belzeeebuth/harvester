import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { commands as serverkitCommands } from '../src/commands/serverkit';
import { SUPPORTED_LOCALES, translatorFor } from '../src/i18n';
import { CATEGORIES, PANELS, ROLES, allChannels, selfAssignableRoles } from '../src/serverkit/blueprint';
import { overwritesFor, planKit, planTotals } from '../src/serverkit/builder';
import {
  FRAMES,
  categoryName,
  renderCategory,
  renderChannel,
  renderRole,
  slugsOf,
  textChannelName,
  type KitStyle,
} from '../src/serverkit/naming';
import { buildPanel, panelMarker } from '../src/serverkit/panels';
import { chunkFields, decodeFlags, decodeStyle, encodeFlags, encodeStyle } from '../src/serverkit/views';
import { buildCustomId } from '../src/utils/custom-id';
import { FANCY_FONTS, fancy, slugify, unfancy } from '../src/utils/fancy-text';

/**
 * Kit serveur (`/serverkit`).
 *
 * Rien ici ne parle à Discord : ces tests verrouillent ce qui peut l'être hors
 * ligne — la promesse « aucun tiret », la réversibilité des polices (dont
 * dépend la reconnaissance des salons déjà posés), la cohérence du plan avec
 * les fichiers de langue, et les limites de l'API que le typage ne connaît pas.
 */

/** Tout ce qui ressemble à un tiret, du trait d'union au cadratin. */
const DASH = /[-\u00ad\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/;

const STYLES: KitStyle[] = SUPPORTED_LOCALES.flatMap((locale) =>
  FANCY_FONTS.flatMap((font) => FRAMES.map((frame) => ({ locale, font, frame }))),
);

const isVoice = (kind: string): boolean => kind === 'voice' || kind === 'stage';

describe('polices fantaisie', () => {
  const SAMPLE = 'The quick brown fox jumps over the lazy dog 0123456789';

  it.each(FANCY_FONTS)('%s : aller-retour fidèle', (font) => {
    expect(unfancy(fancy(SAMPLE, font))).toBe(SAMPLE.toLowerCase());
  });

  it.each(FANCY_FONTS.filter((font) => font !== 'plain'))('%s : 26 lettres transposées', (font) => {
    const glyphs = [...fancy('abcdefghijklmnopqrstuvwxyz', font)];
    expect(glyphs).toHaveLength(26);
    // Seule la petite capitale de « x » n'existe pas : elle reste un x.
    const untouched = glyphs.filter((glyph) => /[a-z]/.test(glyph));
    expect(untouched).toEqual(font === 'smallcaps' ? ['x'] : []);
  });

  it('retire les accents, que ces alphabets ne possèdent pas', () => {
    const styled = fancy('Règlement et Évènements, cœur', 'bold');
    expect(styled).not.toMatch(/[\u0300-\u036f]|[éèêÉœ]/);
    expect(slugify(styled)).toBe('reglementetevenementscoeur');
  });

  it('laisse la police `plain` intacte, accents compris', () => {
    expect(fancy('règlement', 'plain')).toBe('règlement');
  });

  it("préserve le sélecteur de variante des emoji (U+FE0F)", () => {
    expect(fancy('🛠\ufe0f patch', 'sans')).toContain('\ufe0f');
  });

  it('donne la même empreinte quel que soit le décor', () => {
    expect(slugify('🛠️・𝐩𝐚𝐭𝐜𝐡・𝐧𝐨𝐭𝐞𝐬')).toBe('patchnotes');
    expect(slugify('「🛠️」ᴘᴀᴛᴄʜ・ɴᴏᴛᴇꜱ')).toBe('patchnotes');
    expect(slugify('patch-notes')).toBe('patchnotes');
    expect(slugify('✦ ⋆ 𝕊𝕥𝕒𝕗𝕗 ⋆ ✦')).toBe('staff');
    // ǫ (sosie de q) se décompose en o + ogonek : il doit revenir q, pas o.
    expect(slugify(fancy('quiz', 'smallcaps'))).toBe('quiz');
  });
});

describe('noms sans tiret', () => {
  it('aucun salon textuel ne contient de tiret ni d\'espace, quel que soit le style', () => {
    const problems: string[] = [];
    for (const style of STYLES) {
      for (const { channel } of allChannels()) {
        const name = renderChannel(channel, style);
        if (DASH.test(name)) problems.push(`tiret : ${name}`);
        if (!isVoice(channel.kind) && /\s/.test(name)) problems.push(`espace : ${name}`);
        if (name.length === 0 || name.length > 100) problems.push(`longueur : ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('aucun rôle ni catégorie ne contient de tiret', () => {
    const problems: string[] = [];
    for (const style of STYLES) {
      const names = [
        ...ROLES.map((role) => renderRole(role, style)),
        ...CATEGORIES.map((category) => renderCategory(category, style)),
      ];
      for (const name of names) {
        if (DASH.test(name) || name.length === 0 || name.length > 100) problems.push(name);
      }
    }
    expect(problems).toEqual([]);
  });

  it('soude les mots là où Discord aurait mis un tiret', () => {
    const style: KitStyle = { locale: 'fr', font: 'plain', frame: 'dot' };
    expect(textChannelName('🛠️', 'Patch Notes', style)).toBe('🛠️・patch・notes');
    expect(textChannelName('🛠️', 'patch-notes', style)).toBe('🛠️・patch・notes');
    expect(textChannelName('🛠️', 'patch notes', { ...style, frame: 'bracket' })).toBe('「🛠️」patch・notes');
  });

  it('capitalise les catégories avant de les styliser', () => {
    expect(categoryName('🌾', 'Accueil', { locale: 'fr', font: 'bold', frame: 'dot' })).toBe('🌾 ・ 𝐀𝐂𝐂𝐔𝐄𝐈𝐋');
  });

  it('garde une empreinte identique dans tous les styles', () => {
    for (const { channel } of allChannels()) {
      const slugs = slugsOf('channels', channel.key);
      for (const style of STYLES) expect(slugs.has(slugify(renderChannel(channel, style)))).toBe(true);
    }
    for (const role of ROLES) {
      const slugs = slugsOf('roles', role.key);
      for (const style of STYLES) expect(slugs.has(slugify(renderRole(role, style)))).toBe(true);
    }
  });
});

describe('plan du serveur', () => {
  const channels = allChannels().map(({ channel }) => channel);

  it('a des clés uniques', () => {
    for (const keys of [ROLES.map((r) => r.key), CATEGORIES.map((c) => c.key), channels.map((c) => c.key)]) {
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('respecte les plafonds de Discord', () => {
    expect(ROLES.length).toBeLessThanOrEqual(250);
    expect(channels.length + CATEGORIES.length).toBeLessThanOrEqual(500);
    for (const category of CATEGORIES) expect(category.channels.length).toBeLessThanOrEqual(50);
    for (const channel of channels) {
      expect(channel.tags?.length ?? 0).toBeLessThanOrEqual(20);
      expect(channel.slowmode ?? 0).toBeLessThanOrEqual(21_600);
      expect(channel.userLimit ?? 0).toBeLessThanOrEqual(99);
    }
  });

  it.each(SUPPORTED_LOCALES)('%s : chaque entrée a son libellé, chaque salon textuel son sujet', (locale) => {
    const t = translatorFor(locale);
    const missing: string[] = [];
    const need = (key: string, max: number): void => {
      const value = t(key);
      if (value === key || value.length === 0 || value.length > max) missing.push(key);
    };
    for (const role of ROLES) need(`serverkit.roles.${role.key}`, 60);
    for (const category of CATEGORIES) need(`serverkit.categories.${category.key}`, 60);
    for (const channel of channels) {
      need(`serverkit.channels.${channel.key}.name`, 40);
      if (!isVoice(channel.kind)) need(`serverkit.channels.${channel.key}.topic`, 1024);
      for (const tag of channel.tags ?? []) need(`serverkit.tags.${tag.key}`, 20);
    }
    expect(missing).toEqual([]);
  });

  it.each(SUPPORTED_LOCALES)('%s : un libellé de salon textuel ne contient que lettres, chiffres et espaces', (locale) => {
    const t = translatorFor(locale);
    const problems = channels
      .filter((channel) => !isVoice(channel.kind))
      .map((channel) => t(`serverkit.channels.${channel.key}.name`))
      .filter((label) => !/^[\p{L}\p{N} ]+$/u.test(label));
    expect(problems).toEqual([]);
  });

  it('ne laisse aucune empreinte ambiguë entre deux entrées, toutes langues confondues', () => {
    const pools: Array<[string, Array<{ key: string; slugs: Set<string> }>]> = [
      ['roles', ROLES.map((role) => ({ key: role.key, slugs: slugsOf('roles', role.key) }))],
      ['categories', CATEGORIES.map((c) => ({ key: c.key, slugs: slugsOf('categories', c.key) }))],
      ['text', channels.filter((c) => !isVoice(c.kind)).map((c) => ({ key: c.key, slugs: slugsOf('channels', c.key) }))],
      ['voice', channels.filter((c) => isVoice(c.kind)).map((c) => ({ key: c.key, slugs: slugsOf('channels', c.key) }))],
    ];
    const clashes: string[] = [];
    for (const [pool, entries] of pools) {
      const owner = new Map<string, string>();
      for (const entry of entries) {
        for (const slug of entry.slugs) {
          if (slug.length === 0) clashes.push(`${pool}: empreinte vide pour ${entry.key}`);
          const previous = owner.get(slug);
          if (previous && previous !== entry.key) clashes.push(`${pool}: « ${slug} » = ${previous} et ${entry.key}`);
          owner.set(slug, entry.key);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('branche un seul salon par réglage du serveur', () => {
    for (const wire of ['system', 'rules', 'updates', 'afk'] as const) {
      const wired = channels.filter((channel) => channel.wire === wire);
      expect(wired).toHaveLength(1);
      expect(isVoice(wired[0]!.kind)).toBe(wire === 'afk');
    }
  });

  it('réserve Administrateur au seul propriétaire, et ne donne aucun droit aux rôles en libre-service', () => {
    const admins = ROLES.filter((role) => role.permissions.includes(PermissionFlagsBits.Administrator));
    expect(admins.map((role) => role.key)).toEqual(['founder']);
    for (const role of selfAssignableRoles()) expect(role.permissions).toEqual([]);
    expect(selfAssignableRoles().length).toBeGreaterThan(0);
  });

  it('tient ses boutons de rôles dans une rangée par groupe', () => {
    for (const group of ['notify', 'language'] as const) {
      const count = selfAssignableRoles().filter((role) => role.group === group).length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(5);
    }
  });
});

describe('panneaux', () => {
  const refs = { channelIds: new Map<string, string>(), roleIds: new Map<string, string>() };
  const used = new Set(allChannels().flatMap(({ channel }) => channel.panel ?? []));

  it('chaque panneau déclaré est posé quelque part, dans un salon textuel', () => {
    expect([...used].sort()).toEqual(Object.keys(PANELS).sort());
    for (const { channel } of allChannels()) {
      if (channel.panel) expect(channel.kind).toBe('text');
    }
  });

  it.each(STYLES.filter((style) => style.frame === 'dot'))('$locale / $font : embeds complets et dans les limites', (style) => {
    for (const key of used) {
      const { embeds, components } = buildPanel(key, style, refs);
      const embed = embeds[0]!.toJSON();
      const texts = [embed.title ?? '', embed.description ?? '', ...(embed.fields ?? []).flatMap((f) => [f.name, f.value])];

      // Ni clé de traduction restée telle quelle, ni paramètre non résolu.
      for (const text of texts) {
        expect(text).not.toMatch(/serverkit\.|\{\w+\}/);
        expect(text.length).toBeGreaterThan(0);
      }
      expect(embed.title!.length).toBeLessThanOrEqual(256);
      expect(embed.description!.length).toBeLessThanOrEqual(4096);
      for (const field of embed.fields ?? []) {
        expect(field.name.length).toBeLessThanOrEqual(256);
        expect(field.value.length).toBeLessThanOrEqual(1024);
      }
      expect(texts.join('').length + panelMarker(key).length).toBeLessThanOrEqual(6000);
      expect(embed.footer?.text).toBe(panelMarker(key));
      expect(components.length).toBe(key === 'roles' ? 2 : key === 'welcome' ? 1 : 0);
    }
  });

  it('mentionne les salons et rôles dès qu\'ils existent', () => {
    const { embeds } = buildPanel('welcome', { locale: 'fr', font: 'bold', frame: 'dot' }, {
      channelIds: new Map([['rules', '111']]),
      roleIds: new Map(),
    });
    expect(JSON.stringify(embeds[0]!.toJSON())).toContain('<#111>');
  });
});

describe('permissions par profil', () => {
  const context = { everyoneId: 'everyone', botId: 'bot', senior: ['s1', 's2'], junior: ['j1'], bots: 'b1' };
  const find = (list: ReturnType<typeof overwritesFor>, id: string) => list.find((entry) => entry.id === id);

  it('ne pose rien sur un salon public', () => {
    expect(overwritesFor('public', context)).toEqual([]);
  });

  it('coupe l\'écriture à @everyone en lecture seule, pas à l\'équipe ni au bot', () => {
    const list = overwritesFor('readonly', context);
    expect(find(list, 'everyone')?.deny).toContain(PermissionFlagsBits.SendMessages);
    for (const id of ['s1', 's2', 'j1', 'b1', 'bot']) {
      expect(find(list, id)?.allow).toContain(PermissionFlagsBits.SendMessages);
    }
  });

  it('cache les salons d\'équipe, et le journal aux rôles juniors', () => {
    const staff = overwritesFor('staff', context);
    expect(find(staff, 'everyone')?.deny).toContain(PermissionFlagsBits.ViewChannel);
    expect(find(staff, 'j1')?.allow).toContain(PermissionFlagsBits.ViewChannel);

    const senior = overwritesFor('senior', context);
    expect(find(senior, 's1')?.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(find(senior, 'j1')).toBeUndefined();
    expect(find(senior, 'bot')?.allow).toContain(PermissionFlagsBits.ViewChannel);
  });
});

describe('reconnaissance de l\'existant', () => {
  const channel = (id: string, name: string, type: ChannelType) => ({ id, name, type, isThread: () => false });
  const role = (id: string, name: string, managed = false) => ({ id, name, managed });
  const fakeGuild = (channels: Array<ReturnType<typeof channel>>, roles: Array<ReturnType<typeof role>>): Guild =>
    ({
      id: 'guild',
      channels: { cache: new Map(channels.map((entry) => [entry.id, entry])) },
      roles: { cache: new Map([['guild', role('guild', '@everyone')], ...roles.map((entry) => [entry.id, entry] as const)]) },
    }) as unknown as Guild;

  const style: KitStyle = { locale: 'fr', font: 'script', frame: 'cloud' };
  const planned = (plan: ReturnType<typeof planKit>, key: string) =>
    plan.categories.flatMap((category) => category.channels).find((entry) => entry.spec.key === key);

  it('part de zéro sur un serveur vide', () => {
    const plan = planKit(fakeGuild([], []), style);
    expect(planTotals(plan).existing).toBe(0);
    expect(planTotals(plan).missing).toBe(ROLES.length + CATEGORIES.length + allChannels().length);
  });

  it('retrouve un salon posé dans une autre police, un autre cadre, une autre langue', () => {
    const guild = fakeGuild(
      [
        channel('1', '「👋」ᴡᴇʟᴄᴏᴍᴇ', ChannelType.GuildText),
        channel('2', 'règlement', ChannelType.GuildText),
        channel('3', '🌾 ┃ 𝗔𝗖𝗖𝗨𝗘𝗜𝗟', ChannelType.GuildCategory),
      ],
      [role('10', '🛡️ ・ 𝐒𝐭𝐞𝐰𝐚𝐫𝐝𝐬'), role('11', 'Harvester', true)],
    );
    const plan = planKit(guild, style);
    expect(planned(plan, 'welcome')?.existing?.id).toBe('1');
    expect(planned(plan, 'rules')?.existing?.id).toBe('2');
    expect(plan.categories.find((category) => category.spec.key === 'welcome')?.existing?.id).toBe('3');
    expect(plan.roles.find((entry) => entry.spec.key === 'admin')?.existing?.id).toBe('10');
    expect(planTotals(plan).existing).toBe(4);
  });

  it('ne confond pas un vocal et un salon textuel du même nom', () => {
    const plan = planKit(fakeGuild([channel('1', 'musique', ChannelType.GuildText)], []), style);
    expect(planned(plan, 'v_music')?.existing).toBeUndefined();
  });

  it('n\'attribue jamais le même salon à deux entrées, ni un rôle géré par une intégration', () => {
    const guild = fakeGuild([channel('1', 'mine', ChannelType.GuildText)], [role('10', 'Automates', true)]);
    const plan = planKit(guild, style);
    const owners = plan.categories.flatMap((c) => c.channels).filter((entry) => entry.existing?.id === '1');
    expect(owners).toHaveLength(1);
    expect(plan.roles.find((entry) => entry.spec.key === 'bots')?.existing).toBeUndefined();
  });
});

describe('interface de la commande', () => {
  it('répartit les longues listes sans jamais couper une ligne', () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => `➕ ${fancy(`salon numero ${index}`, 'bold')}`);
    const fields = chunkFields('Rôles', lines);
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.flatMap((field) => field.value.split('\n'))).toEqual(lines);
    for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(1024);
  });

  it('garde le custom_id de confirmation sous la limite, avec deux identifiants de 20 chiffres', () => {
    const snowflake = '12345678901234567890';
    const style: KitStyle = { locale: 'fr', font: FANCY_FONTS.at(-1)!, frame: FRAMES.at(-1)! };
    const id = buildCustomId(
      'serverkit', 'build', snowflake, 'yes', 'settings', encodeStyle(style), encodeFlags('sync', true), snowflake,
    );
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it('compacte puis restitue fidèlement le style et les options', () => {
    for (const style of STYLES) expect(decodeStyle(encodeStyle(style), 'fr')).toEqual(style);
    for (const existing of ['keep', 'sync'] as const) {
      for (const community of [true, false]) {
        expect(decodeFlags(encodeFlags(existing, community))).toEqual({ existing, community });
      }
    }
    // Un jeton forgé ou tronqué retombe sur les valeurs par défaut, sans lever.
    expect(decodeStyle('xx.99', 'en')).toEqual({ locale: 'en', font: 'bold', frame: 'dot' });
  });

  it('expose une commande réservée aux administrateurs, avec des choix valides', () => {
    const [command] = serverkitCommands;
    expect(command?.adminOnly).toBe(true);
    expect(command?.dmAllowed).toBe(false);
    const data = command!.data as { default_member_permissions?: string; options?: Array<{ name: string; options?: Array<{ choices?: Array<{ name: string }> }> }> };
    expect(data.default_member_permissions).toBe(String(PermissionFlagsBits.Administrator));
    expect(data.options?.map((option) => option.name)).toEqual(['styles', 'preview', 'build', 'wipe']);
    for (const sub of data.options ?? []) {
      for (const option of sub.options ?? []) {
        expect(option.choices?.length ?? 0).toBeLessThanOrEqual(25);
        for (const choice of option.choices ?? []) expect(choice.name.length).toBeLessThanOrEqual(100);
      }
    }
  });
});
