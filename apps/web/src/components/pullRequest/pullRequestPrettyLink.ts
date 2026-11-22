import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { writeTextToClipboard, type ClipboardTarget } from "~/hooks/useCopyToClipboard";
import { m, type MessageResolver } from "~/i18n/messages";

import { changeRequestTermKind } from "./changeRequestTerm";

export interface PullRequestPrettyLinkInput {
  readonly url: string;
  readonly title?: string | null | undefined;
  readonly number?: number | undefined;
}

export interface FormattedPullRequestPrettyLink {
  readonly label: string;
  readonly text: string;
  readonly html: string;
  readonly rtf: string;
}

const PRETTY_LINK_PREFIX = ":pr:";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function encodeRtfText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x5c || code === 0x7b || code === 0x7d) {
      out += `\\${value[i]}`;
    } else if (code === 0x0a) {
      out += "\\line ";
    } else if (code === 0x0d) {
      continue;
    } else if (code === 0x09) {
      out += "\\tab ";
    } else if (code >= 0x20 && code <= 0x7e) {
      out += value[i];
    } else {
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed} `;
    }
  }
  return out;
}

function encodeRtfUrl(url: string): string {
  return encodeRtfText(url.replaceAll('"', "%22").replace(/[\r\n\t]+/g, ""));
}

export function formatPullRequestPrettyLink(
  input: PullRequestPrettyLinkInput,
): FormattedPullRequestPrettyLink {
  const trimmedTitle = input.title?.trim() ?? "";
  const label =
    trimmedTitle.length > 0
      ? trimmedTitle
      : input.number !== undefined
        ? `#${input.number}`
        : input.url;
  const text = `${PRETTY_LINK_PREFIX} [${label}](${input.url})`;
  const html = `${PRETTY_LINK_PREFIX} <a href="${escapeHtml(input.url)}">${escapeHtml(label)}</a>`;
  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\uc0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\\pard\\f0\\fs24 ${PRETTY_LINK_PREFIX} {\\field{\\*\\fldinst{HYPERLINK "${encodeRtfUrl(input.url)}"}}{\\fldrslt ${encodeRtfText(label)}}}}`;
  return { label, text, html, rtf };
}

export async function writePullRequestPrettyLinkToClipboard(
  input: PullRequestPrettyLinkInput,
  target?: ClipboardTarget,
): Promise<boolean> {
  const { text, html, rtf } = formatPullRequestPrettyLink(input);
  const desktopWrite =
    typeof window !== "undefined" ? window.desktopBridge?.writeClipboard : undefined;
  if (typeof desktopWrite === "function") {
    const wrote = await desktopWrite({ text, html, rtf }).catch(() => false);
    if (wrote) return true;
  }
  return writeTextToClipboard(text, target, { "text/html": html });
}

export async function copyPullRequestPrettyLinkWithToast(
  input: PullRequestPrettyLinkInput & {
    readonly terminology?: ChangeRequestTerminology;
  },
  resolve: MessageResolver = m,
): Promise<void> {
  const terminology =
    input.terminology ??
    (sourceControlClients.findByChangeRequestUrl(input.url) ?? sourceControlClients.get(undefined))
      .changeRequest;
  const term = changeRequestTermKind(terminology);
  try {
    await writePullRequestPrettyLinkToClipboard(input, {
      target: `${terminology.singular} pretty link`,
      unavailableMessage: msg(
        "Clipboard API is unavailable while copying {term, select, mr {merge request} cr {change request} other {pull request}} pretty link.",
        { term },
      ),
      failureMessage: msg(
        "Failed to copy {term, select, mr {merge request} cr {change request} other {pull request}} pretty link to the clipboard.",
        { term },
      ),
    });
  } catch (error) {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: resolve(
          msg("Failed to copy {term, select, mr {MR} cr {change request} other {PR}} pretty link", {
            term,
          }),
        ),
        description: thrownErrorMessage(error, resolve) ?? resolve(msg("An error occurred.")),
      }),
    );
  }
}
