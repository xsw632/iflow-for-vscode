import * as assert from 'assert';
import { EventEmitter } from 'events';
import { startManagedProcessWithProbe } from '../process/processStartupProbe';
import { ProcessManager } from '../processManager';

class FakeStream extends EventEmitter {
  emitData(data: string): void {
    this.emit('data', Buffer.from(data));
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed = false;
  pid = 12345;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

type WsBehavior = 'open' | 'error';

class FakeWebSocket extends EventEmitter {
  readyState = WS_CONNECTING;

  constructor(behavior: WsBehavior) {
    super();

    queueMicrotask(() => {
      if (behavior === 'open') {
        this.readyState = WS_OPEN;
        this.emit('open');
        return;
      }

      this.readyState = WS_CLOSED;
      this.emit('error', new Error('Connection refused'));
    });
  }

  close(): void {
    this.readyState = WS_CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = WS_CLOSED;
    this.emit('close');
  }
}

suite('ProcessManager WebSocket Readiness', () => {
  let processManager: ProcessManager;
  let fakeProcess: FakeChildProcess;
  let wsBehavior: WsBehavior;
  let wsAttempts: number;
  let logs: string[];
  let spawnedArgs: string[] | null;

  setup(() => {
    fakeProcess = new FakeChildProcess();
    wsBehavior = 'open';
    wsAttempts = 0;
    logs = [];
    spawnedArgs = null;

    processManager = new ProcessManager(
      (message) => logs.push(message),
      (message) => logs.push(message),
      {
        spawn: ((_: string, args: string[]) => {
          spawnedArgs = [...args];
          return fakeProcess;
        }) as any,
        createWebSocket: (() => {
          wsAttempts += 1;
          return new FakeWebSocket(wsBehavior) as any;
        }) as any,
        isPortAvailable: async () => true,
        findAvailablePort: async () => 38080,
      },
    );
  });

  teardown(() => {
    processManager.stopManagedProcess();
  });

  test('startManagedProcess resolves when stdout has ready signal', async () => {
    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8090,
      '/usr/lib/iflow/entry.js',
    );

    setTimeout(() => {
      fakeProcess.stdout.emitData('listening on port 8090\n');
    }, 20);

    await assert.doesNotReject(startPromise);
    assert.ok(wsAttempts <= 1);
  });

  test('startManagedProcess resolves via WebSocket readiness probe when no ready output', async () => {
    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8091,
      '/usr/lib/iflow/entry.js',
    );

    await assert.doesNotReject(startPromise);
    assert.ok(wsAttempts >= 1);
    assert.ok(logs.some((line) => line.includes('WebSocket connection confirmed')));
  });

  test('startup probe reports websocket readiness metadata', async () => {
    const startup = await startManagedProcessWithProbe({
      nodePath: '/usr/bin/node',
      port: 8091,
      iflowScript: '/usr/lib/iflow/entry.js',
      spawnProcess: (() => fakeProcess) as any,
      createWebSocket: (() => {
        wsAttempts += 1;
        return new FakeWebSocket('open') as any;
      }) as any,
      log: (message) => logs.push(message),
      isCancelled: () => false,
    });

    assert.strictEqual(startup.readyVia, 'websocket');
    assert.ok(startup.readinessAttempts >= 1);
    assert.strictEqual(startup.port, 8091);
  });

  test('process exit during startup rejects with helpful error', async () => {
    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8092,
      '/usr/lib/iflow/entry.js',
    );

    setTimeout(() => {
      fakeProcess.emit('exit', 1);
    }, 20);

    await assert.rejects(startPromise, /exited immediately with code 1/);
  });

  test('stopManagedProcess stops spawned child process', async () => {
    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8093,
      '/usr/lib/iflow/entry.js',
    );

    setTimeout(() => {
      fakeProcess.stdout.emitData('ready\n');
    }, 20);

    await startPromise;
    processManager.stopManagedProcess();
    assert.strictEqual(fakeProcess.killed, true);
  });

  test('WebSocket probe logs first error attempt', async () => {
    wsBehavior = 'error';

    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8094,
      '/usr/lib/iflow/entry.js',
    );

    setTimeout(() => {
      fakeProcess.stdout.emitData('ready\n');
    }, 1200);

    await assert.doesNotReject(startPromise);
    assert.ok(logs.some((line) => line.includes('[WebSocket check] Attempt 1 failed')));
  });

  test('startManagedProcess includes --stream when enableStream=true', async () => {
    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8095,
      '/usr/lib/iflow/entry.js',
      undefined,
      true,
    );

    setTimeout(() => {
      fakeProcess.stdout.emitData('ready\n');
    }, 20);

    await assert.doesNotReject(startPromise);
    assert.ok(spawnedArgs?.includes('--stream'));
  });

  test('startManagedProcess excludes --stream when enableStream=false', async () => {
    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8096,
      '/usr/lib/iflow/entry.js',
      undefined,
      false,
    );

    setTimeout(() => {
      fakeProcess.stdout.emitData('ready\n');
    }, 20);

    await assert.doesNotReject(startPromise);
    assert.ok(spawnedArgs);
    assert.strictEqual(spawnedArgs?.includes('--stream'), false);
  });
});
