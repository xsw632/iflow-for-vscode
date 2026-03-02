import * as assert from "assert";
import { escapeHtml } from "../shared/escapeHtml";

suite("escapeHtml", () => {
  test("escapes ampersand", () => {
    assert.strictEqual(escapeHtml("&"), "&amp;");
  });

  test("escapes less-than and greater-than in script tag", () => {
    assert.strictEqual(escapeHtml("<script>"), "&lt;script&gt;");
  });

  test("escapes double quotes", () => {
    assert.strictEqual(escapeHtml('"hello"'), "&quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    assert.strictEqual(escapeHtml("'test'"), "&#39;test&#39;");
  });

  test("leaves normal text unchanged", () => {
    assert.strictEqual(escapeHtml("normal text"), "normal text");
  });

  test("escapes all special chars in complex string", () => {
    assert.strictEqual(
      escapeHtml('<div class="foo">&bar</div>'),
      "&lt;div class=&quot;foo&quot;&gt;&amp;bar&lt;/div&gt;",
    );
  });

  test("returns empty string for empty input", () => {
    assert.strictEqual(escapeHtml(""), "");
  });
});
