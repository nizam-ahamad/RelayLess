export default function FileDropZone({ onFiles, disabled }) {
  const handleFiles = (fileList) => {
    if (!disabled && fileList?.length) {
      onFiles([...fileList]);
    }
  };

  return (
    <div
      className={`drop-zone ${disabled ? 'is-disabled' : ''}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (disabled) return;
        handleFiles(event.dataTransfer.files);
      }}
    >
      <div className="drop-icon">↗</div>
      <h3>Drop files here</h3>
      <p className="muted">Files stream directly between devices. Nothing is uploaded to this server.</p>
      <label
        className={`button button-secondary ${disabled ? 'is-disabled' : ''}`}
        tabIndex={disabled ? -1 : 0}
        style={disabled ? { pointerEvents: 'none', opacity: 0.5, cursor: 'not-allowed' } : undefined}
      >
        Browse files
        <input
          type="file"
          multiple
          hidden
          disabled={disabled}
          onChange={(event) => {
            if (disabled) return;
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
