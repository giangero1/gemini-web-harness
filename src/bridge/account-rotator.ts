import fs from "fs";
import path from "path";

export interface AccountSlot {
  slot: number; // 0, 1, 2, 3, 4 ... maps to /u/0/app, /u/1/app
  url: string;
  email?: string;
  rateLimited: boolean;
  rateLimitedUntil?: number; // epoch ms
  resetTimeText?: string;
}

export class AccountRotator {
  private static stateFile = path.resolve(process.env.HARNESS_ROOT || "D:\\gemini-web-harness", ".account-pool.json");
  private static currentSlot = 0;
  private static maxSlots = 5;

  public static getAccountUrl(slot: number): string {
    return `https://gemini.google.com/u/${slot}/app`;
  }

  public static getCurrentSlot(): number {
    return this.currentSlot;
  }

  public static setCurrentSlot(slot: number): void {
    if (slot >= 0 && slot < this.maxSlots) {
      this.currentSlot = slot;
      const state = this.loadState();
      if (!state[slot]) {
        state[slot] = {
          slot,
          url: this.getAccountUrl(slot),
          rateLimited: false,
        };
      }
      this.saveState(state);
    }
  }

  public static loadState(): Record<number, AccountSlot> {
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      }
    } catch {}

    const defaultState: Record<number, AccountSlot> = {};
    for (let i = 0; i < this.maxSlots; i++) {
      defaultState[i] = {
        slot: i,
        url: this.getAccountUrl(i),
        rateLimited: false,
      };
    }
    return defaultState;
  }

  public static saveState(slots?: Record<number, AccountSlot>): void {
    try {
      const state = slots || this.loadState();
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch (err: any) {
      console.warn("[AccountRotator] Failed to save account state:", err.message);
    }
  }

  private static isSlotCooldownActive(slotState: AccountSlot | undefined, now: number = Date.now()): boolean {
    if (!slotState || !slotState.rateLimited) return false;
    if (!slotState.rateLimitedUntil) return false;
    return slotState.rateLimitedUntil > now;
  }

  public static getAllSlots(): (AccountSlot & { isActive: boolean })[] {
    const state = this.loadState();
    const result: (AccountSlot & { isActive: boolean })[] = [];
    const now = Date.now();
    let dirty = false;

    for (let i = 0; i < this.maxSlots; i++) {
      const s: AccountSlot = state[i] || {
        slot: i,
        url: this.getAccountUrl(i),
        rateLimited: false,
      };

      if (s.rateLimited && !this.isSlotCooldownActive(s, now)) {
        s.rateLimited = false;
        delete s.rateLimitedUntil;
        delete s.resetTimeText;
        state[i] = s;
        dirty = true;
      }

      result.push({
        ...s,
        isActive: i === this.currentSlot,
      });
    }

    if (dirty) {
      this.saveState(state);
    }

    return result;
  }

  /**
   * Synchronizes rotator state with the active Chrome tab without navigating
   */
  public static async syncFromActiveTab(sendWs: (method: string, params?: any) => Promise<any>): Promise<{ slot: number; email?: string; modeText?: string }> {
    const res = await sendWs("Runtime.evaluate", {
      expression: `
        (function() {
          const url = window.location.href;
          const slotMatch = url.match(/\\/u\\/(\\d+)(\\/|$)/);
          const slot = slotMatch ? parseInt(slotMatch[1], 10) : 0;
          const avatar = document.querySelector('a[aria-label*="Google Account"], button[aria-label*="Google Account"], [aria-label*="Google Account:"]');
          const avatarAria = avatar ? avatar.getAttribute('aria-label') || '' : '';
          const emailMatch = avatarAria.match(/\\(([^)]+@[^)]+)\\)/) || avatarAria.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2})/);
          const email = emailMatch ? emailMatch[1] : undefined;
          const modeBtn = document.querySelector('[data-test-id="bard-mode-menu-button"]');
          return { slot, email, modeText: modeBtn ? modeBtn.innerText.trim() : null };
        })()
      `,
      returnByValue: true,
    });

    const val = res?.result?.value;
    if (val && typeof val.slot === "number" && val.slot >= 0 && val.slot < this.maxSlots) {
      this.currentSlot = val.slot;
      const state = this.loadState();
      const existing = state[val.slot];
      const stillLimited = this.isSlotCooldownActive(existing);

      const updated: AccountSlot = {
        ...(existing || {}),
        slot: val.slot,
        url: this.getAccountUrl(val.slot),
        email: val.email || existing?.email,
        rateLimited: stillLimited,
      };
      if (!stillLimited) {
        delete updated.rateLimitedUntil;
        delete updated.resetTimeText;
      }
      state[val.slot] = updated;
      this.saveState(state);
      return val;
    }
    return { slot: this.currentSlot };
  }

  /**
   * Parses reset time text (12h AM/PM, 24h HH:MM, or relative durations) into a cooldown duration in ms
   */
  public static parseCooldownMs(resetTimeText?: string, now: number = Date.now()): number {
    const defaultCooldownMs = 60 * 60 * 1000; // default 1 hour cooldown
    if (!resetTimeText || typeof resetTimeText !== "string") {
      return defaultCooldownMs;
    }

    // 1. Check relative duration strings (e.g. "in 2 hours", "in 45 minutes", "2 hr 30 min")
    const hoursRelMatch = resetTimeText.match(/\b(\d+)\s*(?:hours?|hrs?)\b/i);
    const minsRelMatch = resetTimeText.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i);
    if (hoursRelMatch || minsRelMatch) {
      const relHours = hoursRelMatch ? parseInt(hoursRelMatch[1], 10) : 0;
      const relMins = minsRelMatch ? parseInt(minsRelMatch[1], 10) : 0;
      const totalRelativeMs = (relHours * 60 + relMins) * 60 * 1000;
      if (totalRelativeMs > 0) {
        return Math.max(60_000, totalRelativeMs);
      }
    }

    // 2. Check 12-hour (AM/PM) or 24-hour clock format (e.g. "2:30 PM", "14:30", "02:15")
    const timeMatch = resetTimeText.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*(AM|PM))?\b/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const meridiem = timeMatch[3] ? timeMatch[3].toUpperCase() : undefined;

      if (meridiem) {
        if (hours < 1 || hours > 12) {
          return defaultCooldownMs;
        }
        if (meridiem === "PM" && hours < 12) hours += 12;
        if (meridiem === "AM" && hours === 12) hours = 0;
      }

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= now || /\btomorrow\b/i.test(resetTimeText)) {
        if (target.getTime() <= now) {
          target.setDate(target.getDate() + 1);
        }
      }
      return Math.max(60_000, target.getTime() - now);
    }

    return defaultCooldownMs;
  }

  /**
   * Marks a slot as rate-limited and estimates reset epoch ms
   */
  public static markRateLimited(slot: number, resetTimeText?: string): void {
    const state = this.loadState();
    const now = Date.now();
    const cooldownMs = this.parseCooldownMs(resetTimeText, now);

    state[slot] = {
      slot,
      url: this.getAccountUrl(slot),
      rateLimited: true,
      rateLimitedUntil: now + cooldownMs,
      resetTimeText: resetTimeText || "Cooldown active",
      email: state[slot]?.email,
    };

    console.log(`[AccountRotator] Account slot /u/${slot} marked as rate-limited until ${new Date(now + cooldownMs).toLocaleTimeString()} (${resetTimeText || "1h"})`);
    this.saveState(state);
  }

  /**
   * Finds the next available non-rate-limited slot in the pool without mutating currentSlot prematurely
   */
  public static getNextAvailableSlot(fromSlot: number = this.currentSlot): { slot: number; url: string } | null {
    const state = this.loadState();
    const now = Date.now();
    let dirty = false;
    let selected: { slot: number; url: string } | null = null;

    for (let offset = 1; offset <= this.maxSlots; offset++) {
      const candidate = (fromSlot + offset) % this.maxSlots;
      const s = state[candidate];
      const activeCooldown = this.isSlotCooldownActive(s, now);

      if (s && s.rateLimited && !activeCooldown) {
        s.rateLimited = false;
        delete s.rateLimitedUntil;
        delete s.resetTimeText;
        dirty = true;
      }

      if (!activeCooldown && !selected) {
        selected = { slot: candidate, url: this.getAccountUrl(candidate) };
      }
    }

    if (dirty) {
      this.saveState(state);
    }

    return selected;
  }

  /**
   * Navigates Chrome CDP session to the target account slot and waits for verified input box readiness
   */
  public static async switchToSlot(
    sendWs: (method: string, params?: any) => Promise<any>,
    slot: number
  ): Promise<{ success: boolean; url: string; email?: string; error?: string }> {
    const targetUrl = this.getAccountUrl(slot);
    console.log(`[AccountRotator] 🔄 Switching Chrome tab to Account slot #${slot}: ${targetUrl}...`);

    await sendWs("Page.navigate", { url: targetUrl });
    await new Promise((r) => setTimeout(r, 2000));

    // Wait for SPA hydration, verify landed slot URL, & dismiss onboarding modals safely
    const checkRes = await sendWs("Runtime.evaluate", {
      expression: `
        (async function() {
          const expectedSlot = ${slot};
          for (let i = 0; i < 30; i++) {
            const currentUrl = window.location.href || '';

            // Reject unauthenticated redirects to Google login pages
            if (currentUrl.includes('accounts.google.com') || currentUrl.includes('ServiceLogin')) {
              return {
                ready: false,
                url: currentUrl,
                error: 'Redirected to Google login page (account slot #' + expectedSlot + ' is not signed in)'
              };
            }

            // Verify the landed /u/{slot}/ matches the requested slot
            const slotMatch = currentUrl.match(/\\/u\\/(\\d+)(\\/|$)/);
            const landedSlot = slotMatch ? parseInt(slotMatch[1], 10) : 0;
            if (currentUrl.includes('gemini.google.com') && landedSlot !== expectedSlot) {
              return {
                ready: false,
                url: currentUrl,
                landedSlot,
                error: 'Redirected to /u/' + landedSlot + ' instead of requested /u/' + expectedSlot + ' (slot #' + expectedSlot + ' not signed in)'
              };
            }

            // Only click onboarding buttons inside dialogs/modals or actual button elements (never sidebar links)
            const modalBtns = Array.from(document.querySelectorAll('mat-dialog-container button, [role="dialog"] button, button'));
            const letsGo = modalBtns.find(b => {
              if (b.closest('nav, aside, [role="navigation"]')) return false;
              const t = (b.innerText || b.textContent || '').trim().toLowerCase();
              return t === "let's go" || t === "dismiss" || t === "got it";
            });
            if (letsGo) {
              letsGo.click();
              await new Promise(r => setTimeout(r, 300));
            }

            const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                          document.querySelector('div[contenteditable="true"]') ||
                          document.querySelector('textarea');

            // Detect email from avatar
            const avatar = document.querySelector('a[aria-label*="Google Account"], button[aria-label*="Google Account"], [aria-label*="Google Account:"]');
            const avatarAria = avatar ? avatar.getAttribute('aria-label') || '' : '';
            const emailMatch = avatarAria.match(/\\(([^)]+@[^)]+)\\)/) || avatarAria.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2})/);
            const email = emailMatch ? emailMatch[1] : undefined;

            if (input && landedSlot === expectedSlot) {
              return { ready: true, email: email, url: currentUrl, landedSlot };
            }
            await new Promise(r => setTimeout(r, 500));
          }
          return { ready: false, url: window.location.href, error: "Timed out waiting for input on account slot #" + expectedSlot };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const val = checkRes?.result?.value;
    if (val && val.ready) {
      const state = this.loadState();

      // Verify the detected email does not duplicate another signed-in slot (e.g. silent fallback to /u/0 account)
      if (val.email) {
        const normalizedEmail = val.email.toLowerCase();
        const duplicateSlot = Object.values(state).find(
          (s) => s && s.slot !== slot && s.email && s.email.toLowerCase() === normalizedEmail
        );
        if (duplicateSlot) {
          const dupMsg = `Account slot #${slot} resolved to duplicate email ${val.email} (already bound to slot #${duplicateSlot.slot})`;
          console.warn(`[AccountRotator] ⚠️ ${dupMsg}`);
          return { success: false, url: val.url || targetUrl, email: val.email, error: dupMsg };
        }
      }

      this.currentSlot = slot;
      const existing = state[slot];
      const stillLimited = this.isSlotCooldownActive(existing);

      const updatedSlot: AccountSlot = {
        ...(existing || {}),
        slot,
        url: targetUrl,
        email: val.email || existing?.email,
        rateLimited: stillLimited,
      };
      if (!stillLimited) {
        delete updatedSlot.rateLimitedUntil;
        delete updatedSlot.resetTimeText;
      }

      state[slot] = updatedSlot;
      this.saveState(state);
      console.log(`[AccountRotator] ✅ Successfully connected to Account slot #${slot} (${val.email || "Active"})`);
      return { success: true, url: val.url, email: val.email };
    }

    return { success: false, url: val?.url || targetUrl, error: val?.error || "Failed to switch account" };
  }
}
