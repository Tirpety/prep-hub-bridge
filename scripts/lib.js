// Pure helpers (no Foundry globals) so they can be unit tested outside Foundry.

export const MODULE_ID = 'prep-hub-bridge';
export const ROOT_FOLDER = 'Prep Hub';

export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LINK_RE = /<a\b[^>]*\bdata-prephub-id="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

/**
 * Turns Prep Hub entity links into Foundry content links.
 * `resolve(prepHubId)` returns a Foundry UUID or null.
 */
export function rewriteLinks(html, resolve) {
  return String(html ?? '').replace(LINK_RE, (_m, id, label) => {
    const uuid = resolve(id);
    const text = label.replace(/<[^>]+>/g, '').replace(/[[\]{}]/g, '');
    return uuid ? `@UUID[${uuid}]{${text}}` : `<strong>${text}</strong>`;
  });
}

/** Grid positions (top-left, in pixels) for `count` tokens clustered around `center`. */
export function clusterPositions(count, center, gridSize, perRow = 5, spacing = 2) {
  const positions = [];
  const cols = Math.min(perRow, Math.max(1, count));
  const rows = Math.ceil(count / perRow);
  for (let i = 0; i < count; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = center.x + (col - (cols - 1) / 2) * gridSize * spacing;
    const y = center.y + (row - (rows - 1) / 2) * gridSize * spacing;
    positions.push({
      x: Math.round(x / gridSize) * gridSize,
      y: Math.round(y / gridSize) * gridSize,
    });
  }
  return positions;
}

/**
 * Extra token data so new tokens land on the Level the GM is viewing (Foundry v14 scene Levels),
 * standing on that Level's floor. `level` is `canvas.level`; on v12/v13 it is undefined and this returns {}.
 */
export function levelPlacement(level) {
  if (!level?.id) return {};
  const placement = { level: level.id };
  const bottom = level.elevation?.bottom;
  if (typeof bottom === 'number' && Number.isFinite(bottom)) placement.elevation = bottom;
  return placement;
}

/** Maps a compendium/world index entry (pf2e npc or hazard) to Prep Hub's creature shape. */
export function mapActorIndexEntry(entry, source) {
  const sys = entry.system ?? {};
  const details = sys.details ?? {};
  const traits = sys.traits ?? {};
  const level = Number(details.level?.value ?? 0);
  return {
    id: entry.uuid,
    foundryUuid: entry.uuid,
    name: entry.name,
    level: Number.isFinite(level) ? level : 0,
    kind: entry.type === 'hazard' ? 'hazard' : 'creature',
    complex: Boolean(details.isComplex),
    traits: Array.isArray(traits.value) ? traits.value : [],
    rarity: traits.rarity ?? 'common',
    size: traits.size?.value,
    img: entry.img,
    hp: sys.attributes?.hp?.max,
    ac: sys.attributes?.ac?.value,
    sourceLabel: details.publication?.title || details.source?.value || source,
  };
}

/** Lower number = preferred when several compendiums contain the same creature name. */
export function packPriority(pack) {
  const id = String(pack?.collection ?? pack?.metadata?.id ?? '');
  // Core bestiaries: Monster Core (pf2e) and Alien Core (sf2e).
  if (id.includes('monster-core') || id.includes('alien-core')) return 0;
  if (pack?.metadata?.packageType === 'system') return id.includes('bestiary') ? 1 : 2;
  return 3;
}

export function threatLabel(threat) {
  return String(threat ?? '').replace(/^./, (c) => c.toUpperCase());
}

/** Foundry ownership levels (CONST.DOCUMENT_OWNERSHIP_LEVELS) used for player handouts. */
export const OWNERSHIP = { NONE: 0, OBSERVER: 2 };

/**
 * Default ownership for a pushed journal: players may read it (Observer) when it is a
 * handout, nobody but the GM when it was unshared, and unchanged when not specified.
 */
export function handoutOwnership(playerVisible, levels = OWNERSHIP) {
  if (playerVisible === true) return levels.OBSERVER ?? 2;
  if (playerVisible === false) return levels.NONE ?? 0;
  return null;
}

/**
 * Chat message HTML for a general announcement, e.g. a new "Previously on…" recap:
 * a bold title, an optional short excerpt, and a link to the journal entry.
 */
export function announcementHtml(announcement, linkUuid) {
  const title = String(announcement?.title ?? '').trim();
  if (!title) return '';
  const text = String(announcement?.text ?? '').trim();
  // Square and curly brackets would end the @UUID[...]{label} link early.
  const label = String(announcement?.linkLabel ?? '').replace(/[[\]{}]/g, '').trim() || 'Open';
  const link = linkUuid ? `<p>@UUID[${linkUuid}]{${escapeHtml(label)}}</p>` : '';
  return `<p><strong><i class="fas fa-scroll"></i> ${escapeHtml(title)}</strong></p>${text ? `<p>${escapeHtml(text)}</p>` : ''}${link}`;
}

/** Chat message HTML announcing newly revealed clues. */
export function announceHtml(lines, linkUuid) {
  const items = (Array.isArray(lines) ? lines : []).filter(Boolean).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  if (!items) return '';
  const link = linkUuid ? `<p>@UUID[${linkUuid}]{What We Know}</p>` : '';
  return `<p><strong>New clue${lines.length === 1 ? '' : 's'} revealed</strong></p><ul>${items}</ul>${link}`;
}

// ---------------------------------------------------------------------------
// Creatures from Prep Hub's creature builder
// ---------------------------------------------------------------------------

const SPEED_TYPES = ['burrow', 'climb', 'fly', 'swim'];
const ACTION_TYPES = { 1: 'action', 2: 'action', 3: 'action', reaction: 'reaction', free: 'free', passive: 'passive' };

function slug(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** "fire 5, cold iron 3" → [{ type: 'fire', value: 5 }, { type: 'cold-iron', value: 3 }] */
export function parseAmounts(text) {
  return String(text ?? '')
    .split(/[,;]+/)
    .map((part) => /^\s*([a-z][a-z\s-]*?)\s+(\d+)\s*$/i.exec(part))
    .filter(Boolean)
    .map((m) => ({ type: slug(m[1]), value: Number(m[2]) }));
}

/** "poison, sleep" → [{ type: 'poison' }, { type: 'sleep' }] */
export function parseNames(text) {
  return String(text ?? '')
    .split(/[,;]+/)
    .map((t) => slug(t))
    .filter(Boolean)
    .map((type) => ({ type }));
}

/** "climb 20 feet, fly 40 feet" → [{ type: 'climb', value: 20 }, …] (known movement types only) */
export function parseSpeeds(text) {
  return String(text ?? '')
    .split(/[,;]+/)
    .map((part) => /^\s*(\w+)\s+(\d+)/.exec(part))
    .filter((m) => m && SPEED_TYPES.includes(m[1].toLowerCase()))
    .map((m) => ({ type: m[1].toLowerCase(), value: Number(m[2]) }));
}

/**
 * Actor data for a pf2e/sf2e NPC built from a Prep Hub stat block. Two parts, so the caller can
 * fall back if a system version rejects some of it: `system` (the actor) and `items` (Strikes,
 * abilities and spellcasting). The stat block also goes in the notes, so nothing is lost.
 */
export function npcActorSource(block, { notesHtml = '', randomId = () => Math.random().toString(36).slice(2, 18) } = {}) {
  const skills = {};
  for (const s of block?.skills ?? []) {
    const key = slug(s.name);
    if (key && Number.isFinite(s.mod)) skills[key] = { base: s.mod };
  }
  const abilities = {};
  for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) abilities[k] = { mod: Number(block?.attributes?.[k]) || 0 };
  const save = (k) => ({ value: Number(block?.saves?.[k]) || 0, saveDetail: '' });
  const system = {
    details: {
      level: { value: Number(block?.level) || 0 },
      publicNotes: notesHtml,
      languages: { value: [], details: String(block?.languages ?? '') },
    },
    attributes: {
      ac: { value: Number(block?.ac) || 10, details: '' },
      hp: { value: Number(block?.hp) || 1, max: Number(block?.hp) || 1, temp: 0, details: '' },
      speed: { value: Number(block?.speed) || 0, otherSpeeds: parseSpeeds(block?.otherSpeeds), details: '' },
      immunities: parseNames(block?.immunities),
      resistances: parseAmounts(block?.resistances),
      weaknesses: parseAmounts(block?.weaknesses),
    },
    perception: { mod: Number(block?.perception) || 0, details: String(block?.senses ?? '') },
    saves: { fortitude: save('fortitude'), reflex: save('reflex'), will: save('will') },
    abilities,
    skills,
    traits: { value: Array.isArray(block?.traits) ? block.traits : [], rarity: block?.rarity ?? 'common', size: { value: block?.size ?? 'med' } },
  };
  const items = [];
  for (const s of block?.strikes ?? []) {
    items.push({
      name: s.name || 'Strike',
      type: 'melee',
      system: {
        bonus: { value: Number(s.bonus) || 0 },
        damageRolls: { [randomId()]: { damage: String(s.damage || '1d4'), damageType: slug(s.damageType) || 'bludgeoning' } },
        traits: { value: Array.isArray(s.traits) ? s.traits.map(slug).filter(Boolean) : [] },
        weaponType: { value: s.kind === 'ranged' ? 'ranged' : 'melee' },
      },
    });
  }
  for (const a of block?.abilities ?? []) {
    const actions = ['1', '2', '3'].includes(String(a.actions)) ? Number(a.actions) : null;
    items.push({
      name: a.name || 'Ability',
      type: 'action',
      system: {
        actionType: { value: ACTION_TYPES[a.actions] ?? 'passive' },
        actions: { value: actions },
        description: { value: `<p>${escapeHtml(a.text)}</p>` },
        category: 'offensive',
        traits: { value: [] },
      },
    });
  }
  const sc = block?.spellcasting;
  if (sc) {
    const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
    items.push({
      name: `${cap(sc.tradition)} ${cap(sc.kind)} Spells`,
      type: 'spellcastingEntry',
      system: {
        tradition: { value: sc.tradition },
        prepared: { value: sc.kind },
        spelldc: { value: Number(sc.attack) || 0, dc: Number(sc.dc) || 10 },
      },
    });
  }
  return { system, items };
}

// ---------------------------------------------------------------------------
// Items for Prep Hub's "real loot"
// ---------------------------------------------------------------------------

const ITEM_CATEGORIES = {
  weapon: 'permanent',
  armor: 'permanent',
  shield: 'permanent',
  equipment: 'permanent',
  backpack: 'permanent',
  consumable: 'consumable',
  treasure: 'treasure',
};

/** A price object ({ gp, sp, cp, pp } or { credits }) in the system's currency. */
export function priceIn(value, systemId) {
  const v = value ?? {};
  if (Number.isFinite(Number(v.credits)) && Number(v.credits) > 0) return Number(v.credits);
  const gp = (Number(v.pp) || 0) * 10 + (Number(v.gp) || 0) + (Number(v.sp) || 0) / 10 + (Number(v.cp) || 0) / 100;
  return systemId === 'sf2e' ? gp * 10 : gp;
}

/** Compendium index entry → Prep Hub loot item, or null for things that aren't loot. */
export function mapItemIndexEntry(entry, source, systemId) {
  const category = ITEM_CATEGORIES[entry?.type];
  if (!category) return null;
  const sys = entry.system ?? {};
  const level = Number(sys.level?.value ?? 0);
  return {
    uuid: entry.uuid,
    name: entry.name,
    level: Number.isFinite(level) ? level : 0,
    price: Math.round(priceIn(sys.price?.value, systemId) * 100) / 100,
    category,
    type: entry.type,
    rarity: sys.traits?.rarity ?? 'common',
    traits: Array.isArray(sys.traits?.value) ? sys.traits.value : [],
    img: entry.img,
    sourceLabel: sys.publication?.title || sys.source?.value || source,
  };
}
