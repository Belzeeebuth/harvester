import { ChannelType, Collection, GuildFeature, type EmbedBuilder, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, PANELS, ROLES, allChannels } from '../src/serverkit/blueprint';
import { buildKit, isKitRunning, planKit, planTotals, wipeKit, type BuildOptions } from '../src/serverkit/builder';
import type { KitStyle } from '../src/serverkit/naming';

/**
 * Le constructeur, déroulé de bout en bout contre un faux serveur.
 *
 * Le faux serveur n'imite de Discord que ce que `builder.ts` en consomme, mais
 * il l'imite fidèlement sur les deux points qui décident de l'ordre des
 * opérations : un salon d'annonces ou une scène est REFUSÉ hors mode
 * Communauté, et le mode Communauté est refusé sans salon de règlement.
 */

interface Call {
  kind: 'role' | 'channel' | 'guild' | 'message' | 'delete';
  data: Record<string, unknown>;
}

/** Les appels Discord sont asynchrones ; le faux serveur répond tout de suite. */
const done = <T>(value: T): Promise<T> => Promise.resolve(value);
const refused = (message: string): Promise<never> => Promise.reject(new Error(message));

function fakeGuild(options: { refuseForums?: boolean; refuseCommunity?: boolean } = {}) {
  const calls: Call[] = [];
  let nextId = 1_000;
  const roles = new Collection<string, Record<string, unknown>>();
  const channels = new Collection<string, Record<string, unknown>>();

  const entity = (store: Collection<string, Record<string, unknown>>, data: Record<string, unknown>) => {
    const id = String((nextId += 1));
    const self: Record<string, unknown> = {
      ...data,
      id,
      managed: false,
      position: 1,
      isThread: () => false,
      availableTags: data.availableTags ?? [],
      edit: (patch: Record<string, unknown>) => done(Object.assign(self, patch)),
      delete: () => {
        calls.push({ kind: 'delete', data: { id, name: self.name, type: self.type } });
        store.delete(id);
        return done(self);
      },
    };
    store.set(id, self);
    return self;
  };

  const everyone = { id: 'G', name: '@everyone', managed: false, position: 0, setPermissions: () => done(true) };
  roles.set('G', everyone);
  const me = {
    id: 'BOT',
    permissions: { has: () => true },
    roles: { cache: new Collection<string, unknown>(), highest: { position: 99 }, add: () => done(true) },
  };

  const guild = {
    id: 'G',
    name: 'Greenvale',
    ownerId: 'OWNER',
    features: [] as string[],
    verificationLevel: 0,
    systemChannelId: null,
    afkChannelId: null,
    client: { user: { id: 'BOT' } },
    members: {
      me,
      fetchMe: () => done(me),
      addRole: (data: Record<string, unknown>) => done(calls.push({ kind: 'role', data })),
    },
    roles: {
      cache: roles,
      everyone,
      create: (data: Record<string, unknown>) => {
        calls.push({ kind: 'role', data });
        return done(entity(roles, data));
      },
      fetch: () => done(roles),
      setPositions: (positions: Array<Record<string, unknown>>) => {
        calls.push({ kind: 'guild', data: { positions } });
        return done(true);
      },
    },
    channels: {
      cache: channels,
      fetch: (id: string) => done(channels.get(id)),
      create: (data: Record<string, unknown>) => {
        const community = guild.features.includes(GuildFeature.Community);
        if (!community && (data.type === ChannelType.GuildAnnouncement || data.type === ChannelType.GuildStageVoice)) {
          return refused('Cannot execute action on this channel type');
        }
        if (options.refuseForums && data.type === ChannelType.GuildForum) return refused('forums unavailable');
        calls.push({ kind: 'channel', data });

        const messages: Array<Record<string, unknown>> = [];
        return done(
          entity(channels, {
            ...data,
            messages: { fetch: () => done(new Collection(messages.map((m, index) => [String(index), m]))) },
            send: (payload: { embeds: EmbedBuilder[] }) => {
              messages.push({
                author: { id: 'BOT' },
                embeds: payload.embeds.map((embed) => embed.toJSON()),
                edit: () => done(calls.push({ kind: 'message', data: { edited: true } })),
              });
              return done(calls.push({ kind: 'message', data: { channel: data.name } }));
            },
          }),
        );
      },
    },
    edit: (patch: Record<string, unknown>) => {
      if (patch.features) {
        if (options.refuseCommunity || !patch.rulesChannel || !patch.publicUpdatesChannel) {
          return refused('community requirements not met');
        }
        guild.features = patch.features as string[];
      }
      calls.push({ kind: 'guild', data: patch });
      return done(true);
    },
  };

  return { guild: guild as unknown as Guild, calls, channels, roles, state: guild };
}

const style: KitStyle = { locale: 'fr', font: 'bold', frame: 'dot' };
const options = (patch: Partial<BuildOptions> = {}): BuildOptions => ({
  style,
  scope: 'all',
  existing: 'keep',
  community: true,
  invokerId: 'OWNER',
  reason: 'test',
  ...patch,
});

const TOTAL = ROLES.length + CATEGORIES.length + allChannels().length;
const PANEL_COUNT = Object.keys(PANELS).length;
const DASH = /[-\u2010-\u2015\u2212]/;

describe('buildKit', () => {
  it('bâtit tout le serveur sans un seul échec, et sans un seul tiret', async () => {
    const { guild, calls, channels, roles } = fakeGuild();
    const report = await buildKit(guild, options());

    expect(report.failed).toEqual([]);
    expect(report.created).toBe(TOTAL + PANEL_COUNT);
    expect(roles.size).toBe(ROLES.length + 1);
    expect(channels.size).toBe(CATEGORIES.length + allChannels().length);
    expect(isKitRunning('G')).toBe(false);

    const names = calls
      .filter((call) => call.kind === 'role' || call.kind === 'channel')
      .flatMap((call) => (typeof call.data.name === 'string' ? [call.data.name] : []));
    expect(names).toHaveLength(TOTAL);
    expect(names.filter((name) => DASH.test(name))).toEqual([]);
  });

  it('crée les rôles de haut en bas, et remet ceux du bot et du propriétaire', async () => {
    const { guild, calls } = fakeGuild();
    await buildKit(guild, options({ scope: 'roles' }));

    const created = calls.filter((call) => call.kind === 'role' && call.data.name);
    expect(created).toHaveLength(ROLES.length);
    expect(String(created[1]!.data.name)).toContain('👑');
    expect(calls.some((call) => call.kind === 'role' && call.data.user === 'OWNER')).toBe(true);
  });

  it('ne remet pas le rôle de propriétaire à qui ne possède pas le serveur', async () => {
    const { guild, calls } = fakeGuild();
    await buildKit(guild, options({ scope: 'roles', invokerId: 'SOMEONE' }));
    expect(calls.some((call) => call.kind === 'role' && call.data.user)).toBe(false);
  });

  it('active le mode Communauté AVANT les salons qui en dépendent', async () => {
    const { guild, calls, channels, state } = fakeGuild();
    const report = await buildKit(guild, options());

    expect(state.features).toContain(GuildFeature.Community);
    expect(report.notes.map((note) => note.key)).toContain('serverkit.note.community_enabled');
    const types = [...channels.values()].map((channel) => channel.type);
    expect(types.filter((type) => type === ChannelType.GuildAnnouncement)).toHaveLength(3);
    expect(types).toContain(ChannelType.GuildStageVoice);
    expect(types.filter((type) => type === ChannelType.GuildForum)).toHaveLength(3);

    // Les deux salons exigés par Discord sont passés à l'activation.
    const enabling = calls.find((call) => call.kind === 'guild' && call.data.features);
    expect(enabling?.data.rulesChannel).toBeTruthy();
    expect(enabling?.data.publicUpdatesChannel).toBeTruthy();
  });

  it('se replie sur des salons ordinaires quand le mode Communauté est refusé', async () => {
    const { guild, channels } = fakeGuild({ refuseCommunity: true, refuseForums: true });
    const report = await buildKit(guild, options());

    expect(report.failed).toEqual([]);
    expect(channels.size).toBe(CATEGORIES.length + allChannels().length);
    const types = new Set([...channels.values()].map((channel) => channel.type));
    expect(types.has(ChannelType.GuildAnnouncement)).toBe(false);
    expect(types.has(ChannelType.GuildStageVoice)).toBe(false);
    expect(types.has(ChannelType.GuildForum)).toBe(false);

    const notes = report.notes.map((note) => note.key);
    expect(notes).toContain('serverkit.note.community_failed');
    expect(notes.filter((key) => key === 'serverkit.note.community_fallback')).toHaveLength(4);
    expect(notes.filter((key) => key === 'serverkit.note.forum_fallback')).toHaveLength(3);
  });

  it('range chaque salon dans sa catégorie, caché quand elle est réservée à l\'équipe', async () => {
    const { guild, channels } = fakeGuild();
    await buildKit(guild, options({ community: false }));

    const plan = planKit(guild, style);
    for (const category of plan.categories) {
      for (const channel of category.channels) {
        expect(channels.get(channel.existing!.id)?.parent).toBe(category.existing!.id);
      }
    }
    const council = plan.categories.find((category) => category.spec.key === 'council')!;
    for (const channel of council.channels) {
      const overwrites = channels.get(channel.existing!.id)?.permissionOverwrites as Array<{ id: string }>;
      expect(overwrites.some((overwrite) => overwrite.id === 'G')).toBe(true);
      expect(overwrites.some((overwrite) => overwrite.id === 'BOT')).toBe(true);
    }
  });

  it('est rejouable : un second passage ne crée rien et met les panneaux à jour en place', async () => {
    const { guild, calls } = fakeGuild();
    await buildKit(guild, options());
    const before = calls.length;

    expect(planTotals(planKit(guild, style)).missing).toBe(0);
    const again = await buildKit(guild, options({ style: { locale: 'en', font: 'smallcaps', frame: 'bracket' } }));

    expect(again.failed).toEqual([]);
    expect(again.created).toBe(0);
    expect(again.kept).toBe(TOTAL);
    const added = calls.slice(before);
    expect(added.filter((call) => call.kind === 'channel' || (call.kind === 'role' && call.data.name))).toEqual([]);
    expect(added.filter((call) => call.kind === 'message' && call.data.edited)).toHaveLength(PANEL_COUNT);
  });

  it('réaligne l\'existant en mode sync : nouveau style, mêmes salons', async () => {
    const { guild, channels } = fakeGuild();
    await buildKit(guild, options());
    const restyled: KitStyle = { locale: 'fr', font: 'sans', frame: 'bar' };
    const report = await buildKit(guild, options({ style: restyled, existing: 'sync', scope: 'channels' }));

    expect(report.failed).toEqual([]);
    expect(report.created).toBe(0);
    expect(report.updated).toBe(CATEGORIES.length + allChannels().length);
    const plan = planKit(guild, restyled);
    for (const channel of plan.categories.flatMap((category) => category.channels)) {
      expect(channels.get(channel.existing!.id)?.name).toBe(channel.name);
    }
  });

  it('range les rôles d\'un bloc sous celui du bot, du premier au dernier', async () => {
    const { guild, calls, roles } = fakeGuild();
    await buildKit(guild, options({ scope: 'roles' }));

    const order = calls.find((call) => call.kind === 'guild' && call.data.positions)?.data.positions as Array<{
      role: string;
      position: number;
    }>;
    expect(order).toHaveLength(ROLES.length);
    expect(order.map((entry) => entry.position)).toEqual(ROLES.map((_role, index) => 98 - index));
    expect(String(roles.get(order[1]!.role)?.name)).toContain('👑');
  });

  it('laisse un salon existant à sa place quand sa catégorie n\'a pas pu être créée', async () => {
    const { guild, channels, state } = fakeGuild();
    const orphan = await state.channels.create({ name: 'bienvenue', type: ChannelType.GuildText, parent: 'ELSEWHERE' });
    const create = state.channels.create;
    state.channels.create = (data: Record<string, unknown>) =>
      data.type === ChannelType.GuildCategory ? refused('Missing Permissions') : create(data);

    const report = await buildKit(guild, options({ scope: 'channels', existing: 'sync', community: false }));
    expect(report.failed).toHaveLength(CATEGORIES.length);
    expect(channels.get(String(orphan.id))?.parent).toBe('ELSEWHERE');
  });

  it('consigne un refus de Discord et continue le chantier', async () => {
    const { guild, state } = fakeGuild();
    const create = state.roles.create;
    state.roles.create = (data: Record<string, unknown>) =>
      typeof data.name === 'string' && data.name.includes('👑') ? refused('Missing Permissions') : create(data);
    const report = await buildKit(guild, options({ scope: 'roles' }));

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.reason).toBe('Missing Permissions');
    expect(report.created).toBe(ROLES.length - 1);
  });
});

describe('wipeKit', () => {
  it('ne supprime que ce que le kit a posé, les catégories en dernier', async () => {
    const { guild, calls, channels, roles, state } = fakeGuild();
    await state.channels.create({ name: 'salon-du-proprio', type: ChannelType.GuildText });
    await state.roles.create({ name: 'VIP' });
    await buildKit(guild, options({ community: false }));

    const report = await wipeKit(guild, 'kit', { style, reason: 'test' });
    expect(report.failed).toEqual([]);
    expect(report.removed).toBe(TOTAL);
    expect([...channels.values()].map((channel) => channel.name)).toEqual(['salon-du-proprio']);
    expect([...roles.values()].map((role) => role.name)).toEqual(['@everyone', 'VIP']);

    const deleted = calls.filter((call) => call.kind === 'delete' && call.data.type !== undefined);
    const firstCategory = deleted.findIndex((call) => call.data.type === ChannelType.GuildCategory);
    expect(deleted.slice(firstCategory).every((call) => call.data.type === ChannelType.GuildCategory)).toBe(true);
  });

  it('rase tout en portée `all`, sauf le salon d\'où part la commande', async () => {
    const { guild, channels, roles, state } = fakeGuild();
    const keep = await state.channels.create({ name: 'ici', type: ChannelType.GuildText });
    await buildKit(guild, options({ community: false }));

    await wipeKit(guild, 'all', { style, keepChannelId: String(keep.id), reason: 'test' });
    expect([...channels.keys()]).toEqual([keep.id]);
    expect([...roles.keys()]).toEqual(['G']);
  });
});
