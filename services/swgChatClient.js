const dgram = require('dgram');
const SOEProtocol = require('./swgChatProtocol');

const KNOWN_COMMANDS = {
    invite: {
        commandCrc: 0x88505D58
    },
    planetsay: {
        commandCrc: 0xB43480A0
    },
    spatialchat: {
        commandCrc: 0xEE540CF7
    },
    startdance: {
        commandCrc: 0x7B1DCBE0
    },
    tellpet: {
        commandCrc: 0xBD7DF918
    },
    flourish: {
        commandCrc: 0xC8998CE9
    }
};

function createSwgChatClient() {
    let server = {};
    let verboseSWGLogging = false;
    let commandQueueCounter = 0x40000000;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let connectedSince = 0;
    let lastConnectedDurationMs = 0;
    let lastMessageTime = new Date();
    let socket = null;
    let loggedIn = false;
    let fails = 0;
    let disconnectCount = 0;
    let ackInterval = null;
    let pingInterval = null;
    let netStatusInterval = null;
    const discoveredObjects = new Map();
    const announcedControlDeviceIds = new Set();

    const client = {
        isConnected: false,
        paused: false,
        recvChat(message, player) {},
        serverDown() {},
        serverUp() {},
        reconnected() {},
        recvTell(from, message) {},
        controlDeviceDiscovered(device) {},
        discoveryDebug(message) {},
        login(cfg) {
            server = Object.assign({}, cfg);
            verboseSWGLogging = Boolean(server.verboseSWGLogging);
            SOEProtocol.setVerboseLogging(verboseSWGLogging);
            resetConnectionTracking();
            startBackgroundTimers();
            Login();
        },
        debug() {
            verboseSWGLogging = true;
            SOEProtocol.setVerboseLogging(true);
            SOEProtocol.debug();
            console.log(`${getFullTimestamp()} - [SWG Chat] Verbose logging enabled`);
        },
        setPaused(value) {
            client.paused = Boolean(value);
            return client.paused;
        },
        restart() {
            resetConnectionTracking();
            Login();
        },
        getState() {
            return {
                isConnected: client.isConnected,
                paused: client.paused,
                loginAddress: server.LoginAddress || '',
                loginPort: server.LoginPort || 0,
                character: server.Character || '',
                chatRoom: server.ChatRoom || '',
                roomId: server.ChatRoomID || 0,
                serverName: server.SWGServerName || server.ServerName || '',
                joinChatRoom: server.JoinChatRoom !== false
            };
        },
        getDiscoveredControlDevices() {
            return Array.from(discoveredObjects.values())
                .filter((record) => record.isControlDeviceCandidate)
                .map(toDiscoveredControlDeviceSummary);
        },
        sendChat(message, user) {
            if (!client.isConnected) return false;
            if (verboseSWGLogging) {
                console.log(`${getFullTimestamp()} - [SWG Chat] Sending room chat from ${user}`);
            }
            send('ChatSendToRoom', {
                Message: ` \\#ff3333${user}: \\#ff66ff${message}`,
                RoomID: server.ChatRoomID
            });
            return true;
        },
        sendTell(player, message) {
            if (!client.isConnected) return false;
            if (verboseSWGLogging && player !== server.Character) {
                console.log(`${getFullTimestamp()} - [SWG Chat] Sending tell to ${player}`);
            }
            send('ChatInstantMessageToCharacter', {
                ServerName: server.ServerName,
                PlayerName: player,
                Message: message
            });
            return true;
        },
        sendConsoleCommand(command) {
            if (!client.isConnected) return false;

            const normalizedCommand = String(command || '').trim();
            if (!normalizedCommand) return false;

            if (verboseSWGLogging) {
                console.log(`${getFullTimestamp()} - [SWG Chat] Sending console command: ${normalizedCommand}`);
            }

            send('ExecuteConsoleCommand', {Command: normalizedCommand});
            return true;
        },
        supportsGameCommand(command) {
            const normalizedInput = String(command || '').trim().replace(/^\//, '');
            if (!normalizedInput) return false;

            const firstSpaceIndex = normalizedInput.indexOf(' ');
            const commandName = (firstSpaceIndex === -1 ? normalizedInput : normalizedInput.slice(0, firstSpaceIndex))
                .trim()
                .toLowerCase();

            return Boolean(KNOWN_COMMANDS[commandName]);
        },
        sendGameCommand(command) {
            if (!client.isConnected) return false;

            const normalizedInput = String(command || '').trim().replace(/^\//, '');
            if (!normalizedInput) return false;

            const firstSpaceIndex = normalizedInput.indexOf(' ');
            const commandName = (firstSpaceIndex === -1 ? normalizedInput : normalizedInput.slice(0, firstSpaceIndex))
                .trim()
                .toLowerCase();
            const commandArguments = (firstSpaceIndex === -1 ? '' : normalizedInput.slice(firstSpaceIndex + 1)).trim();
            const knownCommand = KNOWN_COMMANDS[commandName];

            if (!knownCommand) {
                console.warn(`${getFullTimestamp()} - [SWG Chat] Unsupported game command: ${normalizedInput}`);
                return false;
            }

            if (!Buffer.isBuffer(server.CharacterID) || server.CharacterID.length !== 8) {
                console.warn(
                    `${getFullTimestamp()} - [SWG Chat] Cannot send game command before CharacterID is ready: ${normalizedInput}`
                );
                return false;
            }

            commandQueueCounter += 0x20;

            if (verboseSWGLogging) {
                console.log(
                    `${getFullTimestamp()} - [SWG Chat] Sending game command: ${commandName}`
                    + (commandArguments ? ` [${commandArguments}]` : '')
                    + ` [crc=0x${knownCommand.commandCrc.toString(16).toUpperCase()}]`
                );
            }

            send('CommandQueueEnqueue', {
                CharacterID: server.CharacterID,
                ActionCount: commandQueueCounter >>> 0,
                CommandCRC: knownCommand.commandCrc,
                TargetID: 0,
                Arguments: commandArguments
            });

            return true;
        },
        sendObjectMenuSelect({objectId, radialId = 0} = {}) {
            if (!client.isConnected) return false;

            let normalizedObjectId;
            try {
                if (objectId === undefined || objectId === null || objectId === '') {
                    return false;
                }

                normalizedObjectId = BigInt(objectId);
            } catch (error) {
                console.warn(`${getFullTimestamp()} - [SWG Chat] Invalid object menu objectId: ${objectId}`);
                return false;
            }

            const normalizedRadialId = Math.max(0, Math.min(255, Number(radialId || 0)));

            if (verboseSWGLogging) {
                console.log(
                    `${getFullTimestamp()} - [SWG Chat] Sending object menu select `
                    + `[objectId=${normalizedObjectId.toString()}] [radialId=${normalizedRadialId}]`
                );
            }

            send('ObjectMenuSelectMessage::MESSAGE_TYPE', {
                ObjectID: normalizedObjectId,
                RadialID: normalizedRadialId
            });
            return true;
        },
        destroy() {
            clearReconnectTimer();
            stopBackgroundTimers();
            client.isConnected = false;
            connectedSince = 0;
            safeCloseSocket();
        }
    };

    const handlePacket = {};
    handlePacket.Ack = function () {};
    handlePacket.SessionResponse = function () {
        if (!loggedIn) {
            send('LoginClientID', {Username: server.Username, Password: server.Password});
        } else {
            send('ClientIdMsg');
        }
    };
    handlePacket.LoginClientToken = function () {
        console.log(`${getFullTimestamp()} - [SWG Chat] Logged into login server`);
        loggedIn = true;
    };
    handlePacket.LoginEnumCluster = function (packet) {
        server.ServerNames = packet.Servers;
    };
    handlePacket.LoginClusterStatus = function (packet) {
        if (verboseSWGLogging) console.log(packet);
        server.Servers = packet.Servers;
    };
    handlePacket.EnumerateCharacterId = function (packet) {
        let character = packet.Characters[server.Character];
        if (!character) {
            for (const candidate in packet.Characters) {
                if (packet.Characters[candidate].Name.startsWith(server.Character)) {
                    character = packet.Characters[candidate];
                    break;
                }
            }
        }

        if (!character) {
            console.warn(`${getFullTimestamp()} - [SWG Chat] Character not found on account: ${server.Character}`);
            return;
        }

        const serverData = server.Servers[character.ServerID];
        if (!serverData) {
            console.warn(`${getFullTimestamp()} - [SWG Chat] Server data missing for character: ${server.Character}`);
            return;
        }

        server.Address = serverData.IPAddress;
        server.Port = serverData.Port;
        server.PingPort = serverData.PingPort;
        server.CharacterID = character.CharacterID;
        server.ServerName = server.ServerNames[character.ServerID].Name;
        send('SessionRequest');
    };
    handlePacket.ClientPermissions = function () {
        send('SelectCharacter', {CharacterID: server.CharacterID});
        setTimeout(() => {
            if (server.JoinChatRoom === false) {
                send('CmdSceneReady');
                setTimeout(() => {
                    markConnected(`Scene ready without chat room as ${server.Character}`);
                }, 1000);
                return;
            }

            send('ChatCreateRoom', {RoomPath: `SWG.${server.ServerName}.${server.ChatRoom}`});
            setTimeout(() => send('CmdSceneReady'), 1000);
        }, 1000);
    };
    handlePacket.ChatRoomList = function (packet) {
        if (verboseSWGLogging) console.log(JSON.stringify(packet, null, 2));
        for (const roomID in packet.Rooms) {
            const room = packet.Rooms[roomID];
            if (room.RoomPath.endsWith(server.ChatRoom)) {
                server.ChatRoomID = room.RoomID;
                send('ChatEnterRoomById', {RoomID: room.RoomID});
            }
        }
    };
    handlePacket.ChatOnEnteredRoom = function (packet) {
        if (verboseSWGLogging) console.log(JSON.stringify(packet, null, 2));
        if (packet.RoomID === server.ChatRoomID && packet.PlayerName === server.Character) {
            markConnected(`Joined room ${packet.RoomID} as ${packet.PlayerName}`);
        }
    };
    handlePacket.ChatRoomMessage = function (packet) {
        if (verboseSWGLogging) console.log(JSON.stringify(packet, null, 2));
        if (packet.RoomID === server.ChatRoomID && packet.CharacterName !== server.Character.toLowerCase()) {
            client.recvChat(packet.Message, packet.CharacterName);
        }
    };
    handlePacket.ChatInstantMessageToClient = function (packet) {
        client.recvTell(packet.PlayerName, packet.Message);
    };
    handlePacket.SceneCreateObjectByCrc = function (packet) {
        upsertDiscoveredObject(packet.ObjectID, {
            objectId: packet.ObjectID,
            objectCRC: packet.ObjectCRC,
            sceneCreateByteFlag: packet.ByteFlag
        });
        client.discoveryDebug({
            type: 'sceneCreate',
            objectId: packet.ObjectID,
            objectCRC: packet.ObjectCRC,
            sceneCreateByteFlag: packet.ByteFlag
        });
    };
    handlePacket.BaselinesMessage = function (packet) {
        const patch = {
            objectId: packet.ObjectID,
            objectType: packet.ObjectType,
            baselineViews: {
                [packet.ViewType]: packet.ParsedBaseline || true
            }
        };

        if (packet.ObjectType === 'ITNO' && packet.ViewType === 3 && packet.ParsedBaseline) {
            patch.stfFile = packet.ParsedBaseline.stfFile;
            patch.stfName = packet.ParsedBaseline.stfName;
            patch.customName = packet.ParsedBaseline.customName;
        }

        if (Array.isArray(packet.PayloadHints) && packet.PayloadHints.length > 0) {
            patch.payloadHints = packet.PayloadHints;
        }

        upsertDiscoveredObject(packet.ObjectID, patch);
        client.discoveryDebug({
            type: 'baseline',
            objectId: packet.ObjectID,
            objectType: packet.ObjectType,
            viewType: packet.ViewType,
            dataSize: packet.DataSize,
            stfFile: patch.stfFile || '',
            stfName: patch.stfName || '',
            customName: patch.customName || '',
            hints: patch.payloadHints || []
        });
    };
    handlePacket.UpdateContainmentMessage = function (packet) {
        upsertDiscoveredObject(packet.ObjectID, {
            objectId: packet.ObjectID,
            parentId: packet.ParentID,
            arrangementId: packet.ArrangementID
        });
        client.discoveryDebug({
            type: 'containment',
            objectId: packet.ObjectID,
            parentId: packet.ParentID,
            arrangementId: packet.ArrangementID
        });
    };
    handlePacket.SceneDestroyObject = function (packet) {
        discoveredObjects.delete(packet.ObjectID);
        announcedControlDeviceIds.delete(packet.ObjectID);
    };
    handlePacket.ChatOnLeaveRoom = function (packet) {
        if (packet.RoomID === server.ChatRoomID && packet.PlayerName === server.Character) {
            console.log(
                `${getFullTimestamp()} - [SWG Chat] Left room ${packet.RoomID} as ${packet.PlayerName} `
                + `[error=${packet.Error}]`
            );
        }
    };
    handlePacket.Disconnect = function (packet) {
        console.warn(
            `${getFullTimestamp()} - [SWG Chat] Disconnect received [connectionId=${packet.connectionID}] `
            + `[reason=${packet.reasonID}] [count=${disconnectCount}]`
        );
        disconnectCount += 1;
        scheduleReconnect(`server disconnect reason=${packet.reasonID}`);
    };

    function resetConnectionTracking() {
        commandQueueCounter = 0x40000000;
        reconnectAttempt = 0;
        lastConnectedDurationMs = 0;
        lastMessageTime = new Date();
        fails = 0;
        disconnectCount = 0;
        discoveredObjects.clear();
        announcedControlDeviceIds.clear();
    }

    function startBackgroundTimers() {
        if (!ackInterval) {
            ackInterval = setInterval(() => {
                if (client.paused) return;
                send('Ack');

                const connectionTimeoutMs = Math.max(1000, Number(server.connectionTimeoutMs || 10000));
                const failureThreshold = Math.max(1, Number(server.failureThreshold || 3));
                if (new Date() - lastMessageTime > connectionTimeoutMs) {
                    fails += 1;
                    client.isConnected = false;
                    connectedSince = 0;
                    if (fails === failureThreshold) client.serverDown();
                    lastMessageTime = new Date();
                    scheduleReconnect('connection timeout');
                }
            }, 100);
        }

        if (!pingInterval) {
            pingInterval = setInterval(() => {
                if (!server.PingPort || !client.isConnected || !socket) return;
                const buf = Buffer.alloc(4);
                const tick = new Date().getTime() & 0xFFFF;
                buf.writeUInt16BE(tick, 0);
                buf.writeUInt16BE(0x7701, 2);
                socket.send(buf, server.PingPort, server.Address);
            }, 1000);
        }

        if (!netStatusInterval) {
            netStatusInterval = setInterval(() => {
                if (!client.isConnected) return;
                send('ClientNetStatusRequest');
            }, 15000);
        }
    }

    function stopBackgroundTimers() {
        if (ackInterval) {
            clearInterval(ackInterval);
            ackInterval = null;
        }

        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        if (netStatusInterval) {
            clearInterval(netStatusInterval);
            netStatusInterval = null;
        }
    }

    function handleMessage(msg, info) {
        lastMessageTime = new Date();
        if (info.port === server.PingPort) return;

        let packets;
        let header = 0;
        try {
            header = msg.readUInt16BE(0);
            packets = SOEProtocol.Decode(msg);
            if (!Array.isArray(packets)) {
                packets = [packets];
            }
        } catch (error) {
            console.error(
                `${getFullTimestamp()} - [SWG Chat] Decode failed for header 0x${header.toString(16).toUpperCase().padStart(4, '0')}: `
                + error.toString()
            );
            scheduleReconnect('decode failure');
            return;
        }

        processPackets(packets);
    }

    function processPackets(packets) {
        if (!Array.isArray(packets)) {
            return;
        }

        for (const packet of packets) {
            processPacketEntry(packet);
        }
    }

    function processPacketEntry(packet) {
        if (Array.isArray(packet)) {
            for (const nestedPacket of packet) {
                processPacketEntry(nestedPacket);
            }
            return;
        }

        if (!packet || !packet.type) {
            return;
        }

        if (verboseSWGLogging) {
            console.log(`${getFullTimestamp()} - recv: ${packet.type}`);
        }

        if (handlePacket[packet.type]) {
            handlePacket[packet.type](packet);
        }
    }

    function markConnected(detail) {
        clearReconnectTimer();

        const stableResetMs = Math.max(0, Number(server.reconnectStableResetMs || 300000));
        if (lastConnectedDurationMs === 0 || stableResetMs === 0 || lastConnectedDurationMs >= stableResetMs) {
            reconnectAttempt = 0;
        }
        lastConnectedDurationMs = 0;

        if (!client.isConnected) {
            client.isConnected = true;
            connectedSince = Date.now();
            if (detail) {
                console.log(`${getFullTimestamp()} - [SWG Chat] ${detail}`);
            }
            client.reconnected();
        }

        const failureThreshold = Math.max(1, Number(server.failureThreshold || 3));
        if (fails >= failureThreshold) client.serverUp();
        fails = 0;
    }

    function Login() {
        clearReconnectTimer();
        loggedIn = false;
        client.isConnected = false;
        connectedSince = 0;
        safeCloseSocket();

        if (!server.LoginAddress || !server.LoginPort) {
            console.warn(`${getFullTimestamp()} - [SWG Chat] Login settings are incomplete.`);
            return;
        }

        server.Address = server.LoginAddress;
        server.Port = server.LoginPort;
        server.PingPort = undefined;

        socket = dgram.createSocket('udp4');
        socket.on('message', handleMessage);
        socket.on('error', (error) => {
            console.error(`${getFullTimestamp()} - [SWG Chat] Socket error: ${error.message}`);
            scheduleReconnect('socket error');
        });

        send('SessionRequest');
    }

    function clearReconnectTimer() {
        if (!reconnectTimer) {
            return;
        }

        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    function scheduleReconnect(reason) {
        if (reconnectTimer) {
            return false;
        }

        client.isConnected = false;
        lastConnectedDurationMs = connectedSince ? (Date.now() - connectedSince) : 0;
        connectedSince = 0;
        safeCloseSocket();

        const baseDelayMs = Math.max(1000, Number(server.reconnectBaseDelayMs || 5000));
        const maxDelayMs = Math.max(baseDelayMs, Number(server.reconnectMaxDelayMs || 60000));
        const jitterMs = Math.max(0, Number(server.reconnectJitterMs || 1500));
        const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, reconnectAttempt));
        const randomizedJitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
        const delayMs = exponentialDelay + randomizedJitter;

        reconnectAttempt += 1;

        console.warn(
            `${getFullTimestamp()} - [SWG Chat] Scheduling reconnect in ${delayMs}ms`
            + (reason ? ` [reason=${reason}]` : '')
            + ` [attempt=${reconnectAttempt}]`
        );

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            lastMessageTime = new Date();
            Login();
        }, delayMs);

        return true;
    }

    function safeCloseSocket() {
        if (!socket) {
            return;
        }

        try {
            socket.removeAllListeners('message');
            socket.removeAllListeners('error');
            socket.close();
        } catch (error) {
            // ignore socket cleanup failures
        }

        socket = null;
    }

    function send(type, data) {
        if (!socket) {
            return;
        }

        const buf = SOEProtocol.Encode(type, data);
        if (!buf) {
            return;
        }

        if (verboseSWGLogging) {
            console.log(`${getFullTimestamp()} - send: ${type}`);
        }

        if (Array.isArray(buf)) {
            for (const packet of buf) {
                socket.send(packet, server.Port, server.Address);
            }
            return;
        }

        socket.send(buf, server.Port, server.Address);
    }

    function upsertDiscoveredObject(objectId, patch) {
        if (!objectId) {
            return;
        }

        const existing = discoveredObjects.get(objectId) || {
            objectId,
            baselineViews: {}
        };

        const merged = {
            ...existing,
            ...patch,
            baselineViews: {
                ...(existing.baselineViews || {}),
                ...((patch && patch.baselineViews) || {})
            }
        };

        merged.isControlDeviceCandidate = isControlDeviceCandidate(merged);
        discoveredObjects.set(objectId, merged);

        if (merged.isControlDeviceCandidate && !announcedControlDeviceIds.has(objectId)) {
            announcedControlDeviceIds.add(objectId);
            client.controlDeviceDiscovered(toDiscoveredControlDeviceSummary(merged));
        }
    }

    function isControlDeviceCandidate(record) {
        if (!record) {
            return false;
        }

        const searchText = getDiscoverySearchText(record);
        const parentRecord = record.parentId ? discoveredObjects.get(record.parentId) : null;
        const parentSearchText = getDiscoverySearchText(parentRecord);
        const isDatapadChild = Boolean(parentRecord) && /\bdatapad\b/.test(parentSearchText);
        const hasCreatureHint = /(?:^|\s|\|)(?:mob\/)?creature_names(?:\s|\||$)/.test(searchText);
        const looksLikePetDevice = /(?:^|[_\s-])pcd(?:$|[_\s-])|pet|droid|control\s*device|helper|astromech|at_st/.test(searchText);

        if (record.objectType === 'ONTI') {
            return looksLikePetDevice || (isDatapadChild && hasCreatureHint);
        }

        return isDatapadChild && looksLikePetDevice;
    }

    function toDiscoveredControlDeviceSummary(record) {
        const parentRecord = record.parentId ? discoveredObjects.get(record.parentId) : null;
        return {
            objectId: record.objectId,
            objectType: record.objectType || '',
            objectCRC: record.objectCRC,
            stfFile: record.stfFile || '',
            stfName: record.stfName || '',
            customName: record.customName || '',
            label: getDiscoveredObjectLabel(record),
            payloadHints: Array.isArray(record.payloadHints) ? record.payloadHints : [],
            parentId: record.parentId || '',
            parentObjectType: parentRecord && parentRecord.objectType ? parentRecord.objectType : '',
            parentLabel: parentRecord ? getDiscoveredObjectLabel(parentRecord) : '',
            arrangementId: record.arrangementId
        };
    }

    function getDiscoverySearchText(record) {
        if (!record) {
            return '';
        }

        return [
            record.objectType,
            record.stfFile,
            record.stfName,
            record.customName,
            ...(Array.isArray(record.payloadHints) ? record.payloadHints : [])
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
    }

    function getDiscoveredObjectLabel(record) {
        if (!record) {
            return '';
        }

        const customName = String(record.customName || '').trim();
        if (customName && !isGenericDiscoveryLabel(customName)) {
            return customName;
        }

        const preferredHint = getPreferredPayloadHint(record.payloadHints);

        const stfName = String(record.stfName || '').trim();
        if (stfName && !isGenericDiscoveryLabel(stfName)) {
            return stfName;
        }

        const stfFile = String(record.stfFile || '').trim();
        if (stfFile && !isGenericDiscoveryLabel(stfFile)) {
            return stfFile;
        }

        if (preferredHint) {
            return preferredHint;
        }

        if (customName) {
            return customName;
        }

        if (stfName) {
            return stfName;
        }

        if (stfFile) {
            return stfFile;
        }

        return '';
    }

    function isGenericDiscoveryLabel(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
            return true;
        }

        return GENERIC_DISCOVERY_LABELS.has(normalized);
    }

    function getPreferredPayloadHint(hints) {
        if (!Array.isArray(hints) || hints.length === 0) {
            return '';
        }

        for (const hint of hints) {
            const normalizedHint = String(hint || '').trim();
            if (!normalizedHint) {
                continue;
            }

            const lowerHint = normalizedHint.toLowerCase();
            if (GENERIC_DISCOVERY_LABELS.has(lowerHint)) {
                continue;
            }

            if (/[a-z]/i.test(normalizedHint)) {
                return normalizedHint;
            }
        }

        return String(hints[0] || '').trim();
    }

    return client;
}

const GENERIC_DISCOVERY_LABELS = new Set([
    'commoner',
    'control_device',
    'creature_names',
    'datapad',
    'inventory',
    'item_d',
    'item_n',
    'mob/creature_names',
    'obj_n',
    'pet_control_device',
    'wearables_name'
]);

function getFullTimestamp() {
    const date = new Date();
    const year = `${date.getFullYear()}`.padStart(4, '0');
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    const hours = `${date.getHours()}`.padStart(2, '0');
    const minutes = `${date.getMinutes()}`.padStart(2, '0');
    const seconds = `${date.getSeconds()}`.padStart(2, '0');
    const millisecs = `${date.getMilliseconds()}`.padStart(3, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millisecs}`;
}

module.exports = {
    createSwgChatClient
};
