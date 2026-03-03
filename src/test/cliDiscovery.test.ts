import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildDiscoveryFailureSummary,
  categorizeDiscoverySource,
  deriveNodePathFromIFlow,
  normalizeDiscoveryFailureReason,
  resolveIFlowScriptCrossPlatform,
  type DiscoveryAttemptDiagnostic,
} from '../cliDiscovery';

type MaybePromise<T> = T | Promise<T>;

type EnvOverrides = Record<string, string | undefined>;

async function withPatchedPlatform<T>(
  platform: NodeJS.Platform,
  run: () => MaybePromise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

async function withPatchedEnv<T>(
  overrides: EnvOverrides,
  run: () => MaybePromise<T>,
): Promise<T> {
  const originals = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of originals.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withPatchedProperty<T extends object, K extends keyof T, R>(
  target: T,
  key: K,
  value: T[K],
  run: () => MaybePromise<R>,
): Promise<R> {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: ownDescriptor?.enumerable ?? true,
    writable: true,
    value,
  });

  try {
    return await run();
  } finally {
    if (ownDescriptor) {
      Object.defineProperty(target, key, ownDescriptor);
    } else {
      delete (target as unknown as Record<string, unknown>)[String(key)];
    }
  }
}

suite('cliDiscovery test harness', () => {
  test('restores process.platform when patched callback throws', async () => {
    const originalPlatform = process.platform;

    await assert.rejects(async () =>
      withPatchedPlatform('win32', async () => {
        assert.strictEqual(process.platform, 'win32');
        throw new Error('intentional-failure');
      }),
    );

    assert.strictEqual(process.platform, originalPlatform);
  });

  test('restores process.env keys after temporary override', async () => {
    const originalShell = process.env.SHELL;
    delete process.env.IFLOW_TMP_ENV;

    await withPatchedEnv(
      {
        SHELL: '/tmp/iflow-shell',
        IFLOW_TMP_ENV: 'temporary',
      },
      () => {
        assert.strictEqual(process.env.SHELL, '/tmp/iflow-shell');
        assert.strictEqual(process.env.IFLOW_TMP_ENV, 'temporary');
      },
    );

    assert.strictEqual(process.env.SHELL, originalShell);
    assert.strictEqual(process.env.IFLOW_TMP_ENV, undefined);
  });
});

suite('cliDiscovery PowerShell Parsing', () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-discovery-test-'));
  });

  teardown(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test('parses standard PowerShell wrapper with $exe variable', () => {
    const ps1Content = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
& "$basedir/node$exe"  "$basedir/node_modules/@iflow-ai/iflow-cli/bundle/entry.js" $args
exit $LASTEXITCODE
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    const jsDir = path.join(tempDir, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'entry.js'), '// entry point');
    fs.writeFileSync(ps1Path, ps1Content);

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'entry.js'), 'Should extract JS path correctly');
  });

  test('parses PowerShell wrapper without $exe variable', () => {
    const ps1Content = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/node_modules/@iflow-ai/iflow-cli/bundle/entry.js" $args
exit $LASTEXITCODE
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    const jsDir = path.join(tempDir, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'entry.js'), '// entry point');
    fs.writeFileSync(ps1Path, ps1Content);

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'entry.js'), 'Should extract JS path correctly');
  });

  test('handles paths with spaces', () => {
    const ps1Content = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/node_modules/some package/cli.js" $args
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    const jsDir = path.join(tempDir, 'node_modules', 'some package');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'cli.js'), '// entry');
    fs.writeFileSync(ps1Path, ps1Content);

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'cli.js'), 'Should handle spaces in path');
  });

  test('handles scoped packages (@org/name)', () => {
    const ps1Content = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/node_modules/@scope/package-name/dist/cli.js" $args
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    const jsDir = path.join(tempDir, 'node_modules', '@scope', 'package-name', 'dist');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'cli.js'), '// entry');
    fs.writeFileSync(ps1Path, ps1Content);

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'cli.js'), 'Should handle scoped packages');
  });

  test('returns null when JS file does not exist', () => {
    const ps1Content = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/node_modules/@iflow-ai/iflow-cli/bundle/entry.js" $args
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    fs.writeFileSync(ps1Path, ps1Content);
    // Don't create the JS file

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, null, 'Should return null when JS file does not exist');
  });

  test('handles very long paths (up to 200 chars)', () => {
    const longPackageName = 'a'.repeat(150);
    const ps1Content = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/node_modules/${longPackageName}/cli.js" $args
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    const jsDir = path.join(tempDir, 'node_modules', longPackageName);
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'cli.js'), '// entry');
    fs.writeFileSync(ps1Path, ps1Content);

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'cli.js'), 'Should handle long paths up to 200 chars');
  });

  test('falls back to original pattern when new pattern fails', () => {
    // This uses the original pattern syntax
    const ps1Content = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/dist/cli.js" $args
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    const jsDir = path.join(tempDir, 'dist');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'cli.js'), '// entry');
    fs.writeFileSync(ps1Path, ps1Content);

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'cli.js'), 'Should fall back to original pattern');
  });

  test('fallback filters out paths with variables', () => {
    // This has a variable in the path which should be filtered
    const ps1Content = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$version="1.0.0"
& "$basedir/dist/$version/cli.js" $args
`;

    const ps1Path = path.join(tempDir, 'iflow.ps1');
    fs.writeFileSync(ps1Path, ps1Content);

    // Create the file anyway to test the filter
    const jsDir = path.join(tempDir, 'dist', '$version');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'cli.js'), '// entry');

    const result = resolveIFlowScriptCrossPlatform(ps1Path, () => {});
    
    // Should not match because path contains $
    assert.strictEqual(result, null, 'Should filter out paths with variables');
  });
});

suite('cliDiscovery CMD Parsing', () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-cmd-test-'));
  });

  teardown(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test('parses CMD wrapper with %~dp0', () => {
    const cmdContent = `@echo off
node "%~dp0\\node_modules\\@iflow-ai\\iflow-cli\\bundle\\entry.js" %*
`;

    const cmdPath = path.join(tempDir, 'iflow.cmd');
    const jsDir = path.join(tempDir, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'entry.js'), '// entry point');
    fs.writeFileSync(cmdPath, cmdContent);

    const result = resolveIFlowScriptCrossPlatform(cmdPath, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'entry.js'), 'Should extract JS path from CMD');
  });

  test('parses CMD wrapper with forward slashes', () => {
    const cmdContent = `@echo off
node "%~dp0/node_modules/@iflow-ai/iflow-cli/bundle/entry.js" %*
`;

    const cmdPath = path.join(tempDir, 'iflow.cmd');
    const jsDir = path.join(tempDir, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(path.join(jsDir, 'entry.js'), '// entry point');
    fs.writeFileSync(cmdPath, cmdContent);

    const result = resolveIFlowScriptCrossPlatform(cmdPath, () => {});
    
    assert.strictEqual(result, path.join(jsDir, 'entry.js'), 'Should handle forward slashes');
  });
});

suite('deriveNodePathFromIFlow', () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-node-derive-test-'));
  });

  teardown(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test('prefers node alongside iflow executable', async () => {
    const binDir = path.join(tempDir, 'bin');
    const iflowPath = path.join(binDir, 'iflow');
    const nodePath = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(iflowPath, '#!/usr/bin/env node');
    fs.writeFileSync(nodePath, '');

    const result = await deriveNodePathFromIFlow(iflowPath, () => {});
    assert.strictEqual(result, nodePath);
  });

  test('infers node path from resolved script under lib/node_modules', async () => {
    const versionRoot = path.join(tempDir, 'nvm', 'versions', 'node', 'v22.0.0');
    const binDir = path.join(versionRoot, 'bin');
    const libDir = path.join(versionRoot, 'lib', 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle');
    const nodePath = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
    const scriptPath = path.join(libDir, 'entry.js');
    const iflowPath = path.join(tempDir, 'shim', 'iflow');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(path.dirname(iflowPath), { recursive: true });
    fs.writeFileSync(nodePath, '');
    fs.writeFileSync(scriptPath, '// entry');
    fs.writeFileSync(iflowPath, '#!/usr/bin/env node');

    const result = await deriveNodePathFromIFlow(iflowPath, () => {}, scriptPath);
    assert.strictEqual(result, nodePath);
  });
});

suite('cliDiscovery diagnostics', () => {
  test('normalizes platform-specific failures to stable reason codes', () => {
    assert.strictEqual(
      normalizeDiscoveryFailureReason(new Error('EACCES: permission denied')),
      'PERMISSION_DENIED',
    );
    assert.strictEqual(
      normalizeDiscoveryFailureReason(new Error('ENOENT: not found')),
      'NOT_FOUND',
    );
    assert.strictEqual(
      normalizeDiscoveryFailureReason(new Error('spawn EPERM')),
      'PERMISSION_DENIED',
    );
  });

  test('categorizes diagnostics by source bucket', () => {
    assert.strictEqual(
      categorizeDiscoverySource('which iflow'),
      'PATH_LOOKUP',
    );
    assert.strictEqual(
      categorizeDiscoverySource('/usr/local/bin/iflow'),
      'KNOWN_LOCATIONS',
    );
    assert.strictEqual(
      categorizeDiscoverySource('/Users/demo/.nvm/versions/node/v22/bin/iflow'),
      'VERSION_MANAGER_SCAN',
    );
  });

  test('builds concise summary with attempts, top reason, and action', () => {
    const diagnostics: DiscoveryAttemptDiagnostic[] = [
      {
        source: 'PATH_LOOKUP',
        target: 'which iflow',
        reasonCode: 'NOT_FOUND',
      },
      {
        source: 'KNOWN_LOCATIONS',
        target: '/usr/local/bin/iflow',
        reasonCode: 'NOT_FOUND',
      },
      {
        source: 'VERSION_MANAGER_SCAN',
        target: '/Users/demo/.nvm/versions/node/v22/bin/iflow',
        reasonCode: 'NOT_EXECUTABLE',
      },
    ];

    const summary = buildDiscoveryFailureSummary(diagnostics, 'linux');
    assert.strictEqual(summary.attemptCount, 3);
    assert.strictEqual(summary.primaryReason, 'NOT_FOUND');
    assert.ok(summary.userMessage.includes('3 attempt(s)'));
    assert.ok(summary.userMessage.includes('NOT_FOUND'));
    assert.ok(summary.userMessage.includes('PATH'));
  });

  test('keeps user summary normalized and free of raw OS error text', () => {
    const diagnostics: DiscoveryAttemptDiagnostic[] = [
      {
        source: 'PATH_LOOKUP',
        target: 'which iflow',
        reasonCode: 'PERMISSION_DENIED',
        detail: 'spawn EACCES: permission denied',
      },
      {
        source: 'KNOWN_LOCATIONS',
        target: '/usr/local/bin/iflow',
        reasonCode: 'NOT_EXECUTABLE',
        detail: 'X_OK check failed',
      },
    ];

    const summary = buildDiscoveryFailureSummary(diagnostics, 'linux');
    assert.ok(summary.userMessage.includes('Reason:'));
    assert.match(
      summary.userMessage,
      /(PERMISSION_DENIED|NOT_EXECUTABLE|NOT_FOUND|COMMAND_FAILED|UNKNOWN)/,
    );
    assert.ok(!summary.userMessage.toLowerCase().includes('eacces'));
    assert.ok(!summary.userMessage.toLowerCase().includes('x_ok'));
    assert.ok(summary.userMessage.includes('Action:'));
  });
});
