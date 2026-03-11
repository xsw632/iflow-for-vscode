import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { ExtensionMessage } from "../protocol";

suite("Settings Infrastructure", () => {
  test("ExtensionMessage accepts settingsUpdated variant", () => {
    // Compile-time type check: this assignment must type-check
    const msg: ExtensionMessage = {
      type: "settingsUpdated",
      settings: { showCwdBar: true },
    };
    assert.strictEqual(msg.type, "settingsUpdated");
    assert.strictEqual(msg.settings.showCwdBar, true);
  });

  test("package.json has iflow.showStatusBar with type boolean and default true", () => {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const props = pkg.contributes.configuration.properties;
    const setting = props["iflow.showStatusBar"];

    assert.ok(setting, "iflow.showStatusBar should exist in package.json");
    assert.strictEqual(setting.type, "boolean");
    assert.strictEqual(setting.default, true);
  });
});
