// A tiny DOM builder. No framework: views build their elements once and update them in render().

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  hidden?: boolean;
  disabled?: boolean;
  /** Extra attributes (type, value, min, ...). */
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.hidden) el.hidden = true;
  if (props.disabled && "disabled" in el) (el as unknown as { disabled: boolean }).disabled = true;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  if (props.on) {
    for (const [type, fn] of Object.entries(props.on)) {
      el.addEventListener(type, fn as EventListener);
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "number" ? String(c) : c);
  }
}

/** Replace all children of `el`. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Set text only when it changed (keeps selections and avoids needless layout). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
