import { describe, expect, it } from "vitest";
import { parseRecipientsFile } from "../recipientParser";

describe("parseRecipientsFile", () => {
  it("picks email cells out of a multi-column CSV", () => {
    const csv = [
      "name,email,company",
      "Alice,alice@example.com,Acme",
      "Bob,bob@example.com,Globex",
    ].join("\n");

    const result = parseRecipientsFile(csv);

    expect(result.recipients).toEqual(["alice@example.com", "bob@example.com"]);
    expect(result.count).toBe(2);
    // the non-email cells (header + names + companies) count as invalid
    expect(result.invalidCount).toBe(7);
  });

  it("parses newline-separated text", () => {
    const result = parseRecipientsFile("a@example.com\r\nb@example.com\nc@example.com\n");

    expect(result.recipients).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(result.count).toBe(3);
    expect(result.invalidCount).toBe(0);
  });

  it("counts invalid entries", () => {
    const result = parseRecipientsFile(
      ["good@example.com", "not-an-email", "missing@tld", "@nouser.com", "two@@example.com"].join("\n")
    );

    expect(result.recipients).toEqual(["good@example.com"]);
    expect(result.invalidCount).toBe(4);
  });

  it("removes duplicates case-insensitively and lowercases", () => {
    const result = parseRecipientsFile(
      ["Alice@Example.com", "alice@example.com", "ALICE@EXAMPLE.COM", "bob@example.com"].join("\n")
    );

    expect(result.recipients).toEqual(["alice@example.com", "bob@example.com"]);
    expect(result.count).toBe(2);
    expect(result.invalidCount).toBe(0);
  });

  it("returns nothing for empty input", () => {
    expect(parseRecipientsFile("   \n ")).toEqual({ count: 0, recipients: [], invalidCount: 0 });
  });
});
