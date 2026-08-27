import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("asset detail responsive styles", () => {
  it("keeps the upload role label on one line without shrinking the upload action", () => {
    expect(styles).toMatch(/\.asset-reference-actions\.upload-only\{grid-template-columns:minmax\(132px,max-content\) minmax\(0,1fr\)\}/);
    expect(styles).toMatch(/\.asset-upload-role\{[^}]*white-space:nowrap[^}]*font-size:11px!important[^}]*\}/);
  });

  it("stacks the upload controls on narrow screens", () => {
    expect(styles).toMatch(/@media\(max-width:650px\)\{\.asset-reference-actions\.upload-only\{grid-template-columns:1fr\}/);
  });

  it("places image upload before the long prompt panel", () => {
    expect(styles).toMatch(/\.asset-reference-workbench>\.asset-reference-actions\.upload-only\{order:3\}/);
    expect(styles).toMatch(/\.asset-reference-workbench>\.asset-prompt-panel\{order:5\}/);
  });

  it("reserves a stable right-side preview rail without increasing card height", () => {
    expect(styles).toMatch(/\.asset-summary-card\{position:relative;align-self:stretch;min-height:176px/);
    expect(styles).toMatch(/\.asset-summary-card>\.asset-reference-preview\{position:absolute;top:76px;right:18px/);
    expect(styles).toMatch(/\.asset-summary-card>h3,\.asset-summary-card>p\{padding-right:170px\}/);
  });
});
