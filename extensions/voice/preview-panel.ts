/**
 * The preview panel: the live dictation transcript, six rows tall, scrolled to its tail.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.2.
 *
 * Mounted through the **factory** form of `ctx.ui.setWidget(key, factory, …)` because the `string[]`
 * form is capped by the host at ten rows plus a truncation marker, while the factory form is uncapped
 * and leaves the height to us. So this module is the only thing holding its own height: it renders at
 * most `opts.lines` (default six) rows and drops older rows off the top.
 *
 * Three things are deliberate, and each has a reason a "nicer" variant would violate:
 *
 *   - **Only transcript text.** No header, no counter, no status label, no theme colours, no animation.
 *     The repository has no UI-copy localisation (English literals throughout; `ui-locale-labels.ts`
 *     holds language names only), and a lone English label beside Chinese dictation reads worse than
 *     no label at all. Colour would also tie a display-only preview to a theme it never asked for.
 *   - **Wrap, do not clip.** The transcript arrives as one flowing paragraph, not one sentence per
 *     line (`transcript-composer.ts` joins segments), so clipping each row to the terminal width would
 *     pin the top of the dictation on screen and hide the words being spoken right now. Wrapping keeps
 *     the live tail visible, which is the only reason the panel exists.
 *   - **No cache.** `getText()` is cheap (the composer caches its own join), and the panel is repainted
 *     from the shared render ticker on every preview event. Caching here would add a stale-state bug
 *     class for no measurable win, so `invalidate()` is a no-op and `render()` reads the text it is
 *     given. Rows are rebuilt on each render — a rolling window of at most `lines` strings, so the hot
 *     path allocates only the visible rows.
 */

import { visualWidth } from "./ui-width";

/** Rows the panel shows when the caller does not ask for a different height. */
export const PREVIEW_LINES = 6;

/** The `aboveEditor` component shape the host's widget factory expects. */
export interface PreviewPanel {
	/** Marks the component stale. The panel caches nothing, so this exists only to satisfy the host. */
	invalidate(): void;
	/** The last rows of the transcript, wrapped to `width` columns. Never throws. */
	render(width: number): string[];
}

export interface PreviewPanelOptions {
	/** Visible rows. Defaults to `PREVIEW_LINES`. */
	lines?: number;
}

/**
 * Build the display-only preview panel over `getText`.
 *
 * `getText` is called once per render and may throw — a throwing source renders nothing rather than
 * tearing down the frame it is drawn into, because the preview must never be on the recording's or the
 * final pass's critical path.
 */
export function createPreviewPanel(getText: () => string, opts: PreviewPanelOptions = {}): PreviewPanel {
	const requested = opts.lines ?? PREVIEW_LINES;
	// A non-finite or sub-1 request must not unbound the window, so clamp rather than trust the caller.
	const maxRows = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : PREVIEW_LINES;

	return {
		invalidate(): void {},

		render(width: number): string[] {
			// A width below one column cannot hold a glyph; render nothing instead of emitting rows the
			// viewport would have to clip.
			if (!(width >= 1)) return [];
			let text: string;
			try {
				text = getText();
			} catch {
				return [];
			}
			return tailRows(text, width, maxRows);
		},
	};

	/**
	 * Wrap `text` to `width` columns and return the last `maxRows` rows.
	 *
	 * Wrapping is a single forward pass that keeps a rolling window of `maxRows` rows, so memory is the
	 * visible tail and not the whole transcript. Iteration is by code point (surrogate pairs included)
	 * and width comes from `visualWidth`, so a wide CJK glyph is never split in half: when it does not
	 * fit in the columns left on the row it starts the next row, leaving that one column unused.
	 */
	function tailRows(text: string, width: number, maxRows: number): string[] {
		let end = text.length;
		while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
		if (end === 0) return [];
		const body = end === text.length ? text : text.slice(0, end);

		const rows: string[] = [];
		let row = "";
		let rowWidth = 0;
		const pushRow = (): void => {
			rows.push(row);
			if (rows.length > maxRows) rows.shift();
			row = "";
			rowWidth = 0;
		};

		for (const ch of body) {
			if (ch === "\n") {
				pushRow();
				continue;
			}
			// "\r" only survives inside the body as part of a "\r\n" break; treat it the same way.
			if (ch === "\r") continue;
			const cw = visualWidth(ch);
			if (rowWidth + cw > width) pushRow();
			row += ch;
			rowWidth += cw;
		}
		pushRow();

		return rows;
	}
}
