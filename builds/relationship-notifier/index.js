(function (plugin, metro, common, patcher, pluginApi, components, assets, storageApi) {
    "use strict";

    const NAME = "Relationship Notifier";
    const VERSION = "0.2.0-alpha.1";
    const STARTUP_DELAY = 10000;
    const BASIC_SCAN_MS = 60 * 60 * 1000;
    const DEFAULT_PRIORITY_HOURS = 2;
    const DEFAULT_RELATED_HOURS = 6;
    const CONFIRM_DELAY = 20000;
    const PROFILE_REQUEST_GAP = 1750;
    const RELATED_BATCH_LIMIT = 25;
    const MAX_HISTORY = 1000;
    const EDGE_STALE_DAYS = 30;

    const React = common.React;
    const RN = common.ReactNative;
    const logger = pluginApi.logger;
    const data = pluginApi.storage;

    let stopped = false;
    let startupTimer = null;
    let basicTimer = null;
    let priorityTimer = null;
    let relatedTimer = null;
    const pendingTimers = new Map();

    let RelationshipStore;
    let GuildStore;
    let ChannelStore;
    let UserStore;
    let GuildMemberStore;
    let UserProfileStore;
    let UserProfileActions;
    let RestAPI;
    let Dispatcher;

    function log(...args) {
        try { logger.log(`[${NAME}]`, ...args); } catch (_) {}
        try { console.log(`[${NAME}]`, ...args); } catch (_) {}
    }

    function logError(...args) {
        try { logger.error(`[${NAME}]`, ...args); } catch (_) {}
        try { console.error(`[${NAME}]`, ...args); } catch (_) {}
    }

    function findByProps(...props) {
        try { return metro.findByProps(...props); } catch (_) { return undefined; }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function uniq(values) {
        return Array.from(new Set((values || []).filter(Boolean).map(String)));
    }

    function parseIds(value) {
        if (Array.isArray(value)) return uniq(value);
        return uniq(String(value || "").split(/[\s,;]+/g).filter(x => /^\d{15,22}$/.test(x)));
    }

    function initializeStorage() {
        data.initialized ??= false;
        data.friends ??= {};
        data.guilds ??= {};
        data.groupDms ??= {};
        data.profiles ??= {};
        data.graph ??= { edges: {}, people: {} };
        data.history ??= [];
        data.lastBasicScan ??= 0;
        data.lastPriorityScan ??= 0;
        data.lastRelatedScan ??= 0;
        data.relatedCursor ??= 0;

        data.settings ??= {};
        data.settings.friendAlerts ??= true;
        data.settings.serverAlerts ??= true;
        data.settings.groupDmAlerts ??= true;
        data.settings.mutualAlerts ??= true;
        data.settings.startupMessage ??= true;
        data.settings.focusUserIds ??= [];
        data.settings.selectedGuildIds ??= [];
        data.settings.selectedGroupDmIds ??= [];
        data.settings.priorityIntervalHours ??= DEFAULT_PRIORITY_HOURS;
        data.settings.relatedIntervalHours ??= DEFAULT_RELATED_HOURS;
        data.settings.includeSelectedGuildMembers ??= true;
        data.settings.includeSelectedGroupMembers ??= true;
        data.settings.relatedBatchLimit ??= RELATED_BATCH_LIMIT;
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
        GuildMemberStore =
            findByProps("getMembers", "getMember") ||
            findByProps("getMutableGuildChannelsForGuild");

        UserProfileStore =
            findByProps("getUserProfile", "isFetchingProfile") ||
            findByProps("getMutualFriends");

        UserProfileActions =
            findByProps("fetchProfile") ||
            findByProps("fetchUserProfile");

        RestAPI =
            findByProps("get", "post", "put", "del") ||
            findByProps("get", "post", "patch", "delete");

        Dispatcher =
            findByProps("subscribe", "unsubscribe", "dispatch");

        return {
            friend: !!RelationshipStore,
            server: !!GuildStore,
            groupDm: !!ChannelStore,
            members: !!GuildMemberStore,
            profileStore: !!UserProfileStore,
            profileFetch: !!UserProfileActions,
            rest: !!RestAPI,
            dispatcher: !!Dispatcher
        };
    }

    function showAlert(title, message) {
        try {
            if (RN?.Alert?.alert) {
                RN.Alert.alert(title, message);
                return true;
            }
        } catch (e) {
            logError("Alert failed", e);
        }

        try {
            const toast = findByProps("showToast");
            if (toast?.showToast) {
                toast.showToast(`${title}: ${message}`);
                return true;
            }
        } catch (e) {
            logError("Toast failed", e);
        }

        log(title, message);
        return false;
    }

    function getUserName(id) {
        try {
            const u = UserStore?.getUser?.(id);
            return u?.globalName || u?.username || id;
        } catch (_) {
            return id;
        }
    }

    function getGuildName(id) {
        try { return GuildStore?.getGuild?.(id)?.name || id; } catch (_) { return id; }
    }

    function snapshotFriends() {
        const out = {};
        if (!RelationshipStore) return out;
        try {
            const rels = RelationshipStore.getRelationships?.() || RelationshipStore.getFriendIDs?.() || {};
            if (Array.isArray(rels)) {
                for (const id of rels) out[id] = { id, name: getUserName(id) };
            } else {
                for (const [id, rel] of Object.entries(rels)) {
                    const type = typeof rel === "object" ? rel?.type : rel;
                    if (type === 1 || type === "FRIEND") out[id] = { id, name: getUserName(id) };
                }
            }
        } catch (e) { logError("Friend snapshot failed", e); }
        return out;
    }

    function snapshotGuilds() {
        const out = {};
        try {
            const guilds = GuildStore?.getGuilds?.() || {};
            for (const [id, guild] of Object.entries(guilds)) {
                out[id] = { id, name: guild?.name || id };
            }
        } catch (e) { logError("Guild snapshot failed", e); }
        return out;
    }

    function snapshotGroupDms() {
        const out = {};
        try {
            const channels = ChannelStore?.getMutablePrivateChannels?.() ||
                ChannelStore?.getPrivateChannels?.() || {};
            for (const [id, channel] of Object.entries(channels)) {
                if (channel?.type !== 3) continue;
                const recipients = Array.isArray(channel.recipients) ? channel.recipients.map(String) : [];
                out[id] = {
                    id,
                    name: channel?.name || recipients.map(getUserName).join(", ") || id,
                    recipients
                };
            }
        } catch (e) { logError("Group DM snapshot failed", e); }
        return out;
    }

    function addHistory(type, subjectId, subjectName, detail, extra) {
        data.history.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type,
            subjectId,
            subjectName,
            detail,
            extra: extra || null,
            timestamp: Date.now()
        });
        if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
    }

    function notify(title, message) {
        showAlert(title, message);
    }

    function confirmMissing(kind, id, previous, currentSnapshot, callback) {
        const key = `${kind}:${id}`;
        if (pendingTimers.has(key) || stopped) return;
        const timer = setTimeout(() => {
            pendingTimers.delete(key);
            if (stopped) return;
            try {
                const now = currentSnapshot();
                if (!now[id]) callback(previous);
            } catch (e) { logError(`Confirmation failed: ${key}`, e); }
        }, CONFIRM_DELAY);
        pendingTimers.set(key, timer);
    }

    function compareBasic(previous, current) {
        if (data.settings.friendAlerts) {
            for (const [id, old] of Object.entries(previous.friends || {})) {
                if (!current.friends[id]) {
                    confirmMissing("friend", id, old, snapshotFriends, confirmed => {
                        notify("Friend-list change", `${confirmed.name} is no longer in your friends list.`);
                        addHistory("friend_removed", id, confirmed.name,
                            "No longer present in your friends list. The plugin cannot determine who initiated it.");
                    });
                }
            }
        }

        if (data.settings.serverAlerts) {
            for (const [id, old] of Object.entries(previous.guilds || {})) {
                if (!current.guilds[id]) {
                    confirmMissing("guild", id, old, snapshotGuilds, confirmed => {
                        notify("Server disappeared", `${confirmed.name} is no longer in your server list.`);
                        addHistory("server_removed", id, confirmed.name,
                            "Server disappeared. This can mean removal, ban, deletion, or loss of access.");
                    });
                }
            }
        }

        if (data.settings.groupDmAlerts) {
            for (const [id, old] of Object.entries(previous.groupDms || {})) {
                if (!current.groupDms[id]) {
                    confirmMissing("groupdm", id, old, snapshotGroupDms, confirmed => {
                        notify("Group DM disappeared", `${confirmed.name} is no longer visible.`);
                        addHistory("group_dm_removed", id, confirmed.name, "Group DM disappeared from the local client.");
                    });
                }
            }
        }
    }

    function runBasicScan(reason) {
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
            if (data.initialized) compareBasic(previous, current);
            data.friends = current.friends;
            data.guilds = current.guilds;
            data.groupDms = current.groupDms;
            data.initialized = true;
            data.lastBasicScan = Date.now();
            log(`Basic scan complete (${reason})`, {
                friends: Object.keys(current.friends).length,
                guilds: Object.keys(current.guilds).length,
                groupDms: Object.keys(current.groupDms).length
            });
        } catch (e) { logError(`Basic scan failed (${reason})`, e); }
    }

    function normalizeMutualFriends(raw) {
        const list =
            raw?.mutual_friends ||
            raw?.mutualFriends ||
            raw?.mutualFriendsList ||
            raw?.user_profile?.mutual_friends ||
            raw?.userProfile?.mutualFriends ||
            [];

        if (!Array.isArray(list)) return [];
        return uniq(list.map(item => {
            if (typeof item === "string") return item;
            return item?.id || item?.user_id || item?.userId || item?.user?.id;
        }));
    }

    function readProfileFromStore(userId) {
        try {
            const p = UserProfileStore?.getUserProfile?.(userId);
            const direct = normalizeMutualFriends(p);
            if (direct.length || p) return { raw: p, mutualIds: direct, source: "profile-store" };
        } catch (_) {}

        try {
            const mf = UserProfileStore?.getMutualFriends?.(userId);
            if (mf) return { raw: mf, mutualIds: normalizeMutualFriends({ mutualFriends: mf }), source: "mutual-store" };
        } catch (_) {}

        return null;
    }

    async function fetchProfile(userId) {
        let result = null;

        try {
            if (UserProfileActions?.fetchProfile) {
                await UserProfileActions.fetchProfile(userId, { withMutualGuilds: true, with_mutual_guilds: true });
                await sleep(300);
                result = readProfileFromStore(userId);
                if (result) return result;
            }
        } catch (e) { logError(`fetchProfile action failed for ${userId}`, e); }

        try {
            if (UserProfileActions?.fetchUserProfile) {
                await UserProfileActions.fetchUserProfile(userId, { withMutualGuilds: true });
                await sleep(300);
                result = readProfileFromStore(userId);
                if (result) return result;
            }
        } catch (e) { logError(`fetchUserProfile action failed for ${userId}`, e); }

        try {
            if (RestAPI?.get) {
                const response = await RestAPI.get({
                    url: `/users/${userId}/profile`,
                    query: { with_mutual_guilds: "true", with_mutual_friends: "true" }
                });
                const body = response?.body || response;
                return { raw: body, mutualIds: normalizeMutualFriends(body), source: "rest" };
            }
        } catch (e) { logError(`REST profile request failed for ${userId}`, e); }

        result = readProfileFromStore(userId);
        if (result) return result;
        throw new Error("No usable profile-fetch method was found or Discord returned no profile data.");
    }

    function edgeKey(a, b) {
        return [String(a), String(b)].sort().join(":");
    }

    function touchPerson(id, reason) {
        data.graph.people[id] ??= {
            id,
            name: getUserName(id),
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            reasons: []
        };
        data.graph.people[id].name = getUserName(id);
        data.graph.people[id].lastSeen = Date.now();
        data.graph.people[id].reasons = uniq([...(data.graph.people[id].reasons || []), reason]);
    }

    function markEdge(a, b, sourceTarget, active) {
        const key = edgeKey(a, b);
        const now = Date.now();
        const existing = data.graph.edges[key];
        data.graph.edges[key] = {
            a: String(a),
            b: String(b),
            active: active !== false,
            firstSeen: existing?.firstSeen || now,
            lastSeen: now,
            lastChanged: existing?.active !== (active !== false) ? now : (existing?.lastChanged || now),
            sources: uniq([...(existing?.sources || []), String(sourceTarget)])
        };
        touchPerson(String(a), `edge:${sourceTarget}`);
        touchPerson(String(b), `edge:${sourceTarget}`);
        return { key, previous: existing, current: data.graph.edges[key] };
    }

    function processProfile(userId, mutualIds, source) {
        const now = Date.now();
        const previous = data.profiles[userId] || null;
        const previousSet = new Set(previous?.mutualIds || []);
        const currentSet = new Set(mutualIds);

        for (const mutualId of mutualIds) {
            markEdge(userId, mutualId, userId, true);
        }

        if (previous) {
            for (const oldMutualId of previousSet) {
                if (!currentSet.has(oldMutualId)) {
                    const { previous: edgeBefore, current: edgeAfter } =
                        markEdge(userId, oldMutualId, userId, false);

                    if (data.settings.mutualAlerts && edgeBefore?.active !== false) {
                        const targetName = getUserName(userId);
                        const mutualName = getUserName(oldMutualId);
                        notify("Observed mutual changed",
                            `${mutualName} no longer appears as a mutual friend on ${targetName}'s profile.`);
                        addHistory("mutual_removed", userId, targetName,
                            `${mutualName} (${oldMutualId}) stopped appearing as a mutual friend. This does not identify who removed whom.`,
                            { otherUserId: oldMutualId, edge: edgeAfter });
                    }
                }
            }

            for (const newMutualId of currentSet) {
                if (!previousSet.has(newMutualId)) {
                    addHistory("mutual_added", userId, getUserName(userId),
                        `${getUserName(newMutualId)} (${newMutualId}) appeared as a mutual friend.`,
                        { otherUserId: newMutualId });
                }
            }
        }

        data.profiles[userId] = {
            userId,
            userName: getUserName(userId),
            mutualIds,
            fetchedAt: now,
            source,
            lastError: null
        };
        touchPerson(userId, "profile-scan");
    }

    async function scanProfiles(ids, reason) {
        const list = uniq(ids);
        let ok = 0, failed = 0;
        for (const id of list) {
            if (stopped) break;
            try {
                const profile = await fetchProfile(id);
                processProfile(id, profile.mutualIds || [], profile.source);
                ok++;
            } catch (e) {
                failed++;
                data.profiles[id] ??= { userId: id, mutualIds: [] };
                data.profiles[id].lastError = String(e?.message || e);
                data.profiles[id].fetchedAt = Date.now();
                logError(`Profile scan failed for ${id}`, e);
            }
            await sleep(PROFILE_REQUEST_GAP);
        }
        log(`Profile scan complete (${reason})`, { requested: list.length, ok, failed });
        return { requested: list.length, ok, failed };
    }

    function collectGuildMemberIds() {
        const ids = [];
        if (!data.settings.includeSelectedGuildMembers) return ids;
        for (const guildId of parseIds(data.settings.selectedGuildIds)) {
            try {
                const members = GuildMemberStore?.getMembers?.(guildId) || [];
                if (Array.isArray(members)) {
                    for (const member of members) {
                        const id = member?.userId || member?.user_id || member?.user?.id;
                        if (id) ids.push(String(id));
                    }
                } else {
                    for (const [id, member] of Object.entries(members || {})) {
                        ids.push(String(member?.userId || member?.user_id || member?.user?.id || id));
                    }
                }
            } catch (e) { logError(`Could not enumerate members for ${guildId}`, e); }
        }
        return uniq(ids);
    }

    function collectGroupDmMemberIds() {
        const ids = [];
        if (!data.settings.includeSelectedGroupMembers) return ids;
        const groups = snapshotGroupDms();
        for (const channelId of parseIds(data.settings.selectedGroupDmIds)) {
            for (const id of groups[channelId]?.recipients || []) ids.push(String(id));
        }
        return uniq(ids);
    }

    function getPriorityIds() {
        return parseIds(data.settings.focusUserIds);
    }

    function getRelatedIds() {
        const priority = new Set(getPriorityIds());
        const ids = [
            ...collectGuildMemberIds(),
            ...collectGroupDmMemberIds()
        ];

        for (const profile of Object.values(data.profiles || {})) {
            ids.push(...(profile?.mutualIds || []));
        }

        return uniq(ids).filter(id => !priority.has(id) && id !== UserStore?.getCurrentUser?.()?.id);
    }

    async function runPriorityScan(reason) {
        const ids = getPriorityIds();
        const result = await scanProfiles(ids, reason);
        data.lastPriorityScan = Date.now();
        return result;
    }

    async function runRelatedScan(reason) {
        const all = getRelatedIds();
        const limit = Math.max(1, Math.min(100, Number(data.settings.relatedBatchLimit) || RELATED_BATCH_LIMIT));
        if (!all.length) {
            data.lastRelatedScan = Date.now();
            return { requested: 0, ok: 0, failed: 0 };
        }
        const cursor = Number(data.relatedCursor) || 0;
        const batch = [];
        for (let i = 0; i < Math.min(limit, all.length); i++) {
            batch.push(all[(cursor + i) % all.length]);
        }
        data.relatedCursor = (cursor + batch.length) % all.length;
        const result = await scanProfiles(batch, reason);
        data.lastRelatedScan = Date.now();
        return result;
    }

    async function runFullScan(reason) {
        runBasicScan(reason);
        const priority = await runPriorityScan(`${reason}: priority`);
        const related = await runRelatedScan(`${reason}: related`);
        return { priority, related };
    }

    function clearSchedules() {
        if (basicTimer) clearInterval(basicTimer);
        if (priorityTimer) clearInterval(priorityTimer);
        if (relatedTimer) clearInterval(relatedTimer);
        basicTimer = priorityTimer = relatedTimer = null;
    }

    function scheduleScans() {
        clearSchedules();
        basicTimer = setInterval(() => runBasicScan("scheduled"), BASIC_SCAN_MS);

        const priorityMs = Math.max(1, Number(data.settings.priorityIntervalHours) || 2) * 60 * 60 * 1000;
        const relatedMs = Math.max(1, Number(data.settings.relatedIntervalHours) || 6) * 60 * 60 * 1000;

        priorityTimer = setInterval(() => runPriorityScan("scheduled priority"), priorityMs);
        relatedTimer = setInterval(() => runRelatedScan("scheduled related"), relatedMs);
    }

    function subscribeEvents() {
        if (!Dispatcher?.subscribe) return;
        const handler = () => setTimeout(() => runBasicScan("Discord relationship/guild event"), 1000);
        const events = [
            "RELATIONSHIP_ADD", "RELATIONSHIP_REMOVE",
            "GUILD_CREATE", "GUILD_DELETE",
            "CHANNEL_CREATE", "CHANNEL_DELETE"
        ];
        for (const event of events) {
            try { Dispatcher.subscribe(event, handler); } catch (_) {}
        }
        plugin.__relationshipEventHandler = handler;
        plugin.__relationshipEvents = events;
    }

    function unsubscribeEvents() {
        if (!Dispatcher?.unsubscribe || !plugin.__relationshipEventHandler) return;
        for (const event of plugin.__relationshipEvents || []) {
            try { Dispatcher.unsubscribe(event, plugin.__relationshipEventHandler); } catch (_) {}
        }
    }

    function formatTime(ts) {
        if (!ts) return "Never";
        try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); }
    }

    function button(label, onPress, disabled) {
        return React.createElement(RN.Pressable, {
            onPress,
            disabled,
            style: {
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 8,
                marginVertical: 5,
                backgroundColor: disabled ? "#555" : "#5865F2"
            }
        }, React.createElement(RN.Text, {
            style: { color: "white", textAlign: "center", fontWeight: "700" }
        }, label));
    }

    function sectionTitle(text) {
        return React.createElement(RN.Text, {
            style: { fontSize: 18, fontWeight: "700", marginTop: 18, marginBottom: 8 }
        }, text);
    }

    function labeledInput(label, value, onChangeText, placeholder, keyboardType) {
        return React.createElement(RN.View, { style: { marginVertical: 7 } },
            React.createElement(RN.Text, { style: { marginBottom: 5, fontWeight: "600" } }, label),
            React.createElement(RN.TextInput, {
                value,
                onChangeText,
                placeholder,
                keyboardType: keyboardType || "default",
                multiline: keyboardType !== "numeric",
                autoCapitalize: "none",
                style: {
                    minHeight: keyboardType === "numeric" ? 44 : 72,
                    borderWidth: 1,
                    borderColor: "#777",
                    borderRadius: 8,
                    padding: 10
                }
            })
        );
    }

    function toggleRow(label, value, onValueChange) {
        return React.createElement(RN.View, {
            style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 }
        },
            React.createElement(RN.Text, { style: { flex: 1, paddingRight: 10 } }, label),
            React.createElement(RN.Switch, { value: !!value, onValueChange })
        );
    }

    function Settings() {
        const [, rerender] = React.useReducer(x => x + 1, 0);
        const [busy, setBusy] = React.useState(false);
        const [focus, setFocus] = React.useState(parseIds(data.settings.focusUserIds).join(", "));
        const [guilds, setGuilds] = React.useState(parseIds(data.settings.selectedGuildIds).join(", "));
        const [groups, setGroups] = React.useState(parseIds(data.settings.selectedGroupDmIds).join(", "));
        const [priorityHours, setPriorityHours] = React.useState(String(data.settings.priorityIntervalHours));
        const [relatedHours, setRelatedHours] = React.useState(String(data.settings.relatedIntervalHours));
        const [batchLimit, setBatchLimit] = React.useState(String(data.settings.relatedBatchLimit));

        function save() {
            data.settings.focusUserIds = parseIds(focus);
            data.settings.selectedGuildIds = parseIds(guilds);
            data.settings.selectedGroupDmIds = parseIds(groups);
            data.settings.priorityIntervalHours = Math.max(1, Number(priorityHours) || 2);
            data.settings.relatedIntervalHours = Math.max(1, Number(relatedHours) || 6);
            data.settings.relatedBatchLimit = Math.max(1, Math.min(100, Number(batchLimit) || 25));
            scheduleScans();
            showAlert(NAME, "Settings saved and scan timers restarted.");
            rerender();
        }

        async function doScan(kind) {
            setBusy(true);
            try {
                let result;
                if (kind === "full") result = await runFullScan("manual full scan");
                else if (kind === "priority") result = await runPriorityScan("manual priority scan");
                else result = await runRelatedScan("manual related scan");
                showAlert(NAME, `${kind} scan finished.\n${JSON.stringify(result)}`);
            } catch (e) {
                showAlert(`${NAME} scan failed`, String(e?.message || e));
            } finally {
                setBusy(false);
                rerender();
            }
        }

        const recent = (data.history || []).slice(0, 12);

        return React.createElement(RN.ScrollView, {
            style: { flex: 1 },
            contentContainerStyle: { padding: 16, paddingBottom: 60 }
        },
            React.createElement(RN.Text, { style: { fontSize: 22, fontWeight: "800" } },
                `${NAME} ${VERSION}`),
            React.createElement(RN.Text, { style: { marginTop: 5, opacity: 0.8 } },
                "Everything is stored locally. A missing mutual only proves that Discord stopped showing that person as mutual on the scanned profile."),

            sectionTitle("Watched people"),
            labeledInput("Priority user IDs (checked at the priority interval)", focus, setFocus,
                "Paste Discord user IDs separated by commas or spaces"),
            labeledInput("Selected server IDs", guilds, setGuilds,
                "Members visible in these servers become related people"),
            labeledInput("Selected group-DM IDs", groups, setGroups,
                "Members of these group DMs become related people"),

            sectionTitle("Intervals"),
            labeledInput("Priority interval in hours", priorityHours, setPriorityHours, "2", "numeric"),
            labeledInput("Related interval in hours", relatedHours, setRelatedHours, "6", "numeric"),
            labeledInput("Maximum related profiles per cycle", batchLimit, setBatchLimit, "25", "numeric"),

            sectionTitle("Alerts and discovery"),
            toggleRow("Friend-list disappearance alerts", data.settings.friendAlerts, v => { data.settings.friendAlerts = v; rerender(); }),
            toggleRow("Server disappearance alerts", data.settings.serverAlerts, v => { data.settings.serverAlerts = v; rerender(); }),
            toggleRow("Group-DM disappearance alerts", data.settings.groupDmAlerts, v => { data.settings.groupDmAlerts = v; rerender(); }),
            toggleRow("Mutual relationship-change alerts", data.settings.mutualAlerts, v => { data.settings.mutualAlerts = v; rerender(); }),
            toggleRow("Startup confirmation", data.settings.startupMessage, v => { data.settings.startupMessage = v; rerender(); }),
            toggleRow("Discover members from selected servers", data.settings.includeSelectedGuildMembers, v => { data.settings.includeSelectedGuildMembers = v; rerender(); }),
            toggleRow("Discover members from selected group DMs", data.settings.includeSelectedGroupMembers, v => { data.settings.includeSelectedGroupMembers = v; rerender(); }),

            button("Save settings", save, busy),
            button("Run full scan now", () => doScan("full"), busy),
            button("Scan priority people now", () => doScan("priority"), busy),
            button("Scan related people now", () => doScan("related"), busy),
            button("Test notification", () => showAlert(NAME, "Notification test succeeded."), busy),

            sectionTitle("Status"),
            React.createElement(RN.Text, null,
                `Friends stored: ${Object.keys(data.friends || {}).length}\n` +
                `Servers stored: ${Object.keys(data.guilds || {}).length}\n` +
                `Group DMs stored: ${Object.keys(data.groupDms || {}).length}\n` +
                `Profiles stored: ${Object.keys(data.profiles || {}).length}\n` +
                `Graph edges stored: ${Object.keys(data.graph?.edges || {}).length}\n` +
                `Related people currently discoverable: ${getRelatedIds().length}\n\n` +
                `Last basic scan: ${formatTime(data.lastBasicScan)}\n` +
                `Last priority scan: ${formatTime(data.lastPriorityScan)}\n` +
                `Last related scan: ${formatTime(data.lastRelatedScan)}`),

            sectionTitle("Recent history"),
            recent.length
                ? recent.map(item => React.createElement(RN.View, {
                    key: item.id,
                    style: { paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: "#777" }
                },
                    React.createElement(RN.Text, { style: { fontWeight: "700" } },
                        `${item.type}: ${item.subjectName || item.subjectId}`),
                    React.createElement(RN.Text, null, item.detail),
                    React.createElement(RN.Text, { style: { opacity: 0.65, marginTop: 3 } },
                        formatTime(item.timestamp))
                ))
                : React.createElement(RN.Text, { style: { opacity: 0.7 } }, "No relationship changes recorded yet.")
        );
    }

    function start() {
        initializeStorage();
        const modules = resolveModules();
        plugin.settings = Settings;

        log("Full plugin started", { version: VERSION, modules });

        if (data.settings.startupMessage !== false) {
            showAlert(`${NAME} is running`,
                `Version ${VERSION}\n\n` +
                `Friend monitor: ${modules.friend ? "ready" : "missing"}\n` +
                `Server monitor: ${modules.server ? "ready" : "missing"}\n` +
                `Group DM monitor: ${modules.groupDm ? "ready" : "missing"}\n` +
                `Profile fetch: ${(modules.profileFetch || modules.rest) ? "ready" : "may be unavailable"}\n\n` +
                `Startup scans begin in 10 seconds.`);
        }

        subscribeEvents();
        scheduleScans();

        startupTimer = setTimeout(async () => {
            runBasicScan("fresh start");
            await runPriorityScan("fresh start priority");
            await runRelatedScan("fresh start related");
        }, STARTUP_DELAY);

        globalThis.RelationshipNotifierDebug = {
            version: VERSION,
            fullScan: () => runFullScan("debug"),
            basicScan: () => runBasicScan("debug"),
            priorityScan: () => runPriorityScan("debug"),
            relatedScan: () => runRelatedScan("debug"),
            fetchProfile,
            settings: () => data.settings,
            profiles: () => data.profiles,
            graph: () => data.graph,
            history: () => data.history,
            modules: () => resolveModules(),
            testNotification: () => showAlert(NAME, "Debug notification succeeded.")
        };
    }

    function stop() {
        stopped = true;
        if (startupTimer) clearTimeout(startupTimer);
        clearSchedules();
        unsubscribeEvents();
        for (const timer of pendingTimers.values()) clearTimeout(timer);
        pendingTimers.clear();
        try { delete globalThis.RelationshipNotifierDebug; } catch (_) {}
        log("Plugin unloaded");
    }

    plugin.onUnload = stop;

    try {
        start();
    } catch (e) {
        logError("Fatal startup error", e);
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
