import { expect, test } from "@playwright/test";

test("boots the real browser client, loads runtime assets, and exposes an accessible settings dialog", async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRuntimeResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (/\.(glb|wasm|js)$/.test(url) || url.includes("/src/")) failedRuntimeResponses.push(`FAILED ${url}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400 && (/\.(glb|wasm|js)$/.test(url) || url.includes("/src/"))) {
      failedRuntimeResponses.push(`${response.status()} ${url}`);
    }
  });

  await page.goto("/");
  const canvas = page.locator("canvas#app");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).height)).toBeGreaterThan(0);

  const settingsButton = page.getByRole("button", { name: "Open settings" });
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByRole("dialog", { name: "SETTINGS" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#vg-settings-dialog :focus")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();

  await page.waitForTimeout(1500);
  expect(pageErrors).toEqual([]);
  expect(failedRuntimeResponses).toEqual([]);
});
