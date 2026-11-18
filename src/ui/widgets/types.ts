// Shared types of the settings widgets.
//
// A widget has two layers. A `Control` is only the inputs of one item (a text box, a switch, ...).
// A `FieldWidget` (field.ts) wraps a control with the label, the description, the "Not set"
// checkbox of nullable items, and the error line. The view only talks to `FieldWidget`.

export interface FieldState {
  /** What to show: the user's edit if there is one, otherwise the device's value. */
  value: unknown;
  /** Validation message for the edited value, if any. */
  error: string | undefined;
  /** The value differs from the device's. */
  dirty: boolean;
  /** Inputs are locked (saving, or not connected). */
  disabled: boolean;
  /** The device changed this item while the user was editing it. */
  changedOnDevice: boolean;
}

export interface FieldWidget {
  readonly el: HTMLElement;
  /**
   * Show `state`. Called on every render, so it must not disturb typing: the inputs are written
   * only when `state.value` is not what the widget itself last reported (the user's own edit),
   * or when `force` is set (Revert, Reset, after a save, after a reload).
   */
  update(state: FieldState, force: boolean): void;
}

export interface Control {
  readonly el: HTMLElement;
  /** Id of the element the label points to. */
  readonly inputId: string;
  /** Show this value in the inputs (never fires `onValue`). */
  set(value: unknown): void;
  /** The value the inputs hold now (used when "Not set" is unticked). */
  raw(): unknown;
  setDisabled(disabled: boolean): void;
  focus(): void;
}

/** Called by a control when the user changes it. */
export type OnValue = (value: unknown) => void;
