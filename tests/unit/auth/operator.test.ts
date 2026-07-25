import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOperator } from "@/shared/lib/operator";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.OPERATOR_USER_IDS;
  delete process.env.OPERATOR_EMAILS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isOperator", () => {
  it("fails closed when no allowlist is configured", () => {
    expect(isOperator({ id: "u1", email: "u1@example.com" })).toBe(false);
  });

  it("matches an exact user id in a trimmed CSV allowlist", () => {
    process.env.OPERATOR_USER_IDS = " other, u1 ";
    expect(isOperator({ id: "u1" })).toBe(true);
    expect(isOperator({ id: "U1" })).toBe(false);
  });

  it("matches emails case-insensitively", () => {
    process.env.OPERATOR_EMAILS = " SRE@Example.com ";
    expect(isOperator({ email: "sre@example.com" })).toBe(true);
  });

  it("does not authorize partial id or email matches", () => {
    process.env.OPERATOR_USER_IDS = "user-10";
    process.env.OPERATOR_EMAILS = "ops@example.com";
    expect(isOperator({ id: "user-1", email: "op@example.com" })).toBe(false);
  });
});
