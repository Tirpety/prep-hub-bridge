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
