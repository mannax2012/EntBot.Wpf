const config = require('../config');
const { createSwgChatClient } = require('./swgChatClient');

let runners = [];
let started = false;

function getSettings() {
    return config.entBot || {};
}

function getEntertainers(settings) {
    if (Array.isArray(settings.entertainers) && settings.entertainers.length > 0) {
        return settings.entertainers;
    }

    return [settings];
}

function getMissingSettings(settings) {
    const missing = [];

    if (!settings.loginAddress) missing.push('loginAddress');
    if (!settings.loginPort) missing.push('loginPort');
    if (!settings.username) missing.push('username');
    if (!settings.password) missing.push('password');
    if (!settings.character) missing.push('character');

    return missing;
}

function getRunnerLabel(settings, index) {
    const name = String(settings.character || '').trim() || `entertainer-${index + 1}`;
    return `[${config.appName}:${name}]`;
}

function summarizeCommands(settings) {
    const commands = [];

    if (Array.isArray(settings.performanceCommands)) {
        for (const command of settings.performanceCommands) {
            const normalized = String(command || '').trim();
            if (normalized) {
                commands.push(normalized);
            }
        }
    }

    const flourishCommand = String(settings.flourishCommand || '').trim();
    if (flourishCommand) {
        commands.push(flourishCommand);
    }

    return commands;
}

function summarizeStartupCommands(settings) {
    if (!Array.isArray(settings.startupCommands)) {
        return [];
    }

    return settings.startupCommands
        .map((command) => String(command || '').trim())
        .filter(Boolean);
}

function isUiActionCommand(command) {
    return /^\/?ui\s+action\b/i.test(String(command || '').trim());
}

function wait(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function executeBotCommand(client, command) {
    const normalized = String(command || '').trim();
    if (!normalized) {
        return false;
    }

    if (client.supportsGameCommand(normalized) && client.sendGameCommand(normalized)) {
        return true;
    }

    return client.sendConsoleCommand(normalized);
}

function createRunner(settings, index) {
    const swgChatClient = createSwgChatClient();
    const label = getRunnerLabel(settings, index);
    const performanceCommands = summarizeCommands(settings);
    const startupCommands = summarizeStartupCommands(settings);
    const petAutoCallEnabled = Boolean(settings.petAutoCallEnabled);
    const petAutoGroupEnabled = Boolean(settings.petAutoGroupEnabled);
    const petAutoGroupCommand = String(settings.petAutoGroupCommand || '').trim();
    const petDiscoveryEnabled = settings.petDiscoveryEnabled !== false;
    const petDiscoveryDebug = Boolean(settings.petDiscoveryDebug);
    const petControlDeviceIds = Array.isArray(settings.petControlDeviceIds) ? settings.petControlDeviceIds : [];
    const petCallRadialId = Math.max(0, Math.min(255, Number(settings.petCallRadialId || 44)));
    const petCallPauseMs = Math.max(0, Number(settings.petCallPauseMs || 3000));
    const petAutoGroupDelayMs = Math.max(0, Number(settings.petAutoGroupDelayMs || petCallPauseMs || 3000));
    const startupCommandPauseMs = Math.max(0, Number(settings.startupCommandPauseMs || 3000));
    const connectionRefreshIntervalMs = Math.max(0, Number(settings.connectionRefreshIntervalMs || 0));
    let startupTimer = null;
    let performanceTimer = null;
    let advertTimer = null;
    let connectionRefreshTimer = null;
    let runnerStarted = false;
    let startupSequenceId = 0;

    function cancelStartupSequence() {
        startupSequenceId += 1;
    }

    function clearPerformanceLoop() {
        if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
        }

        if (performanceTimer) {
            clearInterval(performanceTimer);
            performanceTimer = null;
        }
    }

    function clearAdvertLoop() {
        if (!advertTimer) {
            return;
        }

        clearInterval(advertTimer);
        advertTimer = null;
    }

    function clearConnectionRefreshTimer() {
        if (!connectionRefreshTimer) {
            return;
        }

        clearTimeout(connectionRefreshTimer);
        connectionRefreshTimer = null;
    }

    function startConnectionRefreshTimer() {
        clearConnectionRefreshTimer();

        if (connectionRefreshIntervalMs <= 0) {
            return;
        }

        connectionRefreshTimer = setTimeout(() => {
            connectionRefreshTimer = null;

            if (!runnerStarted || !swgChatClient.getState().isConnected) {
                console.log(`${label} Scheduled connection refresh skipped because the client is not connected.`);
                return;
            }

            console.log(
                `${label} Refreshing SWG connection `
                + `[intervalMinutes=${settings.connectionRefreshIntervalMinutes || 0}]`
            );
            cancelStartupSequence();
            clearPerformanceLoop();
            clearAdvertLoop();
            swgChatClient.restart();
        }, connectionRefreshIntervalMs);
    }

    function sendPerformanceCommands() {
        let sentAny = false;

        for (const command of performanceCommands) {
            sentAny = executeBotCommand(swgChatClient, command) || sentAny;
        }

        return sentAny;
    }

    async function sendPerformanceResetCommands(sequenceId) {
        const resetCommands = ['/stopdance', '/stopmusic'];
        let sentAny = false;

        for (let idx = 0; idx < resetCommands.length; idx += 1) {
            if (sequenceId !== startupSequenceId) {
                return sentAny;
            }

            sentAny = executeBotCommand(swgChatClient, resetCommands[idx]) || sentAny;

            if (idx < resetCommands.length - 1) {
                await wait(500);
            }
        }

        return sentAny;
    }

    async function sendStartupCommands(sequenceId) {
        let sentAny = false;

        for (let index = 0; index < startupCommands.length; index += 1) {
            if (sequenceId !== startupSequenceId) {
                return sentAny;
            }

            const command = startupCommands[index];
            if (isUiActionCommand(command)) {
                console.warn(
                    `${label} Skipping unsupported client UI command in startupCommands: ${command}`
                );
                continue;
            }

            sentAny = executeBotCommand(swgChatClient, command) || sentAny;

            if (index < startupCommands.length - 1 && startupCommandPauseMs > 0) {
                await wait(startupCommandPauseMs);
            }
        }

        return sentAny;
    }

    async function sendPetControlDeviceCalls(sequenceId) {
        let sentAny = false;

        for (let index = 0; index < petControlDeviceIds.length; index += 1) {
            if (sequenceId !== startupSequenceId) {
                return sentAny;
            }

            const sent = swgChatClient.sendObjectMenuSelect({
                objectId: petControlDeviceIds[index],
                radialId: petCallRadialId
            });
            sentAny = sent || sentAny;

            if (index < petControlDeviceIds.length - 1 && petCallPauseMs > 0) {
                await wait(petCallPauseMs);
            }
        }

        return sentAny;
    }

    async function runStartupSequence(sequenceId) {
        console.log(`${label} Resetting active performance state [commands=/stopdance | /stopmusic]`);
        await sendPerformanceResetCommands(sequenceId);

        if (sequenceId !== startupSequenceId) {
            return;
        }

        if (petDiscoveryEnabled) {
            const discoveredDevices = swgChatClient.getDiscoveredControlDevices();
            if (discoveredDevices.length > 0) {
                console.log(
                    `${label} Discovered control device candidates `
                    + `[devices=${discoveredDevices
                        .map((device) => `${device.objectId}:${device.label || device.stfFile || 'unknown'}`)
                        .join(' | ')}]`
                );
            } else {
                console.log(`${label} No control device candidates discovered yet.`);
            }
        }

        if (petControlDeviceIds.length > 0 && !petAutoCallEnabled) {
            console.log(
                `${label} Pet control device IDs configured but pet auto-call is disabled `
                + `[count=${petControlDeviceIds.length}]`
            );
        }

        if (petAutoCallEnabled) {
            if (petControlDeviceIds.length === 0) {
                console.warn(`${label} Pet auto-call skipped because no pet control device IDs are configured.`);
            } else {
                console.log(
                    `${label} Pet auto-call sequence started [count=${petControlDeviceIds.length}] `
                    + `[radialId=${petCallRadialId}] [pauseMs=${petCallPauseMs}]`
                );
                await sendPetControlDeviceCalls(sequenceId);
            }
        }

        if (sequenceId !== startupSequenceId) {
            return;
        }

        if (petAutoGroupEnabled) {
            if (!petAutoCallEnabled || petControlDeviceIds.length === 0) {
                console.warn(
                    `${label} Pet auto-group skipped because no pets were auto-called in this startup sequence.`
                );
            } else if (!petAutoGroupCommand) {
                console.warn(`${label} Pet auto-group skipped because no pet auto-group command is configured.`);
            } else {
                console.log(
                    `${label} Pet auto-group scheduled [command=${petAutoGroupCommand}] `
                    + `[delayMs=${petAutoGroupDelayMs}]`
                );

                if (petAutoGroupDelayMs > 0) {
                    await wait(petAutoGroupDelayMs);
                }

                if (sequenceId !== startupSequenceId) {
                    return;
                }

                executeBotCommand(swgChatClient, petAutoGroupCommand);
            }
        }

        if (startupCommands.length > 0) {
            console.log(
                `${label} Startup command sequence started [commands=${startupCommands.join(' | ')}] `
                + `[pauseMs=${startupCommandPauseMs}]`
            );
            await sendStartupCommands(sequenceId);
        }

        if (sequenceId !== startupSequenceId) {
            return;
        }

        if (performanceCommands.length > 0) {
            console.log(
                `${label} Performance loop started [type=${settings.performanceType}] `
                + `[commands=${performanceCommands.join(' | ')}] `
                + `[intervalMs=${settings.intervalMs || 3000}]`
            );

            if (settings.announceCommands) {
                swgChatClient.sendTell(
                    settings.character,
                    `[${config.appName}] started ${performanceCommands.join(' + ')} every ${settings.intervalMs || 3000}ms`
                );
            }

            sendPerformanceCommands();
            startPerformanceLoop();
        }

        if (sequenceId !== startupSequenceId) {
            return;
        }

        if (settings.advertsEnabled && settings.advertMessage && settings.advertChannels.length > 0) {
            console.log(
                `${label} Advert loop started [channels=${settings.advertChannels.join(',')}] `
                + `[intervalMs=${settings.advertIntervalMs || 120000}]`
            );
            sendAdvertMessage();
            startAdvertLoop();
        }
    }

    function startPerformanceLoop() {
        if (performanceTimer) {
            clearInterval(performanceTimer);
            performanceTimer = null;
        }

        if (performanceCommands.length === 0) {
            return;
        }

        const intervalMs = Math.max(1000, Number(settings.intervalMs || 3000));
        performanceTimer = setInterval(() => {
            sendPerformanceCommands();
        }, intervalMs);
    }

    function sendAdvertMessage() {
        const channels = Array.isArray(settings.advertChannels) ? settings.advertChannels : [];
        const message = String(settings.advertMessage || '').trim();

        if (!settings.advertsEnabled || channels.length === 0 || !message) {
            return false;
        }

        let sentAny = false;
        for (const channel of channels) {
            sentAny = executeBotCommand(swgChatClient, `/${channel} ${message}`) || sentAny;
        }

        return sentAny;
    }

    function startAdvertLoop() {
        clearAdvertLoop();

        const channels = Array.isArray(settings.advertChannels) ? settings.advertChannels : [];
        const message = String(settings.advertMessage || '').trim();

        if (!settings.advertsEnabled || channels.length === 0 || !message) {
            return;
        }

        const intervalMs = Math.max(120000, Number(settings.advertIntervalMs || 120000));
        advertTimer = setInterval(() => {
            sendAdvertMessage();
        }, intervalMs);
    }

    function attachCallbacks() {
        swgChatClient.controlDeviceDiscovered = function (device) {
            if (!petDiscoveryEnabled || !device) {
                return;
            }

            const name = device.label || device.stfFile || 'unknown';

            console.log(
                `${label} Discovered control device candidate [id=${device.objectId}] `
                + `[name=${name}]`
                + (device.parentLabel ? ` [parent=${device.parentLabel}]` : '')
                + (device.parentId ? ` [parentId=${device.parentId}]` : '')
            );
        };

        swgChatClient.discoveryDebug = function (event) {
            if (!petDiscoveryDebug || !event) {
                return;
            }

            if (event.type === 'sceneCreate') {
                console.log(
                    `${label} Discovery sceneCreate [objectId=${event.objectId}] `
                    + `[objectCRC=${event.objectCRC}] [byteFlag=${event.sceneCreateByteFlag}]`
                );
            }

            if (event.type === 'baseline') {
                console.log(
                    `${label} Discovery baseline [objectId=${event.objectId}] [objectType=${event.objectType}] `
                    + `[viewType=${event.viewType}] [dataSize=${event.dataSize}]`
                    + (event.stfFile ? ` [stfFile=${event.stfFile}]` : '')
                    + (event.stfName ? ` [stfName=${event.stfName}]` : '')
                    + (event.customName ? ` [customName=${event.customName}]` : '')
                    + (event.hints && event.hints.length > 0 ? ` [hints=${event.hints.join(' | ')}]` : '')
                );
            }

            if (event.type === 'containment') {
                console.log(
                    `${label} Discovery containment [objectId=${event.objectId}] `
                    + `[parentId=${event.parentId}] [arrangementId=${event.arrangementId}]`
                );
            }
        };

        swgChatClient.recvTell = function (from) {
            const sender = String(from || '').trim();
            const character = String(settings.character || '').trim();

            if (!settings.autoInviteOnTell || !sender) {
                return;
            }

            if (sender.toLowerCase() === character.toLowerCase()) {
                return;
            }

            console.log(`${label} Auto-invite requested from tell [from=${sender}]`);
            executeBotCommand(swgChatClient, `/invite ${sender}`);
        };

        swgChatClient.serverDown = function () {
            console.warn(`${label} Lost contact with the SWG server.`);
        };

        swgChatClient.serverUp = function () {
            console.log(`${label} SWG server connection recovered.`);
        };

        swgChatClient.reconnected = function () {
            const state = swgChatClient.getState();
            cancelStartupSequence();
            clearPerformanceLoop();
            clearAdvertLoop();
            startConnectionRefreshTimer();

            console.log(`${label} Connected [character=${state.character}]`);

            startupTimer = setTimeout(() => {
                startupTimer = null;
                startupSequenceId += 1;
                void runStartupSequence(startupSequenceId);
            }, Math.max(0, Number(settings.startupDelayMs || 2500)));
        };
    }

    return {
        label,
        start() {
            if (runnerStarted) {
                return true;
            }

            const missing = getMissingSettings(settings);
            if (missing.length > 0) {
                console.warn(`${label} Missing settings: ${missing.join(', ')}`);
                return false;
            }

            attachCallbacks();

            swgChatClient.login({
                LoginAddress: settings.loginAddress,
                LoginPort: settings.loginPort,
                Username: settings.username,
                Password: settings.password,
                Character: settings.character,
                JoinChatRoom: false,
                verboseSWGLogging: settings.verboseSwgLogging,
                connectionTimeoutMs: settings.connectionTimeoutMs,
                failureThreshold: settings.failureThreshold,
                reconnectBaseDelayMs: settings.reconnectBaseDelayMs,
                reconnectMaxDelayMs: settings.reconnectMaxDelayMs,
                reconnectJitterMs: settings.reconnectJitterMs,
                reconnectStableResetMs: settings.reconnectStableResetMs
            });

            runnerStarted = true;
            console.log(
                `${label} Starting [type=${settings.performanceType}] [intervalMs=${settings.intervalMs || 3000}] `
                + `[performanceCommands=${performanceCommands.join(' | ') || 'none'}] `
                + `[startupCommands=${startupCommands.join(' | ') || 'none'}] `
                + `[petDiscovery=${petDiscoveryEnabled}] `
                + `[petDiscoveryDebug=${petDiscoveryDebug}] `
                + `[petAutoCall=${petAutoCallEnabled}] `
                + `[petAutoGroup=${petAutoGroupEnabled}] `
                + `[petControlDeviceIds=${petControlDeviceIds.join(' | ') || 'none'}] `
                + `[petCallRadialId=${petCallRadialId}]`
            );
            return true;
        },
        stop() {
            cancelStartupSequence();
            clearPerformanceLoop();
            clearAdvertLoop();
            clearConnectionRefreshTimer();
            swgChatClient.destroy();
            runnerStarted = false;
        }
    };
}

function startEntBot() {
    if (started) {
        return true;
    }

    const settings = getSettings();
    const entertainers = getEntertainers(settings);

    if (entertainers.length === 0) {
        console.warn(`[${config.appName}] No entertainers configured.`);
        return false;
    }

    runners = entertainers.map((entertainer, index) => createRunner(entertainer, index));

    let startedCount = 0;
    for (const runner of runners) {
        startedCount += runner.start() ? 1 : 0;
    }

    if (startedCount === 0) {
        runners = [];
        return false;
    }

    started = true;
    console.log(
        `[${config.appName}] Active entertainers: ${startedCount}/${entertainers.length}`
        + (settings.bandEnabled ? ' [band mode]' : '')
    );
    return true;
}

function stopEntBot() {
    for (const runner of runners) {
        runner.stop();
    }

    runners = [];
    started = false;
}

process.on('SIGINT', () => {
    stopEntBot();
    process.exit(0);
});

process.on('SIGTERM', () => {
    stopEntBot();
    process.exit(0);
});

module.exports = {
    startEntBot,
    stopEntBot
};
