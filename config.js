const fs = require('fs');
const path = require('path');

loadEnvironmentFile();

function loadEnvironmentFile() {
    try {
        // Prefer dotenv when it is installed for local Node-only workflows.
        require('dotenv').config();
        return;
    } catch (error) {
        if (error && error.code !== 'MODULE_NOT_FOUND') {
            console.warn(`[config] Failed to initialize dotenv: ${error.message}`);
            return;
        }
    }

    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
        return;
    }

    try {
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex <= 0) {
                continue;
            }

            const key = trimmed.slice(0, separatorIndex).trim();
            if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
                continue;
            }

            let value = trimmed.slice(separatorIndex + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            process.env[key] = value;
        }
    } catch (error) {
        console.warn(`[config] Failed to load .env file: ${error.message}`);
    }
}

function hasOwn(object, propertyName) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, propertyName);
}

function tryParseJson(raw, label, fallback = null) {
    if (raw === undefined || raw === null || raw === '') {
        return fallback;
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`[config] Failed to parse ${label} as JSON: ${error.message}`);
        return fallback;
    }
}

function resolveSettingsFilePath() {
    const explicitPath = process.env.ENT_BOT_SETTINGS_FILE;
    if (explicitPath) {
        return path.isAbsolute(explicitPath)
            ? explicitPath
            : path.resolve(process.cwd(), explicitPath);
    }

    const defaultPath = path.resolve(process.cwd(), 'settings.json');
    return fs.existsSync(defaultPath) ? defaultPath : '';
}

function loadExternalSettings() {
    const settingsFilePath = resolveSettingsFilePath();
    if (!settingsFilePath) {
        return {};
    }

    try {
        const raw = fs.readFileSync(settingsFilePath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = tryParseJson(raw, settingsFilePath, {});
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.warn(`[config] Ignoring invalid settings file root: ${settingsFilePath}`);
            return {};
        }

        return parsed;
    } catch (error) {
        console.warn(`[config] Failed to load settings file ${settingsFilePath}: ${error.message}`);
        return {};
    }
}

const externalSettings = loadExternalSettings();
const externalEntBotSettings = externalSettings && typeof externalSettings.entBot === 'object' && !Array.isArray(externalSettings.entBot)
    ? externalSettings.entBot
    : {};

function readSetting(source, key, envName, envParser = (value) => value) {
    if (hasOwn(source, key)) {
        return source[key];
    }

    const raw = process.env[envName];
    if (typeof raw === 'string' && raw !== '') {
        return envParser(raw);
    }

    return undefined;
}

function env(name, fallback = '') {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') {
        return value;
    }

    return fallback;
}

function envInt(name, fallback = 0) {
    const raw = env(name, '');
    if (raw === '') {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(name, fallback = false) {
    const raw = String(env(name, fallback ? 'true' : 'false')).trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function envJson(name, fallback = null) {
    const raw = env(name, '');
    if (raw === '') {
        return fallback;
    }

    return tryParseJson(raw, name, fallback);
}

function normalizeString(value, fallback = '') {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value);
}

function normalizeInt(value, fallback = 0) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const raw = String(value).trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function normalizeStringArray(value, fallback = []) {
    const resolved = value === undefined || value === null || value === ''
        ? fallback
        : value;

    if (Array.isArray(resolved)) {
        return resolved
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }

    return String(resolved || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function normalizeUnsignedId(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        return BigInt(value).toString();
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return null;
    }

    if (/^\d+$/.test(normalized) || /^0x[0-9a-f]+$/i.test(normalized)) {
        try {
            return BigInt(normalized).toString();
        } catch (error) {
            return null;
        }
    }

    return null;
}

function normalizeUnsignedIdArray(value, fallback = []) {
    const resolved = value === undefined || value === null || value === ''
        ? fallback
        : value;

    const entries = Array.isArray(resolved)
        ? resolved
        : String(resolved || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

    const uniqueIds = [];
    for (const entry of entries) {
        const objectId = normalizeUnsignedId(entry);
        if (objectId === null || uniqueIds.includes(objectId)) {
            continue;
        }

        uniqueIds.push(objectId);
    }

    return uniqueIds;
}

function normalizeByte(value, fallback = 0) {
    const parsed = normalizeInt(value, fallback);
    if (parsed < 0) {
        return fallback;
    }

    if (parsed > 255) {
        return 255;
    }

    return parsed;
}

function normalizeCommandList(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }

    const command = String(value || '').trim();
    return command ? [command] : [];
}

function resolvePerformanceCommands(settings) {
    const explicitList = normalizeCommandList(settings.performanceCommands);
    if (explicitList.length > 0) {
        return explicitList;
    }

    const explicitCommand = String(settings.performanceCommand || '').trim();
    if (explicitCommand) {
        return [explicitCommand];
    }

    const performanceType = String(settings.performanceType || 'dance').trim().toLowerCase();
    if (performanceType === 'music') {
        const musicCommand = String(settings.musicCommand || '/startmusic').trim();
        return musicCommand ? [musicCommand] : [];
    }

    const danceCommand = String(settings.danceCommand || '/startdance').trim();
    return danceCommand ? [danceCommand] : [];
}

function resolveStartupCommands(settings) {
    return normalizeCommandList(settings.startupCommands);
}

function buildEntertainerSettings(baseSettings, overrides = {}) {
    const merged = {
        ...baseSettings,
        ...(overrides && typeof overrides === 'object' ? overrides : {})
    };

    const settings = {
        loginAddress: normalizeString(merged.loginAddress, baseSettings.loginAddress),
        loginPort: normalizeInt(merged.loginPort, baseSettings.loginPort),
        username: normalizeString(merged.username, ''),
        password: normalizeString(merged.password, ''),
        character: normalizeString(merged.character, ''),
        performanceType: normalizeString(merged.performanceType, 'dance').trim().toLowerCase() || 'dance',
        performanceCommand: normalizeString(merged.performanceCommand, ''),
        performanceCommands: normalizeCommandList(merged.performanceCommands),
        startupCommands: normalizeCommandList(merged.startupCommands),
        petAutoCallEnabled: normalizeBool(merged.petAutoCallEnabled, false),
        petAutoGroupEnabled: normalizeBool(merged.petAutoGroupEnabled, false),
        petAutoGroupCommand: normalizeString(merged.petAutoGroupCommand, '/tellpet group'),
        petDiscoveryEnabled: normalizeBool(merged.petDiscoveryEnabled, true),
        petDiscoveryDebug: normalizeBool(merged.petDiscoveryDebug, false),
        petControlDeviceIds: normalizeUnsignedIdArray(merged.petControlDeviceIds, baseSettings.petControlDeviceIds),
        petCallRadialId: normalizeByte(merged.petCallRadialId, 44),
        petCallPauseMs: Math.max(0, normalizeInt(merged.petCallPauseMs, 3000)),
        danceCommand: normalizeString(merged.danceCommand, '/startdance'),
        musicCommand: normalizeString(merged.musicCommand, '/startmusic'),
        flourishCommand: normalizeString(merged.flourishCommand, ''),
        startupCommandPauseMs: Math.max(0, normalizeInt(merged.startupCommandPauseMs, 3000)),
        startupDelayMs: normalizeInt(merged.startupDelayMs, 2500),
        intervalMs: normalizeInt(merged.intervalMs, 3000),
        announceCommands: normalizeBool(merged.announceCommands, true),
        autoInviteOnTell: normalizeBool(merged.autoInviteOnTell, false),
        advertsEnabled: normalizeBool(merged.advertsEnabled, false),
        advertIntervalMs: normalizeInt(merged.advertIntervalMs, 120000),
        advertChannels: normalizeStringArray(merged.advertChannels, ['spatialChat', 'planetSay']),
        advertMessage: normalizeString(
            merged.advertMessage,
            'Buff service available in Mos Eisley Cantina. Come get your entertainer buffs.'
        ),
        connectionRefreshIntervalMinutes: Math.max(
            0,
            normalizeInt(merged.connectionRefreshIntervalMinutes, baseSettings.connectionRefreshIntervalMinutes)
        ),
        connectionTimeoutMs: normalizeInt(merged.connectionTimeoutMs, 10000),
        failureThreshold: normalizeInt(merged.failureThreshold, 3),
        reconnectBaseDelayMs: normalizeInt(merged.reconnectBaseDelayMs, 5000),
        reconnectMaxDelayMs: normalizeInt(merged.reconnectMaxDelayMs, 60000),
        reconnectJitterMs: normalizeInt(merged.reconnectJitterMs, 1500),
        reconnectStableResetMs: normalizeInt(merged.reconnectStableResetMs, 300000),
        verboseSwgLogging: normalizeBool(merged.verboseSwgLogging, false)
    };

    settings.performanceCommands = resolvePerformanceCommands(settings);
    settings.startupCommands = resolveStartupCommands(settings);
    settings.connectionRefreshIntervalMs = settings.connectionRefreshIntervalMinutes > 0
        ? settings.connectionRefreshIntervalMinutes * 60 * 1000
        : 0;
    settings.petAutoGroupDelayMs = Math.max(
        0,
        normalizeInt(merged.petAutoGroupDelayMs, settings.petCallPauseMs)
    );
    return settings;
}

const baseEntBotSettings = {
    loginAddress: normalizeString(
        readSetting(externalEntBotSettings, 'loginAddress', 'ENT_BOT_LOGIN_ADDRESS'),
        'login.swg-starforge.com'
    ),
    loginPort: normalizeInt(
        readSetting(externalEntBotSettings, 'loginPort', 'ENT_BOT_LOGIN_PORT'),
        44553
    ),
    username: normalizeString(
        readSetting(externalEntBotSettings, 'username', 'ENT_BOT_USERNAME'),
        ''
    ),
    password: normalizeString(
        readSetting(externalEntBotSettings, 'password', 'ENT_BOT_PASSWORD'),
        ''
    ),
    character: normalizeString(
        readSetting(externalEntBotSettings, 'character', 'ENT_BOT_CHARACTER'),
        ''
    ),
    performanceType: normalizeString(
        readSetting(externalEntBotSettings, 'performanceType', 'ENT_BOT_PERFORMANCE_TYPE'),
        'dance'
    ),
    performanceCommand: normalizeString(
        readSetting(externalEntBotSettings, 'performanceCommand', 'ENT_BOT_PERFORMANCE_COMMAND'),
        ''
    ),
    performanceCommands: normalizeCommandList(
        readSetting(
            externalEntBotSettings,
            'performanceCommands',
            'ENT_BOT_PERFORMANCE_COMMANDS',
            (value) => tryParseJson(value, 'ENT_BOT_PERFORMANCE_COMMANDS', [])
        )
    ),
    startupCommands: normalizeCommandList(
        readSetting(
            externalEntBotSettings,
            'startupCommands',
            'ENT_BOT_STARTUP_COMMANDS',
            (value) => tryParseJson(value, 'ENT_BOT_STARTUP_COMMANDS', [])
        )
    ),
    petAutoCallEnabled: normalizeBool(
        readSetting(externalEntBotSettings, 'petAutoCallEnabled', 'ENT_BOT_PET_AUTO_CALL_ENABLED'),
        false
    ),
    petAutoGroupEnabled: normalizeBool(
        readSetting(externalEntBotSettings, 'petAutoGroupEnabled', 'ENT_BOT_PET_AUTO_GROUP_ENABLED'),
        false
    ),
    petAutoGroupCommand: normalizeString(
        readSetting(externalEntBotSettings, 'petAutoGroupCommand', 'ENT_BOT_PET_AUTO_GROUP_COMMAND'),
        '/tellpet group'
    ),
    petDiscoveryEnabled: normalizeBool(
        readSetting(externalEntBotSettings, 'petDiscoveryEnabled', 'ENT_BOT_PET_DISCOVERY_ENABLED'),
        true
    ),
    petDiscoveryDebug: normalizeBool(
        readSetting(externalEntBotSettings, 'petDiscoveryDebug', 'ENT_BOT_PET_DISCOVERY_DEBUG'),
        false
    ),
    petControlDeviceIds: normalizeUnsignedIdArray(
        readSetting(externalEntBotSettings, 'petControlDeviceIds', 'ENT_BOT_PET_CONTROL_DEVICE_IDS'),
        []
    ),
    petCallRadialId: normalizeByte(
        readSetting(externalEntBotSettings, 'petCallRadialId', 'ENT_BOT_PET_CALL_RADIAL_ID'),
        44
    ),
    petCallPauseMs: normalizeInt(
        readSetting(externalEntBotSettings, 'petCallPauseMs', 'ENT_BOT_PET_CALL_PAUSE_MS'),
        3000
    ),
    petAutoGroupDelayMs: normalizeInt(
        readSetting(externalEntBotSettings, 'petAutoGroupDelayMs', 'ENT_BOT_PET_AUTO_GROUP_DELAY_MS'),
        3000
    ),
    danceCommand: normalizeString(
        readSetting(externalEntBotSettings, 'danceCommand', 'ENT_BOT_DANCE_COMMAND'),
        '/startdance'
    ),
    musicCommand: normalizeString(
        readSetting(externalEntBotSettings, 'musicCommand', 'ENT_BOT_MUSIC_COMMAND'),
        '/startmusic'
    ),
    flourishCommand: normalizeString(
        readSetting(externalEntBotSettings, 'flourishCommand', 'ENT_BOT_FLOURISH_COMMAND'),
        '/flourish'
    ),
    startupCommandPauseMs: normalizeInt(
        readSetting(externalEntBotSettings, 'startupCommandPauseMs', 'ENT_BOT_STARTUP_COMMAND_PAUSE_MS'),
        3000
    ),
    startupDelayMs: normalizeInt(
        readSetting(externalEntBotSettings, 'startupDelayMs', 'ENT_BOT_STARTUP_DELAY_MS'),
        2500
    ),
    intervalMs: normalizeInt(
        readSetting(externalEntBotSettings, 'intervalMs', 'ENT_BOT_INTERVAL_MS'),
        3000
    ),
    announceCommands: normalizeBool(
        readSetting(externalEntBotSettings, 'announceCommands', 'ENT_BOT_ANNOUNCE_COMMANDS'),
        true
    ),
    autoInviteOnTell: normalizeBool(
        readSetting(externalEntBotSettings, 'autoInviteOnTell', 'ENT_BOT_AUTO_INVITE_ON_TELL'),
        false
    ),
    advertsEnabled: normalizeBool(
        readSetting(externalEntBotSettings, 'advertsEnabled', 'ENT_BOT_ADVERTS_ENABLED'),
        false
    ),
    advertIntervalMs: normalizeInt(
        readSetting(externalEntBotSettings, 'advertIntervalMs', 'ENT_BOT_ADVERT_INTERVAL_MS'),
        120000
    ),
    advertChannels: normalizeStringArray(
        readSetting(externalEntBotSettings, 'advertChannels', 'ENT_BOT_ADVERT_CHANNELS'),
        ['spatialChat', 'planetSay']
    ),
    advertMessage: normalizeString(
        readSetting(externalEntBotSettings, 'advertMessage', 'ENT_BOT_ADVERT_MESSAGE'),
        'Buff service available in Mos Eisley Cantina. Come get your entertainer buffs.'
    ),
    connectionRefreshIntervalMinutes: Math.max(
        0,
        normalizeInt(
            readSetting(
                externalEntBotSettings,
                'connectionRefreshIntervalMinutes',
                'ENT_BOT_CONNECTION_REFRESH_INTERVAL_MINUTES'
            ),
            30
        )
    ),
    connectionTimeoutMs: normalizeInt(
        readSetting(externalEntBotSettings, 'connectionTimeoutMs', 'ENT_BOT_CONNECTION_TIMEOUT_MS'),
        10000
    ),
    failureThreshold: normalizeInt(
        readSetting(externalEntBotSettings, 'failureThreshold', 'ENT_BOT_FAILURE_THRESHOLD'),
        3
    ),
    reconnectBaseDelayMs: normalizeInt(
        readSetting(externalEntBotSettings, 'reconnectBaseDelayMs', 'ENT_BOT_RECONNECT_BASE_DELAY_MS'),
        5000
    ),
    reconnectMaxDelayMs: normalizeInt(
        readSetting(externalEntBotSettings, 'reconnectMaxDelayMs', 'ENT_BOT_RECONNECT_MAX_DELAY_MS'),
        60000
    ),
    reconnectJitterMs: normalizeInt(
        readSetting(externalEntBotSettings, 'reconnectJitterMs', 'ENT_BOT_RECONNECT_JITTER_MS'),
        1500
    ),
    reconnectStableResetMs: normalizeInt(
        readSetting(externalEntBotSettings, 'reconnectStableResetMs', 'ENT_BOT_RECONNECT_STABLE_RESET_MS'),
        300000
    ),
    verboseSwgLogging: normalizeBool(
        readSetting(externalEntBotSettings, 'verboseSwgLogging', 'ENT_BOT_VERBOSE_SWG_LOGGING'),
        false
    )
};

const configuredEntertainers = hasOwn(externalEntBotSettings, 'entertainers')
    ? externalEntBotSettings.entertainers
    : envJson('ENT_BOT_ENTERTAINERS', []);
const entertainers = Array.isArray(configuredEntertainers) && configuredEntertainers.length > 0
    ? configuredEntertainers.map((entertainer) => buildEntertainerSettings(baseEntBotSettings, entertainer))
    : [buildEntertainerSettings(baseEntBotSettings)];

module.exports = {
    appName: 'EntBot',
    entBot: {
        ...baseEntBotSettings,
        entertainers,
        bandEnabled: entertainers.length > 1
    }
};
