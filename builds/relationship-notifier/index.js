(function (plugin, metro, common, patcher, pluginApi, components, assets, storageApi) {
    "use strict";

    const NAME = "Relationship Notifier";
    const VERSION = "0.1.3-alpha.1";
    const STARTUP_SCAN_DELAY_MS = 10000;
    const PERIODIC_SCAN_MS = 60000;
    const CONFIRM_REMOVAL_DELAY_MS = 20000;
    const MAX_HISTORY = 500;

    const logger = pluginApi.logger;
    const data = pluginApi.storage;

    let stopped = false;
    let startupTimer = null;
    let periodicTimer = null;
    const confirmationTimers = new Map();

    let RelationshipStore;
    let GuildStore;
    let ChannelStore;
    let UserStore;

    function log(...args) {
        try { logger.log(`[${NAME}]`, ...args); } catch (_) {}
        try { console.log(`[${NAME}]`, ...args); } catch (_) {}
    }

    function error(...args) {
        try { logger.error(`[${NAME}]`, ...args); } catch (_) {}
        try { console.error(`[${NAME}]`, ...args); } catch (_) {}
    }

    function findByProps(...props) {
        try {
            return metro.findByProps(...props);
        } catch (_) {
            return undefined;
        }
    }

    function initializeStorage() {
        data.initialized ??= false;
        data.friends ??= {};
        data.guilds ??= {};
        data.groupDms ??= {};
        data.pending ??= {};
        data.history ??= [];
        data.lastScan ??= 0;

        data.settings ??= {};
        data.settings.friendAlerts ??= true;
        data.settings.serverAlerts ??= true;
        data.settings.groupDmAlerts ??= true;
        data.settings.startupMessage ??= true;
        data.settings.focusUserIds ??= [];
        data.settings.selectedGuildIds ??= [];
        data.settings.selectedGroupDmIds ??= [];
        data.settings.priorityIntervalHours ??= 2;
        data.settings.relatedIntervalHours ??= 6;
    }

    function resolveModules() {
        RelationshipStore =
            findByProps("getRelationships", "isFriend") ||
            findByProps("getFriendIDs");

        GuildStore = findByProps("getGuilds", "getGuild");

        ChannelStore =
            findByProps("getMutablePrivateChannels") ||
            findByProps("getPrivateChannels", "getChannel");

        UserStore = findByProps("getUser", "getCurrentUser");

        return {
            friend: Boolean(RelationshipStore),
            server: Boolean(GuildStore),
            groupDm: Boolean(ChannelStore),
            user: Boolean(UserStore)
        };
    }

    function showAlert(title, message) {
        try {
            const Alert = common.ReactNative?.Alert;
            if (Alert?.alert) {
                Alert.alert(title, message);
                return true;
            }
        } catch (e) {
            error("Alert failed", e);
        }

        try {
            const toast = findByProps("showToast");
            if (toast?.showToast) {
                toast.showToast(`${title}: ${message}`);
                return true;
            }
        } catch (e) {
            error("Toast failed", e);
        }

        log(title, message);
        return false;
    }

    function showStartupConfirmation(modules) {
        const message =
            `Version ${VERSION}\n\n` +
            `Friend monitor: ${modules.friend ? "ready" : "missing"}\n` +
            `Server monitor: ${modules.server ? "ready" : "missing"}\n` +
            `Group DM monitor: ${modules.groupDm ? "ready" : "missing"}\n\n` +
            `The first scan runs in 10 seconds.`;

        showAlert(`${NAME} is running`, message);
    }

    function getUserName(id) {
        try {
            const user = UserStore?.getUser?.(id);
            return user?.globalName || user?.username || id;
        } catch (_) {
            return id;
        }
    }

    function snapshotFriends() {
        const output = {};
        if (!RelationshipStore) return output;

        try {
            const relationships =
                RelationshipStore.getRelationships?.() ||
                RelationshipStore.getFriendIDs?.() ||
                {};

            if (Array.isArray(relationships)) {
                for (const id of relationships) {
                    output[id] = { id, name: getUserName(id) };
                }
                return output;
            }

            for (const [id, relationship] of Object.entries(relationships)) {
                const type =
                    typeof relationship === "object"
                        ? relationship?.type
                        : relationship;

                if (type === 1 || type === "FRIEND") {
                    output[id] = { id, name: getUserName(id) };
                }
            }
        } catch (e) {
            error("Friend snapshot failed", e);
        }

        return output;
    }

    function snapshotGuilds() {
        const output = {};
        if (!GuildStore) return output;

        try {
            const guilds = GuildStore.getGuilds?.() || {};
            for (const [id, guild] of Object.entries(guilds)) {
                output[id] = {
                    id,
                    name: guild?.name || id
                };
            }
        } catch (e) {
            error("Server snapshot failed", e);
        }

        return output;
    }

    function snapshotGroupDms() {
        const output = {};
        if (!ChannelStore) return output;

        try {
            const channels =
                ChannelStore.getMutablePrivateChannels?.() ||
                ChannelStore.getPrivateChannels?.() ||
                {};

            for (const [id, channel] of Object.entries(channels)) {
                if (channel?.type !== 3) continue;

                const recipients = Array.isArray(channel.recipients)
                    ? channel.recipients
                    : [];

                output[id] = {
                    id,
                    name:
                        channel?.name ||
                        recipients.map(getUserName).join(", ") ||
                        id,
                    recipients
                };
            }
        } catch (e) {
            error("Group-DM snapshot failed", e);
        }

        return output;
    }

    function addHistory(type, id, name, detail) {
        data.history.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type,
            subjectId: id,
            subjectName: name,
            detail,
            timestamp: Date.now()
        });

        if (data.history.length > MAX_HISTORY) {
            data.history.length = MAX_HISTORY;
        }
    }

    function notify(title, message) {
        showAlert(title, message);
    }

    function confirmMissing(kind, id, priorEntry, currentSnapshot, callback) {
        const key = `${kind}:${id}`;
        if (confirmationTimers.has(key) || stopped) return;

        const timer = setTimeout(() => {
            confirmationTimers.delete(key);
            if (stopped) return;

            try {
                const current = currentSnapshot();
                if (!current[id]) callback(priorEntry);
            } catch (e) {
                error(`Confirmation failed for ${key}`, e);
            }
        }, CONFIRM_REMOVAL_DELAY_MS);

        confirmationTimers.set(key, timer);
    }

    function compareSnapshots(previous, current) {
        if (data.settings.friendAlerts) {
            for (const [id, oldFriend] of Object.entries(previous.friends)) {
                if (!current.friends[id]) {
                    confirmMissing(
                        "friend",
                        id,
                        oldFriend,
                        snapshotFriends,
                        confirmed => {
                            notify(
                                "Friend-list change",
                                `${confirmed.name} is no longer in your friends list.`
                            );
                            addHistory(
                                "friend_removed",
                                id,
                                confirmed.name,
                                "No longer present in the local friends-list snapshot."
                            );
                        }
                    );
                }
            }
        }

        if (data.settings.serverAlerts) {
            for (const [id, oldGuild] of Object.entries(previous.guilds)) {
                if (!current.guilds[id]) {
                    confirmMissing(
                        "server",
                        id,
                        oldGuild,
                        snapshotGuilds,
                        confirmed => {
                            notify(
                                "Server disappeared",
                                `${confirmed.name} is no longer in your server list. This does not prove why it disappeared.`
                            );
                            addHistory(
                                "server_removed",
                                id,
                                confirmed.name,
                                "Server disappeared from the local guild snapshot."
                            );
                        }
                    );
                }
            }
        }

        if (data.settings.groupDmAlerts) {
            for (const [id, oldGroup] of Object.entries(previous.groupDms)) {
                if (!current.groupDms[id]) {
                    confirmMissing(
                        "group-dm",
                        id,
                        oldGroup,
                        snapshotGroupDms,
                        confirmed => {
                            notify(
                                "Group DM disappeared",
                                `${confirmed.name} is no longer visible.`
                            );
                            addHistory(
                                "group_dm_removed",
                                id,
                                confirmed.name,
                                "Group DM disappeared from the local snapshot."
                            );
                        }
                    );
                }
            }
        }
    }

    function scan(reason) {
        if (stopped) return;

        try {
            const current = {
                friends: snapshotFriends(),
                guilds: snapshotGuilds(),
                groupDms: snapshotGroupDms()
            };

            const previous = {
                friends: data.friends || {},
                guilds: data.guilds || {},
                groupDms: data.groupDms || {}
            };

            if (data.initialized) {
                compareSnapshots(previous, current);
            }

            data.friends = current.friends;
            data.guilds = current.guilds;
            data.groupDms = current.groupDms;
            data.initialized = true;
            data.lastScan = Date.now();

            log(`Scan complete: ${reason}`, {
                friends: Object.keys(current.friends).length,
                servers: Object.keys(current.guilds).length,
                groupDms: Object.keys(current.groupDms).length
            });
        } catch (e) {
            error(`Scan failed: ${reason}`, e);
        }
    }

    function start() {
        initializeStorage();
        const modules = resolveModules();

        log("Plugin executed successfully", {
            version: VERSION,
            modules
        });

        if (data.settings.startupMessage !== false) {
            showStartupConfirmation(modules);
        }

        startupTimer = setTimeout(
            () => scan("fresh start"),
            STARTUP_SCAN_DELAY_MS
        );

        periodicTimer = setInterval(
            () => scan("periodic scan"),
            PERIODIC_SCAN_MS
        );

        globalThis.RelationshipNotifierDebug = {
            version: VERSION,
            scanNow: () => scan("manual debug scan"),
            testNotification: () =>
                notify(NAME, "Manual notification test succeeded."),
            modules: () => resolveModules(),
            history: () => data.history,
            storage: () => data
        };
    }

    function stop() {
        stopped = true;

        if (startupTimer) clearTimeout(startupTimer);
        if (periodicTimer) clearInterval(periodicTimer);

        for (const timer of confirmationTimers.values()) {
            clearTimeout(timer);
        }
        confirmationTimers.clear();

        try {
            delete globalThis.RelationshipNotifierDebug;
        } catch (_) {}

        log("Plugin unloaded");
    }

    plugin.onUnload = stop;

    try {
        start();
    } catch (e) {
        error("Fatal startup error", e);
        showAlert(`${NAME} failed to start`, String(e?.message || e));
        throw e;
    }

    return plugin;
})(
    {},
    vendetta.metro,
    vendetta.metro.common,
    vendetta.patcher,
    vendetta.plugin,
    vendetta.ui.components,
    vendetta.ui.assets,
    vendetta.storage
);
