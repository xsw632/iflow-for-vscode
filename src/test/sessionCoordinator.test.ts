import * as assert from 'assert';
import { SessionCoordinator } from '../acp/sessionCoordinator';
import {
  ensureLayerTag,
  recoverReusableSession,
  resolveAuthMethodOrder,
  DEFAULT_AUTH_RECOVERY_ACTION,
} from '../acp/sessionRecoveryHandler';
import { RuntimeConfigApplier } from '../acp/runtimeConfigApplier';
import { InteractionBridge } from '../acp/interactionBridge';
import { ConnectionSnapshot, RunOptions } from '../acp/types';

class FakeTransport {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  lastConnectUrl: string | null = null;
  connectFailure: unknown | null = null;
  onClose: ((error?: Error) => void) | null = null;

  async connect(options?: { url: string }): Promise<void> {
    if (this.connectFailure !== null) {
      throw this.connectFailure;
    }
    this.connected = true;
    this.connectCalls += 1;
    this.lastConnectUrl = options?.url ?? null;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCalls += 1;
  }

  triggerClose(error?: Error): void {
    this.connected = false;
    this.onClose?.(error);
  }

  async send(): Promise<void> {}

  async receive(): Promise<string> {
    return new Promise<string>(() => {
      // no-op in tests
    });
  }
}

class FakeProtocol {
  requests: Array<{ method: string; params?: unknown }> = [];
  serverHandlers = new Map<string, (...args: unknown[]) => unknown>();
  started = false;
  disposed = false;
  failOnMethod: string | null = null;
  failAuthMethodId: string | null = null;
  methodFailures = new Map<string, unknown>();
  initializeResult: { isAuthenticated?: boolean; authMethods?: Array<{ id?: string }> } = {
    isAuthenticated: false,
  };

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });

    if (this.methodFailures.has(method)) {
      throw this.methodFailures.get(method);
    }

    if (this.failOnMethod && method === this.failOnMethod) {
      throw new Error(`forced failure on ${method}`);
    }

    switch (method) {
      case 'initialize':
        return this.initializeResult;
      case 'authenticate':
        if (
          this.failAuthMethodId
          && (params as { methodId?: string } | undefined)?.methodId === this.failAuthMethodId
        ) {
          throw new Error(`forced failure on authenticate:${this.failAuthMethodId}`);
        }
        return { ok: true };
      case 'session/new':
        return { sessionId: 'session-new-1' };
      case 'session/load':
        return { ok: true };
      case 'session/set_mode':
        return { ok: true };
      case 'session/set_model':
        return { ok: true };
      case 'session/set_think':
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  onServerMethod(method: string, handler: (...args: unknown[]) => unknown): void {
    this.serverHandlers.set(method, handler);
  }

  onNotification(): void {}

  startReceiveLoop(): void {
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function baseRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: 'hello',
    attachedFiles: [],
    mode: 'default',
    think: false,
    model: 'GLM-4.7',
    cwd: '/tmp/workspace-a',
    ...overrides,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createProcessManagerRecorder(
  startInfo: { nodePath: string; iflowScript: string; port: number } | null,
): {
  startCalls: Array<{ enableStream: boolean | undefined }>;
  manager: {
    hasProcess: boolean;
    currentPort: number | null;
    stopManagedProcess: () => void;
    resolveStartMode: () => Promise<{ nodePath: string; iflowScript: string; port: number } | null>;
    startManagedProcess: (
      nodePath: string,
      port: number,
      iflowScript?: string,
      cwd?: string,
      enableStream?: boolean,
    ) => Promise<number>;
  };
} {
  const startCalls: Array<{ enableStream: boolean | undefined }> = [];

  return {
    startCalls,
    manager: {
      hasProcess: false,
      currentPort: null,
      stopManagedProcess: () => {},
      resolveStartMode: async () => startInfo,
      startManagedProcess: async (
        _nodePath: string,
        _port: number,
        _iflowScript?: string,
        _cwd?: string,
        enableStream?: boolean,
      ) => {
        startCalls.push({ enableStream });
        return startInfo?.port ?? 8090;
      },
    },
  };
}

suite('SessionCoordinator', () => {
  test('establishes connection and reaches ready state', async () => {
    const snapshots: Array<{ snapshot: ConnectionSnapshot; reason: string }> = [];
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
      onConnectionStateChange: (snapshot, reason) => {
        snapshots.push({ snapshot, reason });
      },
    });

    await coordinator.ensureConnected(baseRunOptions());

    assert.strictEqual(coordinator.currentIsConnected, true);
    assert.strictEqual(coordinator.currentSessionId, 'session-new-1');
    assert.ok(snapshots.some((s) => s.snapshot.status === 'connecting'));
    assert.ok(snapshots.some((s) => s.snapshot.status === 'initializing'));
    assert.ok(snapshots.some((s) => s.snapshot.status === 'ready'));
  });

  test('uses managed process actual port when startup returns a different port', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: false,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => ({
          nodePath: '/usr/bin/node',
          iflowScript: '/tmp/iflow.js',
          port: 8090,
        }),
        startManagedProcess: async () => 30604,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());
    assert.strictEqual(transport.lastConnectUrl, 'ws://localhost:30604/acp');
  });

  test('uses current managed process port when process already exists', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: 30604,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => {
          throw new Error('should not start managed process when one already exists');
        },
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());
    assert.strictEqual(transport.lastConnectUrl, 'ws://localhost:30604/acp');
  });

  test('reuses connection for same cwd and loads requested session', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a' }));
    const connectCallsAfterFirstRun = transport.connectCalls;

    await coordinator.ensureConnected(baseRunOptions({
      cwd: '/tmp/workspace-a',
      sessionId: 'session-loaded-1',
      mode: 'smart',
    }));

    assert.strictEqual(transport.connectCalls, connectCallsAfterFirstRun);
    assert.ok(protocol.requests.some((r) => r.method === 'session/load'));
    assert.strictEqual(coordinator.currentSessionId, 'session-loaded-1');
  });

  test('reloads current session when mode changes from plan to execution', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ mode: 'plan' }));
    const activeSessionId = coordinator.currentSessionId;
    assert.ok(activeSessionId);

    protocol.requests = [];
    await coordinator.ensureConnected(baseRunOptions({
      mode: 'smart',
      sessionId: activeSessionId ?? undefined,
    }));

    assert.ok(
      protocol.requests.some((r) => r.method === 'session/load'),
      'expected session/load to refresh settings after leaving plan mode',
    );

    const loadRequest = protocol.requests.find((r) => r.method === 'session/load');
    const settings = (
      loadRequest?.params as { settings?: Record<string, unknown> } | undefined
    )?.settings;
    assert.ok(settings);
    assert.strictEqual(settings?.permission_mode, 'smart');
    assert.strictEqual(settings?.append_system_prompt, '');
  });

  test('creates a fresh session for new conversation on reused connection', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ mode: 'plan' }));

    protocol.requests = [];
    await coordinator.ensureConnected(baseRunOptions({ mode: 'default', sessionId: undefined }));

    const newRequest = protocol.requests.find((r) => r.method === 'session/new');
    assert.ok(newRequest, 'expected session/new for new conversation');
    assert.ok(!protocol.requests.some((r) => r.method === 'session/load'));

    const settings = (
      newRequest?.params as { settings?: Record<string, unknown> } | undefined
    )?.settings;
    assert.ok(settings);
    assert.strictEqual(settings?.permission_mode, 'default');
    assert.strictEqual(settings?.append_system_prompt, '');
  });

  test('reconnects when cwd changes', async () => {
    const transportA = new FakeTransport();
    const transportB = new FakeTransport();
    const protocolA = new FakeProtocol();
    const protocolB = new FakeProtocol();
    let createTransportCalls = 0;

    const coordinator = new SessionCoordinator({
      createTransport: () => {
        createTransportCalls += 1;
        return createTransportCalls === 1 ? transportA as never : transportB as never;
      },
      createProtocol: () => (createTransportCalls === 1 ? protocolA : protocolB) as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a' }));
    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-b' }));

    assert.strictEqual(createTransportCalls, 2);
    assert.ok(transportA.disconnectCalls >= 1);
    assert.strictEqual(coordinator.currentCwd, '/tmp/workspace-b');
  });

  test('reset returns to disconnected state and allows reconnect', async () => {
    const transportA = new FakeTransport();
    const transportB = new FakeTransport();
    const protocolA = new FakeProtocol();
    const protocolB = new FakeProtocol();
    let createTransportCalls = 0;

    const coordinator = new SessionCoordinator({
      createTransport: () => {
        createTransportCalls += 1;
        return createTransportCalls === 1 ? transportA as never : transportB as never;
      },
      createProtocol: () => (createTransportCalls === 1 ? protocolA : protocolB) as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a' }));
    await coordinator.reset();

    assert.strictEqual(coordinator.connectionSnapshot.status, 'disconnected');
    assert.strictEqual(coordinator.currentSessionId, null);
    assert.strictEqual(coordinator.currentIsConnected, false);

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-b' }));

    assert.strictEqual(coordinator.connectionSnapshot.status, 'ready');
    assert.strictEqual(coordinator.currentCwd, '/tmp/workspace-b');
    assert.strictEqual(createTransportCalls, 2);
  });

  test('dispose is terminal and blocks reconnect', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());
    await coordinator.dispose();

    assert.strictEqual(coordinator.connectionSnapshot.status, 'disposed');
    await assert.rejects(
      coordinator.ensureConnected(baseRunOptions()),
      /Session coordinator is disposed/,
    );
  });

  test('reuses connection when cwd differs only by trailing separator', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a/' }));
    const connectCallsAfterFirstRun = transport.connectCalls;

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a' }));

    assert.strictEqual(transport.connectCalls, connectCallsAfterFirstRun);
  });

  test('rolls back to disconnected on initialization failure', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.failOnMethod = 'session/new';

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(
      coordinator.ensureConnected(baseRunOptions()),
      /forced failure on session\/new/,
    );

    assert.strictEqual(coordinator.currentIsConnected, false);
    assert.strictEqual(coordinator.currentProtocol, null);
    assert.strictEqual(coordinator.currentSessionId, null);
    assert.strictEqual(coordinator.connectionSnapshot.status, 'disconnected');
  });

  test('publishes closed transition when transport closes', async () => {
    const reasons: string[] = [];
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
      onConnectionStateChange: (_snapshot, reason) => {
        reasons.push(reason);
      },
    });

    await coordinator.ensureConnected(baseRunOptions());
    transport.triggerClose(new Error('socket dropped'));

    assert.strictEqual(coordinator.currentIsConnected, false);
    assert.strictEqual(coordinator.currentSessionId, null);
    assert.strictEqual(coordinator.connectionSnapshot.status, 'disconnected');
    assert.ok(reasons.includes('closed'));
  });

  test('passes enableCliStream=true to process manager by default', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    const { startCalls, manager } = createProcessManagerRecorder({
      nodePath: '/usr/bin/node',
      iflowScript: '/usr/lib/iflow/entry.js',
      port: 8090,
    });

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => manager,
      getConfig: <T>(key: string, defaultValue: T) => {
        if (key === 'enableCliStream') {
          return true as T;
        }
        return defaultValue;
      },
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());
    assert.strictEqual(startCalls.length, 1);
    assert.strictEqual(startCalls[0].enableStream, true);
  });

  test('passes enableCliStream=false to process manager when configured', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    const { startCalls, manager } = createProcessManagerRecorder({
      nodePath: '/usr/bin/node',
      iflowScript: '/usr/lib/iflow/entry.js',
      port: 8090,
    });

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => manager,
      getConfig: <T>(key: string, defaultValue: T) => {
        if (key === 'enableCliStream') {
          return false as T;
        }
        return defaultValue;
      },
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());
    assert.strictEqual(startCalls.length, 1);
    assert.strictEqual(startCalls[0].enableStream, false);
  });

  test('prefers oauth-iflow over iflow when both auth methods are available', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.initializeResult = {
      isAuthenticated: false,
      authMethods: [{ id: 'iflow' }, { id: 'oauth-iflow' }],
    };

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());

    const authenticate = protocol.requests.find((request) => request.method === 'authenticate');
    assert.ok(authenticate);
    assert.strictEqual(
      (authenticate?.params as { methodId?: string } | undefined)?.methodId,
      'oauth-iflow',
    );
  });

  test('falls back to next auth method when preferred method fails', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.initializeResult = {
      isAuthenticated: false,
      authMethods: [{ id: 'oauth-iflow' }, { id: 'iflow' }],
    };
    protocol.failAuthMethodId = 'oauth-iflow';

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());

    const authenticateRequests = protocol.requests.filter((request) => request.method === 'authenticate');
    assert.strictEqual(authenticateRequests.length, 2);
    assert.strictEqual(
      (authenticateRequests[0]?.params as { methodId?: string } | undefined)?.methodId,
      'oauth-iflow',
    );
    assert.strictEqual(
      (authenticateRequests[1]?.params as { methodId?: string } | undefined)?.methodId,
      'iflow',
    );
  });

  test('tags transport failures with TRANSPORT_ERROR', async () => {
    const transport = new FakeTransport();
    transport.connectFailure = new Error('socket refused');
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(coordinator.ensureConnected(baseRunOptions()), (error) => {
      const message = getErrorMessage(error);
      assert.match(message, /\[TRANSPORT_ERROR\]/);
      assert.match(message, /socket refused/);
      return true;
    });
  });

  test('tags authentication failures with AUTH_ERROR and recovery action', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.initializeResult = {
      isAuthenticated: false,
      authMethods: [{ id: 'oauth-iflow' }],
    };
    protocol.failOnMethod = 'authenticate';

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(coordinator.ensureConnected(baseRunOptions()), (error) => {
      const message = getErrorMessage(error);
      assert.match(message, /\[AUTH_ERROR\]/);
      assert.match(message, /iflow login/i);
      return true;
    });
  });

  test('tags initialize/session lifecycle failures with PROTOCOL_ERROR', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.failOnMethod = 'initialize';

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(coordinator.ensureConnected(baseRunOptions()), (error) => {
      const message = getErrorMessage(error);
      assert.match(message, /\[PROTOCOL_ERROR\]/);
      assert.match(message, /forced failure on initialize/);
      return true;
    });
  });

  test('preserves session-not-found text for stale-session recovery while tagging', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.methodFailures.set(
      'session/load',
      new Error('[JSON-RPC -32600] Invalid request (data: {"details":"Session not found: stale-1"})'),
    );

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions());
    await assert.rejects(
      coordinator.ensureConnected(
        baseRunOptions({
          sessionId: 'stale-1',
        }),
      ),
      (error) => {
        const message = getErrorMessage(error);
        assert.match(message, /\[PROTOCOL_ERROR\]/);
        assert.match(message, /Session not found: stale-1/);
        return true;
      },
    );

    assert.strictEqual(coordinator.connectionSnapshot.status, 'ready');
    assert.strictEqual(transport.disconnectCalls, 0);
  });

  test('normalizes non-error protocol failures before wrapping with tags', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.methodFailures.set('session/new', { details: 'payload invalid' });

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(coordinator.ensureConnected(baseRunOptions()), (error) => {
      const message = getErrorMessage(error);
      assert.match(message, /\[PROTOCOL_ERROR\]/);
      assert.match(message, /"details":"payload invalid"/);
      return true;
    });
  });

  test('falls back to PROTOCOL_ERROR for ambiguous lifecycle failures', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.initializeResult = {
      isAuthenticated: false,
      authMethods: [{ id: 'iflow' }],
    };

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        currentPort: null,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => 8090,
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      resolveAuthMethodOrder: () => {
        throw new Error('preference resolver failed unexpectedly');
      },
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(coordinator.ensureConnected(baseRunOptions()), (error) => {
      const message = getErrorMessage(error);
      assert.match(message, /\[PROTOCOL_ERROR\]/);
      assert.match(message, /preference resolver failed unexpectedly/);
      return true;
    });
  });

  test('resolveAuthMethodOrder keeps preferred ordering with deterministic fallbacks', () => {
    const order = resolveAuthMethodOrder({
      availableMethodIds: ['iflow', 'oauth-iflow'],
      preferredMethodIds: ['iflow', 'oauth-iflow'],
    });

    assert.deepStrictEqual(order, ['iflow', 'oauth-iflow']);
  });

  test('ensureLayerTag adds auth recovery action exactly once', () => {
    const error = ensureLayerTag(new Error('token expired'), 'AUTH_ERROR');
    assert.match(error.message, /\[AUTH_ERROR\]/);
    assert.match(error.message, /token expired/);
    assert.match(error.message, /iflow login/i);

    const taggedAgain = ensureLayerTag(error, 'AUTH_ERROR');
    const actionOccurrences = taggedAgain.message.match(
      new RegExp(DEFAULT_AUTH_RECOVERY_ACTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    );
    assert.strictEqual(actionOccurrences?.length ?? 0, 1);
  });

  test('recoverReusableSession creates a new server session when no sessionId is provided', async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];

    const result = await recoverReusableSession({
      options: baseRunOptions({ sessionId: undefined }),
      currentSessionId: 'session-existing',
      currentMode: 'plan',
      sendRequest: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === 'session/new') {
          return { sessionId: 'session-fresh-2' };
        }
        return { ok: true };
      },
      buildSessionSettings: () => ({ permission_mode: 'default' }),
    });

    assert.strictEqual(result.sessionId, 'session-fresh-2');
    assert.ok(requests.some((request) => request.method === 'session/new'));
  });

  test('recoverReusableSession loads requested session when switching session ids', async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];

    const result = await recoverReusableSession({
      options: baseRunOptions({ sessionId: 'session-target', mode: 'default' }),
      currentSessionId: 'session-existing',
      currentMode: 'default',
      sendRequest: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return { ok: true };
      },
      buildSessionSettings: () => ({ permission_mode: 'default' }),
    });

    assert.strictEqual(result.action, 'load_requested');
    assert.strictEqual(result.sessionId, 'session-target');
    const loadRequest = requests.find((request) => request.method === 'session/load');
    assert.ok(loadRequest, 'expected session/load when switching session ids');
    assert.strictEqual((loadRequest?.params as { sessionId?: string }).sessionId, 'session-target');
  });

  test('recoverReusableSession reloads current session when mode changes', async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];

    const result = await recoverReusableSession({
      options: baseRunOptions({ sessionId: 'session-existing', mode: 'plan' }),
      currentSessionId: 'session-existing',
      currentMode: 'default',
      sendRequest: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return { ok: true };
      },
      buildSessionSettings: () => ({ permission_mode: 'default' }),
    });

    assert.strictEqual(result.action, 'reload_current');
    assert.strictEqual(result.sessionId, 'session-existing');
    assert.ok(
      requests.some((request) => request.method === 'session/load'),
      'expected session/load when mode changes on existing session',
    );
  });

  test('recoverReusableSession keeps existing session when mode and id are unchanged', async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];

    const result = await recoverReusableSession({
      options: baseRunOptions({ sessionId: 'session-existing', mode: 'default' }),
      currentSessionId: 'session-existing',
      currentMode: 'default',
      sendRequest: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return { ok: true };
      },
      buildSessionSettings: () => ({ permission_mode: 'default' }),
    });

    assert.strictEqual(result.action, 'reuse_existing');
    assert.strictEqual(result.sessionId, 'session-existing');
    assert.strictEqual(requests.length, 0);
  });
});
