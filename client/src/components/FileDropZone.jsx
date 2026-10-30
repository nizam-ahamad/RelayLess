export default function FileDropZone({ onFiles, disabled }) {
  const handleFiles = (fileList) => {
    if (!disabled && fileList?.length) {
      onFiles([...fileList]);
    }
  };

  return (
    <div
      className={`drop-zone bg-[#131314]/50 border-[#3c4043] hover:border-[#a8c7fa] ${disabled ? 'is-disabled' : ''}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (disabled) return;
        handleFiles(event.dataTransfer.files);
      }}
    >
      <div className="drop-icon bg-[#282a2c] border border-[#3c4043] text-[#a8c7fa]">↗</div>
      <h3 className="text-[#e3e3e3]">Drop files here</h3>
      <p className="muted text-[#9aa0a6]">Files stream directly between devices. Nothing is uploaded to this server.</p>
      <label
        className={`button button-secondary bg-[#e3e3e3] hover:bg-white text-[#131314] ${disabled ? 'is-disabled' : ''}`}
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
