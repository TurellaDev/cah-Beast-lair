"use strict";

// Config-driven beast-lair spawner for HogwartsMP.
//
// The framework's NPC service only accepts enemy ids. Wild/tame creatures use the
// separate Beast API:
//
//   Beast.create("Niffler", { x, y, z, yaw, preferredOwnerId });
//
// This resource keeps configured lairs empty until a player approaches, then
// spawns each configured species. Captured or otherwise removed beasts are
// respawned after the configured delay.

const RESOURCE = "hmp-beast-lairs";
const Hmp = Imports.get("hmp-lib");
const Core = Imports.get("hmp-core");
const logger = Hmp.logger.create(RESOURCE);
const fs = (() => { try { return require("fs"); } catch (_) { return null; } })();

const DEFAULTS = Object.freeze({
  command: "beastlair",
  enableCommands: true,
  adminGroups: [{ key: "admin", minimumGrade: 1 }],
  enabled: true,
  tickIntervalMs: 2000,
  activateRadius: 12000,
  deactivateRadius: 18000,
  respawnDelayMs: 30000,
  maximumBeasts: 256,
  lairs: []
});

let configSource = process.env.HMP_BEAST_LAIRS_CONFIG || "data/hmp-beast-lairs.json";

function numberInRange(value, label, minimum, maximum, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be a number from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function integerInRange(value, label, minimum, maximum, fallback) {
  const parsed = numberInRange(value, label, minimum, maximum, fallback);
  if (!Number.isInteger(parsed)) throw new TypeError(`${label} must be an integer`);
  return parsed;
}

function booleanValue(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function stringValue(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = String(value).trim();
  if (!parsed) throw new TypeError(`${label} must be a non-empty string`);
  return parsed;
}

function validatePosition(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object with x, y and z`);
  }
  return {
    x: numberInRange(value.x, `${label}.x`, -1e7, 1e7, 0),
    y: numberInRange(value.y, `${label}.y`, -1e7, 1e7, 0),
    z: numberInRange(value.z, `${label}.z`, -1e7, 1e7, 0)
  };
}

function validateOptionalColor(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = String(value).trim();
  if (!parsed) throw new TypeError(`${label} must be a non-empty string when provided`);
  return parsed;
}

function validateOptionalGender(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = String(value).trim().toLowerCase();
  if (parsed !== "male" && parsed !== "female") throw new TypeError(`${label} must be male or female`);
  return parsed;
}

function validateOptionalScale(value, label) {
  return numberInRange(value, label, 0.05, 100, undefined);
}

function validateOptionalYaw(value, label) {
  return numberInRange(value, label, -36000, 36000, undefined);
}

function validateBeastGroup(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const species = stringValue(value.species, `${label}.species`);
  const count = integerInRange(value.count, `${label}.count`, 1, 64, 1);
  const scale = validateOptionalScale(value.scale, `${label}.scale`);
  const yaw = validateOptionalYaw(value.yaw, `${label}.yaw`);
  const name = value.name === undefined || value.name === null || value.name === "" ? undefined : String(value.name).trim();
  if (name !== undefined && Buffer.byteLength(name, "utf8") > 64) throw new TypeError(`${label}.name must be at most 64 UTF-8 bytes`);
  return {
    species,
    count,
    scale,
    yaw,
    name,
    gender: validateOptionalGender(value.gender, `${label}.gender`),
    color: validateOptionalColor(value.color, `${label}.color`),
    capturable: booleanValue(value.capturable, `${label}.capturable`, true)
  };
}

function validateLair(value, index) {
  const label = `hmp-beast-lairs lairs[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const key = stringValue(value.key, `${label}.key`).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) {
    throw new TypeError(`${label}.key must be 1-64 letters, numbers, underscores or hyphens`);
  }
  const position = validatePosition(value.position, `${label}.position`);
  const radius = numberInRange(value.radius, `${label}.radius`, 1, 1000000, 3000);
  const virtualWorld = integerInRange(value.virtualWorld, `${label}.virtualWorld`, 0, 100000, 0);
  const enabled = booleanValue(value.enabled, `${label}.enabled`, true);
  if (!Array.isArray(value.beasts) || !value.beasts.length) throw new TypeError(`${label}.beasts must be a non-empty array`);
  const beasts = value.beasts.map((group, groupIndex) => validateBeastGroup(group, `${label}.beasts[${groupIndex}]`));
  return { key, enabled, position, radius, virtualWorld, beasts };
}

function validateAdminGroups(value, label) {
  if (value === undefined || value === null) return DEFAULTS.adminGroups.map((group) => ({ ...group }));
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`${label}[${index}] must be an object`);
    const key = stringValue(entry.key, `${label}[${index}].key`).toLowerCase();
    const minimumGrade = integerInRange(entry.minimumGrade, `${label}[${index}].minimumGrade`, 0, 1000, 0);
    return { key, minimumGrade };
  });
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("hmp-beast-lairs configuration must be an object");
  const command = stringValue(raw.command, "hmp-beast-lairs command", DEFAULTS.command).toLowerCase().replace(/^[+/]/, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(command)) throw new TypeError("hmp-beast-lairs command must be 1-24 letters, numbers, underscores or hyphens");
  const config = {
    command,
    enableCommands: booleanValue(raw.enableCommands, "hmp-beast-lairs enableCommands", DEFAULTS.enableCommands),
    adminGroups: validateAdminGroups(raw.adminGroups, "hmp-beast-lairs adminGroups"),
    enabled: booleanValue(raw.enabled, "hmp-beast-lairs enabled", DEFAULTS.enabled),
    tickIntervalMs: integerInRange(raw.tickIntervalMs, "hmp-beast-lairs tickIntervalMs", 250, 60000, DEFAULTS.tickIntervalMs),
    activateRadius: numberInRange(raw.activateRadius, "hmp-beast-lairs activateRadius", 100, 1000000, DEFAULTS.activateRadius),
    deactivateRadius: numberInRange(raw.deactivateRadius, "hmp-beast-lairs deactivateRadius", 100, 1000000, DEFAULTS.deactivateRadius),
    respawnDelayMs: integerInRange(raw.respawnDelayMs, "hmp-beast-lairs respawnDelayMs", 0, 86400000, DEFAULTS.respawnDelayMs),
    maximumBeasts: integerInRange(raw.maximumBeasts, "hmp-beast-lairs maximumBeasts", 1, 4096, DEFAULTS.maximumBeasts)
  };
  if (config.deactivateRadius < config.activateRadius) config.deactivateRadius = config.activateRadius;
  if (!Array.isArray(raw.lairs)) throw new TypeError("hmp-beast-lairs lairs must be an array");
  const lairs = raw.lairs.map(validateLair);
  const keys = new Set();
  for (const lair of lairs) {
    if (keys.has(lair.key)) throw new TypeError(`hmp-beast-lairs duplicate lair key '${lair.key}'`);
    keys.add(lair.key);
  }
  config.lairs = lairs;
  return config;
}

function loadConfig() {
  const loaded = Hmp.config.load(configSource, {
    cwd: process.cwd(),
    defaults: DEFAULTS,
    validate(_value, source) {
      if (source) configSource = String(source);
      return true;
    }
  });
  return normalizeConfig(loaded);
}

function persistConfig() {
  if (!fs) {
    logger.warn("filesystem unavailable; runtime lair edits will reset on restart");
    return false;
  }
  try {
    fs.writeFileSync(configSource, JSON.stringify(config, null, 2) + "\n", "utf8");
    return true;
  } catch (error) {
    logger.error(`could not write ${configSource}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function finitePosition(position) {
  return Boolean(
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z)
  );
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function createLairState(lair) {
  const slots = [];
  for (const group of lair.beasts) {
    for (let index = 0; index < group.count; index += 1) {
      slots.push({ group, beast: null, respawnAt: 0 });
    }
  }
  return { lair, slots };
}

function randomPointInRadius(lair) {
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.sqrt(Math.random()) * lair.radius;
  return {
    x: lair.position.x + Math.cos(angle) * distance,
    y: lair.position.y + Math.sin(angle) * distance,
    z: lair.position.z
  };
}

function findNearestPlayer(lair, players) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const player of players) {
    if (!player || player.connected === false || player.virtualWorld !== lair.virtualWorld) continue;
    if (typeof player.location === "function" && !player.location()) continue;
    const position = player.position;
    if (!finitePosition(position)) continue;
    const distance = distanceSquared(position, lair.position);
    if (distance < nearestDistance) {
      nearest = player;
      nearestDistance = distance;
    }
  }
  return nearest ? { player: nearest, distanceSquared: nearestDistance } : null;
}

function spawnSlot(lair, slot, owner, now) {
  if (slot.beast || now < slot.respawnAt) return false;
  const position = randomPointInRadius(lair);
  const options = {
    x: position.x,
    y: position.y,
    z: position.z,
    preferredOwnerId: owner ? owner.id : undefined
  };
  if (slot.group.yaw !== undefined) options.yaw = slot.group.yaw;
  if (slot.group.scale !== undefined) options.scale = slot.group.scale;
  if (slot.group.name !== undefined) options.name = slot.group.name;
  if (slot.group.gender !== undefined) options.gender = slot.group.gender;
  if (slot.group.color !== undefined) options.color = slot.group.color;
  try {
    const beast = Beast.create(slot.group.species, options);
    if (slot.group.scale !== undefined && typeof beast.setScale === "function") beast.setScale(slot.group.scale);
    beast.capturable = slot.group.capturable;
    slot.beast = beast;
    return true;
  } catch (error) {
    slot.respawnAt = now + 30000;
    logger.warn(`Failed to spawn '${slot.group.species}' at lair '${lair.key}': ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function destroySlot(slot, now) {
  if (!slot.beast) return false;
  try {
    slot.beast.destroy();
  } catch {
  }
  slot.beast = null;
  slot.respawnAt = now;
  return true;
}

function createService(options) {
  const { config, beastManager, playerManager, beastApi } = options;
  const lairs = config.lairs.map(createLairState);
  const liveBeastIds = new Set();
  let state = "ready";
  let timer = null;
  let spawned = 0;
  let despawned = 0;
  let spawnErrors = 0;
  let lastTickAt = 0;

  function refreshLiveBeasts() {
    liveBeastIds.clear();
    if (!beastManager || typeof beastManager.getAll !== "function") return;
    for (const beast of beastManager.getAll()) liveBeastIds.add(beast.id);
  }

  function playerList() {
    if (!playerManager || typeof playerManager.getAll !== "function") return [];
    return playerManager.getAll();
  }

  function tick() {
    if (state !== "ready") return;
    lastTickAt = Date.now();
    const now = lastTickAt;
    const players = playerList();
    refreshLiveBeasts();
    let activeBeasts = 0;
    for (const lairState of lairs) {
      const { lair, slots } = lairState;
      for (const slot of slots) if (slot.beast) activeBeasts += 1;
      if (!lair.enabled) {
        for (const slot of slots) if (destroySlot(slot, now)) {
          despawned += 1;
          activeBeasts -= 1;
        }
        continue;
      }
      const nearest = findNearestPlayer(lair, players);
      const active = Boolean(nearest && nearest.distanceSquared <= config.activateRadius * config.activateRadius);
      const stillNear = Boolean(nearest && nearest.distanceSquared <= config.deactivateRadius * config.deactivateRadius);
      if (!stillNear) {
        for (const slot of slots) if (destroySlot(slot, now)) {
          despawned += 1;
          activeBeasts -= 1;
        }
        continue;
      }
      if (!active) continue;
      for (const slot of slots) {
        if (slot.beast && !liveBeastIds.has(slot.beast.id)) {
          slot.beast = null;
          slot.respawnAt = now + config.respawnDelayMs;
          activeBeasts -= 1;
        }
        if (!slot.beast && spawnErrors < 100 && activeBeasts < config.maximumBeasts) {
          if (spawnSlot(lair, slot, nearest.player, now)) {
            spawned += 1;
            activeBeasts += 1;
          } else {
            spawnErrors += 1;
          }
        }
      }
    }
    return activeBeasts;
  }

  function start() {
    if (state !== "ready" || timer) return;
    timer = setInterval(() => {
      try {
        tick();
      } catch (error) {
        logger.error(`Lair tick failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
    }, config.tickIntervalMs);
    logger.info(`Beast lairs ready: ${lairs.length} lair(s), ${lairs.reduce((total, lair) => total + lair.slots.length, 0)} slot(s)`);
  }

  function stop() {
    if (state === "stopped") return;
    state = "stopped";
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const { slots } of lairs) for (const slot of slots) {
      if (!slot.beast) continue;
      try {
        slot.beast.destroy();
      } catch {
      }
      slot.beast = null;
    }
  }

  function rebuild(nextLairs) {
    for (const { slots } of lairs) for (const slot of slots) {
      if (!slot.beast) continue;
      try {
        slot.beast.destroy();
      } catch {
      }
      slot.beast = null;
    }
    lairs.length = 0;
    for (const lair of nextLairs) lairs.push(createLairState(lair));
  }

  function status() {
    let active = 0;
    let configured = 0;
    for (const { slots } of lairs) {
      configured += slots.length;
      for (const slot of slots) if (slot.beast) active += 1;
    }
    return {
      state,
      enabled: config.enabled,
      lairs: lairs.length,
      configured,
      active,
      spawned,
      despawned,
      spawnErrors,
      lastTickAt
    };
  }

  return Object.freeze({ start, stop, status, tick, rebuild });
}

const config = loadConfig();
const hasBeastApi = typeof Beast !== "undefined" && typeof Beast.create === "function";
const beastManager = typeof BeastManager !== "undefined" ? BeastManager : null;
const playerManager = typeof PlayerManager !== "undefined" ? PlayerManager : null;

let service = null;
if (!config.enabled) {
  logger.info("Beast lair spawner disabled by configuration");
} else if (!hasBeastApi) {
  logger.warn("Beast lair spawner disabled: this server build does not expose Beast.create");
} else {
  service = createService({ config, beastManager, playerManager, beastApi: Beast });
  service.start();
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function isAdmin(player) {
  if (!config.adminGroups.length) return false;
  const checks = await Promise.all(config.adminGroups.map((group) => Core.groups.has(player, group.key, group.minimumGrade || 0)));
  return checks.some(Boolean);
}

function rebuildService() {
  if (service) service.rebuild(config.lairs);
}

function formatPosition(position) {
  return `(${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)})`;
}

function listLairs() {
  return config.lairs.map((lair) => `${lair.key}: ${lair.position ? formatPosition(lair.position) : "no position"}; ${lair.beasts.map((group) => `${group.count}x ${group.species}`).join(", ") || "no beasts"}${lair.enabled ? "" : " [disabled]"}`);
}

// ---------------------------------------------------------------------------
// Admin webview editor
// ---------------------------------------------------------------------------

const openSessions = new Map(); // playerId -> player

function parsePayload(raw) {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function send(player, event, payload = {}) {
  if (!player || typeof player.emit !== "function") return false;
  try {
    player.emit(event, JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function readCatalog() {
  if (!hasBeastApi || typeof Beast.catalog !== "function") return [];
  let entries = [];
  try { entries = Beast.catalog() || []; } catch (_) { return []; }
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (typeof entry === "string") {
      const species = entry.trim();
      if (species) out.push({ species, colors: [], genders: ["male", "female"] });
      continue;
    }
    const species = String(entry.species || entry.id || entry.name || "").trim();
    if (!species) continue;
    const colors = Array.isArray(entry.colors)
      ? entry.colors.map((color) => (typeof color === "string" ? color : String(color?.name || color?.id || color || ""))).filter(Boolean)
      : [];
    const genders = Array.isArray(entry.genders) && entry.genders.length
      ? entry.genders.map((gender) => String(gender))
      : ["male", "female"];
    out.push({ species, colors, genders });
  }
  out.sort((a, b) => a.species.localeCompare(b.species));
  return out;
}

function cloneLair(lair) {
  return {
    key: lair.key,
    enabled: lair.enabled,
    position: { ...lair.position },
    radius: lair.radius,
    virtualWorld: lair.virtualWorld,
    beasts: lair.beasts.map((group) => ({
      species: group.species,
      count: group.count,
      scale: group.scale,
      yaw: group.yaw,
      name: group.name,
      gender: group.gender,
      color: group.color,
      capturable: group.capturable
    }))
  };
}

function buildModel(player) {
  const position = Hmp.position.read(player) || { x: 0, y: 0, z: 0 };
  const virtualWorld = Number.isSafeInteger(Number(player?.virtualWorld)) ? Number(player.virtualWorld) : 0;
  const status = service
    ? service.status()
    : { state: hasBeastApi ? "disabled" : "unavailable", enabled: config.enabled, lairs: config.lairs.length, configured: 0, active: 0 };
  return {
    configSource,
    hasBeastApi,
    player: { position: { x: position.x, y: position.y, z: position.z }, virtualWorld },
    defaults: {
      radius: 3000,
      respawnDelayMs: config.respawnDelayMs,
      activateRadius: config.activateRadius,
      deactivateRadius: config.deactivateRadius,
      maximumBeasts: config.maximumBeasts
    },
    catalog: readCatalog(),
    lairs: config.lairs.map(cloneLair),
    status
  };
}

async function openUi(player) {
  if (!(await isAdmin(player))) {
    send(player, "hmp-beast-lairs:error", { message: "You do not have permission to manage beast lairs." });
    return false;
  }
  if (player?.id !== undefined && player.id !== null) openSessions.set(Number(player.id), player);
  return send(player, "hmp-beast-lairs:open", buildModel(player));
}

function upsertLair(raw) {
  let lair;
  try {
    lair = validateLair(raw, 0);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  const index = config.lairs.findIndex((entry) => entry.key === lair.key);
  if (index >= 0) config.lairs[index] = lair;
  else config.lairs.push(lair);
  const saved = persistConfig();
  rebuildService();
  return { ok: true, message: `${index >= 0 ? "Updated" : "Created"} lair '${lair.key}'${saved ? "" : " (not persisted)"}.` };
}

async function handleCommand(context) {
  const { args, reply, player } = context;
  const action = String(args[0] || "open").toLowerCase();

  if (action === "status") {
    const status = service ? service.status() : { state: hasBeastApi ? "disabled" : "unavailable", lairs: config.lairs.length };
    reply(`${status.state}; ${status.lairs} lair(s); ${configSource}`);
    return;
  }

  if (action === "list") {
    const lines = listLairs();
    reply(lines.length ? `${lines.length} lair(s):` : "No beast lairs configured.");
    for (const line of lines) reply(line);
    return;
  }

  if (action === "catalog") {
    const entries = readCatalog();
    if (!entries.length) {
      reply("This server build did not return a Beast catalog.");
      return;
    }
    reply(`${entries.length} beast species:`);
    for (const entry of entries) {
      const colors = entry.colors.length ? entry.colors.join(", ") : "";
      reply(colors ? `${entry.species}: ${colors}` : entry.species);
    }
    return;
  }

  // Everything below needs admin and opens the webview editor.
  if (!(await isAdmin(player))) {
    reply("You do not have permission to manage beast lairs.");
    return;
  }

  if (action === "reload") {
    const loaded = loadConfig();
    Object.assign(config, loaded);
    rebuildService();
    reply(`Reloaded ${configSource}: ${config.lairs.length} lair(s).`);
    return;
  }

  // Default: open the admin lair editor.
  await openUi(player);
}

if (config.enableCommands) {
  const commands = Hmp.command.createRouter({ logger, prefix: `[${RESOURCE}]` });
  commands.register(config.command, {
    aliases: ["lair"],
    description: "Open the beast lair editor (admins).",
    usage: `/${config.command} - open the lair editor | status | list | catalog | reload`,
    guard: async (context) => {
      const action = String((context.args && context.args[0]) || "open").toLowerCase();
      if (["status", "list", "catalog"].includes(action)) return true;
      return await isAdmin(context.player) || "You do not have permission to manage beast lairs.";
    }
  }, handleCommand);
  Events.on("chatCommand", (player, message, command, args) => {
    void Promise.resolve(commands.handle(player, message, command, args)).catch((error) => logger.warn(`command failed for #${player?.id}: ${messageOf(error)}`));
  });
}

// ---------------------------------------------------------------------------
// Webview action bridge - the page talks to us through the client script.
// ---------------------------------------------------------------------------

Events.onClient("hmp-beast-lairs:action", (player, raw) => {
  void (async () => {
    if (!(await isAdmin(player))) {
      send(player, "hmp-beast-lairs:error", { message: "You do not have permission to manage beast lairs." });
      return;
    }
    const payload = parsePayload(raw);
    const action = String(payload.action || "").toLowerCase();

    if (action === "save") {
      const result = upsertLair(payload.lair);
      if (!result.ok) {
        send(player, "hmp-beast-lairs:error", { message: result.error });
        return;
      }
      send(player, "hmp-beast-lairs:model", buildModel(player));
      send(player, "hmp-beast-lairs:notice", { message: result.message });
      logger.info(`#${player?.id} ${result.message.toLowerCase()}`);
      return;
    }

    if (action === "delete") {
      const key = String(payload.key || "").trim().toLowerCase();
      const index = config.lairs.findIndex((lair) => lair.key === key);
      if (index < 0) {
        send(player, "hmp-beast-lairs:error", { message: `No lair named '${key}'.` });
        return;
      }
      config.lairs.splice(index, 1);
      const saved = persistConfig();
      rebuildService();
      send(player, "hmp-beast-lairs:model", buildModel(player));
      send(player, "hmp-beast-lairs:notice", { message: `Removed lair '${key}'${saved ? "" : " (not persisted)"}.` });
      logger.info(`#${player?.id} removed beast lair '${key}'`);
      return;
    }

    if (action === "reload") {
      const loaded = loadConfig();
      Object.assign(config, loaded);
      rebuildService();
      send(player, "hmp-beast-lairs:model", buildModel(player));
      send(player, "hmp-beast-lairs:notice", { message: `Reloaded ${configSource}: ${config.lairs.length} lair(s).` });
      return;
    }

    if (action === "position") {
      const position = Hmp.position.read(player);
      const virtualWorld = Number.isSafeInteger(Number(player?.virtualWorld)) ? Number(player.virtualWorld) : 0;
      send(player, "hmp-beast-lairs:position", {
        position: position ? { x: position.x, y: position.y, z: position.z } : null,
        virtualWorld
      });
      return;
    }

    if (action === "close") {
      if (player?.id !== undefined && player.id !== null) openSessions.delete(Number(player.id));
      return;
    }
  })().catch((error) => {
    logger.warn(`lair editor action failed for #${player?.id}: ${messageOf(error)}`);
    send(player, "hmp-beast-lairs:error", { message: "The lair editor hit an error. Check the server console." });
  });
});

function dropSession(player) {
  if (player?.id !== undefined && player.id !== null) openSessions.delete(Number(player.id));
}

Events.on("playerDisconnect", (player) => dropSession(player));
Events.on("hmp:session:ended", (session) => { if (session?.player) dropSession(session.player); });

Exports.register("catalog", () => (hasBeastApi && typeof Beast.catalog === "function" ? Beast.catalog() : []));
Exports.register("list", () => config.lairs.map((lair) => ({ key: lair.key, enabled: lair.enabled, position: { ...lair.position }, radius: lair.radius, beasts: lair.beasts.map((group) => ({ species: group.species, count: group.count })) })));
Exports.register("status", () => service ? service.status() : { state: "disabled", enabled: config.enabled, lairs: config.lairs.length, configured: 0, active: 0 });

Events.on("resourceStop", (name) => {
  if (!name || name === RESOURCE) {
    if (service) service.stop();
    return;
  }
  if (service) service.tick();
});
