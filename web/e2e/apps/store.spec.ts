import { test, expect } from "@playwright/test";

test.describe("Store E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("button", { hasText: "Store" }).first().click();
    await expect(page.locator("h1", { hasText: "Store" })).toBeVisible();
  });

  test("renders tabs and catalog apps correctly", async ({ page }) => {
    await expect(page.locator("button", { hasText: "Store Catalog" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Installed (" })).toBeVisible();
    await expect(page.locator("text=Crypto Tracker")).toBeVisible();
    await expect(page.locator("text=Chirper")).toBeVisible();
  });

  test("opens app permission and details inspector modal", async ({ page }) => {
    await page.locator("text=Crypto Tracker").first().click();

    await expect(page.locator("h3", { hasText: "Crypto Tracker" })).toBeVisible();
    await expect(page.locator("text=Network Access")).toBeVisible();
    await expect(page.locator("text=Local Storage")).toBeVisible();
    await expect(page.locator("text=Satoshi Labs")).toBeVisible();
  });

  test("installs community add-on app and verifies icon appears on home screen", async ({ page }) => {
    // Click Install button on Crypto Tracker specifically
    const installBtn = page.locator("div.rounded-xl", { hasText: "Crypto Tracker" }).locator("button", { hasText: "Install" });
    await installBtn.click();

    // Verify toast or button state updates
    await expect(page.locator("text=installed successfully")).toBeVisible();

    // Go back home
    await page.locator("button[aria-label='Back to Home']").click();

    // Verify new Crypto Tracker app icon exists on home screen
    await expect(page.locator("button", { hasText: "Crypto Tracker" })).toBeVisible();
  });

  test("displays installed system vs add-on filter in Installed tab", async ({ page }) => {
    await page.locator("button", { hasText: "Installed (" }).click();

    await expect(page.locator("button", { hasText: "System" }).first()).toBeVisible();
    await expect(page.locator("button", { hasText: "Add-ons" }).first()).toBeVisible();

    // System apps should display "System" badge
    await expect(page.locator("text=System").first()).toBeVisible();
  });
});
