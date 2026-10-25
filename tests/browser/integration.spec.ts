import { test, expect } from "@playwright/test";

const base = "http://127.0.0.1:4180";

test("real Vue switches remain independent and keyboard accessible through rapid reversals", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const first = page.getByRole("switch", { name: "Notifications" });
  const second = page.getByRole("switch", { name: "Product updates" });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(second).toHaveAttribute("aria-checked", "false");
  expect(await second.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(
    0,
  );

  for (let i = 0; i < 5; i++) await first.click();
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect
    .poll(() => first.evaluate((element) => element.getAnimations({ subtree: true }).length))
    .toBe(0);
  const thumb = first.locator(".thumb");
  await expect
    .poll(() => thumb.evaluate((element) => parseFloat(getComputedStyle(element).translate)))
    .toBe(0);
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Active", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  for (let i = 0; i < 3; i++) {
    await first.click();
    await page.getByRole("button", { name: "Unmount switches" }).click();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await page.getByRole("button", { name: "Mount switches" }).click();
    await expect(page.getByRole("switch")).toHaveCount(2);
    await expect(first).toHaveAttribute("aria-checked", "false");
  }

  expect(errors).toEqual([]);
});

test("nearest-root registration handles nested roots and conditional targets", async ({ page }) => {
  await page.goto(`${base}/tests/lifecycle.html`);
  const count = () => page.evaluate(() => (window as any).records.size);
  await expect.poll(count).toBe(2);
  expect(await page.evaluate(() => (window as any).diagnostics)).toEqual([]);
  await page.getByRole("button", { name: "Outer", exact: true }).click();
  await expect
    .poll(() =>
      page.locator("#outer-thumb").evaluate((e) => parseFloat(getComputedStyle(e).translate)),
    )
    .toBe(20);
  expect(
    await page.locator("#inner-thumb").evaluate((e) => parseFloat(getComputedStyle(e).translate)),
  ).toBe(0);

  await page.getByRole("button", { name: "Target", exact: true }).click();
  await page.getByRole("button", { name: "Outer", exact: true }).click();
  await page.getByRole("button", { name: "Target", exact: true }).click();
  await expect
    .poll(() =>
      page.locator("#outer-thumb").evaluate((e) => parseFloat(getComputedStyle(e).translate)),
    )
    .toBe(0);
  await page.getByRole("button", { name: "Inner", exact: true }).click();
  await page.getByRole("button", { name: "Mount", exact: true }).click();
  await expect.poll(count).toBe(0);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("invalid source retains last valid definition and fixed source resumes HMR", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "A shared source-writing HMR transaction runs once");
  const { readFile, writeFile } = await import("node:fs/promises");
  const file = new URL("../../playground/tests/Hmr.vue", import.meta.url);
  const original = await readFile(file, "utf8");

  try {
    await page.goto(`${base}/tests/hmr.html`);
    const button = page.getByRole("button");
    await expect(button).toHaveCSS("background-color", "rgb(255, 0, 0)");
    await writeFile(file, original.replace("50ms", "invalid"));
    await expect
      .poll(async () => (await page.request.get(`${base}/tests/Hmr.vue?raw`)).text())
      .toContain("invalid");
    await button.click();
    await expect(button).toHaveCSS("background-color", "rgb(0, 0, 255)");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);

    await writeFile(file, original.replace("background-color: red", "background-color: green"));
    await expect(button).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect.poll(() => button.evaluate((e) => e.getAnimations().length)).toBe(0);
  } finally {
    await writeFile(file, original);
  }
});
