import { describe, expect, it } from "vite-plus/test";

import {
  CODE_REFERENCE_SECTION_PREFIX,
  CODE_REFERENCE_SECTION_TITLE,
  extractPastedCodeReferences,
  isCodeReferenceContext,
  normalizeCodeReferencePath,
} from "./pastedCodeReferences.ts";

describe("normalizeCodeReferencePath", () => {
  it("relativizes POSIX and Windows absolute paths inside cwd", () => {
    expect(
      normalizeCodeReferencePath("/Users/alice/repo/apps/web/src/App.tsx", "/Users/alice/repo"),
    ).toBe("apps/web/src/App.tsx");
    expect(
      normalizeCodeReferencePath("/Users/alice/repo/apps/web/src/App.tsx", "/Users/alice/repo/"),
    ).toBe("apps/web/src/App.tsx");
    expect(
      normalizeCodeReferencePath(
        String.raw`C:\Users\Alice\Repo\src\index.ts`,
        String.raw`c:\users\alice\repo`,
      ),
    ).toBe("src/index.ts");
  });

  it("keeps absolute paths outside cwd intact and cleans relative prefixes", () => {
    expect(normalizeCodeReferencePath("/other/repo/src/a.ts", "/Users/alice/repo")).toBe(
      "/other/repo/src/a.ts",
    );
    expect(normalizeCodeReferencePath("./src/foo.ts", "/Users/alice/repo")).toBe("src/foo.ts");
    expect(normalizeCodeReferencePath(String.raw`.\src\foo.ts`)).toBe("src/foo.ts");
  });
});

describe("extractPastedCodeReferences", () => {
  it.each([
    ["@src/components/Button.tsx:42", "src/components/Button.tsx", 41, 41, "L42", "Button.tsx L42"],
    [
      "@src/components/Button.tsx:10-25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    [
      "@src/components/Button.tsx:10:5-25:12",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    [
      "@src/components/Button.tsx#L42",
      "src/components/Button.tsx",
      41,
      41,
      "L42",
      "Button.tsx L42",
    ],
    [
      "@src/components/Button.tsx#L10-25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    [
      "@src/components/Button.tsx#L10-L25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    [
      "@src/components/Button.tsx#10-25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    ['@"src/my file.tsx":10-25', "src/my file.tsx", 9, 24, "L10 to L25", "my file.tsx L10 to L25"],
    [
      '@"src/my file.tsx#L10-L25"',
      "src/my file.tsx",
      9,
      24,
      "L10 to L25",
      "my file.tsx L10 to L25",
    ],
    [
      "src/components/Button.tsx:10-25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    [
      "src/components/Button.tsx#L10-L25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    ["Button.tsx:42", "Button.tsx", 41, 41, "L42", "Button.tsx L42"],
    [
      "cursor://file/Users/alice/repo/src/components/Button.tsx:10:5",
      "src/components/Button.tsx",
      9,
      9,
      "L10",
      "Button.tsx L10",
    ],
    [
      "vscode://file/Users/alice/repo/src/components/Button.tsx:10-25",
      "src/components/Button.tsx",
      9,
      24,
      "L10 to L25",
      "Button.tsx L10 to L25",
    ],
    [
      "file:///Users/alice/repo/src/my%20file.tsx#L10-L25",
      "src/my file.tsx",
      9,
      24,
      "L10 to L25",
      "my file.tsx L10 to L25",
    ],
  ])("parses %s", (input, filePath, startIndex, endIndex, rangeLabel, label) => {
    const result = extractPastedCodeReferences(input, { cwd: "/Users/alice/repo" });
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record).toMatchObject({
      kind: "review-comment",
      sectionId: `${CODE_REFERENCE_SECTION_PREFIX}${filePath}`,
      sectionTitle: CODE_REFERENCE_SECTION_TITLE,
      filePath,
      startIndex,
      endIndex,
      rangeLabel,
      label,
      text: "",
      diff: "",
      fenceLanguage: "tsx",
    });
    expect(isCodeReferenceContext(record)).toBe(true);
    expect(result.text).toBe(`[${label}](t3-context://v1/review-comment/${record.contextId})`);
  });

  it("parses Cursor fenced code blocks with embedded line ranges and code", () => {
    const input = [
      "```12:14:src/utils/format.ts",
      "export function format(x: number) {",
      "  return String(x);",
      "}",
      "```",
    ].join("\n");
    const result = extractPastedCodeReferences(input);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record).toMatchObject({
      filePath: "src/utils/format.ts",
      startIndex: 11,
      endIndex: 13,
      rangeLabel: "L12 to L14",
      label: "format.ts L12 to L14",
      fenceLanguage: "ts",
      diff: "export function format(x: number) {\n  return String(x);\n}",
    });
    expect(result.text).toBe(
      `[format.ts L12 to L14](t3-context://v1/review-comment/${record.contextId})`,
    );
  });

  it("parses a reference header followed by a fenced code block", () => {
    const input = ["`src/app.py:5-7`", "```python", "def greet():", "    return 'hi'", "```"].join(
      "\n",
    );
    const result = extractPastedCodeReferences(input);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record).toMatchObject({
      filePath: "src/app.py",
      startIndex: 4,
      endIndex: 6,
      rangeLabel: "L5 to L7",
      fenceLanguage: "python",
      diff: "def greet():\n    return 'hi'",
    });
    expect(result.text).toBe(
      `[app.py L5 to L7](t3-context://v1/review-comment/${record.contextId})`,
    );
  });

  it("parses inline @ references inside prose while preserving trailing punctuation", () => {
    const result = extractPastedCodeReferences(
      "Look at @src/a.ts:10-20, and compare with @src/b.ts#L5.",
    );
    expect(result.records).toHaveLength(2);
    expect(result.text).toBe(
      `Look at [a.ts L10 to L20](t3-context://v1/review-comment/${result.records[0]!.contextId}), and compare with [b.ts L5](t3-context://v1/review-comment/${result.records[1]!.contextId}).`,
    );
  });

  it("leaves ordinary code fences, stack traces, URLs, ports, and prose untouched", () => {
    const samples = [
      "https://example.com:8080/src/app.ts",
      "http://localhost:3000",
      "127.0.0.1:8080",
      "12:30",
      "localhost:3000",
      "Error: boom\n    at render (src/App.tsx:42:10)\n    at main (src/index.ts:3:1)",
      "```ts\n// @src/foo.ts:10-20 inside a plain code block stays literal\nconst x = 1;\n```",
      "Check src/foo.ts:10-20 and let me know",
      "Plain mention without lines @src/foo.ts here",
    ];
    for (const sample of samples) {
      const result = extractPastedCodeReferences(sample);
      expect(result.records, sample).toEqual([]);
      expect(result.text, sample).toBe(sample);
    }
  });
});
