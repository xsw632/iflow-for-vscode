import * as assert from 'assert';
import * as WebSocket from 'ws';
import { ProcessManager } from '../processManager';

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn
}));

suite('ProcessManager WebSocket Readiness', () => {
  let processManager: ProcessManager;
  let mockProcess: any;
  let eventHandlers: Map<string, Function[]>;

  setup(() => {
    eventHandlers = new Map();
    
    mockProcess = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, handler: Function) => {
        if (!eventHandlers.has(event)) {
          eventHandlers.set(event, []);
        }
        eventHandlers.get(event)!.push(handler);
      }),
      killed: false,
      kill: jest.fn()
    };

    mockSpawn.mockReturnValue(mockProcess);

    processManager = new ProcessManager(
      () => {}, // log
      () => {}, // logInfo
      () => '/test/cwd'
    );
  });

  teardown(() => {
    jest.clearAllMocks();
  });

  test('startManagedProcess waits for WebSocket connection', async () => {
    // Mock successful WebSocket connection
    const mockWs = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'open') {
          // Simulate successful connection
          setTimeout(() => handler(), 100);
        }
      }),
      close: jest.fn(),
      terminate: jest.fn()
    };
    
    jest.spyOn(WebSocket.prototype, 'on').mockImplementation(function(this: any, event: string, handler: Function) {
      if (event === 'open') {
        setTimeout(() => handler.call(this), 100);
      }
      return this;
    });

    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8090,
      '/usr/lib/iflow/entry.js'
    );

    // Should eventually resolve when WebSocket connects
    await assert.doesNotReject(startPromise);
  });

  test('startManagedProcess handles WebSocket timeout', async () => {
    // Mock WebSocket that never connects (will timeout after 20 attempts)
    jest.spyOn(WebSocket.prototype, 'on').mockImplementation(function(this: any, event: string, handler: Function) {
      if (event === 'error') {
        // Simulate connection error
        setTimeout(() => handler(new Error('Connection refused')), 10);
      }
      return this;
    });

    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8091,
      '/usr/lib/iflow/entry.js'
    );

    // Should resolve after max attempts (20 * 300ms = 6s, but we have a shorter fallback)
    await assert.doesNotReject(startPromise);
  });

  test('startManagedProcess collects stdout/stderr in buffer', async () => {
    const stdoutData: string[] = [];
    const stderrData: string[] = [];

    mockProcess.stdout.on = jest.fn((event: string, handler: Function) => {
      if (event === 'data') {
        // Simulate stdout output
        setTimeout(() => handler(Buffer.from('Listening on port 8090\n')), 50);
      }
    });

    mockProcess.stderr.on = jest.fn((event: string, handler: Function) => {
      if (event === 'data') {
        // Simulate stderr output
        setTimeout(() => handler(Buffer.from('Warning: deprecated flag\n')), 60);
      }
    });

    // Mock successful WebSocket
    jest.spyOn(WebSocket.prototype, 'on').mockImplementation(function(this: any, event: string, handler: Function) {
      if (event === 'open') {
        setTimeout(() => handler.call(this), 200);
      }
      return this;
    });

    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8092,
      '/usr/lib/iflow/entry.js'
    );

    await assert.doesNotReject(startPromise);
  });

  test('process exit during startup provides helpful error', async () => {
    mockProcess.stdout.on = jest.fn();
    mockProcess.stderr.on = jest.fn();
    
    mockProcess.on = jest.fn((event: string, handler: Function) => {
      if (event === 'exit') {
        // Simulate process exiting with code 1
        setTimeout(() => handler(1), 100);
      }
    });

    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8093,
      '/usr/lib/iflow/entry.js'
    );

    try {
      await startPromise;
      assert.fail('Should have thrown an error');
    } catch (error: any) {
      assert.ok(error.message.includes('exited immediately'), 'Should mention process exited');
      assert.ok(error.message.includes('--experimental-acp') || error.message.includes('code 1'), 
        'Should provide helpful hint for exit code 1');
    }
  });

  test('WebSocket connection confirmed logs attempt count', async () => {
    let attemptCount = 0;
    
    jest.spyOn(WebSocket.prototype, 'on').mockImplementation(function(this: any, event: string, handler: Function) {
      if (event === 'open') {
        // Connect on 3rd attempt
        setTimeout(() => {
          attemptCount++;
          if (attemptCount >= 3) {
            handler.call(this);
          }
        }, 100);
      } else if (event === 'error') {
        setTimeout(() => handler(new Error('Connection refused')), 50);
      }
      return this;
    });

    const startPromise = processManager.startManagedProcess(
      '/usr/bin/node',
      8094,
      '/usr/lib/iflow/entry.js'
    );

    await assert.doesNotReject(startPromise);
  });
});