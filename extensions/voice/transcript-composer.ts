import { joinTranscriptParts } from "./transcript-join";

/**
 * The preview transcript, kept as the two things the preview channel actually emits.
 *
 * A `commit` is a finished segment: it appends and never changes again. A `partial` is the live tail
 * of the segment still being decoded: each revision replaces the previous one. Rendering is delegated
 * to `joinTranscriptParts` so the preview, the panel and the unconfirmed fallback all stitch segment
 * boundaries the same way the final pass does.
 *
 * Pure by design: no timers, no I/O, no host APIs — the session coordinator owns all of that.
 */
export interface Composer {
	/** Replaces the live tail. Stale revisions, and tails of committed segments, are dropped. */
	applyPartial(segmentId: number, revision: number, text: string): void;
	/** Appends a finished segment. A repeat commit for the same segment is ignored. */
	applyCommit(segmentId: number, text: string): void;
	/** The committed segments joined, then the live tail joined onto them. */
	readonly text: string;
	/** Length of the committed prefix of `text`, i.e. everything that can no longer change. */
	readonly committedChars: number;
	/** Drops every segment, the tail and the revision high-water mark. */
	clear(): void;
}

interface Tail {
	segmentId: number;
	revision: number;
	text: string;
}

export function createComposer(): Composer {
	/** Committed segments by id; ids ascend at every segment boundary but may arrive out of order. */
	const commits = new Map<number, string>();
	let tail: Tail | null = null;

	// `text` is read on every panel render and every revision of the tail changes it, so the join is
	// cached and invalidated by the two mutators instead of running on each read.
	let rendered: { text: string; committedChars: number } | null = null;

	function committedParts(): string[] {
		return [...commits.keys()].sort((a, b) => a - b).map((id) => commits.get(id) ?? "");
	}

	function render(): { text: string; committedChars: number } {
		if (rendered !== null) return rendered;
		const parts = committedParts();
		const committedText = joinTranscriptParts(parts);
		// The tail joins the committed parts as one more part, not as a string append: a Latin tail after
		// a Latin commit still needs its space, and a CJK tail after a CJK commit must not get one.
		const text = tail === null ? committedText : joinTranscriptParts([committedText, tail.text]);
		rendered = { text, committedChars: committedText.length };
		return rendered;
	}

	function lastCommittedSegmentId(): number | null {
		if (commits.size === 0) return null;
		let max = -Infinity;
		for (const id of commits.keys()) max = Math.max(max, id);
		return max;
	}

	return {
		applyPartial(segmentId: number, revision: number, text: string): void {
			const lastCommitted = lastCommittedSegmentId();
			// A tail can only belong to the segment after the last commit: anything at or before it has
			// already been replaced by immutable text and must not resurrect itself.
			if (lastCommitted !== null && segmentId <= lastCommitted) return;
			if (tail !== null) {
				if (segmentId < tail.segmentId) return;
				// Revisions strictly increase per segment; a repeat or an older one is late, not newer.
				if (segmentId === tail.segmentId && revision <= tail.revision) return;
			}
			tail = { segmentId, revision, text };
			rendered = null;
		},

		applyCommit(segmentId: number, text: string): void {
			// Commits are immutable: a repeated commit must not duplicate the segment, and a late one must
			// not rewrite text the user has already seen committed.
			if (commits.has(segmentId)) return;
			commits.set(segmentId, text);
			// Committing this segment ends the tail's claim: whether the tail was its own partial or a
			// later one, a segment at or below the commit is history now.
			if (tail !== null && tail.segmentId <= segmentId) tail = null;
			rendered = null;
		},

		get text(): string {
			return render().text;
		},

		get committedChars(): number {
			return render().committedChars;
		},

		clear(): void {
			commits.clear();
			tail = null;
			rendered = null;
		},
	};
}
