import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { forceLinting, lintGutter, lintKeymap, linter, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { haAutocomplete, filePathFacet } from './ha/complete';
import { parseLine } from './ha/yamlPath';
import { validateJson, validateYaml, type Problem } from './ha/validate';
import { kindOf, languageFor } from './lang';

export const wrapCompartment = new Compartment();
export const gutterCompartment = new Compartment();

const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.propertyName, t.definition(t.propertyName), t.labelName], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.meta, t.typeName, t.className, t.tagName], color: 'var(--syn-tag)' },
  { tag: [t.variableName, t.name], color: 'var(--syn-var)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.punctuation, t.separator, t.operator, t.bracket], color: 'var(--syn-punct)' },
  { tag: t.heading, color: 'var(--syn-key)', fontWeight: '700' },
  { tag: t.link, color: 'var(--syn-fn)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

/** {{ templates }} and {% blocks %} get their own colour even though YAML sees plain strings. */
const jinjaMatcher = new MatchDecorator({
  regexp: /\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}/g,
  decoration: Decoration.mark({ class: 'cm-jinja' }),
});
const jinjaPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = jinjaMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = jinjaMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Enter in YAML: keep the structure going. After `key:` indent one level, inside
 * `- item` keep aligned, and continue scalar list items with a new dash.
 */
function yamlEnter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false; // only at end of line; elsewhere use default behaviour
  const info = parseLine(line.text);
  const pad = (n: number) => ' '.repeat(Math.max(0, n));
  let insert: string;
  let removeFrom: number | null = null;
  if (info.dashCol !== null && info.rest === '' && info.key === null) {
    // empty list item: leave the list
    removeFrom = line.from;
    insert = pad(Math.max(0, info.dashCol - 2));
  } else if (info.key !== null && info.rest === '') {
    insert = '\n' + pad(info.keyCol + 2);
  } else if (info.dashCol !== null && info.key === null) {
    insert = '\n' + pad(info.dashCol) + '- ';
  } else {
    insert = '\n' + pad(info.keyCol);
  }
  const from = removeFrom ?? sel.head;
  view.dispatch({
    changes: { from, to: sel.head, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

function toDiagnostics(view: EditorView, problems: Problem[]): Diagnostic[] {
  const len = view.state.doc.length;
  return problems.map((p) => ({
    from: Math.min(p.from, len),
    to: Math.min(Math.max(p.to, p.from + 1), len),
    severity: p.severity,
    message: p.message,
  }));
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Roboto Mono', monospace",
    fontSize: 'var(--editor-font, 15px)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  // Room below the last line so the caret can sit above the keyboard and toolbar.
  '.cm-content': { padding: '8px 0 45vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 10px 0 6px' },
  '.cm-gutters': { backgroundColor: 'var(--bg-elev)', color: 'var(--fg-dim)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  // Native selection (drawSelection is intentionally NOT used) keeps the OS handles and magnifier.
  '.cm-content ::selection, .cm-content::selection': { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--match)', outline: '1px solid var(--accent)' },
  '.cm-jinja': { color: 'var(--syn-jinja)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-elev)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '38vh' },
  '.cm-tooltip-autocomplete ul li': { padding: '8px 10px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
  '.cm-completionDetail': { opacity: 0.7, marginLeft: '0.8em', fontStyle: 'normal' },
  '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'system-ui, sans-serif' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
  '.cm-panels': { backgroundColor: 'var(--bg-elev)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--match)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
});

export interface EditorOptions {
  path: string;
  doc: string;
  wrap: boolean;
  lineNumbers: boolean;
  onSave: () => void;
  onChange: (u: ViewUpdate) => void;
}

export function createState(o: EditorOptions): EditorState {
  const kind = kindOf(o.path);
  const lint =
    kind === 'yaml'
      ? linter((view) => toDiagnostics(view, validateYaml(view.state.doc.toString(), o.path)), { delay: 400 })
      : kind === 'json'
        ? linter((view) => toDiagnostics(view, validateJson(view.state.doc.toString())), { delay: 400 })
        : [];

  const keys = [
    { key: 'Mod-s', preventDefault: true, run: () => (o.onSave(), true) },
    ...(kind === 'yaml' ? [{ key: 'Enter', run: yamlEnter }] : []),
    ...closeBracketsKeymap,
    ...completionKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...lintKeymap,
    indentWithTab,
  ];

  const extensions: Extension[] = [
    filePathFacet.of(o.path),
    gutterCompartment.of(gutters(o.lineNumbers)),
    highlightSpecialChars(),
    history(),
    codeFolding(),
    indentOnInput(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(highlight),
    languageFor(kind),
    kind === 'yaml' ? [haAutocomplete(), jinjaPlugin] : autocompletion({ icons: false }),
    lint,
    wrapCompartment.of(o.wrap ? EditorView.lineWrapping : []),
    EditorView.contentAttributes.of({
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      autocomplete: 'off',
      enterkeyhint: 'enter',
    }),
    keymap.of(keys),
    theme,
    EditorView.updateListener.of(o.onChange),
  ];
  return EditorState.create({ doc: o.doc, extensions });
}

export function gutters(withNumbers: boolean): Extension {
  return [withNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [], foldGutter(), lintGutter()];
}

export { forceLinting };
