import { createWriteStream, appendFileSync, readFileSync } from 'fs';
import { logger } from './logger.js';
import { loadConfig, loadSelectors } from './config.js';
import { CDPBridge } from './cdp-bridge.js';
import { DOMExtractor } from './dom-extractor.js';
import { CommandExecutor } from './command-executor.js';
import { StateManager } from './state-manager.js';
import { CapabilityStateManager } from './capability-state-manager.js';
import { TargetUiCoordinator } from './target-ui-coordinator.js';
import { probePassiveCapabilities, mergePassiveCapabilityObservation } from './passive-capability-probe.js';
import { probeInteractiveModeAndModel } from './interactive-capability-probe.js';
import { ActionRegistry, classifyObservedToolType, isExecutableActionType } from './action-registry.js';
import { AdapterStore } from './adapter-store.js';
import { RuntimeSelectorProvider, endpointFingerprint, probeDomSignature } from './runtime-selector-provider.js';
import { validateSelectorRuntime } from './runtime-validator.js';
import { CapabilityCircuitBreaker } from './capability-circuit-breaker.js';
import { WindowMonitor } from './window-monitor.js';
import { Relay } from './relay.js';
import type { Transport } from './transports/types.js';
import type { ToolCapability } from './types.js';
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
  const builtinSelectors = loadSelectors(config);

  logger.info('config', 'Server configuration', {
    cdpUrl: config.cdpUrl,
    serverHost: config.serverHost,
    serverPort: config.serverPort,
    pollIntervalMs: config.pollIntervalMs,
    debounceMs: config.debounceMs,
    telegramEnabled: config.telegram.enabled,
  });

  const stateManager = new StateManager(config.debounceMs);
  const capabilityStateManager = new CapabilityStateManager();
  const targetUiCoordinator = new TargetUiCoordinator();
  const cdpBridge = new CDPBridge(config);
  const adapterStore = new AdapterStore(config.adapterStorePath, { backupCount: config.adapterBackupCount });
  const adapterData = await adapterStore.load();
  const runtimeSelectors = new RuntimeSelectorProvider(builtinSelectors, adapterData);
  const selectors = runtimeSelectors.selectors;
  const commandExecutor = new CommandExecutor(selectors);
  commandExecutor.setUiCoordinator(
    targetUiCoordinator,
    () => cdpBridge.activeTargetId,
    () => cdpBridge.getTargetGeneration(),
  );
  commandExecutor.setCapabilityGuard({
    getSnapshot: (targetId) => capabilityStateManager.getSnapshot(targetId),
    getActiveTargetId: () => cdpBridge.activeTargetId,
    getTargetGeneration: (targetId) => cdpBridge.getTargetGeneration(targetId),
  });

  const actionRegistry = new ActionRegistry({ ttlMs: config.actionTtlMs });
  commandExecutor.setActionRegistry(actionRegistry);
  let lastActionTargetId = '';
  let lastToolAdapterId = '';

  const extractor = new DOMExtractor(
    selectors,
    (state, errorMessage) => {
      if (state) {
        const targetId = cdpBridge.activeTargetId;
        const generation = targetId ? cdpBridge.getTargetGeneration(targetId) : 0;
        const toolAdapter = runtimeSelectors.getUsage().tool;
        const adapterId = toolAdapter.source === 'adapter' ? toolAdapter.adapterId : 'builtin';
        if (lastActionTargetId && targetId && lastActionTargetId !== targetId) {
          actionRegistry.invalidateTarget(lastActionTargetId);
        }
        if (targetId) lastActionTargetId = targetId;
        if (lastToolAdapterId && lastToolAdapterId !== adapterId) {
          actionRegistry.invalidateAdapter(lastToolAdapterId);
        }
        lastToolAdapterId = adapterId;
        const register = (toolCallId: string, action: { label: string; type: string; selectorPath: string; actionId?: string }) => {
          if (!targetId || !generation || !state.activeComposerId || !action.selectorPath) return;
          try {
            const publicAction = actionRegistry.registerObserved({
              windowId: targetId,
              targetId,
              targetGeneration: generation,
              composerId: state.activeComposerId,
              toolCallId,
              adapterId,
              actionType: action.type,
              expectedLabel: action.label,
              selectorStrategyId: 'dom-observed',
              selectorPath: action.selectorPath,
            });
            action.actionId = publicAction.actionId;
          } catch (err) { logger.warn('action_registration_failed', 'Ignored unsafe observed action', { message: err instanceof Error ? err.message : String(err) }); }
        };
        for (const approval of state.pendingApprovals) for (const action of approval.actions) register(approval.id, action);
        for (const message of state.messages) {
          if ((message.type === 'tool' || message.type === 'run_command') && message.actions) {
            const recognizedToolType = classifyObservedToolType(message);
            if (recognizedToolType) {
              for (const action of message.actions) register(message.toolCallId, action);
            }
          }
          if (message.type === 'plan' && message.actions) {
            for (const action of message.actions) {
              const registered: { label: string; type: string; selectorPath: string; actionId?: string } = action;
              register(`plan:${message.id}`, registered);
              action.actionId = registered.actionId;
            }
          }
          if (message.type === 'plan' && message.modelDropdownSelectorPath) {
            const modelAction: { label: string; type: string; selectorPath: string; actionId?: string } = {
              label: 'Plan model', type: 'plan_model', selectorPath: message.modelDropdownSelectorPath,
            };
            register(`plan-model:${message.id}`, modelAction);
            message.modelActionId = modelAction.actionId;
          }
        }
        if (state.questionnaire) {
          for (const question of state.questionnaire.questions) for (const option of question.options) {
            const action: { label: string; type: string; selectorPath: string; actionId?: string } = { label: option.label, type: 'questionnaire_option', selectorPath: option.selectorPath };
            register(`questionnaire:${question.number}:${option.letter}`, action);
            option.actionId = action.actionId;
          }
          if (state.questionnaire.skipSelectorPath) { const action: { label: string; type: string; selectorPath: string; actionId?: string }={label:'Skip',type:'skip',selectorPath:state.questionnaire.skipSelectorPath}; register('questionnaire:skip',action); state.questionnaire.skipActionId=action.actionId; }
          if (state.questionnaire.continueSelectorPath) { const action: { label: string; type: string; selectorPath: string; actionId?: string }={label:'Continue',type:'continue',selectorPath:state.questionnaire.continueSelectorPath}; register('questionnaire:continue',action); state.questionnaire.continueActionId=action.actionId; }
        }
        const observedTools: ToolCapability[] = [];
        for (const message of state.messages) {
          if ((message.type !== 'tool' && message.type !== 'run_command') || !message.toolCallId) continue;
          const actions = (message.actions ?? []).map((action) => action.actionId ? actionRegistry.public(action.actionId) : null).filter((action): action is NonNullable<ReturnType<typeof actionRegistry.public>> => !!action);
          const recognizedToolType = classifyObservedToolType(message);
          const toolType = recognizedToolType ?? 'generic_tool';
          const executable = recognizedToolType !== null && actions.some((action) => action.executable && isExecutableActionType(action.kind));
          observedTools.push({ id:message.toolCallId, type:toolType, source:'data_attribute', executable, actions });
        }
        const activeTarget = targetId && generation ? capabilityStateManager.getSnapshot(targetId) : null;
        if (activeTarget && observedTools.length > 0) capabilityStateManager.applyObserved({ targetId, targetGeneration:generation, tools:observedTools, state:'ok' });
        // CapabilityStateManager is the sole owner of dynamic Mode/Model data.
        // The legacy extractor may still return stale compatibility fields, so
        // project the verified snapshot immediately before publishing state.
        const projection = capabilityStateManager.projectModeModel(targetId);
        state.mode = projection.mode;
        state.model = projection.model;
        stateManager.onExtraction(state);
      } else stateManager.onExtractionFailure(errorMessage ?? 'Extraction failed');
    },
    () => cdpBridge.windows.find(w => w.id === cdpBridge.activeTargetId)?.title ?? ''
  );

  const windowMonitor = new WindowMonitor(cdpBridge, stateManager, extractor, config, selectors);
  windowMonitor.setSelectorResolver(async (client, targetId) => {
    const identity = cdpBridge.getEndpointIdentity();
    if (!identity?.verified) return builtinSelectors;
    const domSignature = await probeDomSignature(client);
    return runtimeSelectors.resolveForContext({
      endpointFingerprint: endpointFingerprint(identity),
      cursorBuild: identity.product,
      domSignature,
      targetId,
      targetGeneration: 0,
      observedAt: Date.now(),
    });
  });
  windowMonitor.setCapabilityProjector((targetId) => capabilityStateManager.projectModeModel(targetId));
  let capabilityProbeTimer: ReturnType<typeof setInterval> | null = null;

  const probeCapabilities = async (): Promise<void> => {
    const client = cdpBridge.getClient();
    const targetId = cdpBridge.activeTargetId;
    const generation = targetId ? cdpBridge.getTargetGeneration(targetId) : 0;
    if (!client || !targetId || !generation) return;
    const adapterCircuitKey = () => {
      const runtimeContext = runtimeSelectors.getContext();
      const usage = runtimeSelectors.getUsage();
      return {
        cursorBuild: runtimeContext?.cursorBuild ?? '',
        domSignature: runtimeContext?.domSignature ?? '',
        capabilityKind: 'mode-model-tool',
        adapterId: [usage.mode.adapterId, usage.model.adapterId, usage.tool.adapterId].filter(Boolean).join(',') || 'builtin',
      };
    };
    try {
      const observed = await targetUiCoordinator.enqueue(
        targetId,
        ({ signal }) => {
          if (signal.aborted) throw new Error('Passive capability probe cancelled');
          return probePassiveCapabilities(
            client,
            selectors.modeDropdown?.strategies ?? [],
            selectors.modelDropdown?.strategies ?? [],
          );
        },
        { generation, timeoutMs: 5_000, label: 'probe:capabilities' },
      );
      if (targetId !== cdpBridge.activeTargetId || generation !== cdpBridge.getTargetGeneration(targetId)) return;
      const circuitKey = adapterCircuitKey();
      if (capabilityCircuitBreaker.isOpen(circuitKey)) {
        capabilityStateManager.applyObserved({ targetId, targetGeneration:generation, state:'unavailable', completeness:'unknown', confidence:0 });
        return;
      }
      capabilityCircuitBreaker.record(circuitKey, true);
      const merged = mergePassiveCapabilityObservation(
        capabilityStateManager.getSnapshot(targetId),
        observed,
      );
      capabilityStateManager.applyObserved({
        targetId,
        targetGeneration: generation,
        modes: merged.modes,
        models: merged.models,
        tools: merged.tools,
        state: observed.composerReady ? 'ok' : 'unknown',
        completeness: merged.completeness,
        confidence: observed.composerReady ? 0.8 : 0,
        adapterBindings: runtimeSelectors.getAdapterBindings(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const circuitKey = adapterCircuitKey();
      const circuit = capabilityCircuitBreaker.record(circuitKey, false);
      logger.warn('capability_probe_failed', 'Passive capability probe failed', { message });
      if (targetId === cdpBridge.activeTargetId && generation === cdpBridge.getTargetGeneration(targetId)) {
        capabilityStateManager.applyObserved({
          targetId,
          targetGeneration: generation,
          state: circuit.open ? 'unavailable' : 'degraded',
          completeness: 'unknown',
          confidence: 0,
        });
      }
    }
  };

  cdpBridge.on('connected', () => {
    void (async () => {
      const client = cdpBridge.getClient();
      const targetId = cdpBridge.activeTargetId;
      const generation = targetId ? cdpBridge.getTargetGeneration(targetId) : 0;
      stateManager.onConnectionChanged(true);
      stateManager.updateWindows(cdpBridge.windows, targetId);
      if (!client || !targetId || !generation || !cdpBridge.isEndpointVerified()) {
        commandExecutor.setClient(null);
        runtimeSelectors.clearActiveContext();
        return;
      }
      actionRegistry.invalidateGeneration(targetId, generation);
      if (lastActionTargetId && lastActionTargetId !== targetId) {
        actionRegistry.invalidateTarget(lastActionTargetId);
      }
      lastActionTargetId = targetId;
      capabilityStateManager.setActiveTarget(targetId, generation);
      targetUiCoordinator.setGeneration(targetId, generation);
      try {
        const identity = cdpBridge.getEndpointIdentity();
        if (!identity?.verified) throw new Error('Cursor endpoint identity unavailable');
        const context = {
          endpointFingerprint: endpointFingerprint(identity),
          cursorBuild: identity.product,
          domSignature: await probeDomSignature(client),
          targetId,
          targetGeneration: generation,
          observedAt: Date.now(),
        };
        if (targetId !== cdpBridge.activeTargetId || generation !== cdpBridge.getTargetGeneration(targetId)) return;
        runtimeSelectors.setActiveContext(context);
        const toolAdapter = runtimeSelectors.getUsage().tool;
        const adapterId = toolAdapter.source === 'adapter' ? toolAdapter.adapterId : 'builtin';
        if (lastToolAdapterId && lastToolAdapterId !== adapterId) {
          actionRegistry.invalidateAdapter(lastToolAdapterId);
        }
        lastToolAdapterId = adapterId;
        commandExecutor.setClient(client);
        extractor.start(client, config.pollIntervalMs);
        void probeCapabilities();
        if (!capabilityProbeTimer) {
          capabilityProbeTimer = setInterval(() => void probeCapabilities(), Math.max(config.pollIntervalMs * 10, 5_000));
        }
      } catch (err) {
        runtimeSelectors.clearActiveContext();
        commandExecutor.setClient(null);
        capabilityStateManager.applyObserved({
          targetId,
          targetGeneration: generation,
          state: 'unavailable',
          completeness: 'unknown',
          confidence: 0,
        });
        logger.error('adapter_context_failed', 'Failed to establish runtime adapter context', err instanceof Error ? err : { error: String(err) });
      }
    })();
  });

  cdpBridge.on('disconnected', () => {
    stateManager.onConnectionChanged(false);
    commandExecutor.setClient(null);
    runtimeSelectors.clearActiveContext();
    extractor.stop();
    if (capabilityProbeTimer) {
      clearInterval(capabilityProbeTimer);
      capabilityProbeTimer = null;
    }
    capabilityStateManager.markStale();
    actionRegistry.clear();
    lastActionTargetId = '';
    lastToolAdapterId = '';
    targetUiCoordinator.cancelAll('cancelled');
  });

  cdpBridge.on('error', (err: Error) => {
    logger.error('cdp_error', 'CDP connection error', err);
  });

  const transports: Transport[] = [];

  const capabilityCircuitBreaker = new CapabilityCircuitBreaker({ minSamples: 3, failureRatio: .66 });
  const relay = new Relay(config, stateManager, commandExecutor, cdpBridge, windowMonitor, capabilityStateManager, actionRegistry, adapterStore, targetUiCoordinator, runtimeSelectors);
  relay.setDiscoveryRunner(async () => {
    const client = cdpBridge.getClient();
    const targetId = cdpBridge.activeTargetId;
    const generation = targetId ? cdpBridge.getTargetGeneration(targetId) : 0;
    if (!client || !targetId || !generation) throw new Error('No verified Cursor target');
    return targetUiCoordinator.enqueue(targetId, async () => {
      const discovered = await probeInteractiveModeAndModel(client, {
        modeSelectors: selectors.modeDropdown?.strategies ?? [],
        modelSelectors: selectors.modelDropdown?.strategies ?? [],
      });
      if (targetId !== cdpBridge.activeTargetId || generation !== cdpBridge.getTargetGeneration(targetId)) throw new Error('Target generation changed');
      const snapshot = capabilityStateManager.applyObserved({ targetId, targetGeneration:generation, modes:discovered.modes, models:discovered.models, tools:discovered.tools, state:'ok', completeness:discovered.models.completeness, confidence:.9, adapterBindings:runtimeSelectors.getAdapterBindings() });
      const context = runtimeSelectors.getContext();
      if (snapshot && context && context.targetId === targetId && context.targetGeneration === generation) {
        const kinds = ['mode', ...(discovered.models.items.length ? ['model'] : [])] as Array<'mode'|'model'>;
        const candidates: Record<'mode'|'model', string[]> = {
          mode: ['.composer-unified-dropdown[data-mode]', '[data-mode-id]'],
          model: ['.vscode-model-picker__trigger', '.ui-model-picker__trigger', '[data-model]', '[data-model-id]'],
        };
        for (const kind of kinds) {
          const verifiedSelectors: string[] = [];
          for (const selector of candidates[kind]) {
            const checked = await validateSelectorRuntime(client, selector);
            if (checked.ok) verifiedSelectors.push(selector);
          }
          if (verifiedSelectors.length === 0) continue;
          const pending = await adapterStore.savePending({
            id: `candidate-${context.cursorBuild.replace(/[^A-Za-z0-9.-]/g, '-')}-${context.domSignature}-${kind}`,
            cursorVersionRange: context.cursorBuild,
            endpointFingerprint: context.endpointFingerprint,
            domSignature: context.domSignature,
            capabilityKinds: [kind],
            strategies: kind === 'mode'
              ? { modeDropdown: verifiedSelectors.map((selector, index) => ({ id:`mode-${index}`, kind:'observed', selector, scope:'composer', operationClass:'interactive_read' as const })) }
              : { modelDropdown: verifiedSelectors.map((selector, index) => ({ id:`model-${index}`, kind:'observed', selector, scope:'composer', operationClass:'interactive_read' as const })) },
            evidence: [{ source:'interactive_probe', summary:`${kind} selector uniquely visible at capability revision ${snapshot.revision}`, confidence:1 }],
          });
          if (pending.status === 'pending_confirmation') relay.notifyAdapterPending(pending);
        }
      }
      return snapshot;
    }, { generation, timeoutMs:20_000, label:'probe:interactive-capabilities' });
  });
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
