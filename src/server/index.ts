import { createWriteStream, appendFileSync, readFileSync } from 'fs';
import { logger } from './logger.js';
import { loadConfig, loadSelectors } from './config.js';
import { CDPBridge } from './cdp-bridge.js';
import { DOMExtractor } from './dom-extractor.js';
import { CommandExecutor } from './command-executor.js';
import { StateManager } from './state-manager.js';
import { WindowMonitor } from './window-monitor.js';
import { Relay } from './relay.js';
import type { Transport } from './transports/types.js';
import { TelegramTransport } from './transports/telegram/index.js';
import { RawTelegramTransport } from './transports/telegram-raw/index.js';

// Legacy log file stream (still write to temp/server.log for compatibility)
const logStream = createWriteStream('./temp/server.log', { flags: 'a' });

// Patch console.* to use structured logger
logger.patchConsole();

process.on('uncaughtException', (err) => {
  logger.error('crash', 'Uncaught exception', err);
  try {
    appendFileSync('./temp/server.log', `${new Date().toISOString()} [CRASH] ${err.message}\n${err.stack ?? ''}\n`);
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(1), 100);
});

async function main(): Promise<void> {
  let version = 'unknown';
  for (const rel of ['../../package.json', '../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));
      if (pkg.name === 'cursor-remote') { version = pkg.version; break; }
    } catch { /* try next */ }
  }
  logger.info('startup', `CursorRemote v${version}`, { version });

  const config = loadConfig();
  const selectors = loadSelectors(config);

  logger.info('config', 'Server configuration', {
    cdpUrl: config.cdpUrl,
    serverHost: config.serverHost,
    serverPort: config.serverPort,
    pollIntervalMs: config.pollIntervalMs,
    debounceMs: config.debounceMs,
    telegramEnabled: config.telegram.enabled,
  });

  const stateManager = new StateManager(config.debounceMs);
  const commandExecutor = new CommandExecutor(selectors);

  const cdpBridge = new CDPBridge(config);

  const extractor = new DOMExtractor(
    selectors,
    (state, errorMessage) => {
      if (state) stateManager.onExtraction(state);
      else stateManager.onExtractionFailure(errorMessage ?? 'Extraction failed');
    },
    () => cdpBridge.windows.find(w => w.id === cdpBridge.activeTargetId)?.title ?? ''
  );

  const windowMonitor = new WindowMonitor(cdpBridge, stateManager, extractor, config, selectors);

  cdpBridge.on('connected', () => {
    const client = cdpBridge.getClient();
    stateManager.onConnectionChanged(true);
    stateManager.updateWindows(cdpBridge.windows, cdpBridge.activeTargetId);
    commandExecutor.setClient(client);
    if (client) {
      extractor.start(client, config.pollIntervalMs);
    }
  });

  cdpBridge.on('disconnected', () => {
    stateManager.onConnectionChanged(false);
    commandExecutor.setClient(null);
    extractor.stop();
  });

  cdpBridge.on('error', (err: Error) => {
    logger.error('cdp_error', 'CDP connection error', err);
  });

  const transports: Transport[] = [];

  const relay = new Relay(config, stateManager, commandExecutor, cdpBridge, windowMonitor);
  await relay.start();

  logger.info('cdp_connect', 'Connecting to Cursor IDE...', { url: config.cdpUrl });
  await cdpBridge.connect();

  if (config.telegram.enabled && config.telegram.botToken) {
    const TgTransport = config.telegram.impl === 'raw' ? RawTelegramTransport : TelegramTransport;
    if (config.telegram.impl === 'raw') {
      logger.info('telegram_impl', 'Using raw Bot API transport (no Grammy)');
    }
    const telegram = new TgTransport(
      config.telegram,
      windowMonitor,
      stateManager,
      commandExecutor,
      cdpBridge
    );

    const names = telegram.registeredUserNames;
    if (names.length > 0) {
      logger.info('telegram_users', `Registered user(s): ${names.join(', ')}`, { users: names });
      logger.info('telegram_register', `To register a different user: /register ${telegram.registerToken}`);
    } else {
      logger.info('telegram_register', `To register, send in your Telegram group: /register ${telegram.registerToken}`);
    }

    telegram.start().catch(err => {
      logger.error('telegram_start_fail', 'Failed to start Telegram transport', err);
    });
    transports.push(telegram);
  }

  windowMonitor.start();

  const shutdown = async () => {
    logger.info('shutdown', 'Shutting down...');
    windowMonitor.stop();
    extractor.stop();
    for (const transport of transports) {
      await transport.stop();
    }
    await cdpBridge.disconnect();
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', 'Unhandled rejection', { reason: String(reason) });
    try {
      appendFileSync('./temp/server.log', `${new Date().toISOString()} [ERROR] Unhandled rejection: ${String(reason)}\n`);
    } catch {
      /* ignore */
    }
  });
}

main().catch((err) => {
  logger.error('main_fatal', 'Fatal error in main', err);
  try {
    appendFileSync('./temp/server.log', `${new Date().toISOString()} [FATAL] ${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? err.stack ?? '' : ''}\n`);
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(1), 100);
});
