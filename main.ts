import { Editor, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";

interface AIRange {
  from: number;
  to: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Stop {
  pos: number;
  rgb: RGB;
}

interface GradientField {
  baseCenterX: number;
  rangeTop: number;
  radius: number;
  waveAmplitude: number;
  wavePeriod: number;
}

const addAIRange = StateEffect.define<AIRange>();

const aiRangeField = StateField.define<AIRange[]>({
  create: () => [],
  update(ranges, tr) {
    let next = ranges
      .map(range => ({
        from: tr.changes.mapPos(range.from, 1),
        to: tr.changes.mapPos(range.to, -1),
      }))
      .filter(range => range.to > range.from);

    for (const effect of tr.effects) {
      if (effect.is(addAIRange)) {
        next = mergeRange(next, effect.value);
      }
    }

    return next;
  },
});

const GRADIENT_STOPS: Stop[] = [
  { pos: 0.0, rgb: { r: 0x78, g: 0xa8, b: 0xff } },
  { pos: 0.25, rgb: { r: 0x8f, g: 0x98, b: 0xff } },
  { pos: 0.5, rgb: { r: 0xa7, g: 0x86, b: 0xf3 } },
  { pos: 0.75, rgb: { r: 0xcb, g: 0x7f, b: 0xe2 } },
  { pos: 1.0, rgb: { r: 0xf0, g: 0x8b, b: 0xc8 } },
];

function mergeRange(ranges: AIRange[], incoming: AIRange): AIRange[] {
  const all = [...ranges, incoming].sort((a, b) => a.from - b.from);
  const merged: AIRange[] = [];

  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function colorAt(t: number): string {
  const tc = clamp(t, 0, 1);
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    const start = GRADIENT_STOPS[i];
    const end = GRADIENT_STOPS[i + 1];
    if (tc <= end.pos) {
      const local = (tc - start.pos) / (end.pos - start.pos);
      const r = Math.round(start.rgb.r + (end.rgb.r - start.rgb.r) * local);
      const g = Math.round(start.rgb.g + (end.rgb.g - start.rgb.g) * local);
      const b = Math.round(start.rgb.b + (end.rgb.b - start.rgb.b) * local);
      return `rgb(${r},${g},${b})`;
    }
  }

  const last = GRADIENT_STOPS[GRADIENT_STOPS.length - 1].rgb;
  return `rgb(${last.r},${last.g},${last.b})`;
}

function buildLineDecoration(color: string): Decoration {
  return Decoration.mark({
    class: "leftcoast-ai-chunk",
    attributes: {
      style: `color: ${color} !important; -webkit-text-fill-color: ${color} !important;`,
    },
  });
}

function buildGradientField(view: EditorView, rangeFrom: number): GradientField {
  const viewportRect = view.scrollDOM.getBoundingClientRect();
  const horizontalInset = Math.max(view.defaultCharacterWidth * 2, 24);
  const fieldLeft = viewportRect.left + horizontalInset;
  const fieldRight = viewportRect.right - horizontalInset;
  const fieldWidth = Math.max(fieldRight - fieldLeft, view.defaultCharacterWidth * 8);
  const lineBlock = view.lineBlockAt(rangeFrom);

  return {
    baseCenterX: fieldLeft + fieldWidth / 2,
    rangeTop: lineBlock.top,
    radius: fieldWidth / 2,
    waveAmplitude: clamp(fieldWidth * 0.02, 8, 18),
    wavePeriod: Math.max(lineBlock.height, 24) * 8,
  };
}

function intersectRange(a: AIRange, b: AIRange): AIRange | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return to > from ? { from, to } : null;
}

function buildVisibleSlices(view: EditorView, range: AIRange): AIRange[] {
  const slices: AIRange[] = [];
  for (const visible of view.visibleRanges) {
    const slice = intersectRange(range, visible);
    if (slice) {
      slices.push(slice);
    }
  }
  return slices;
}

function rowCenterX(field: GradientField, rowTop: number): number {
  const phase = ((rowTop - field.rangeTop) / field.wavePeriod) * Math.PI * 2;
  return field.baseCenterX + Math.sin(phase) * field.waveAmplitude;
}

const aiHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const rangesChanged =
        update.state.field(aiRangeField, false) !==
        update.startState.field(aiRangeField, false);

      if (update.docChanged || update.viewportChanged || rangesChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const ranges = view.state.field(aiRangeField, false) ?? [];
      const docLength = view.state.doc.length;

      for (const range of ranges) {
        const from = Math.max(0, range.from);
        const to = Math.min(docLength, range.to);
        if (to <= from) {
          continue;
        }

        const field = buildGradientField(view, from);
        for (const slice of buildVisibleSlices(view, { from, to })) {
          let cursor = slice.from;
          while (cursor <= slice.to && cursor <= docLength) {
            const block = view.lineBlockAt(cursor);
            const segFrom = Math.max(block.from, slice.from);
            const segTo = Math.min(block.to, slice.to);

            if (segTo > segFrom) {
              const centerX = rowCenterX(field, block.top);
              const blockLen = Math.max(1, block.to - block.from);
              const fieldLeft = field.baseCenterX - field.radius;
              const fieldSpan = field.radius * 2;
              // Character index ratio within the visual line block, mapped
              // into the field's pixel-space width. Avoids coordsAtPos
              // entirely — CM6 forbids DOM layout reads during update.
              for (let pos = segFrom; pos < segTo; pos++) {
                const chunkEnd = pos + 1;
                const normalized = (pos - block.from) / blockLen;
                const x = fieldLeft + normalized * fieldSpan;
                const d = clamp(Math.abs(x - centerX) / field.radius, 0, 1);
                builder.add(pos, chunkEnd, buildLineDecoration(colorAt(d)));
              }
            }

            if (block.to >= slice.to) {
              break;
            }
            cursor = block.to + 1;
          }
        }
      }

      return builder.finish();
    }
  },
  { decorations: value => value.decorations }
);

export default class LeftcoastAuthorshipPlugin extends Plugin {
  async onload() {
    this.registerEditorExtension([aiRangeField, aiHighlightPlugin]);

    this.addCommand({
      id: "paste-as-ai",
      name: "Paste as Styled AI",
      editorCallback: async (editor: Editor) => {
        const text = await navigator.clipboard.readText().catch(() => "");
        if (!text) {
          new Notice("Clipboard is empty");
          return;
        }
        this.pasteAsAI(editor, text);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, _view: MarkdownView) => {
        menu.addItem(item => {
          item
            .setTitle("Paste as Styled AI")
            .setIcon("clipboard-paste")
            .onClick(async () => {
              const text = await navigator.clipboard.readText().catch(() => "");
              if (!text) {
                new Notice("Clipboard is empty");
                return;
              }
              this.pasteAsAI(editor, text);
            });
        });
      })
    );

    console.log("Leftcoast Authorship: loaded");
  }

  private pasteAsAI(editor: Editor, text: string) {
    // @ts-ignore Obsidian exposes the CM6 EditorView via editor.cm
    const cm: EditorView = (editor as any).cm;
    if (!cm) {
      new Notice("Could not access editor");
      return;
    }

    const from = cm.state.selection.main.from;
    const to = cm.state.selection.main.to;
    const insertEnd = from + text.length;

    cm.dispatch({
      changes: { from, to, insert: text },
      effects: addAIRange.of({ from, to: insertEnd }),
      selection: { anchor: insertEnd },
    });
  }

  async onunload() {
    console.log("Leftcoast Authorship: unloaded");
  }
}
