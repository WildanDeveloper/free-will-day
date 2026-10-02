/**
 * Headless browser tool. Playwright is loaded lazily and only when
 * ENABLE_BROWSER=1, so a run with the browser disabled needs no dependency at
 * all and starts instantly.
 *
 * One page is kept alive across iterations. The model navigates, reads, and
 * interacts with it; the same page is what gets screenshotted for the dashboard.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

type Page = {
  goto(url: string, options?: unknown): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  content(): Promise<string>;
  evaluate<R>(fn: () => R): Promise<R>;
  click(selector: string, options?: unknown): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options?: unknown): Promise<Buffer>;
  goBack(): Promise<unknown>;
  setDefaultTimeout?(ms: number): void;
};

type Browser = {
  newPage(options?: unknown): Promise<Page>;
  close(): Promise<void>;
};

export type BrowserContext = {
  /** Directory screenshots are written to. */
  screenshotDir: string;
  maxOutput: number;
  /** Cap on a single navigation, in milliseconds. */
  navTimeoutMs: number;
  userAgent?: string;
};

type Launched = {
  browser: Browser;
  page: Page;
};

export type BrowserResult = {
  output: string;
  ok: boolean;
  /** Path of a screenshot captured after this action. */
  screenshot?: string;
};

/**
 * True when the failure is a dead browser or page rather than a real error like
 * a bad selector. Only this class of failure is worth a relaunch.
 */
export function isDeadPage(message: string): boolean {
  return /Target (?:page|closed)|browser has been closed|browser\.close|Protocol error|Target crashed/i.test(
    message,
  );
}

/**
 * Playwright is an optional dependency. Kept behind a dynamic import so a
 * missing install degrades to a clear error rather than a crash at startup.
 */
async function launch(ctx: BrowserContext): Promise<Launched> {
  let playwright: { chromium: { launch(o: unknown): Promise<Browser> } };
  try {
    playwright = (await import("playwright")) as unknown as typeof playwright;
  } catch {
    throw new Error(
      "playwright is not installed. Run: npm install && npx playwright install chromium",
    );
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    viewport: { width: 1280, height: 800 },
  });
  page.setDefaultTimeout?.(ctx.navTimeoutMs);
  return { browser, page };
}

export class BrowserSession {
  private readonly ctx: BrowserContext;
  private launched: Launched | null = null;
  /** Screenshots taken, newest last. Keeps the dashboard from rescanning. */
  private counter = 0;

  constructor(ctx: BrowserContext) {
    this.ctx = ctx;
    mkdirSync(ctx.screenshotDir, { recursive: true });
  }

  /** True once the browser has actually been launched. */
  get started(): boolean {
    return this.launched !== null;
  }

  /**
   * A crash leaves `launched` set while the page is dead, so every later call
   * fails with "Target page, context or browser has been closed". Probe the
   * page and relaunch when it is gone, which is the normal outcome of the
   * agent running for 24 hours.
   */
  private async ensure(): Promise<Launched> {
    if (this.launched) {
      const alive = await this.probe(this.launched.page);
      if (alive) return this.launched;
      await this.shutdown();
    }
    this.launched = await launch(this.ctx);
    return this.launched;
  }

  /** Cheap liveness check that swallows its own errors. */
  private async probe(page: Page): Promise<boolean> {
    try {
      await page.evaluate(() => 1);
      return true;
    } catch {
      return false;
    }
  }

  private async shoot(page: Page): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${String(++this.counter).padStart(3, "0")}.png`;
    const path = join(this.ctx.screenshotDir, name);
    const buffer = await page.screenshot({ fullPage: false });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, buffer);
    return path;
  }

  private clip(text: string): string {
    if (text.length <= this.ctx.maxOutput) return text;
    return `${text.slice(0, this.ctx.maxOutput)}\n... [truncated ${text.length - this.ctx.maxOutput} chars]`;
  }

  async act(action: string, input: Record<string, unknown>): Promise<BrowserResult> {
    // One retry: a dead page is recovered by relaunching, and the common
    // sequence is open-then-interact, so a dead page should not be terminal.
    const first = await this.perform(action, input);
    if (first.ok) return first;

    if (isDeadPage(first.output)) {
      await this.shutdown();
      const second = await this.perform(action, input);
      if (second.ok) return second;
      return {
        ok: false,
        output: `${second.output} (retried once after relaunch)`,
      };
    }
    return first;
  }

  private async perform(action: string, input: Record<string, unknown>): Promise<BrowserResult> {
    let session: Launched;
    try {
      session = await this.ensure();
    } catch (err) {
      return { ok: false, output: `browser unavailable: ${(err as Error).message}` };
    }

    const { page } = session;

    try {
      switch (action) {
        case "open": {
          const url = String(input.url ?? "");
          if (!/^https?:\/\//i.test(url)) {
            return { ok: false, output: `url must start with http:// or https://, got: ${url}` };
          }
          const res = await page.goto(url, { timeout: this.ctx.navTimeoutMs });
          const title = await page.title();
          const shot = await this.shoot(page);
          return {
            ok: true,
            output: this.clip(`status ${res ? res.status() : "?"}\ntitle: ${title}\nurl: ${page.url()}`),
            screenshot: shot,
          };
        }

        case "read": {
          // Prefer visible text over markup: far less noise for the model.
          const text = await page.evaluate(() => {
            const main = document.querySelector("main, article, [role=main]") ?? document.body;
            return (main as HTMLElement).innerText ?? "";
          });
          const title = await page.title();
          return {
            ok: true,
            output: this.clip(`title: ${title}\nurl: ${page.url()}\n\n${text}`),
          };
        }

        case "click": {
          await page.click(String(input.selector ?? ""), {
            timeout: this.ctx.navTimeoutMs,
          });
          const shot = await this.shoot(page);
          return { ok: true, output: `clicked ${input.selector}\nnow at ${page.url()}`, screenshot: shot };
        }

        case "type": {
          await page.fill(String(input.selector ?? ""), String(input.text ?? ""), {
            timeout: this.ctx.navTimeoutMs,
          });
          const shot = await this.shoot(page);
          return {
            ok: true,
            output: `typed ${String(input.text ?? "").length} chars into ${input.selector}`,
            screenshot: shot,
          };
        }

        case "press": {
          await page.press(String(input.selector ?? ""), String(input.key ?? "Enter"), {
            timeout: this.ctx.navTimeoutMs,
          });
          const shot = await this.shoot(page);
          return { ok: true, output: `pressed ${input.key} on ${input.selector}`, screenshot: shot };
        }

        case "back": {
          await page.goBack();
          return { ok: true, output: `now at ${page.url()}` };
        }

        case "screenshot": {
          const shot = await this.shoot(page);
          return { ok: true, output: `saved ${shot}`, screenshot: shot };
        }

        case "close": {
          await this.shutdown();
          return { ok: true, output: "browser closed" };
        }

        default:
          return {
            ok: false,
            output: `unknown browser action: ${action}. Use open, read, click, type, press, back, screenshot, close.`,
          };
      }
    } catch (err) {
      const message = (err as Error).message.split("\n")[0];
      return { ok: false, output: `${action} failed: ${message}` };
    }
  }

  /**
   * Periodic capture for the dashboard, independent of whether the model is
   * using the browser. Silently gives up when the page is unusable.
   */
  async captureQuietly(): Promise<string | undefined> {
    if (!this.launched) return undefined;
    // Only capture from a page that still works. A dead page is not an error
    // worth logging on a timer.
    if (!(await this.probe(this.launched.page))) return undefined;
    try {
      return await this.shoot(this.launched.page);
    } catch {
      return undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.launched) return;
    const { browser } = this.launched;
    this.launched = null;
    try {
      await browser.close();
    } catch {
      // Already gone.
    }
  }
}