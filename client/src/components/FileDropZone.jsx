import { useRef } from 'react';

export default function FileDropZone({ onFiles, disabled }) {
  const fileInputRef = useRef(null);

  const handleFiles = (fileList) => {
    if (!disabled && fileList?.length) {
      onFiles([...fileList]);
    }
  };

  return (
    <div
      className={`drop-zone bg-[#131314]/50 border-[#3c4043] hover:border-[#a8c7fa] cursor-pointer ${disabled ? 'is-disabled' : ''}`}
      onClick={() => {
        if (!disabled) {
          fileInputRef.current?.click();
        }
      }}
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
      <button
        type="button"
        className={`button button-secondary bg-[#e3e3e3] hover:bg-white text-[#131314] ${disabled ? 'is-disabled' : ''}`}
        tabIndex={disabled ? -1 : 0}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) {
            fileInputRef.current?.click();
          }
        }}
        style={disabled ? { pointerEvents: 'none', opacity: 0.5, cursor: 'not-allowed' } : undefined}
      >
        Browse files
      </button>
      <input
        type="file"
        ref={fileInputRef}
        multiple
        hidden
        disabled={disabled}
        onChange={(event) => {
          if (disabled) return;
          handleFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}
