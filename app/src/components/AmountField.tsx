/**
 * A labelled amount input with an "All" button. The label wraps only its text (a label may name one control), so the
 * input's accessible name is exactly the visible label and the button keeps its own name.
 */
export function AmountField({
  id,
  label,
  value,
  disabled,
  onChange,
  onAll,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onAll: () => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="row">
        <input id={id} value={value} disabled={disabled} inputMode="decimal" onChange={(e) => onChange(e.target.value)} />
        <button type="button" disabled={disabled} onClick={onAll}>
          All
        </button>
      </span>
    </div>
  );
}
