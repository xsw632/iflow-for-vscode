import * as assert from 'assert';
import * as net from 'net';
import { findAvailablePort, isPortAvailable } from '../process/portDiscovery';

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
  throw new Error('not implemented');
}

suite('portDiscovery fake server harness', () => {
  test('restores net.createServer after patching', () => {
    const original = net.createServer;
    const harness = installFakeCreateServerHarness();

    assert.notStrictEqual(net.createServer, original);
    harness.restore();
    assert.strictEqual(net.createServer, original);
  });

  test('can drive deterministic listening and error paths for isPortAvailable', async () => {
    const harness = installFakeCreateServerHarness();
    harness.queue({ outcome: 'listening' });
    harness.queue({ outcome: 'error', error: new Error('EADDRINUSE') });

    const first = await isPortAvailable(19001);
    const second = await isPortAvailable(19001);

    harness.restore();
    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
  });

  test('supports resolve and reject flows for findAvailablePort', async () => {
    const harness = installFakeCreateServerHarness();
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

    harness.restore();
    assert.strictEqual(resolved, 19002);
  });
});
