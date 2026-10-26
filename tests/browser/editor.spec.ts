import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:4180";
test.describe.configure({ mode: "serial" });
const file = new URL("../../playground/tests/EditorToggle.vue", import.meta.url);

async function open(page: Page, fixture = false) {
  await page.goto(fixture ? `${base}/tests/editor.html` : base);
  await page.getByRole("button", { name: "Motion editor", exact: true }).click();
  await expect(page.getByLabel("Playhead")).toBeVisible();
}

async function seek(page: Page, time: number) {
  await page.getByLabel("Playhead").evaluate((element, time) => {
    (element as HTMLInputElement).value = String(time);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, time);
  await expect(page.getByRole("status")).toContainText("Previewing");
}

async function track(page: Page, target: string, property: string) {
  const toggle = page.getByRole("button", { name: `Toggle ${target} tracks` });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByRole("button", { name: `Select ${target}.${property}`, exact: true }).click();
}

async function save(page: Page) {
  await expect(page.getByRole("status")).toContainText("Previewing");
  await page.getByRole("button", { name: "Save to source" }).click();
  await expect(page.getByRole("status")).toContainText("All shared instances are synchronized");
}

test("docked timeline scrubs both ways, isolates instances, and yields to application state", async ({
  page,
}) => {
  await open(page);
  const first = page.getByRole("switch", { name: "Notifications", exact: true });
  const second = page.getByRole("switch", { name: "Product updates", exact: true });
  await expect(page.locator("[data-liva-editor] .editor")).toHaveCSS("position", "fixed");
  await expect(page.getByRole("button", { name: "Toggle thumb tracks" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await track(page, "thumb", "scale");
  await expect(page.locator('[data-track="thumb.scale"] .key')).toHaveCount(4);

  await seek(page, 350);
  await expect(first).toHaveCSS("background-color", "rgb(52, 178, 123)");
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect(second).toHaveCSS("background-color", "rgb(136, 136, 136)");
  await seek(page, 0);
  await expect(first).toHaveCSS("background-color", "rgb(136, 136, 136)");
  await seek(page, 100);
  await expect
    .poll(() => first.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe("rgb(136, 136, 136)");

  await page.getByRole("button", { name: "End preview", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(first).toHaveCSS("background-color", "rgb(136, 136, 136)");
  await seek(page, 100);
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("status")).toContainText("Application state superseded");
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(first).toHaveCSS("background-color", "rgb(52, 178, 123)");
});

test("editing inherited keys copies the collection, rejects collisions, and restores inheritance", async ({
  page,
}) => {
  await open(page);
  await track(page, "thumb", "scale");
  await page.getByRole("button", { name: "thumb.scale 40%", exact: true }).click();
  await expect(page.getByText("Inherited common keyframe", { exact: true })).toBeVisible();
  await page.getByLabel("Keyframe value", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "Apply keyframe", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await expect(page.locator('[data-track="thumb.scale"] .key')).toHaveCount(4);
  await expect(page.getByText("Local keyframe", { exact: true })).toBeVisible();

  await page.getByLabel("Keyframe percentage", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Apply keyframe", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("already exists");
  await expect(page.getByRole("button", { name: "thumb.scale 40%", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use common keyframes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await expect(page.getByLabel("Keyframe value", { exact: true })).toHaveValue("1.3 1");
});

test("duration edits preserve offsets and spring tracks reject intermediate keys", async ({
  page,
}) => {
  await open(page);
  await track(page, "thumb", "scale");
  await page.getByLabel("Track duration", { exact: true }).fill("700");
  await page.getByRole("button", { name: "Apply timing", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await page.getByRole("button", { name: "thumb.scale 40%", exact: true }).click();
  await expect(page.getByLabel("Keyframe time", { exact: true })).toHaveValue("280");

  await track(page, "thumb", "translate");
  await expect(page.getByLabel("Timing mode", { exact: true })).toHaveValue("spring-physics");
  await expect(page.getByRole("button", { name: "New keyframe at playhead" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Resize thumb.translate" })).toHaveCount(0);
  await page.getByLabel("Timing mode", { exact: true }).selectOption("spring-duration");
  await page.getByLabel("Track duration", { exact: true }).fill("400");
  await page.getByRole("button", { name: "Apply timing", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await expect(page.getByRole("button", { name: "Resize thumb.translate" })).toBeVisible();
});

test("playback pauses and close releases preview effects while retaining draft", async ({
  page,
}) => {
  await open(page);
  await track(page, "thumb", "scale");
  await page.getByLabel("Track duration", { exact: true }).fill("3000");
  await page.getByRole("button", { name: "Apply timing", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.getByLabel("Playhead").inputValue()).not.toBe("0");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const time = await page.getByLabel("Playhead").inputValue();
  await expect(page.getByLabel("Playhead")).toHaveValue(time);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  await page.getByRole("button", { name: "Motion editor", exact: true }).click();
  await expect(page.getByLabel("Track duration", { exact: true })).toHaveValue("3000");
});

test("timeline saves timing, new frames and endpoint state values with shared HMR", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Shared source writes run once");
  const original = await readFile(file, "utf8");
  try {
    await open(page, true);
    await track(page, "box", "background-color");
    await page.getByLabel("Track duration", { exact: true }).fill("200");
    await page.getByRole("button", { name: "Apply timing", exact: true }).click();
    await seek(page, 100);
    await page.getByRole("button", { name: "New keyframe at playhead" }).click();
    await page.getByLabel("Keyframe value", { exact: true }).fill("purple");
    await page.getByRole("button", { name: "Add keyframe", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Previewing");
    expect(await readFile(file, "utf8")).toBe(original);
    await save(page);

    const saved = await readFile(file, "utf8");
    expect(saved).toContain("transition off -> on");
    expect(saved).toContain("duration: 200ms");
    expect(saved).toContain("50%");
    expect(saved).toContain("value: purple");
    expect(saved.slice(0, saved.indexOf("<liva>"))).toBe(
      original.slice(0, original.indexOf("<liva>")),
    );
    await track(page, "box", "background-color");
    await page.getByRole("button", { name: "box.background-color 50%", exact: true }).click();
    await page.getByRole("button", { name: "Delete keyframe", exact: true }).click();
    await save(page);
    expect(await readFile(file, "utf8")).not.toContain("purple");

    await track(page, "box", "background-color");
    await page.getByRole("button", { name: "Use common keyframes", exact: true }).click();
    await page.getByRole("button", { name: "box.background-color 100%", exact: true }).click();
    await page.getByLabel("Keyframe value", { exact: true }).fill("green");
    await page.getByRole("button", { name: "Update state value", exact: true }).click();
    await save(page);
    expect(await readFile(file, "utf8")).toContain("background-color: green");
  } finally {
    await writeFile(file, original);
  }
});

test("editor rejects invalid sessions, origins, hosts and oversized requests", async ({ page }) => {
  await page.goto(base);
  const module = await (await page.request.get(`${base}/@id/__x00__liva:vue-plugin`)).text();
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

test("pointer editing adds and moves keys and resizes duration in real time", async ({ page }) => {
  await open(page, true);
  await track(page, "box", "background-color");
  const lane = page.locator('[data-track="box.background-color"]');
  const bounds = (await lane.boundingBox())!;

  await lane.dblclick({ position: { x: bounds.width * 0.2, y: 18 }, modifiers: ["Alt"] });
  await page.getByLabel("Keyframe percentage", { exact: true }).fill("40");
  await page.getByLabel("Keyframe value", { exact: true }).fill("purple");
  await page.getByRole("button", { name: "Add keyframe", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");

  const key = page.getByRole("button", { name: "box.background-color 40%", exact: true });
  const keyBounds = (await key.boundingBox())!;
  await page.mouse.move(keyBounds.x + keyBounds.width / 2, keyBounds.y + keyBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.3, keyBounds.y + keyBounds.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "box.background-color 60%", exact: true }),
  ).toBeVisible();

  const handle = page.getByRole("button", { name: "Resize box.background-color", exact: true });
  const handleBounds = (await handle.boundingBox())!;
  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.8, handleBounds.y + handleBounds.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(page.getByLabel("Track duration", { exact: true })).toHaveValue("80");
  await page.getByRole("button", { name: "box.background-color 60%", exact: true }).click();
  await expect(page.getByLabel("Keyframe time", { exact: true })).toHaveValue("48");
});

test("selection, discard, close and application updates invalidate pending previews", async ({
  page,
}) => {
  await open(page);
  const options = await page
    .getByLabel("Preview instance")
    .locator("option")
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  await page.getByLabel("Preview instance").selectOption(options[2]);
  await expect(page.getByLabel("Playhead")).toBeVisible();
  await track(page, "thumb", "scale");
  await page.getByLabel("Track duration", { exact: true }).fill("600");
  await page.getByRole("button", { name: "Apply timing", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByLabel("Playhead")).toBeVisible();
  await track(page, "thumb", "scale");
  await expect(page.getByLabel("Track duration", { exact: true })).toHaveValue("350");

  for (const action of ["close", "application"] as const) {
    await page.getByLabel("Track duration", { exact: true }).fill("600");
    await page.evaluate((action) => {
      const shadow = document.querySelector("[data-liva-editor]")!.shadowRoot!;
      const buttons = [...shadow.querySelectorAll("button")];
      buttons.find((button) => button.textContent?.trim() === "Apply timing")!.click();
      if (action === "close")
        buttons.find((button) => button.textContent?.trim() === "Close")!.click();
      else document.querySelector<HTMLButtonElement>('[aria-label="Product updates"]')!.click();
    }, action);

    // Observe beyond the 150ms debounce, so a canceled preview cannot pass early.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__LIVA_EDITOR__.previewActive)).toBe(false);
    if (action === "close")
      await page.getByRole("button", { name: "Motion editor", exact: true }).click();
    await expect(page.getByLabel("Track duration", { exact: true })).toHaveValue("600");
  }
});

test("manual scrubbing survives reduced-motion changes and unmount releases effects", async ({
  page,
}) => {
  await open(page);
  const first = page.getByRole("switch", { name: "Notifications", exact: true });
  await seek(page, 100);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seek(page, 0);
  await expect(first).toHaveCSS("background-color", "rgb(136, 136, 136)");
  await seek(page, 350);
  await expect(first).toHaveCSS("background-color", "rgb(52, 178, 123)");

  await page
    .getByRole("button", { name: "Unmount switches", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => (window as any).__LIVA_EDITOR__.previewActive)).toBe(false);
});

test("enabling reduced motion during Play settles immediately but still allows scrubbing", async ({
  page,
}) => {
  await open(page);
  await track(page, "thumb", "scale");
  await page.getByLabel("Track duration", { exact: true }).fill("3000");
  await page.getByRole("button", { name: "Apply timing", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByLabel("Playhead")).toHaveValue("3000");
  await seek(page, 0);
  await expect(page.getByRole("switch", { name: "Notifications", exact: true })).toHaveCSS(
    "background-color",
    "rgb(136, 136, 136)",
  );
});

test("an unsettled spring keeps its parameter controls available for correction", async ({
  page,
}) => {
  await page.route("**/__liva/editor", async (route) => {
    const response = await route.fetch();
    const reply = await response.json();
    if (route.request().postDataJSON().action === "inspect") {
      const property = reply.definition.generalTransition.targets
        .find((target: any) => target.name === "thumb")
        .properties.find((property: any) => property.name === "translate");
      property.timing.damping = 0.000001;
    }
    await route.fulfill({ response, json: reply });
  });
  await open(page);
  await track(page, "thumb", "translate");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();

  await page.getByLabel("Damping", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Apply timing", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Previewing");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
});
