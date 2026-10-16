import { describe, expect, it } from "vitest";
import { stepSchema, secretNames } from "@shared/steps";
import { hostAllowed, isPrivateIp, isBlockedAddress } from "../../server/lib/netpolicy";
import { decryptSecret, encryptSecret, hashToken, newToken } from "../../server/lib/crypto";
import { makeMasker, resolveUrl } from "../../server/runner/engine";
import { redact } from "../../server/lib/log";

describe("step validation", () => {
  const ok = (x: object) => stepSchema.safeParse({ name: "s", options: {}, enabled: true, ...x });
  it("requires a locator for element actions", () => {
    expect(ok({ action: "click" }).success).toBe(false);
    expect(ok({ action: "click", locatorType: "text", locatorValue: "Save" }).success).toBe(true);
  });
  it("rejects a locator on page actions and requires values", () => {
    expect(ok({ action: "navigate", value: "/", locatorType: "css", locatorValue: "a" }).success).toBe(false);
    expect(ok({ action: "navigate" }).success).toBe(false);
    expect(ok({ action: "wait", value: "two" }).success).toBe(false);
  });
  it("allows secrets only where text is typed", () => {
    expect(ok({ action: "fill", locatorType: "id", locatorValue: "pw", value: "{{secrets.PW}}" }).success).toBe(true);
    expect(ok({ action: "navigate", value: "/x?token={{secrets.PW}}" }).success).toBe(false);
    expect(secretNames([{ value: "{{secrets.A}} and {{ secrets.B_2 }}" }, { value: null }])).toEqual(["A", "B_2"]);
  });
  it("rejects unknown options and actions", () => {
    expect(ok({ action: "click", locatorType: "text", locatorValue: "x", options: { evil: true } }).success).toBe(false);
    expect(ok({ action: "shell", value: "rm -rf /" }).success).toBe(false);
  });
});

describe("network policy", () => {
  it("recognizes private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it("blocks localhost names", async () => {
    expect(await isBlockedAddress("localhost")).toBe(true);
    expect(await isBlockedAddress("metadata.google.internal")).toBe(true);
  });
  it("matches allowed hosts exactly or by wildcard", () => {
    expect(hostAllowed("app.example.com", ["app.example.com"])).toBe(true);
    expect(hostAllowed("evil-app.example.com", ["app.example.com"])).toBe(false);
    expect(hostAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com.evil.net", ["*.example.com"])).toBe(false);
  });
  it("resolves relative paths against the base URL", () => {
    expect(resolveUrl("/login", "https://app.example.com").href).toBe("https://app.example.com/login");
    expect(resolveUrl("reports?x=1", "https://app.example.com/base").href).toBe("https://app.example.com/base/reports?x=1");
  });
});

describe("secrets", () => {
  const key = Buffer.alloc(32, 7);
  it("round-trips and detects tampering", () => {
    const c = encryptSecret("p@ss", key);
    expect(c).not.toContain("p@ss");
    expect(decryptSecret(c, key)).toBe("p@ss");
    const parts = c.split(":");
    parts[3] = Buffer.from("xxxx").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
    expect(() => decryptSecret(c, Buffer.alloc(32, 8))).toThrow();
  });
  it("masks every secret value, longest first", () => {
    const mask = makeMasker(new Map([["A", "hunter2"], ["B", "hunter2-admin"]]));
    expect(mask("typed hunter2-admin then hunter2")).toBe("typed •••••• then ••••••");
  });
  it("stores only token hashes", () => {
    const { token, hash } = newToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });
  it("redacts secret-looking keys in logs", () => {
    expect(redact({ email: "a@b.c", password: "x", nested: { apiKey: "k", ok: 1 } })).toEqual({ email: "a@b.c", password: "[redacted]", nested: { apiKey: "[redacted]", ok: 1 } });
  });
});
