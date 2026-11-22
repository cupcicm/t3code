import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatPullRequestPrettyLink,
  writePullRequestPrettyLinkToClipboard,
} from "./pullRequestPrettyLink";

describe("formatPullRequestPrettyLink", () => {
  it("formats HTML, RTF, and plain text for a pull request title and URL", () => {
    const formatted = formatPullRequestPrettyLink({
      title: 'Fix {braces} & "quotes" \\ café 🚀 now',
      url: "https://github.com/org/repo/pull/42",
      number: 42,
    });

    expect(formatted.label).toBe('Fix {braces} & "quotes" \\ café 🚀 now');
    expect(formatted.text).toBe(
      ':pr: [Fix {braces} & "quotes" \\ café 🚀 now](https://github.com/org/repo/pull/42)',
    );
    expect(formatted.html).toBe(
      ':pr: <a href="https://github.com/org/repo/pull/42">Fix {braces} &amp; &quot;quotes&quot; \\ café 🚀 now</a>',
    );
    expect(formatted.rtf).toContain(
      ':pr: {\\field{\\*\\fldinst{HYPERLINK "https://github.com/org/repo/pull/42"}}{\\fldrslt Fix \\{braces\\} & "quotes" \\\\ caf\\u233  \\u-10179 \\u-8576  now}}',
    );
  });

  it("falls back to the pull request number or URL when the title is blank", () => {
    expect(
      formatPullRequestPrettyLink({
        title: "   ",
        url: "https://github.com/org/repo/pull/7",
        number: 7,
      }).html,
    ).toBe(':pr: <a href="https://github.com/org/repo/pull/7">#7</a>');

    expect(
      formatPullRequestPrettyLink({
        url: "https://github.com/org/repo/pull/7",
      }).html,
    ).toBe(
      ':pr: <a href="https://github.com/org/repo/pull/7">https://github.com/org/repo/pull/7</a>',
    );
  });
});

describe("writePullRequestPrettyLinkToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes plain text, HTML, and RTF through the desktop bridge when available", async () => {
    const writeClipboard = vi.fn().mockResolvedValue(true);
    const browserWrite = vi.fn();
    vi.stubGlobal("window", { desktopBridge: { writeClipboard } });
    vi.stubGlobal("navigator", { clipboard: { write: browserWrite, writeText: vi.fn() } });

    await expect(
      writePullRequestPrettyLinkToClipboard({
        title: "Ship feature",
        url: "https://github.com/org/repo/pull/9",
        number: 9,
      }),
    ).resolves.toBe(true);

    expect(writeClipboard).toHaveBeenCalledWith(
      expect.objectContaining({
        text: ":pr: [Ship feature](https://github.com/org/repo/pull/9)",
        html: ':pr: <a href="https://github.com/org/repo/pull/9">Ship feature</a>',
        rtf: expect.stringContaining('HYPERLINK "https://github.com/org/repo/pull/9"'),
      }),
    );
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("falls back to the browser clipboard with HTML and plain text when desktop bridge is absent", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        readonly data: Record<string, Blob>;
        constructor(data: Record<string, Blob>) {
          this.data = data;
        }
      },
    );

    await expect(
      writePullRequestPrettyLinkToClipboard({
        title: "Ship feature",
        url: "https://github.com/org/repo/pull/9",
        number: 9,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe(
      ":pr: [Ship feature](https://github.com/org/repo/pull/9)",
    );
    expect(await items[0]!.data["text/html"]!.text()).toBe(
      ':pr: <a href="https://github.com/org/repo/pull/9">Ship feature</a>',
    );
  });
});
