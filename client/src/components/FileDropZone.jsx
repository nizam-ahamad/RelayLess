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
        handleFiles(event.dataTransfer.files);
      }}
    >
      <div className="drop-icon">↗</div>
      <h3>Drop files here</h3>
      <p className="muted">Files stream directly between devices. Nothing is uploaded to this server.</p>
      <label className="button button-secondary" tabIndex={disabled ? -1 : 0}>
        Browse files
        <input
          type="file"
          multiple
          hidden
          disabled={disabled}
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
