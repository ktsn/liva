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
  await expect(page.locator("[data-liva-editor] .editor")).toHaveCSS("position", "fixed");
  await expect(page.locator("[data-liva-editor] .panel")).toHaveCSS("padding", "20px");
  await expect(page.locator("[data-liva-editor] .actions")).toHaveCSS("position", "sticky");
  await expect(page.locator("[data-liva-editor] .field").first()).toHaveCSS(
    "border-left-width",
    "2px",
  );
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
    await page.getByText("Create a directional timing override", { exact: true }).click();
    await page.getByLabel("Override timing", { exact: true }).fill("tween(duration: 100ms)");
    await page.getByRole("button", { name: "Add override to draft" }).click();
    await expect(page.getByRole("status")).toContainText("Previewing");
    await page.getByRole("button", { name: "Save to source" }).click();
    await expect(page.getByRole("status")).toContainText("All shared instances are synchronized");

    await page.getByText("Add or remove a keyframe", { exact: true }).click();
    await page.getByLabel("New frame value", { exact: true }).fill("purple");
    await page.getByRole("button", { name: "Add frame to draft" }).click();
    await expect(page.getByRole("status")).toContainText("Previewing");
    await page.getByRole("button", { name: "Save to source" }).click();
    await expect(page.getByRole("status")).toContainText("All shared instances are synchronized");
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("value: purple");
    expect(saved.slice(0, saved.indexOf("<liva>"))).toBe(
      original.slice(0, original.indexOf("<liva>")),
    );
    await page.getByText("Add or remove a keyframe", { exact: true }).click();
    await page.getByRole("button", { name: "Remove 0.5 frame", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Previewing");
    await page.getByRole("button", { name: "Save to source" }).click();
    await expect(page.getByRole("status")).toContainText("All shared instances are synchronized");
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

test("debounced Vue form preview follows the latest destination and yields to app state", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByRole("button", { name: "Motion editor", exact: true }).click();
  const path = "toggle/transition/general/target/track/property/background-color/timing/duration";
  await expect(page.locator(`input:not([type="range"])[data-path="${path}"]`)).toBeVisible();

  await page.evaluate((path) => {
    const shadow = document.querySelector("[data-liva-editor]")!.shadowRoot!;
    const input = shadow.querySelector<HTMLInputElement>(
      `input:not([type="range"])[data-path="${path}"]`,
    )!;
    input.value = "100ms";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const destination = shadow.querySelector<HTMLSelectElement>(
      '[aria-label="Preview destination"]',
    )!;
    destination.value = "off";
    destination.dispatchEvent(new Event("change", { bubbles: true }));
  }, path);

  await expect(page.getByRole("status")).toContainText("Previewing");
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  const first = page.getByRole("switch", { name: "Notifications" });
  await expect(first).toHaveCSS("background-color", "rgb(136, 136, 136)");

  await page.evaluate((path) => {
    const shadow = document.querySelector("[data-liva-editor]")!.shadowRoot!;
    const input = shadow.querySelector<HTMLInputElement>(
      `input:not([type="range"])[data-path="${path}"]`,
    )!;
    input.value = "150ms";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[aria-label="Notifications"]')!.click();
  }, path);

  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(first).toHaveCSS("background-color", "rgb(52, 178, 123)");
  await expect(page.getByRole("status")).toContainText("Application state superseded");
  await expect(page.locator(`input:not([type="range"])[data-path="${path}"]`)).toHaveValue("150ms");
});
