export default function PinInput({ value, onChange, onSubmit, disabled }) {
  return (
    <form className="pin-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label htmlFor="pin-input">Enter pairing PIN</label>
      <div className="pin-row">
        <input
          id="pin-input"
          inputMode="text"
          autoComplete="one-time-code"
          maxLength={6}
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase())}
          placeholder="ABC123"
          disabled={disabled}
          spellCheck="false"
        />
        <button className="button button-primary" type="submit" disabled={disabled || value.length !== 6}>
          Connect
        </button>
      </div>
    </form>
  );
}
