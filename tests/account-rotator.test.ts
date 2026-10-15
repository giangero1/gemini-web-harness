import assert from "assert";
import { AccountRotator } from "../src/bridge/account-rotator";

console.log("--- Starting AccountRotator Unit Tests ---");

// Test 1: URL generation
assert.strictEqual(AccountRotator.getAccountUrl(0), "https://gemini.google.com/u/0/app");
assert.strictEqual(AccountRotator.getAccountUrl(3), "https://gemini.google.com/u/3/app");
console.log("✓ Test 1 Passed: Account URL generation");

// Test 2: Rate limiting with 12h format
const testSlot = 4;
AccountRotator.markRateLimited(testSlot, "Limit resets 4:30 AM");
const slots = AccountRotator.getAllSlots();
const s4 = slots.find((s) => s.slot === testSlot);
assert.ok(s4?.rateLimited, "Slot 4 should be marked as rate-limited");
assert.ok(s4?.rateLimitedUntil && s4.rateLimitedUntil > Date.now(), "rateLimitedUntil should be in future");
console.log("✓ Test 2 Passed: 12-hour AM/PM rate limit parsing");

// Test 3: Rate limiting with relative duration
AccountRotator.markRateLimited(testSlot, "Resets in 2 hours");
const slotsRel = AccountRotator.getAllSlots();
const s4Rel = slotsRel.find((s) => s.slot === testSlot);
assert.ok(s4Rel?.rateLimited);
const expectedMin = Date.now() + 115 * 60 * 1000;
const expectedMax = Date.now() + 125 * 60 * 1000;
assert.ok(s4Rel.rateLimitedUntil! >= expectedMin && s4Rel.rateLimitedUntil! <= expectedMax, "Should parse ~2 hours relative duration");
console.log("✓ Test 3 Passed: Relative duration parsing");

// Test 4: Slot availability navigation
const state = AccountRotator.loadState();
state[testSlot] = {
  slot: testSlot,
  url: AccountRotator.getAccountUrl(testSlot),
  rateLimited: false,
};
AccountRotator.saveState(state);
const slotsAfter = AccountRotator.getAllSlots();
assert.strictEqual(slotsAfter.find((s) => s.slot === testSlot)?.rateLimited, false);
console.log("✓ Test 4 Passed: Slot state persistence & recovery");

console.log("--- All AccountRotator Tests Passed! ---");
