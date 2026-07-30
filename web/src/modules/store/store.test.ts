import { describe, it, expect } from "vitest";
import manifest from "./manifest";
import { appRegistryStore } from "../../store/registry";
import { get } from "svelte/store";

describe("Store Module", () => {
  it("exports a valid system app manifest", () => {
    expect(manifest.id).toBe("store");
    expect(manifest.name).toBe("Store");
    expect(manifest.author).toBe("gPhone");
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).toContain("network");
  });

  it("is registered in appRegistryStore automatically", () => {
    const apps = get(appRegistryStore);
    const storeApp = apps.find((a) => a.id === "store");
    expect(storeApp).toBeDefined();
    expect(storeApp?.name).toBe("Store");
  });

  it("prohibits unregistering the Store system app", () => {
    expect(() => appRegistryStore.unregisterApp("store")).toThrow(
      "gPhone App Registry error: Unregistering system app 'store' is prohibited."
    );
  });
});
