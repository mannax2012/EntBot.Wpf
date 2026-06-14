const config = require('./config');
const { startEntBot, stopEntBot } = require('./services/entBot');

console.log(`[Startup] Starting ${config.appName}`);

const started = startEntBot();
if (!started) {
    process.exit(64);
}

if (process.stdin && !process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        const commands = String(chunk || '')
            .split(/\r?\n/g)
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean);

        for (const command of commands) {
            if (command !== 'shutdown' && command !== 'stop' && command !== 'exit') {
                continue;
            }

            console.log('[Startup] Shutdown requested by host process.');
            stopEntBot();
            process.exit(0);
        }
    });
}
