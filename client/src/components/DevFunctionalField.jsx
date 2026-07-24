import { useState } from 'react';
import { filterSafeTextInput, hasUnsafeTextChars, UNSAFE_TEXT_MSG } from '../textInput.js';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../nameInput.js';

const OTHERS = 'Others';

/**
 * "Behavior & Social" and "Motor Skills" free-text fields (behavior concerns,
 * sensory sensitivities, fine motor concerns, ...) are a descriptive
 * write-up, not a value with a legitimate digit in it, so they get the same
 * strict letters-only filter as a name field instead of the general
 * safe-text one (which allows digits for fields like Allergies/Daily
 * Medication where a dosage is normal).
 */
const LETTERS_ONLY_SECTIONS = ['Behavior & Social', 'Motor Skills'];
function isLettersOnlySection(field) {
  return LETTERS_ONLY_SECTIONS.includes(field.section);
}

/**
 * "Primary mode of communication" only makes sense once the child has been
 * marked non-verbal, so it stays hidden until "Verbal" is answered "No".
 * Keyed by label, not a generic admin-configurable dependency, it's the one
 * conditional relationship the clinic's intake form needs today.
 */
export function devFieldHidden(field, allFields, data) {
  if (field.label !== 'Primary mode of communication') return false;
  const verbalField = allFields.find(f => f.label === 'Verbal');
  if (!verbalField) return false;
  return data[verbalField.id] !== 'No';
}

/**
 * Renders one Development & Functional Information field: 'text' is a plain
 * input, 'select' a dropdown, 'select_other' a dropdown with an implicit
 * trailing "Others" option that reveals a free-text box underneath.
 */
export default function DevFunctionalField({ field, data, onChange, disabled }) {
  const value = data[field.id] || '';
  const options = field.options || [];
  const [otherMode, setOtherMode] = useState(field.field_type === 'select_other' && value !== '' && !options.includes(value));
  const [unsafeNote, setUnsafeNote] = useState('');
  const lettersOnly = isLettersOnlySection(field);

  function changeText(e) {
    if (lettersOnly) {
      setUnsafeNote(hasInvalidNameChars(e.target.value) ? INVALID_NAME_MSG : '');
      onChange(field.id, sanitizeNameInput(e.target.value));
    } else {
      setUnsafeNote(hasUnsafeTextChars(e.target.value) ? UNSAFE_TEXT_MSG : '');
      onChange(field.id, filterSafeTextInput(e.target.value));
    }
  }

  if (field.field_type === 'select' || field.field_type === 'select_other') {
    return (
      <>
        <select
          className="form-select"
          value={otherMode ? OTHERS : value}
          disabled={disabled}
          onChange={e => {
            if (field.field_type === 'select_other' && e.target.value === OTHERS) {
              setOtherMode(true);
              onChange(field.id, '');
            } else {
              setOtherMode(false);
              onChange(field.id, e.target.value);
            }
          }}
        >
          <option value="">- Select -</option>
          {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          {field.field_type === 'select_other' && <option value={OTHERS}>{OTHERS}</option>}
        </select>
        {field.field_type === 'select_other' && otherMode && (
          <>
            <input
              className="form-input"
              style={{ marginTop: 6 }}
              value={value}
              disabled={disabled}
              onChange={changeText}
              placeholder="Please specify"
            />
            {unsafeNote && <div style={{ fontSize: 11, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{unsafeNote}</div>}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <input className="form-input" value={value} disabled={disabled} onChange={changeText} placeholder="Optional" />
      {unsafeNote && <div style={{ fontSize: 11, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{unsafeNote}</div>}
    </>
  );
}
