interface MentionMenuProps {
  files: Array<{ path: string; name: string }>;
  filter: string;
  onSelect: (path: string) => void;
}

export function MentionMenu({ files, filter, onSelect }: MentionMenuProps) {
  const filtered = files.filter(
    (f) =>
      f.name.toLowerCase().includes(filter.toLowerCase()) ||
      f.path.toLowerCase().includes(filter.toLowerCase()),
  );
  const visible = filtered.slice(0, 10);

  return (
    <div class="mention-menu" id="mention-menu">
      {visible.length === 0 && (
        <div class="no-results">No files found</div>
      )}
      {visible.map((f) => (
        <div
          key={f.path}
          class="mention-item"
          onClick={() => onSelect(f.path)}
        >
          <span class="file-name">{f.name}</span>
          <span class="file-path">{f.path}</span>
        </div>
      ))}
    </div>
  );
}
