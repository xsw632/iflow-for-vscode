import * as assert from 'assert';
import { EventEmitter } from 'events';
import { ProcessManager } from '../processManager';
import { buildStartupFailureMessage } from '../process/startupSignals';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = 1234;
  exitCode: number | null = null;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    return true;
  }

  emitExit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;

  constructor(private readonly shouldOpen: boolean) {
    super();
    setImmediate(() => {
      if (this.shouldOpen) {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
      } else {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit('error', new Error('connect failed'));
      }
    });
  }

  terminate(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

suite('ProcessManager', () => {
  test('returns CLI-reported ACP port when CLI switches to an available port', async () => {
    const child = new FakeChildProcess();
    const manager = new ProcessManager(
      () => {},
      () => {},
      {
        spawn: (() => child) as unknown as typeof import('child_process').spawn,
        createWebSocket: (() => new FakeWebSocket(true) as never),
        isPortAvailable: async () => true,
      },
    );

    const startPromise = manager.startManagedProcess(
      '/usr/bin/node',
      8090,
      '/tmp/iflow.js',
      '/tmp',
      true,
    );

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('Found available port 30604 on attempt 1\n'));
      child.stdout.emit('data', Buffer.from('Using port: 30604\n'));
      child.stdout.emit('data', Buffer.from('Starting WebSocket service on port 30604...\n'));
    });

    const actualPort = await startPromise;
    assert.strictEqual(actualPort, 30604);
    assert.strictEqual(manager.currentPort, 30604);
  });

  test('reports a clear error when configured ACP port is already in use', async () => {
    const child = new FakeChildProcess();
    const manager = new ProcessManager(
      () => {},
      () => {},
      {
        spawn: (() => child) as unknown as typeof import('child_process').spawn,
      },
    );

    const startPromise = manager.startManagedProcess(
      '/usr/bin/node',
      8090,
      '/tmp/iflow.js',
      '/tmp',
      true,
      false,
    );

    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use :::8090\n'));
      child.emitExit(1);
    });

    await assert.rejects(
      startPromise,
      /failed to bind ACP port 8090 because it is already in use/i,
    );
    assert.strictEqual(manager.currentPort, null);
  });

  test('includes runtime context and guidance for startup failures', () => {
    const message = buildStartupFailureMessage(
      1,
      ['booting...\n'],
      ['error: startup failed\n'],
      8090,
      '/Users/dev/.volta/bin/node',
      30_000,
    );

    assert.ok(message.includes('port=8090'));
    assert.ok(message.includes('timeoutMs=30000'));
    assert.ok(message.includes('node=node'));
    assert.ok(message.includes('verify iflow.nodePath/config and retry'));
  });

  test('adds runtime context to port-in-use errors', () => {
    const message = buildStartupFailureMessage(
      1,
      [],
      ['Error: listen EADDRINUSE: address already in use :::8090'],
      8090,
      '/usr/local/bin/node',
      30_000,
    );

    assert.ok(message.includes('port=8090'));
    assert.ok(message.includes('timeoutMs=30000'));
    assert.ok(message.includes('node=node'));
    assert.ok(message.includes('verify iflow.nodePath/config and retry'));
  });

  test('proactively falls back to an available port when configured port is occupied', async () => {
    const child = new FakeChildProcess();
    let spawnedPort: number | null = null;
    const occupiedPort = 8090;
    const fallbackPort = 30604;
    const manager = new ProcessManager(
      () => {},
      () => {},
      {
        spawn: ((_: string, args: string[]) => {
          const idx = args.indexOf('--port');
          if (idx >= 0 && idx + 1 < args.length) {
            spawnedPort = Number.parseInt(args[idx + 1], 10);
          }
          return child as unknown as import('child_process').ChildProcess;
        }) as unknown as typeof import('child_process').spawn,
        createWebSocket: (() => new FakeWebSocket(true) as never),
        isPortAvailable: async (port) => port !== occupiedPort,
        findAvailablePort: async () => fallbackPort,
      },
    );

    const startPromise = manager.startManagedProcess(
      '/usr/bin/node',
      occupiedPort,
      '/tmp/iflow.js',
      '/tmp',
      true,
      true,
    );

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('ready\n'));
    });

    const actualPort = await startPromise;
    assert.ok(typeof spawnedPort === 'number');
    assert.notStrictEqual(spawnedPort, occupiedPort);
    assert.strictEqual(actualPort, spawnedPort);
    assert.strictEqual(manager.currentPort, spawnedPort);
  });
});
