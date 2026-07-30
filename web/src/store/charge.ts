import { writable, derived } from "svelte/store";
import { isBrowser } from "../utils/isBrowser";

// Charge level between 0 and 100
export const charge = writable<number>(100);

// Rounded to nearest hundredth (2 decimal places)
export const roundedCharge = derived(charge, ($charge) => {
    return Math.round(Math.max(0, Math.min(100, $charge)) * 100) / 100;
});

// Display percentage using Math.ceil so non-zero values (like 0.49) display as 1% instead of 0%
export const displayCharge = derived(roundedCharge, ($roundedCharge) => {
    if ($roundedCharge <= 0) return 0;
    return Math.ceil($roundedCharge);
});

// Flag indicating if the battery is completely drained
export const isDead = derived(roundedCharge, ($roundedCharge) => {
    return $roundedCharge <= 0;
});

// Simulate battery deterioration in browser dev mode (outside FiveM NUI)
if (isBrowser()) {
    let lastTime = Date.now();
    let drainMultiplier = 1.0; // Standard 1x speed (1% per minute)

    setInterval(() => {
        const now = Date.now();
        const deltaSeconds = (now - lastTime) / 1000;
        lastTime = now;

        const drainPerSecond = (1.0 / 60) * drainMultiplier;
        charge.update(($charge) => Math.max(0, $charge - (drainPerSecond * deltaSeconds)));
    }, 1000);

    // Browser dev helpers available in browser console (F12):
    // - setBattery(50)       -> Set battery level to 50%
    // - setDrainSpeed(10)    -> Speed up battery drain by 10x for testing
    (window as any).setBattery = (val: number) => {
        lastTime = Date.now();
        charge.set(val);
    };
    (window as any).setDrainSpeed = (multiplier: number) => {
        drainMultiplier = multiplier;
        console.log(`[gPhone] Battery drain speed set to ${multiplier}x`);
    };
}
