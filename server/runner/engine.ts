// Executes one step against a Playwright page. Generic: no site-specific
// workarounds live here. Every wait is bounded and cancellable.
import type { BrowserContext, Frame, Locator, Page } from "playwright";
import type { Step } from "@shared/steps";
import { SECRET_REF } from "@shared/steps";
import { hostAllowed } from "../lib/netpolicy";

export type ErrorCategory =
  | "assertion"
  | "element_not_found"
  | "navigation"
  | "timeout"
  | "configuration"
  | "policy"
  | "cancelled"
  | "infrastructure";

export class StepFailure extends Error {
  constructor(
    message: string,
    public category: ErrorCategory,
  ) {
    super(message);
  }
}

export type RunState = {
  context: BrowserContext;
  page: Page;
  mainPage: Page;
  baseUrl: string;
  allowedHosts: string[];
  secrets: Map<string, string>;
  allowScripts: boolean;
  isCancelled: () => boolean;
  /** Set by the request guard when a navigation was refused. */
  policyViolation: string | null;
  screenshot: (label: string) => Promise<void>;
};

export function makeMasker(secrets: Map<string, string>) {
  const values = [...secrets.values()].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const v of values) out = out.split(v).join("••••••");
    return out;
  };
}

function interpolate(value: string, secrets: Map<string, string>): string {
  return value.replace(SECRET_REF, (_m, name: string) => {
    const v = secrets.get(name);
    if (v === undefined) throw new StepFailure(`Secret ${name} is not set in this workspace.`, "configuration");
    return v;
  });
}

function sleep(ms: number, state: RunState) {
  return new Promise<void>((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (state.isCancelled()) return reject(new StepFailure("Cancelled", "cancelled"));
      const left = end - Date.now();
      if (left <= 0) return resolve();
      setTimeout(tick, Math.min(250, left));
    };
    tick();
  });
}

function build(scope: Page | Frame, step: Step): Locator {
  const v = step.locatorValue ?? "";
  const exact = step.options.exact;
  let loc: Locator;
  switch (step.locatorType) {
    case "role":
      loc = scope.getByRole(v.trim() as Parameters<Page["getByRole"]>[0], { name: step.options.roleName, exact });
      break;
    case "label":
      loc = scope.getByLabel(v, { exact });
      break;
    case "text":
      loc = scope.getByText(v, { exact });
      break;
    case "placeholder":
      loc = scope.getByPlaceholder(v, { exact });
      break;
    case "test_id":
      loc = scope.getByTestId(v);
      break;
    case "xpath":
      loc = scope.locator(`xpath=${v}`);
      break;
    case "id":
      loc = scope.locator(`[id="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
      break;
    default:
      loc = scope.locator(v);
  }
  return step.options.nth !== undefined ? loc.nth(step.options.nth) : loc.first();
}

/** The frames to search: the one named in options.frame, or the page and all its frames. */
async function scopes(state: RunState, step: Step): Promise<(Page | Frame)[]> {
  if (step.options.frame) {
    const handle = await state.page.$(step.options.frame);
    const frame = await handle?.contentFrame();
    return frame ? [frame] : [];
  }
  return [state.page, ...state.page.frames().filter((f) => f !== state.page.mainFrame())];
}

async function poll<T>(state: RunState, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (state.isCancelled()) throw new StepFailure("Cancelled", "cancelled");
    if (state.policyViolation) throw new StepFailure(state.policyViolation, "policy");
    try {
      const r = await probe();
      if (r) return r as T;
    } catch {
      // frames detach mid-probe while pages navigate; try again
    }
    if (Date.now() >= end) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** First visible match in the page or any of its frames. */
async function findVisible(state: RunState, step: Step, timeoutMs: number): Promise<{ loc: Locator; where: string }> {
  const found = await poll(state, timeoutMs, async () => {
    for (const scope of await scopes(state, step)) {
      const loc = build(scope, step);
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        const where = scope === state.page ? "page" : `frame ${(scope as Frame).url().slice(0, 80) || "(inline)"}`;
        return { loc, where };
      }
    }
    return null;
  });
  if (!found) throw new StepFailure(`Couldn't find a visible element by ${describe(step)} within ${Math.round(timeoutMs / 1000)}s.`, "element_not_found");
  return found;
}

async function anyVisible(state: RunState, step: Step): Promise<boolean> {
  for (const scope of await scopes(state, step)) {
    const loc = build(scope, step);
    if ((await loc.count()) > 0 && (await loc.isVisible())) return true;
  }
  return false;
}

async function pageHasText(state: RunState, step: Step, text: string): Promise<boolean> {
  if (step.locatorType && step.locatorValue) {
    for (const scope of await scopes(state, step)) {
      const loc = build(scope, step);
      if ((await loc.count()) > 0 && (await loc.innerText({ timeout: 1000 })).includes(text)) return true;
    }
    return false;
  }
  for (const scope of await scopes(state, step)) {
    const body = await scope.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (body.includes(text)) return true;
  }
  return false;
}

function describe(step: Step): string {
  const v = step.locatorValue ?? "";
  const role = step.locatorType === "role" && step.options.roleName ? ` named “${step.options.roleName}”` : "";
  return `${step.locatorType} “${v.length > 80 ? v.slice(0, 77) + "…" : v}”${role}`;
}

export function resolveUrl(raw: string, baseUrl: string): URL {
  try {
    return new URL(raw, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  } catch {
    throw new StepFailure(`“${raw}” is not a valid URL.`, "configuration");
  }
}

function checkHost(url: URL, state: RunState) {
  if (!/^https?:$/.test(url.protocol)) throw new StepFailure(`Only http and https URLs can be opened (got ${url.protocol}).`, "policy");
  if (!hostAllowed(url.hostname, state.allowedHosts))
    throw new StepFailure(`${url.hostname} isn't in this environment's allowed hosts (${state.allowedHosts.join(", ")}).`, "policy");
}

/** Runs one step. Returns a short, human-readable log line (secrets unmasked; the caller masks). */
export async function runStep(state: RunState, step: Step, timeoutMs: number): Promise<string> {
  const t = step.options.timeoutMs ?? timeoutMs;
  const value = step.value ? interpolate(step.value, state.secrets) : "";
  const page = state.page;

  switch (step.action) {
    case "navigate": {
      const url = resolveUrl(value, state.baseUrl);
      checkHost(url, state);
      const res = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: Math.max(t, 30_000) }).catch((err: Error) => {
        if (state.policyViolation) throw new StepFailure(state.policyViolation, "policy");
        throw new StepFailure(`Couldn't open ${url.href}: ${err.message.split("\n")[0]}`, "navigation");
      });
      return `Opened ${url.href}${res ? ` (HTTP ${res.status()})` : ""}`;
    }
    case "refresh":
      await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(t, 30_000) });
      return "Reloaded the page";
    case "switch_to_new_tab": {
      const pages = state.context.pages();
      const newest = pages[pages.length - 1];
      if (!newest || newest === page) throw new StepFailure("No newer tab is open.", "element_not_found");
      await newest.waitForLoadState("domcontentloaded", { timeout: t });
      state.page = newest;
      return `Switched to the newest tab (${newest.url().slice(0, 120)})`;
    }
    case "switch_to_main_tab":
      state.page = state.mainPage;
      await state.page.bringToFront();
      return "Switched to the first tab";
    case "click": {
      const { loc, where } = await findVisible(state, step, t);
      if (step.options.opensNewTab) {
        const [popup] = await Promise.all([state.context.waitForEvent("page", { timeout: t }), loc.click({ timeout: t, force: step.options.force })]);
        await popup.waitForLoadState("domcontentloaded", { timeout: Math.max(t, 30_000) });
        state.page = popup;
        return `Clicked ${describe(step)} in the ${where}; continued in the new tab (${popup.url().slice(0, 120)})`;
      }
      await loc.click({ timeout: t, force: step.options.force });
      return `Clicked ${describe(step)} in the ${where}`;
    }
    case "fill": {
      const { loc, where } = await findVisible(state, step, t);
      if (step.options.typeSlowly) {
        await loc.fill("", { timeout: t });
        await loc.pressSequentially(value, { delay: 40, timeout: Math.max(t, value.length * 60) });
      } else await loc.fill(value, { timeout: t });
      return `Filled ${describe(step)} in the ${where} (${value.length} characters)`;
    }
    case "clear": {
      const { loc } = await findVisible(state, step, t);
      await loc.clear({ timeout: t });
      return `Cleared ${describe(step)}`;
    }
    case "select": {
      const { loc } = await findVisible(state, step, t);
      const chosen = await loc.selectOption({ label: value }, { timeout: t }).catch(() => loc.selectOption(value, { timeout: t }));
      return `Selected “${value}” (${chosen.join(", ")}) in ${describe(step)}`;
    }
    case "check":
    case "uncheck": {
      const { loc } = await findVisible(state, step, t);
      if (step.action === "check") await loc.check({ timeout: t, force: step.options.force });
      else await loc.uncheck({ timeout: t, force: step.options.force });
      return `${step.action === "check" ? "Checked" : "Unchecked"} ${describe(step)}`;
    }
    case "hover": {
      const { loc } = await findVisible(state, step, t);
      await loc.hover({ timeout: t });
      return `Hovered ${describe(step)}`;
    }
    case "press": {
      if (step.locatorType && step.locatorValue) {
        const { loc } = await findVisible(state, step, t);
        await loc.press(value, { timeout: t });
        return `Pressed ${value} on ${describe(step)}`;
      }
      await page.keyboard.press(value);
      return `Pressed ${value}`;
    }
    case "scroll": {
      if (step.locatorType && step.locatorValue) {
        const { loc } = await findVisible(state, step, t);
        await loc.scrollIntoViewIfNeeded({ timeout: t });
        return `Scrolled ${describe(step)} into view`;
      }
      await page.mouse.wheel(0, 100_000);
      return "Scrolled to the bottom of the page";
    }
    case "wait": {
      const seconds = Math.min(Number(value) || 0, 300);
      await sleep(seconds * 1000, state);
      return `Waited ${seconds}s`;
    }
    case "wait_for_text":
    case "assert_text": {
      const ok = await poll(state, t, () => pageHasText(state, step, value));
      if (!ok)
        throw new StepFailure(
          `${step.action === "assert_text" ? "Expected" : "Waited for"} the text “${value}”${step.locatorType ? ` in ${describe(step)}` : ""}, but it wasn't shown within ${Math.round(t / 1000)}s.`,
          step.action === "assert_text" ? "assertion" : "timeout",
        );
      return `Found the text “${value}”`;
    }
    case "wait_for_text_gone": {
      const ok = await poll(state, t, async () => !(await pageHasText(state, step, value)));
      if (!ok) throw new StepFailure(`The text “${value}” was still shown after ${Math.round(t / 1000)}s.`, "timeout");
      return `The text “${value}” is gone`;
    }
    case "wait_for_element":
    case "assert_visible": {
      await findVisible(state, step, t).catch((e: StepFailure) => {
        throw new StepFailure(e.message, step.action === "assert_visible" ? "assertion" : "element_not_found");
      });
      return `${describe(step)} is visible`;
    }
    case "wait_for_element_gone":
    case "assert_hidden": {
      const ok = await poll(state, t, async () => !(await anyVisible(state, step)));
      if (!ok) throw new StepFailure(`${describe(step)} was still visible after ${Math.round(t / 1000)}s.`, step.action === "assert_hidden" ? "assertion" : "timeout");
      return `${describe(step)} is hidden`;
    }
    case "assert_url": {
      const ok = await poll(state, t, async () => state.page.url().includes(value));
      if (!ok) throw new StepFailure(`Expected the URL to contain “${value}”, but it is ${state.page.url()}.`, "assertion");
      return `URL contains “${value}” (${state.page.url().slice(0, 160)})`;
    }
    case "assert_value": {
      const { loc } = await findVisible(state, step, t);
      let actual = "";
      const ok = await poll(state, t, async () => {
        actual = await loc.inputValue({ timeout: 1000 });
        return actual.includes(value);
      });
      if (!ok) throw new StepFailure(`Expected ${describe(step)} to contain “${value}”, but its value is “${actual.slice(0, 200)}”.`, "assertion");
      return `${describe(step)} contains “${value}”`;
    }
    case "screenshot":
      await state.screenshot(step.name);
      return "Saved a screenshot";
    case "script": {
      if (!state.allowScripts) throw new StepFailure("Script steps are disabled on this runner (ALLOW_SCRIPT_STEPS).", "policy");
      const result = await page.evaluate(value);
      return `Script ran${result !== undefined ? `; returned ${JSON.stringify(result)?.slice(0, 200)}` : ""}`;
    }
  }
}

/** Maps a thrown error to a step failure with a category. */
export function classify(err: unknown, state: RunState | null): StepFailure {
  if (err instanceof StepFailure) return err;
  const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
  if (state?.isCancelled()) return new StepFailure("Cancelled", "cancelled");
  if (state?.policyViolation) return new StepFailure(state.policyViolation, "policy");
  if (/Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected/i.test(msg))
    return new StepFailure(`The browser closed unexpectedly: ${msg}`, "infrastructure");
  if (/Timeout \d+ms exceeded|TimeoutError/i.test(msg)) return new StepFailure(msg, "timeout");
  if (/net::ERR_|NS_ERROR_/i.test(msg)) return new StepFailure(msg, "navigation");
  return new StepFailure(msg, "assertion");
}
