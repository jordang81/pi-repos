import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIST_LIMIT } from "./constants.ts";
import { compareCaseInsensitive, normalizeNewlines, stripUndefined } from "./path-utils.ts";

export function formatDirectoryListOutput(
	entries: Array<{ name: string; type: string }>,
	limit?: number,
): { text: string; count: number; entryLimitReached?: number; truncation?: TruncationResult } {
	entries.sort((left, right) => compareCaseInsensitive(left.name, right.name));
	const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
	const entryLimitReached = entries.length > effectiveLimit;
	const selected = entries.slice(0, effectiveLimit);
	if (selected.length === 0) return { text: "(empty directory)", count: 0 };
	let output = selected.map(formatListEntry).join("\n");
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
	}
	const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return stripUndefined({
		text: output,
		count: selected.length,
		entryLimitReached: entryLimitReached ? effectiveLimit : undefined,
		truncation: truncation.truncated ? truncation : undefined,
	});
}

export function formatPathListOutput(
	matches: string[],
	effectiveLimit: number,
): { text: string; count: number; resultLimitReached?: number; truncation?: TruncationResult } {
	const resultLimitReached = matches.length > effectiveLimit;
	const selected = matches.slice(0, effectiveLimit);
	let output = selected.join("\n");
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more`);
	}
	const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return stripUndefined({
		text: output,
		count: selected.length,
		resultLimitReached: resultLimitReached ? effectiveLimit : undefined,
		truncation: truncation.truncated ? truncation : undefined,
	});
}

export function formatListEntry(entry: { type: string; name: string }): string {
	return entry.type === "dir" ? `${entry.name}/` : entry.name;
}

export function formatReadOutput(text: string, offset?: number, limit?: number): { text: string; truncation?: TruncationResult } {
	const allLines = normalizeNewlines(text).split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selected = allLines.slice(startLine).join("\n");
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selected = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	}
	const truncation = truncateHead(selected);
	if (truncation.firstLineExceedsLimit) {
		return {
			text: `[Line ${startLineDisplay} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Narrow with limit or offset.]`,
			truncation,
		};
	}
	if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const suffix =
			truncation.truncatedBy === "lines"
				? `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
				: `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		return { text: `${truncation.content}\n\n${suffix}`, truncation };
	}
	if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		return { text: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]` };
	}
	return { text: truncation.content };
}
