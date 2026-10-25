import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:4180";
test.describe.configure({ mode: "serial" });
const file = new URL("../../playground/tests/EditorToggle.vue", import.meta.url);

test("editor isolates previews and restores the latest application state on cancel", async ({
  page,
}) => {
  await page.goto(base);
  const first = page.getByRole("switch", { name: "Notifications", exact: true });
  const second = page.getByRole("switch", { name: "Product updates", exact: true });
  await page.getByRole("button", { name: "Motion editor", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(first).toHaveCSS("background-color", "rgb(52, 178, 123)");
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect(second).toHaveCSS("background-color", "rgb(136, 136, 136)");

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await first.click();
  await page.getByRole("button", { name: "Motion editor", exact: true }).click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Cancel draft" }).click();
  await expect(first).toHaveCSS("background-color", "rgb(52, 178, 123)");
  await expect(second).toHaveCSS("background-color", "rgb(136, 136, 136)");
});

test("editor saves one source transaction and synchronizes every shared instance", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Shared source writes run once");
  const original = await readFile(file, "utf8");
  try {
    await page.goto(`${base}/tests/editor.html`);
    await page.getByRole("button", { name: "Motion editor", exact: true }).click();
    const duration = page.locator(
      'input:not([type="range"])[data-path="motion/transition/general/timing/duration"]',
    );
    await duration.fill("180ms");
    await duration.dispatchEvent("change");
    await expect(page.getByRole("status")).toContainText("Previewing");
    expect(await readFile(file, "utf8")).toBe(original);

    await page.getByRole("button", { name: "Save to source" }).click();
    await expect(page.getByRole("status")).toContainText("All shared instances are synchronized");
    expect(await readFile(file, "utf8")).toBe(original.replace("50ms", "180ms"));
    expect(
      await page.evaluate(() =>
        [...(window as any).__LIVA_EDITOR__.entries.values()].map(
          (e: any) => e.binding.definition.generalTransition.timing.durationMs,
        ),
      ),
    ).toEqual([180, 180]);
    await expect(duration).toHaveValue("180ms");
  } finally {
    await writeFile(file, original);
  }
});

test("editor inserts overrides and frames and removes frames through guarded saves", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Shared source writes run once");
  const original = await readFile(file, "utf8");
  try {
    await page.goto(`${base}/tests/editor.html`);
    await page.getByRole("button", { name: "Motion editor", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save to source" })).toBeVisible();
    await page.evaluate(async () => {
      const editor = (window as any).__LIVA_EDITOR__;
      editor.setDraft([
        {
          op: "override",
          definition: "motion",
          from: "off",
          to: "on",
          target: "box",
          property: "background-color",
          timing: "tween(duration: 100ms)",
        },
        {
          op: "addFrame",
          path: "motion/transition/directional/off/on/target/box/property/background-color",
          offset: 0.5,
          value: "purple",
        },
      ]);
      await editor.preview("on");
      await editor.commit();
    });
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("value: purple");
    expect(saved.slice(0, saved.indexOf("<liva>"))).toBe(
      original.slice(0, original.indexOf("<liva>")),
    );
    await page.evaluate(async () => {
      const editor = (window as any).__LIVA_EDITOR__;
      editor.setDraft([
        {
          op: "removeFrame",
          path: "motion/transition/directional/off/on/target/box/property/background-color/frame/0.5",
        },
      ]);
      await editor.commit();
    });
    expect(await readFile(file, "utf8")).not.toContain("value: purple");
    await expect(page.getByRole("status")).toContainText("All shared instances are synchronized");
  } finally {
    await writeFile(file, original);
  }
});

test("editor rejects invalid sessions, origins, hosts and oversized requests", async ({ page }) => {
  await page.goto(base);
  const module = await (await page.request.get(`${base}/@id/__x00__virtual:liva-plugin`)).text();
  const token = module.match(/createDevPlugin\("([^"]+)"\)/)![1];
  const headers = { "X-Liva-Session": token, Origin: base, "Content-Type": "application/json" };
  for (const invalid of [
    { "X-Liva-Session": "invalid" },
    { Origin: "https://example.com" },
    { Host: "example.com:4180" },
  ] as Record<string, string>[]) {
    const response = await page.request.post(`${base}/__liva/editor`, {
      headers: { ...headers, ...invalid },
      data: {},
    });
    expect(response.status()).toBe(403);
  }
  const oversized = await page.request.post(`${base}/__liva/editor`, {
    headers,
    data: "x".repeat(65537),
  });
  expect(oversized.status()).toBe(413);
});

test("pending mode changes and removed frames disable conflicting parameter controls", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByRole("button", { name: "Motion editor", exact: true }).click();
  const timing = page.locator(
    '[data-path="toggle/transition/general/target/thumb/property/translate/timing"]',
  );
  await timing.fill("spring(duration: 400ms, bounce: 0.2)");
  await timing.dispatchEvent("change");
  await expect(
    page.locator(
      '[data-path="toggle/transition/general/target/thumb/property/translate/timing/stiffness"]',
    ),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel draft" }).click();
  await page.getByText("Add or remove a keyframe", { exact: true }).click();
  await page.getByRole("button", { name: "Remove 0.4 frame", exact: true }).click();
  await expect(
    page.locator(
      '[data-path="toggle/transition/general/target/thumb/property/scale/frame/0.4/value"]',
    ),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Previewing");
});
