/**
 * Revenge Relationship Notifier
 * Alpha 0.1.0-alpha.1
 *
 * This first test build intentionally focuses on:
 * - friend removal events
 * - server disappearance events
 * - group-DM disappearance events
 * - persistent local history
 * - a conservative snapshot at startup/reconnect
 *
 * Mutual-friend profile interception is scaffolded in storage, but is not
 * enabled until the exact Discord 337.10 profile module is confirmed on-device.
 */

const PLUGIN_ID = "relationship-notifier";
const STORAGE_KEY = "relationshipNotifierState";
const MAX_HISTORY = 500;
const STARTUP_DELAY_MS = 60_000;
const CONFIRMATION_DELAY_MS = 25_000;

let Dispatcher;
let RelationshipStore;
let GuildStore;
let ChannelStore;
let UserStore;
let showToast;
let storage;
let startupTimer;
let confirmationTimers = new Set();
let subscriptions = [];

const defaultState = {
  version: 1,
  settings: {
    friendAlerts: true,
    serverAlerts: true,
    groupDmAlerts: true,
    startupComparison: true,
    requireConfirmation: true,
    focusUserIds: [],
    selectedGuildIds: [],
    selectedGroupDmIds: [],
    priorityIntervalHours: 2,
    relatedIntervalHours: 6
  },
  snapshots: {
    friends: {},
    guilds: {},
    groupDms: {},
    mutuals: {}
  },
  pending: {},
  history: [],
  lastStartupCheck: 0
};

function now() {
  return Date.now();
}

function safeString(value, fallback = "Unknown") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function getGlobal(path) {
  try {
    return path.split(".").reduce((obj, key) => obj?.[key], globalThis);
  } catch {
    return undefined;
  }
}

function findByProps(...props) {
  const candidates = [
    getGlobal("vendetta.metro.findByProps"),
    getGlobal("revenge.metro.findByProps"),
    getGlobal("window.vendetta.metro.findByProps"),
    getGlobal("window.revenge.metro.findByProps")
  ].filter(Boolean);

  for (const finder of candidates) {
    try {
      const result = finder(...props);
      if (result) return result;
    } catch {}
  }
}

function resolveToast() {
  const candidates = [
    getGlobal("vendetta.ui.toasts.showToast"),
    getGlobal("revenge.ui.toasts.showToast"),
    findByProps("showToast")?.showToast
  ].filter(Boolean);

  return candidates[0] || ((message) => console.log(`[${PLUGIN_ID}] ${message}`));
}

function resolveStorage() {
  const createStorage =
    getGlobal("vendetta.plugin.createStorage") ||
    getGlobal("revenge.plugin.createStorage") ||
    getGlobal("vendetta.storage.createStorage") ||
    getGlobal("revenge.storage.createStorage");

  if (typeof createStorage === "function") {
    try {
      return createStorage(STORAGE_KEY, defaultState);
    } catch {}
  }

  // Fallback remains in-memory. This lets the plugin load while exposing
  // compatibility errors without crashing Discord.
  if (!globalThis.__relationshipNotifierFallbackState) {
    globalThis.__relationshipNotifierFallbackState =
      JSON.parse(JSON.stringify(defaultState));
  }
  return globalThis.__relationshipNotifierFallbackState;
}

function hydrateState() {
  if (!storage.settings) storage.settings = {...defaultState.settings};
  if (!storage.snapshots) storage.snapshots = JSON.parse(JSON.stringify(defaultState.snapshots));
  if (!storage.snapshots.friends) storage.snapshots.friends = {};
  if (!storage.snapshots.guilds) storage.snapshots.guilds = {};
  if (!storage.snapshots.groupDms) storage.snapshots.groupDms = {};
  if (!storage.snapshots.mutuals) storage.snapshots.mutuals = {};
  if (!storage.pending) storage.pending = {};
  if (!Array.isArray(storage.history)) storage.history = [];
}

function notify(title, body) {
  const text = `${title}: ${body}`;
  try {
    showToast(text);
  } catch {
    console.log(`[${PLUGIN_ID}] ${text}`);
  }
}

function addHistory(type, subjectId, subjectName, detail, metadata = {}) {
  storage.history.unshift({
    id: `${now()}-${Math.random().toString(36).slice(2)}`,
    type,
    subjectId,
    subjectName,
    detail,
    metadata,
    timestamp: now()
  });
  if (storage.history.length > MAX_HISTORY) {
    storage.history.length = MAX_HISTORY;
  }
}

function friendSnapshot() {
  const output = {};
  try {
    const relationships =
      RelationshipStore?.getRelationships?.() ||
      RelationshipStore?.getFriendIDs?.() ||
      {};

    if (Array.isArray(relationships)) {
      for (const id of relationships) {
        const user = UserStore?.getUser?.(id);
        output[id] = {
          id,
          name: safeString(user?.globalName || user?.username, id)
        };
      }
    } else {
      for (const [id, type] of Object.entries(relationships || {})) {
        // Discord relationship type 1 is FRIEND.
        if (type === 1 || type === "FRIEND" || type?.type === 1) {
          const user = UserStore?.getUser?.(id);
          output[id] = {
            id,
            name: safeString(user?.globalName || user?.username, id)
          };
        }
      }
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] Failed to snapshot friends`, error);
  }
  return output;
}

function guildSnapshot() {
  const output = {};
  try {
    const guilds = GuildStore?.getGuilds?.() || {};
    for (const [id, guild] of Object.entries(guilds)) {
      output[id] = {id, name: safeString(guild?.name, id)};
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] Failed to snapshot guilds`, error);
  }
  return output;
}

function groupDmSnapshot() {
  const output = {};
  try {
    const channels =
      ChannelStore?.getMutablePrivateChannels?.() ||
      ChannelStore?.getPrivateChannels?.() ||
      {};

    for (const [id, channel] of Object.entries(channels)) {
      // Discord channel type 3 = GROUP_DM.
      if (channel?.type !== 3) continue;
      const recipients = Array.isArray(channel.recipients)
        ? channel.recipients.map((uid) => {
            const user = UserStore?.getUser?.(uid);
            return safeString(user?.globalName || user?.username, uid);
          })
        : [];
      output[id] = {
        id,
        name: safeString(channel?.name, recipients.join(", ") || id),
        recipients
      };
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] Failed to snapshot group DMs`, error);
  }
  return output;
}

function getCurrentSnapshots() {
  return {
    friends: friendSnapshot(),
    guilds: guildSnapshot(),
    groupDms: groupDmSnapshot()
  };
}

function confirmMissing(kind, id, prior, getter, onConfirmed) {
  const key = `${kind}:${id}`;
  if (storage.pending[key]) return;

  storage.pending[key] = {
    firstObservedMissing: now(),
    prior
  };

  const timer = setTimeout(() => {
    confirmationTimers.delete(timer);
    try {
      const current = getter();
      if (!current[id]) {
        onConfirmed(prior);
      }
    } finally {
      delete storage.pending[key];
    }
  }, storage.settings.requireConfirmation ? CONFIRMATION_DELAY_MS : 0);

  confirmationTimers.add(timer);
}

function processSnapshotDiffs(previous, current) {
  if (storage.settings.friendAlerts) {
    for (const [id, prior] of Object.entries(previous.friends || {})) {
      if (!current.friends[id]) {
        confirmMissing("friend", id, prior, friendSnapshot, (confirmed) => {
          notify("Friend removed", `${confirmed.name} is no longer in your friends list.`);
          addHistory("friend_removed", id, confirmed.name, "No longer present in your friends list.");
        });
      }
    }
  }

  if (storage.settings.serverAlerts) {
    for (const [id, prior] of Object.entries(previous.guilds || {})) {
      if (!current.guilds[id]) {
        confirmMissing("guild", id, prior, guildSnapshot, (confirmed) => {
          notify("Server removed", `${confirmed.name} disappeared from your server list.`);
          addHistory(
            "server_removed",
            id,
            confirmed.name,
            "Server disappeared. This may mean kick, ban, deletion, or temporary loss of access."
          );
        });
      }
    }
  }

  if (storage.settings.groupDmAlerts) {
    for (const [id, prior] of Object.entries(previous.groupDms || {})) {
      if (!current.groupDms[id]) {
        confirmMissing("groupDm", id, prior, groupDmSnapshot, (confirmed) => {
          notify("Group DM removed", `${confirmed.name} disappeared from your group DMs.`);
          addHistory("group_dm_removed", id, confirmed.name, "Group DM no longer visible.");
        });
      }
    }
  }
}

function replaceSnapshots(current) {
  storage.snapshots.friends = current.friends;
  storage.snapshots.guilds = current.guilds;
  storage.snapshots.groupDms = current.groupDms;
}

function compareAndSave(reason = "manual") {
  const previous = {
    friends: storage.snapshots.friends || {},
    guilds: storage.snapshots.guilds || {},
    groupDms: storage.snapshots.groupDms || {}
  };
  const current = getCurrentSnapshots();

  const hasBaseline =
    Object.keys(previous.friends).length ||
    Object.keys(previous.guilds).length ||
    Object.keys(previous.groupDms).length;

  if (hasBaseline) processSnapshotDiffs(previous, current);
  replaceSnapshots(current);
  storage.lastStartupCheck = now();

  console.log(`[${PLUGIN_ID}] Comparison complete (${reason})`, {
    friends: Object.keys(current.friends).length,
    guilds: Object.keys(current.guilds).length,
    groupDms: Object.keys(current.groupDms).length
  });
}

function subscribe(event, handler) {
  if (!Dispatcher?.subscribe || !Dispatcher?.unsubscribe) return;
  try {
    Dispatcher.subscribe(event, handler);
    subscriptions.push([event, handler]);
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] Could not subscribe to ${event}`, error);
  }
}

function registerDispatchListeners() {
  // Event payload details vary by Discord version, so the alpha uses the
  // dispatch only as a trigger and verifies against the stores.
  subscribe("RELATIONSHIP_REMOVE", () => setTimeout(() => compareAndSave("RELATIONSHIP_REMOVE"), 750));
  subscribe("GUILD_DELETE", () => setTimeout(() => compareAndSave("GUILD_DELETE"), 750));
  subscribe("CHANNEL_DELETE", () => setTimeout(() => compareAndSave("CHANNEL_DELETE"), 750));
  subscribe("CONNECTION_OPEN", () => {
    if (!storage.settings.startupComparison) return;
    setTimeout(() => compareAndSave("CONNECTION_OPEN"), 10_000);
  });
}

function resolveModules() {
  Dispatcher = findByProps("dispatch", "subscribe", "unsubscribe");
  RelationshipStore =
    findByProps("getRelationships", "isFriend") ||
    findByProps("getFriendIDs");
  GuildStore = findByProps("getGuilds", "getGuild");
  ChannelStore =
    findByProps("getMutablePrivateChannels") ||
    findByProps("getPrivateChannels", "getChannel");
  UserStore = findByProps("getUser", "getCurrentUser");
  showToast = resolveToast();
  storage = resolveStorage();
  hydrateState();
}

function compatibilityReport() {
  return {
    dispatcher: !!Dispatcher,
    relationshipStore: !!RelationshipStore,
    guildStore: !!GuildStore,
    channelStore: !!ChannelStore,
    userStore: !!UserStore,
    persistentStorageLikely: storage !== globalThis.__relationshipNotifierFallbackState
  };
}

module.exports = {
  onLoad() {
    resolveModules();
    const report = compatibilityReport();
    console.log(`[${PLUGIN_ID}] Loaded`, report);

    const critical =
      report.dispatcher &&
      report.relationshipStore &&
      report.guildStore &&
      report.channelStore;

    if (!critical) {
      notify(
        "Relationship Notifier alpha",
        "Loaded with missing Discord modules. Open Revenge logs and send the compatibility report."
      );
    } else {
      notify("Relationship Notifier", "Alpha loaded. Building the first local snapshot.");
    }

    registerDispatchListeners();

    startupTimer = setTimeout(() => {
      try {
        compareAndSave("startup");
      } catch (error) {
        console.error(`[${PLUGIN_ID}] Startup comparison failed`, error);
        notify("Relationship Notifier", "Startup comparison failed. Check Revenge logs.");
      }
    }, STARTUP_DELAY_MS);

    // Expose a small debug API for testing through Revenge's developer console.
    globalThis.RelationshipNotifierDebug = {
      compareNow: () => compareAndSave("debug"),
      getCompatibility: compatibilityReport,
      getHistory: () => storage.history,
      getState: () => storage,
      clearHistory: () => { storage.history = []; },
      addFocusUser: (id) => {
        if (!storage.settings.focusUserIds.includes(id)) storage.settings.focusUserIds.push(id);
      },
      setSelectedGuilds: (ids) => { storage.settings.selectedGuildIds = [...new Set(ids)]; },
      setSelectedGroupDms: (ids) => { storage.settings.selectedGroupDmIds = [...new Set(ids)]; }
    };
  },

  onUnload() {
    if (startupTimer) clearTimeout(startupTimer);
    for (const timer of confirmationTimers) clearTimeout(timer);
    confirmationTimers.clear();

    for (const [event, handler] of subscriptions) {
      try { Dispatcher?.unsubscribe?.(event, handler); } catch {}
    }
    subscriptions = [];
    delete globalThis.RelationshipNotifierDebug;
    console.log(`[${PLUGIN_ID}] Unloaded`);
  }
};
