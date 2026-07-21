/*
 * Revenge Relationship Notifier
 * 0.1.1-alpha.1
 *
 * IMPORTANT: Revenge Classic evaluates this file inside:
 *   (bunny, definePlugin) => { ...; return plugin?.default ?? plugin; }
 *
 * Therefore this file must expose a top-level variable named `plugin`.
 */

var plugin = (function () {
    "use strict";

    const PLUGIN = "Relationship Notifier";
    const VERSION = "0.1.1-alpha.1";
    const START_DELAY = 10000;
    const SCAN_INTERVAL = 60000;
    const CONFIRM_DELAY = 20000;
    const MAX_HISTORY = 500;

    let state;
    let interval;
    let startupTimer;
    let confirmationTimers = new Map();
    let started = false;

    let RelationshipStore;
    let GuildStore;
    let ChannelStore;
    let UserStore;

    const defaults = {
        initialized: false,
        friends: {},
        guilds: {},
        groupDms: {},
        pending: {},
        history: [],
        settings: {
            friendAlerts: true,
            serverAlerts: true,
            groupDmAlerts: true,
            startupMessage: true,
            focusUserIds: [],
            selectedGuildIds: [],
            selectedGroupDmIds: [],
            priorityIntervalHours: 2,
            relatedIntervalHours: 6
        },
        lastScan: 0
    };

    function log(...args) {
        try { bunny.plugin.logger.log(`[${PLUGIN}]`, ...args); } catch (_) {}
        try { console.log(`[${PLUGIN}]`, ...args); } catch (_) {}
    }

    function logError(...args) {
        try { bunny.plugin.logger.error(`[${PLUGIN}]`, ...args); } catch (_) {}
        try { console.error(`[${PLUGIN}]`, ...args); } catch (_) {}
    }

    function copyDefaults() {
        return JSON.parse(JSON.stringify(defaults));
    }

    function hydrateStorage() {
        state = bunny.plugin.createStorage();

        if (!state.settings) state.settings = copyDefaults().settings;
        if (!state.friends) state.friends = {};
        if (!state.guilds) state.guilds = {};
        if (!state.groupDms) state.groupDms = {};
        if (!state.pending) state.pending = {};
        if (!Array.isArray(state.history)) state.history = [];
        if (typeof state.initialized !== "boolean") state.initialized = false;
        if (typeof state.lastScan !== "number") state.lastScan = 0;
    }

    function findByProps(...props) {
        try {
            if (bunny.metro && typeof bunny.metro.findByProps === "function") {
                return bunny.metro.findByProps(...props);
            }
        } catch (_) {}

        try {
            if (globalThis.vendetta?.metro?.findByProps) {
                return globalThis.vendetta.metro.findByProps(...props);
            }
        } catch (_) {}

        return undefined;
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
            relationshipStore: !!RelationshipStore,
            guildStore: !!GuildStore,
            channelStore: !!ChannelStore,
            userStore: !!UserStore
        };
    }

    function showStartupConfirmation(report) {
        const status =
            `Friend monitor: ${report.relationshipStore ? "ready" : "missing"}\n` +
            `Server monitor: ${report.guildStore ? "ready" : "missing"}\n` +
            `Group DM monitor: ${report.channelStore ? "ready" : "missing"}`;

        // Most reliable option: React Native Alert from Revenge's exposed metro common API.
        try {
            const Alert = bunny.metro?.common?.ReactNative?.Alert;
            if (Alert?.alert) {
                Alert.alert(
                    `${PLUGIN} loaded`,
                    `Version ${VERSION}\n\n${status}\n\nA baseline scan will run in 10 seconds.`
                );
                return;
            }
        } catch (error) {
            logError("Alert API failed", error);
        }

        // Fallback to a Discord/Revenge toast module if available.
        try {
            const toastModule = findByProps("showToast");
            if (toastModule?.showToast) {
                toastModule.showToast(`${PLUGIN} ${VERSION} loaded`);
                return;
            }
        } catch (error) {
            logError("Toast API failed", error);
        }

        log("STARTUP CONFIRMATION", VERSION, report);
    }

    function userName(id) {
        try {
            const user = UserStore?.getUser?.(id);
            return user?.globalName || user?.username || id;
        } catch (_) {
            return id;
        }
    }

    function snapshotFriends() {
        const result = {};
        if (!RelationshipStore) return result;

        try {
            const relationships =
                RelationshipStore.getRelationships?.() ||
                RelationshipStore.getFriendIDs?.() ||
                {};

            if (Array.isArray(relationships)) {
                for (const id of relationships) {
                    result[id] = { id, name: userName(id) };
                }
                return result;
            }

            for (const [id, value] of Object.entries(relationships)) {
                const type = typeof value === "object" ? value?.type : value;
                if (type === 1 || type === "FRIEND") {
                    result[id] = { id, name: userName(id) };
                }
            }
        } catch (error) {
            logError("Friend snapshot failed", error);
        }

        return result;
    }

    function snapshotGuilds() {
        const result = {};
        if (!GuildStore) return result;

        try {
            const guilds = GuildStore.getGuilds?.() || {};
            for (const [id, guild] of Object.entries(guilds)) {
                result[id] = { id, name: guild?.name || id };
            }
        } catch (error) {
            logError("Guild snapshot failed", error);
        }

        return result;
    }

    function snapshotGroupDms() {
        const result = {};
        if (!ChannelStore) return result;

        try {
            const channels =
                ChannelStore.getMutablePrivateChannels?.() ||
                ChannelStore.getPrivateChannels?.() ||
                {};

            for (const [id, channel] of Object.entries(channels)) {
                if (channel?.type !== 3) continue;
                const names = Array.isArray(channel.recipients)
                    ? channel.recipients.map(userName)
                    : [];
                result[id] = {
                    id,
                    name: channel?.name || names.join(", ") || id,
                    recipients: Array.isArray(channel.recipients) ? channel.recipients : []
                };
            }
        } catch (error) {
            logError("Group DM snapshot failed", error);
        }

        return result;
    }

    function notify(title, message) {
        try {
            const Alert = bunny.metro?.common?.ReactNative?.Alert;
            if (Alert?.alert) {
                Alert.alert(title, message);
                return;
            }
        } catch (_) {}

        try {
            const toastModule = findByProps("showToast");
            if (toastModule?.showToast) {
                toastModule.showToast(`${title}: ${message}`);
                return;
            }
        } catch (_) {}

        log("NOTIFICATION", title, message);
    }

    function addHistory(type, id, name, detail) {
        state.history.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type,
            subjectId: id,
            subjectName: name,
            detail,
            timestamp: Date.now()
        });
        if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    }

    function confirmMissing(kind, id, previousEntry, currentGetter, confirmed) {
        const key = `${kind}:${id}`;
        if (confirmationTimers.has(key)) return;

        const timer = setTimeout(() => {
            confirmationTimers.delete(key);
            try {
                const current = currentGetter();
                if (!current[id]) confirmed(previousEntry);
            } catch (error) {
                logError(`Confirmation failed for ${key}`, error);
            }
        }, CONFIRM_DELAY);

        confirmationTimers.set(key, timer);
    }

    function compareRemoved(previous, current) {
        if (state.settings.friendAlerts) {
            for (const [id, oldFriend] of Object.entries(previous.friends || {})) {
                if (!current.friends[id]) {
                    confirmMissing("friend", id, oldFriend, snapshotFriends, confirmed => {
                        notify("Friend removed", `${confirmed.name} is no longer in your friends list.`);
                        addHistory("friend_removed", id, confirmed.name, "No longer present in friends list.");
                    });
                }
            }
        }

        if (state.settings.serverAlerts) {
            for (const [id, oldGuild] of Object.entries(previous.guilds || {})) {
                if (!current.guilds[id]) {
                    confirmMissing("guild", id, oldGuild, snapshotGuilds, confirmed => {
                        notify(
                            "Server disappeared",
                            `${confirmed.name} is no longer in your server list. This can mean a kick, ban, server deletion, or temporary access loss.`
                        );
                        addHistory("server_removed", id, confirmed.name, "Server disappeared from guild list.");
                    });
                }
            }
        }

        if (state.settings.groupDmAlerts) {
            for (const [id, oldGroup] of Object.entries(previous.groupDms || {})) {
                if (!current.groupDms[id]) {
                    confirmMissing("groupdm", id, oldGroup, snapshotGroupDms, confirmed => {
                        notify("Group DM disappeared", `${confirmed.name} is no longer visible.`);
                        addHistory("group_dm_removed", id, confirmed.name, "Group DM disappeared.");
                    });
                }
            }
        }
    }

    function scan(reason) {
        if (!started) return;

        try {
            const current = {
                friends: snapshotFriends(),
                guilds: snapshotGuilds(),
                groupDms: snapshotGroupDms()
            };

            const previous = {
                friends: state.friends || {},
                guilds: state.guilds || {},
                groupDms: state.groupDms || {}
            };

            if (state.initialized) compareRemoved(previous, current);

            state.friends = current.friends;
            state.guilds = current.guilds;
            state.groupDms = current.groupDms;
            state.initialized = true;
            state.lastScan = Date.now();

            log(`Scan complete (${reason})`, {
                friends: Object.keys(current.friends).length,
                guilds: Object.keys(current.guilds).length,
                groupDms: Object.keys(current.groupDms).length
            });
        } catch (error) {
            logError(`Scan failed (${reason})`, error);
        }
    }

    function start() {
        if (started) return;
        started = true;

        try {
            hydrateStorage();
            const report = resolveModules();

            log("Plugin started successfully", {
                version: VERSION,
                modules: report
            });

            if (state.settings.startupMessage !== false) {
                showStartupConfirmation(report);
            }

            startupTimer = setTimeout(() => scan("fresh start"), START_DELAY);
            interval = setInterval(() => scan("periodic safety scan"), SCAN_INTERVAL);

            // Debug helpers for this alpha.
            globalThis.RelationshipNotifierDebug = {
                version: VERSION,
                scanNow: () => scan("manual debug"),
                state: () => state,
                modules: () => resolveModules(),
                history: () => state.history,
                notifyTest: () => notify(PLUGIN, "Manual notification test succeeded.")
            };
        } catch (error) {
            logError("Fatal startup error", error);
            notify(`${PLUGIN} failed`, String(error?.message || error));
            throw error;
        }
    }

    function stop() {
        started = false;
        if (startupTimer) clearTimeout(startupTimer);
        if (interval) clearInterval(interval);

        for (const timer of confirmationTimers.values()) clearTimeout(timer);
        confirmationTimers.clear();

        try { delete globalThis.RelationshipNotifierDebug; } catch (_) {}
        log("Plugin stopped");
    }

    return {
        start,
        stop
    };
})();
