import * as assert from 'assert';
import { EventEmitter } from 'events';
import type { AddressInfo, Server } from 'net';
import { findAvailablePort, isPortAvailable } from '../process/portDiscovery';

const netModule = require('net') as typeof import('net');

type Scenario = {
  outcome: 'listening' | 'error';
  address?: unknown;
  error?: Error;
};

type FakeHarness = {
  queue: (scenario: Scenario) => void;
  restore: () => void;
};

function installFakeCreateServerHarness(): FakeHarness {
  class FakeServer extends EventEmitter {
    private addressValue: unknown = null;

    constructor(private readonly scenarios: Scenario[]) {
      super();
    }

    listen(port?: number, host?: string): this {
      const scenario = this.scenarios.shift();
      if (!scenario) {
        queueMicrotask(() => {
          this.emit('error', new Error(`No fake scenario queued for listen(${port ?? 'n/a'}, ${host ?? 'n/a'})`));
        });
        return this;
      }

      queueMicrotask(() => {
        if (scenario.outcome === 'error') {
          this.emit('error', scenario.error ?? new Error('Fake listen error'));
          return;
        }

        this.addressValue =
          scenario.address ??
          ({
            address: '127.0.0.1',
            family: 'IPv4',
            port: 19000,
          } satisfies AddressInfo);
        this.emit('listening');
      });
      return this;
    }

    close(callback?: (err?: Error) => void): this {
      queueMicrotask(() => {
        if (callback) {
          callback();
        }
      });
      return this;
    }

    address(): string | AddressInfo | null {
      if (typeof this.addressValue === 'string') {
        return this.addressValue;
      }
      if (this.addressValue && typeof this.addressValue === 'object') {
        return this.addressValue as AddressInfo;
      }
      return null;
    }
  }

  const scenarios: Scenario[] = [];
  const mutableNet = netModule as typeof netModule & { createServer: () => Server };
  const originalCreateServer = mutableNet.createServer;
  let restored = false;

  mutableNet.createServer = () => new FakeServer(scenarios) as unknown as Server;

  return {
    queue: (scenario) => {
      scenarios.push(scenario);
    },
    restore: () => {
      if (restored) {
        return;
      }
      mutableNet.createServer = originalCreateServer;
      restored = true;
    },
  };
}

suite('portDiscovery fake server harness', () => {
  let activeHarness: FakeHarness | null = null;

  const installHarness = (): FakeHarness => {
    activeHarness = installFakeCreateServerHarness();
    return activeHarness;
  };

  teardown(() => {
    if (activeHarness) {
      activeHarness.restore();
      activeHarness = null;
    }
  });

  test('restores net.createServer after patching', () => {
    const original = netModule.createServer;
    const harness = installHarness();

    assert.notStrictEqual(netModule.createServer, original);
    harness.restore();
    activeHarness = null;
    assert.strictEqual(netModule.createServer, original);
  });

  test('can drive deterministic listening and error paths for isPortAvailable', async () => {
    const harness = installHarness();
    harness.queue({ outcome: 'listening' });
    harness.queue({ outcome: 'error', error: new Error('EADDRINUSE') });

    const first = await isPortAvailable(19001);
    const second = await isPortAvailable(19001);

    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
  });

  test('supports resolve and reject flows for findAvailablePort', async () => {
    const harness = installHarness();
    harness.queue({
      outcome: 'listening',
      address: { address: '127.0.0.1', family: 'IPv4', port: 19002 },
    });
    harness.queue({
      outcome: 'listening',
      address: 'invalid',
    });

    const resolved = await findAvailablePort();
    await assert.rejects(() => findAvailablePort(), /Failed to resolve available ACP port/);

    assert.strictEqual(resolved, 19002);
  });
});
