import {
  showCwdBar,
  currentConversation,
  getCwd,
  getWorkspaceFolderName,
} from "../../store/signals";

export function CwdBar() {
  if (!showCwdBar.value) return null;

  const conversation = currentConversation.value;
  const fullPath = getCwd(conversation);
  if (!fullPath) return null;

  const folderName =
    getWorkspaceFolderName(conversation) ||
    fullPath.split(/[\\/]/).pop() ||
    fullPath;

  return (
    <div class="cwd-bar" title={fullPath}>
      <span class="cwd-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h12v4.49zm0-5.49h-12V3h4.29l.85.85.36.15H14v3z" />
        </svg>
      </span>
      <span class="cwd-name">{folderName}</span>
    </div>
  );
}
